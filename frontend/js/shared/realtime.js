/* ================================================================
   realtime.js — Same-origin WebSocket connection, resume and freshness
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.realtimeMixin = {
  realtimeSocket: null,
  realtimeState: 'connecting', // connecting | online | degraded | offline
  realtimeReady: false,
  realtimeInstanceId: null,
  realtimeTaskStateUnknown: false,
  _realtimeTopics: null,
  _realtimeCursors: null,
  _realtimeReplayTopics: null,
  _realtimeLastMessageAt: 0,
  _realtimeReconnectTimer: null,
  _realtimeConnectTimer: null,
  _realtimePingTimer: null,
  _realtimeHealthTimer: null,
  _realtimeSnapshotRetryTimer: null,
  _realtimeReconnectDelay: 500,
  _realtimeSnapshotRetryDelay: 500,
  _realtimeHealthFailures: 0,
  _realtimeSocketClosed: false,
  _realtimeInboundChain: null,
  _realtimeSnapshotController: null,
  _realtimeInstanceStorageKey: 'anima-realtime-instance-id',
  _realtimeWsToken: '',
  _realtimeWsTokenExpiresAt: 0,
  _realtimeWsAuthEnabled: null,
  _realtimeAuthBlocked: false,
  _realtimeConnectSeq: 0,
  _realtimeWakeGraceUntil: 0,
  _realtimeWakeProbeTimer: null,

  _realtimeTiming() {
    const remote = window.isRemoteOrigin();
    return remote ? {
      pingIntervalMs: 5000,
      degradedAgeMs: 10000,
      healthTimeoutMs: 5000,
      healthIntervalMs: 3000,
      connectTimeoutMs: 15000,
      snapshotTimeoutMs: 15000,
      visibilityGraceMs: 4000,
    } : {
      pingIntervalMs: 1000,
      degradedAgeMs: 2000,
      healthTimeoutMs: 1000,
      healthIntervalMs: 2000,
      connectTimeoutMs: 4000,
      snapshotTimeoutMs: 4000,
      visibilityGraceMs: 2000,
    };
  },

  startRealtime() {
    this._realtimeTopics = new Set();
    this._loadRealtimeState();
    setInterval(() => this._checkRealtimeFreshness(), 500);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._handleRealtimeWakeUp();
    });
    window.addEventListener?.('online', () => this._handleRealtimeOnline());
    // 训练生命周期状态走串行 HTTP 轮询（单一写入方）；WS 只承载流式增量。
    this._scheduleTrainingStatePoll(0);
    void this._connectRealtimeWithAuth();
  },

  _handleRealtimeWakeUp() {
    if (this._realtimeAuthBlocked) return;
    const timing = this._realtimeTiming();
    this._realtimeWakeGraceUntil = Date.now() + timing.visibilityGraceMs;
    if (this._realtimeWakeProbeTimer) {
      clearTimeout(this._realtimeWakeProbeTimer);
      this._realtimeWakeProbeTimer = null;
    }
    if (!this.realtimeSocket || this.realtimeSocket.readyState > WebSocket.OPEN) {
      this._realtimeReconnectDelay = 500;
      void this._connectRealtimeWithAuth();
    } else if (this.realtimeSocket.readyState === WebSocket.OPEN) {
      const socket = this.realtimeSocket;
      const sentAt = Date.now();
      this._sendRealtime({ op: 'ping' });
      this._realtimeWakeProbeTimer = setTimeout(() => {
        this._realtimeWakeProbeTimer = null;
        if (this.realtimeSocket === socket && this._realtimeLastMessageAt < sentAt) {
          try { socket.close(); } catch (_) {}
        }
      }, timing.visibilityGraceMs);
    }
    // 回到前台立即对账一次（休眠/后台节流期间状态可能已陈旧）。
    void this._pollTrainingState();
  },

  _handleRealtimeOnline() {
    if (this._realtimeAuthBlocked) return;
    const timing = this._realtimeTiming();
    this._realtimeReconnectDelay = 500;
    this._realtimeHealthFailures = 0;
    this._realtimeWakeGraceUntil = Date.now() + timing.visibilityGraceMs;
    if (!this.realtimeSocket || this.realtimeSocket.readyState > WebSocket.OPEN) {
      void this._connectRealtimeWithAuth();
    } else if (this.realtimeSocket.readyState === WebSocket.OPEN) {
      this._sendRealtime({ op: 'ping' });
    }
    void this._pollTrainingState();
  },

  _realtimeUrl() {
    let url = window.animaWsUrl('/ws/realtime');
    if (this._realtimeWsToken) {
      url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(this._realtimeWsToken);
    }
    return url;
  },

  async _fetchRealtimeWsToken() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutMs = this._realtimeTiming().healthTimeoutMs;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const tokenUrl = window.animaUrl('/api/auth/ws-token');
      const response = await fetch(tokenUrl, {
        method: 'POST',
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.status === 401) {
        this._handleRealtimeAuthRequired();
        return { ok: false, unauthorized: true };
      }
      if (!response.ok) return { ok: false, unauthorized: false };
      const raw = await response.json();
      const payload = (raw && raw.data && typeof raw.data === 'object') ? raw.data : raw;
      const authEnabled = !!(payload && payload.auth_enabled);
      this._realtimeWsAuthEnabled = authEnabled;
      if (authEnabled && payload.token) {
        this._realtimeWsToken = String(payload.token);
        const expiresIn = Math.max(30, Number(payload.expires_in) || 300);
        this._realtimeWsTokenExpiresAt = Date.now() + Math.max(10, expiresIn - 30) * 1000;
      } else {
        this._realtimeWsToken = '';
        this._realtimeWsTokenExpiresAt = 0;
      }
      return { ok: true, authEnabled, token: this._realtimeWsToken };
    } catch (_) {
      return { ok: false, unauthorized: false };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  },

  _handleRealtimeAuthRequired() {
    this._realtimeAuthBlocked = true;
    this._realtimeConnectSeq++;
    this._realtimeWsToken = '';
    this._realtimeWsTokenExpiresAt = 0;
    if (this._realtimeReconnectTimer) { clearTimeout(this._realtimeReconnectTimer); this._realtimeReconnectTimer = null; }
    if (this._realtimeConnectTimer) { clearTimeout(this._realtimeConnectTimer); this._realtimeConnectTimer = null; }
    if (this._realtimeHealthTimer) { clearInterval(this._realtimeHealthTimer); this._realtimeHealthTimer = null; }
    if (this._realtimeSnapshotRetryTimer) { clearTimeout(this._realtimeSnapshotRetryTimer); this._realtimeSnapshotRetryTimer = null; }
    if (this._realtimeWakeProbeTimer) { clearTimeout(this._realtimeWakeProbeTimer); this._realtimeWakeProbeTimer = null; }
    this._stopRealtimePing();
    const socket = this.realtimeSocket;
    this.realtimeSocket = null;
    if (socket) { try { socket.close(); } catch (_) {} }
    this.realtimeReady = false;
    this.realtimeState = 'offline';
    this.backendConnected = false;
    this.setPreviewMediaPaused?.(true);
    const msg = (typeof this.t === 'function' && this.t('common.backendAuthExpiredToast') !== 'common.backendAuthExpiredToast')
      ? this.t('common.backendAuthExpiredToast')
      : 'Authentication expired. Reload the page to sign in again.';
    this.toast?.(msg, 'error', { key: 'backend-auth-required', persistent: true });
  },

  async _connectRealtimeWithAuth() {
    if (this._realtimeAuthBlocked) return;
    if (this.realtimeSocket && (this.realtimeSocket.readyState === WebSocket.OPEN || this.realtimeSocket.readyState === WebSocket.CONNECTING)) return;
    const seq = ++this._realtimeConnectSeq;
    const needsToken = this._realtimeWsAuthEnabled !== false
      && (!this._realtimeWsToken || Date.now() >= (this._realtimeWsTokenExpiresAt || 0));
    if (needsToken && typeof fetch === 'function') {
      const result = await this._fetchRealtimeWsToken();
      if (seq !== this._realtimeConnectSeq || this._realtimeAuthBlocked || result?.unauthorized) return;
    }
    if (seq !== this._realtimeConnectSeq || this._realtimeAuthBlocked) return;
    this._connectRealtimeNow();
  },

  _connectRealtimeNow() {
    if (this._realtimeAuthBlocked) return;
    if (this.realtimeSocket && (this.realtimeSocket.readyState === WebSocket.OPEN || this.realtimeSocket.readyState === WebSocket.CONNECTING)) return;
    this._realtimeConnectSeq++;
    if (this._realtimeReconnectTimer) { clearTimeout(this._realtimeReconnectTimer); this._realtimeReconnectTimer = null; }
    if (this._realtimeSnapshotRetryTimer) { clearTimeout(this._realtimeSnapshotRetryTimer); this._realtimeSnapshotRetryTimer = null; }
    this._stopRealtimePing();
    this.realtimeReady = false;
    this._setRealtimeState('connecting');
    let socket;
    try { socket = new WebSocket(this._realtimeUrl()); } catch (_) { this._scheduleRealtimeReconnect(); return; }
    this.realtimeSocket = socket;
    this._realtimeInboundChain = Promise.resolve();
    this._realtimeConnectTimer = setTimeout(() => {
      if (this.realtimeSocket === socket && !this.realtimeReady) {
        try { socket.close(); } catch (_) {}
      }
    }, this._realtimeTiming().connectTimeoutMs);

    socket.onopen = () => {
      if (this.realtimeSocket !== socket) return;
      this._realtimeSocketClosed = false;
      this._realtimeHealthFailures = 0;
      this._sendRealtime({
        op: 'hello',
        protocol: 1,
        server_instance_id: this.realtimeInstanceId || null,
      });
    };
    socket.onmessage = (event) => {
      if (this.realtimeSocket !== socket || socket.readyState > WebSocket.OPEN) return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (!message || typeof message !== 'object') return;
      this._realtimeLastMessageAt = Date.now();
      const previous = this._realtimeInboundChain || Promise.resolve();
      this._realtimeInboundChain = previous
        .then(() => this._handleRealtimeMessage(message, socket))
        .catch(error => console.error('Realtime event processing failed', error));
    };
    socket.onerror = () => { /* onclose owns state changes */ };
    socket.onclose = (event) => {
      // A superseded socket is allowed to close silently. It must never mark
      // the newer, healthy connection as delayed or schedule a second retry.
      if (this.realtimeSocket !== socket) return;
      this.realtimeSocket = null;
      this._realtimeSnapshotController?.abort();
      if (this._realtimeSnapshotRetryTimer) { clearTimeout(this._realtimeSnapshotRetryTimer); this._realtimeSnapshotRetryTimer = null; }
      if (this._realtimeConnectTimer) { clearTimeout(this._realtimeConnectTimer); this._realtimeConnectTimer = null; }
      if (this._realtimeWakeProbeTimer) { clearTimeout(this._realtimeWakeProbeTimer); this._realtimeWakeProbeTimer = null; }
      this._stopRealtimePing();
      const wasReady = this.realtimeReady;
      this.realtimeReady = false;
      this._realtimeSocketClosed = true;
      if (this._realtimeAuthBlocked) return;
      if ((event && event.code === 1008) || (!wasReady && this._realtimeWsToken)) {
        // Policy violation (1008) or pre-ready handshake rejection (e.g. Uvicorn
        // HTTP 403 -> browser 1006 after a server restart with a new token nonce):
        // invalidate cached token so the next reconnect requests /api/auth/ws-token.
        this._realtimeWsToken = '';
        this._realtimeWsTokenExpiresAt = 0;
        this._realtimeWsAuthEnabled = null;
        if (event && event.code === 1008) this._realtimeReconnectDelay = 500;
      }
      this._setRealtimeState('degraded');
      this._ensureRealtimeHealthProbe();
      this._wakeTrainingStatePoll();
      this._scheduleRealtimeReconnect();
    };
  },

  _scheduleRealtimeReconnect() {
    if (this._realtimeAuthBlocked || this._realtimeReconnectTimer) return;
    const delay = this._realtimeReconnectDelay;
    this._realtimeReconnectDelay = Math.min(5000, Math.max(500, delay * 2));
    this._realtimeReconnectTimer = setTimeout(() => {
      this._realtimeReconnectTimer = null;
      void this._connectRealtimeWithAuth();
    }, delay);
  },

  _sendRealtime(message) {
    const socket = this.realtimeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch (_) { return false; }
  },

  _startRealtimePing() {
    if (this._realtimePingTimer) return;
    const ping = () => {
      if (!this.realtimeReady) return;
      this._sendRealtime({ op: 'ping' });
    };
    ping();
    this._realtimePingTimer = setInterval(ping, this._realtimeTiming().pingIntervalMs);
  },

  _stopRealtimePing() {
    if (this._realtimePingTimer) clearInterval(this._realtimePingTimer);
    this._realtimePingTimer = null;
  },

  realtimeSubscribe(topic) {
    if (!topic) return;
    if (!this._realtimeTopics) this._realtimeTopics = new Set();
    if (this._realtimeTopics.has(topic)) return;
    this._realtimeTopics.add(topic);
    if (this.realtimeReady) {
      const resume = {}; resume[topic] = (this._realtimeCursors || {})[topic] || 0;
      this._sendRealtime({ op: 'subscribe', topics: [topic], resume });
    }
  },

  realtimeUnsubscribe(topic) {
    if (!topic || !this._realtimeTopics || !this._realtimeTopics.has(topic)) return;
    this._realtimeTopics.delete(topic);
    this._realtimeReplayTopics?.delete(topic);
    this._sendRealtime({ op: 'unsubscribe', topics: [topic] });
  },

  _sendRealtimeSubscriptions() {
    const topics = Array.from(this._realtimeTopics || []);
    const resume = {};
    for (const topic of topics) resume[topic] = (this._realtimeCursors || {})[topic] || 0;
    this._sendRealtime({ op: 'subscribe', topics, resume });
  },

  async _handleRealtimeMessage(message, socket) {
    if (socket && (this.realtimeSocket !== socket || socket.readyState > WebSocket.OPEN)) return;
    if (message.op === 'ready') {
      await this._handleRealtimeReady(message, socket);
      return;
    }
    if (message.op === 'pong') {
      if (message.server_instance_id && this.realtimeInstanceId && message.server_instance_id !== this.realtimeInstanceId) {
        await this._handleRealtimeResync({
          op: 'resync_required', topics: [], reason: 'server_instance_changed',
          server_instance_id: message.server_instance_id,
        }, socket);
        return;
      }
      // A pong is useful only after ready + snapshot established a coherent
      // browser state; before that it must not mark the backend as connected.
      if (this.realtimeReady && Date.now() - this._realtimeLastMessageAt <= this._realtimeTiming().degradedAgeMs) this._setRealtimeState('online');
      return;
    }
    if (message.op === 'resync_required') {
      await this._handleRealtimeResync(message, socket);
      return;
    }
    if (message.op !== 'event') return;
    if (!this.realtimeReady) return;

    const topic = message.topic;
    const seq = Number(message.seq) || 0;
    if (topic && seq) {
      let last = Number((this._realtimeCursors || {})[topic] || 0);
      if (seq <= last) return;
      if (last && seq > last + 1 && !(topic === 'hardware' && message.type === 'hardware.sample')) {
        const ok = await this._handleRealtimeResync({ op: 'resync_required', topics: [topic], reason: 'sequence_gap' }, socket);
        if (!ok) return;
        last = Number((this._realtimeCursors || {})[topic] || 0);
        if (seq <= last) return;
      }
    }
    if (this.realtimeReady && Date.now() - this._realtimeLastMessageAt <= this._realtimeTiming().degradedAgeMs) this._setRealtimeState('online');
    try {
      this._dispatchRealtimeEvent(message);
    } catch (error) {
      console.error('Realtime event processing failed', error);
      this._reconnectRealtimeAfterError(socket);
      return;
    }
    if (topic && seq) {
      if (!this._realtimeCursors) this._realtimeCursors = {};
      this._realtimeCursors[topic] = seq;
      this._realtimeReplayTopics?.delete(topic);
    }
  },

  _reconnectRealtimeAfterError(socket) {
    this._realtimeReplayTopics = new Set(this._realtimeTopics);
    this.realtimeReady = false;
    this._setRealtimeState('degraded');
    this._wakeTrainingStatePoll();
    socket.close();
  },

  async _handleRealtimeReady(message, socket) {
    if (this.realtimeSocket !== socket) return;
    if (this._realtimeConnectTimer) { clearTimeout(this._realtimeConnectTimer); this._realtimeConnectTimer = null; }
    const nextId = message.server_instance_id;
    if (!nextId) return;
    const previousId = this.realtimeInstanceId;
    const restarted = !!previousId && previousId !== nextId;
    this.realtimeInstanceId = nextId;
    this._saveRealtimeInstanceId();
    if (restarted) this._handleRealtimeServerRestart();
    // The connection gate uses the compact snapshot only. A dashboard may
    // subsequently request curves/log metadata, but a slow disk scan must not
    // prevent the socket itself from becoming healthy.
    const ok = await this._refreshRealtimeSnapshot(nextId, socket);
    if (this.realtimeSocket !== socket) return;
    if (!ok || this.realtimeInstanceId !== nextId) {
      this._setRealtimeState('degraded');
      this._wakeTrainingStatePoll();
      this._scheduleRealtimeSnapshotRetry(nextId);
      return;
    }
    this._finishRealtimeBootstrap(nextId, socket);
  },

  _finishRealtimeBootstrap(instanceId, socket) {
    if ((socket && this.realtimeSocket !== socket)) return;
    if (!instanceId || this.realtimeInstanceId !== instanceId) return;
    if (!this.realtimeSocket || this.realtimeSocket.readyState !== WebSocket.OPEN) return;
    this.realtimeReady = true;
    this._realtimeReconnectDelay = 500;
    this._realtimeSnapshotRetryDelay = 500;
    this._realtimeHealthFailures = 0;
    this._realtimeLastMessageAt = Date.now();
    this._setRealtimeState('online');
    this._startRealtimePing();
    this._sendRealtimeSubscriptions();
    if (this.currentRoute === 'monitor-dashboard') {
      // A pending live detail may predate the snapshot's subscription cursor.
      void this.refreshMonitorRealtimeDetail(!!this.liveTaskId || !this.currentOutputRunDir);
    }
  },

  _scheduleRealtimeSnapshotRetry(instanceId) {
    if (this._realtimeSnapshotRetryTimer) return;
    const delay = this._realtimeSnapshotRetryDelay;
    const socket = this.realtimeSocket;
    this._realtimeSnapshotRetryDelay = Math.min(5000, Math.max(500, delay * 2));
    const timer = setTimeout(() => {
      const previous = this._realtimeInboundChain || Promise.resolve();
      this._realtimeInboundChain = previous.then(async () => {
        if (this._realtimeSnapshotRetryTimer !== timer) return;
        this._realtimeSnapshotRetryTimer = null;
        if (this.realtimeSocket !== socket || !socket || socket.readyState !== WebSocket.OPEN
          || this.realtimeInstanceId !== instanceId || this.realtimeReady) return;
        const ok = await this._refreshRealtimeSnapshot(instanceId, socket);
        if (ok) this._finishRealtimeBootstrap(instanceId, socket);
        else if (this.realtimeSocket === socket && this.realtimeInstanceId === instanceId) this._scheduleRealtimeSnapshotRetry(instanceId);
      }).catch(error => console.error('Realtime event processing failed', error));
    }, delay);
    this._realtimeSnapshotRetryTimer = timer;
  },

  async _handleRealtimeResync(message, socket) {
    if ((socket && this.realtimeSocket !== socket)) return;
    const announcedId = message && message.server_instance_id;
    if (announcedId && announcedId !== this.realtimeInstanceId) {
      this.realtimeInstanceId = announcedId;
      this._saveRealtimeInstanceId();
      this._handleRealtimeServerRestart();
    }
    const topics = Array.isArray(message && message.topics) ? message.topics : [];
    this.handleRealtimeResyncRequired(topics);
    const ok = await this._refreshRealtimeSnapshot(this.realtimeInstanceId, socket, { topics });
    if (!ok && socket && this.realtimeSocket === socket) {
      this._reconnectRealtimeAfterError(socket);
    } else if (ok && this.currentRoute === 'monitor-dashboard') {
      void this.refreshMonitorRealtimeDetail(true);
    }
    return ok;
  },

  async _refreshRealtimeSnapshot(expectedInstanceId, expectedSocket, options) {
    if (expectedSocket && (this.realtimeSocket !== expectedSocket || expectedSocket.readyState > WebSocket.OPEN)) return false;
    if (!expectedInstanceId || expectedInstanceId !== this.realtimeInstanceId) return false;
    const topics = options?.topics;
    this._realtimeSnapshotController?.abort();
    const controller = this._realtimeSnapshotController = new AbortController();
    const taskBoundaryAt = this.liveTaskBoundaryAt, requestedTaskId = this.liveTaskId;
    const timeout = setTimeout(() => controller.abort(), this._realtimeTiming().snapshotTimeoutMs);
    let snapshot;
    try {
      const snapshotUrl = window.animaUrl('/api/realtime/snapshot');
      const response = await fetch(snapshotUrl, { cache: 'no-store', signal: controller.signal });
      if (response.status === 401) {
        this._handleRealtimeAuthRequired();
        return false;
      }
      if (!response.ok) return false;
      const body = await response.json();
      if (body.status !== 'success' || !body.data) return false;
      snapshot = body.data;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timeout);
      if (this._realtimeSnapshotController === controller) this._realtimeSnapshotController = null;
    }
    if (expectedSocket && (this.realtimeSocket !== expectedSocket || expectedSocket.readyState > WebSocket.OPEN)) return false;
    if (expectedInstanceId !== this.realtimeInstanceId || snapshot.server_instance_id !== expectedInstanceId) return false;
    const applyMonitor = requestedTaskId === this.liveTaskId
      && taskBoundaryAt === this.liveTaskBoundaryAt;
    const domainSnapshot = topics?.length ? {
      ...snapshot,
      hardware: topics.includes('hardware') ? snapshot.hardware : null,
      tasks: { ...snapshot.tasks, tracked: (snapshot.tasks?.tracked || []).filter(task => topics.includes('task:' + task.task_id)) },
    } : snapshot;
    try {
      this._applyRealtimeSnapshot(domainSnapshot, { applyMonitor });
      if (topics) {
        if (topics.length) topics.forEach(topic => { delete this._realtimeCursors?.[topic]; this._realtimeReplayTopics?.delete(topic); });
        else { this._realtimeCursors = {}; this._realtimeReplayTopics = null; }
      }
      this._applyRealtimeSnapshotCursors(snapshot.cursors || {}, topics);
    } catch (error) {
      console.error('Realtime snapshot processing failed', error);
      return false;
    }
    return true;
  },

  _applyRealtimeSnapshotCursors(snapshotCursors, topics) {
    if (!this._realtimeCursors) this._realtimeCursors = {};
    if (topics?.length) {
      for (const topic of topics) {
        const seq = Number(snapshotCursors[topic]) || 0;
        if (seq > Number(this._realtimeCursors[topic] || 0)) this._realtimeCursors[topic] = seq;
      }
      return;
    }
    const subscribed = this._realtimeTopics || new Set();
    for (const topic of Object.keys(this._realtimeCursors)) {
      if (!subscribed.has(topic) && !Object.prototype.hasOwnProperty.call(snapshotCursors, topic)) delete this._realtimeCursors[topic];
    }
    for (const [topic, seq] of Object.entries(snapshotCursors || {})) {
      if (subscribed.has(topic) && this._realtimeReplayTopics?.has(topic)) continue;
      const numericSeq = Number(seq) || 0;
      if (numericSeq > Number(this._realtimeCursors[topic] || 0)) {
        this._realtimeCursors[topic] = numericSeq;
      }
    }
  },

  _applyRealtimeSnapshot(snapshot, options) {
    // 训练生命周期状态不在这里拼装：轮询（_applyManagedTrainingState）是唯一
    // 写入方。这里只回填各领域快照（监控详情/打标/环境）。
    if (!options || options.applyMonitor !== false) {
      this.applyRealtimeMonitorSnapshot(snapshot);
    }
    this.applyRealtimeTaggerSnapshot(snapshot);
    this.applyRealtimeRegularizationSnapshot(snapshot);
    this.applyRealtimeEnvironmentSnapshot(snapshot);
  },

  _dispatchRealtimeEvent(event) {
    this.handleRealtimeMonitorEvent(event);
    this.handleRealtimeTaggerEvent(event);
    this.handleRealtimeRegularizationEvent(event);
    this.handleRealtimeEnvironmentEvent(event);
  },

  _handleRealtimeServerRestart() {
    this._realtimeCursors = {};
    this._realtimeReplayTopics = null;
    let hadLiveTask = false;
    hadLiveTask = this.resetRealtimeMonitorState() || hadLiveTask;
    hadLiveTask = this.resetRealtimeTrainingState() || hadLiveTask;
    hadLiveTask = this.resetRealtimeTaggerState() || hadLiveTask;
    hadLiveTask = this.resetRealtimeEnvironmentState() || hadLiveTask;
    this.resetRealtimeRegularizationState();
    this.realtimeTaskStateUnknown = hadLiveTask;
    this.toast(
      hadLiveTask
        ? this.t('monitor.taskStateUnknown')
        : this.t('common.backendRestarted'),
      'warning',
    );
  },

  _checkRealtimeFreshness() {
    if (!this.realtimeReady) return;
    const now = Date.now();
    if (now < (this._realtimeWakeGraceUntil || 0)) return;
    const age = now - this._realtimeLastMessageAt;
    if (age > this._realtimeTiming().degradedAgeMs) {
      const changed = this.realtimeState !== 'degraded' && this.realtimeState !== 'offline';
      this._setRealtimeState('degraded');
      if (changed) this._wakeTrainingStatePoll();
    } else {
      this._setRealtimeState('online');
    }
  },

  async _probeRealtimeHealth() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._realtimeTiming().healthTimeoutMs);
    try {
      const healthUrl = window.animaUrl('/api/health');
      const response = await fetch(healthUrl, { cache: 'no-store', signal: controller.signal });
      if (response.status === 401) {
        this._handleRealtimeAuthRequired();
        return false;
      }
      return response.ok;
    } catch (_) {
      return false;
    } finally { clearTimeout(timeout); }
  },

  _ensureRealtimeHealthProbe() {
    if (this._realtimeAuthBlocked || this._realtimeHealthTimer) return;
    const probe = async () => {
      if (this._realtimeAuthBlocked) return;
      this._recordRealtimeHttpResult(await this._probeRealtimeHealth());
    };
    void probe();
    this._realtimeHealthTimer = setInterval(probe, this._realtimeTiming().healthIntervalMs);
  },

  _recordRealtimeHttpResult(reachable) {
    if (this._realtimeAuthBlocked) return;
    if (reachable) this._realtimeHealthFailures = 0;
    else if (this._realtimeSocketClosed && ++this._realtimeHealthFailures >= 2) this._setRealtimeState('offline');
  },

  _setRealtimeState(state) {
    // ``offline`` is terminal until the full WebSocket handshake and compact
    // snapshot succeed. Reconnect probes and health checks otherwise caused
    // an offline -> delayed -> offline loop and duplicate disconnect toasts.
    if (this.realtimeState === state || (this.realtimeState === 'offline' && state !== 'online')) return;
    const wasOffline = this.realtimeState === 'offline';
    this.realtimeState = state;
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
    if (state === 'online') {
      this.backendConnected = true;
      this.backendDisconnectedAt = null;
      this.backendDisconnectedDuration = '';
      if (this._disconnectedTimer) { clearInterval(this._disconnectedTimer); this._disconnectedTimer = null; }
      if (this._realtimeHealthTimer) { clearInterval(this._realtimeHealthTimer); this._realtimeHealthTimer = null; }
      if (wasOffline) {
        window.AnimaUI?.dismissNotification('backend-disconnected');
        window.AnimaUI?.dismissNotification('backend-auth-required');
        this.toast(this.t('common.backendReconnectedToast'), 'success');
      }
      this.setPreviewMediaPaused(false);
      return;
    }
    if (state === 'degraded') {
      // Keep the previous confirmed-connectivity bit. Transient tunnel jitter
      // marks realtime degraded briefly; do not abort active preview thumbnail
      // fetches unless the backend actually transitions to offline.
      return;
    }
    if (state === 'offline') {
      this.setPreviewMediaPaused(true);
      if (this.backendConnected) {
        this.backendConnected = false;
        this.backendDisconnectedAt = Date.now();
        this._updateDisconnectedDuration();
        if (!this._disconnectedTimer) this._disconnectedTimer = setInterval(() => this._updateDisconnectedDuration(), 1000);
        this.toast(this.t('common.backendDisconnectedToast'), 'error', { key: 'backend-disconnected' });
      }
    }
  },

  _loadRealtimeState() {
    this._realtimeCursors = {};
    try { this.realtimeInstanceId = sessionStorage.getItem(this._realtimeInstanceStorageKey) || this.realtimeInstanceId || null; }
    catch (_) {}
  },

  _saveRealtimeInstanceId() {
    try {
      if (this.realtimeInstanceId) sessionStorage.setItem(this._realtimeInstanceStorageKey, this.realtimeInstanceId);
      else sessionStorage.removeItem(this._realtimeInstanceStorageKey);
    } catch (_) {}
  },
};
