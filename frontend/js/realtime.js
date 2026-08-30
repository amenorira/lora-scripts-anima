/* ================================================================
   realtime.js — Same-origin WebSocket connection, resume and freshness
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.realtimeMixin = {
  realtimeSocket: null,
  realtimeState: 'connecting', // connecting | online | degraded | offline
  realtimeReady: false,
  realtimeInstanceId: null,
  realtimeSnapshot: null,
  realtimeTaskStateUnknown: false,
  _realtimeTopics: null,
  _realtimeCursors: null,
  _realtimeLastMessageAt: 0,
  _realtimeReconnectTimer: null,
  _realtimeConnectTimer: null,
  _realtimeFreshnessTimer: null,
  _realtimePingTimer: null,
  _realtimeHealthTimer: null,
  _realtimeSnapshotRetryTimer: null,
  _realtimeReconnectDelay: 500,
  _realtimeSnapshotRetryDelay: 500,
  _realtimeHealthFailures: 0,
  _realtimeSocketClosed: false,
  _realtimeStopped: false,
  _realtimeVisibilityHandler: null,
  _realtimeInboundChain: null,
  _realtimeSnapshotPromise: null,
  _startReconcilePending: false,
  _realtimeSnapshotAbort: null,
  _realtimeCursorsStorageKey: 'anima-realtime-cursors',
  _realtimeInstanceStorageKey: 'anima-realtime-instance-id',

  startRealtime() {
    this._realtimeStopped = false;
    if (!this._realtimeTopics) this._realtimeTopics = new Set(['server']);
    if (!this._realtimeCursors) this._loadRealtimeState();
    if (!this._realtimeFreshnessTimer) {
      this._realtimeFreshnessTimer = setInterval(() => this._checkRealtimeFreshness(), 500);
    }
    if (!this._realtimeVisibilityHandler) {
      this._realtimeVisibilityHandler = () => {
        if (!document.hidden && (!this.realtimeSocket || this.realtimeSocket.readyState > WebSocket.OPEN)) {
          this._connectRealtimeNow();
        }
      };
      document.addEventListener('visibilitychange', this._realtimeVisibilityHandler);
    }
    this._connectRealtimeNow();
  },

  _realtimeUrl() {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return scheme + '//' + window.location.host + '/ws/realtime';
  },

  _connectRealtimeNow() {
    if (this._realtimeStopped) return;
    if (this.realtimeSocket && (this.realtimeSocket.readyState === WebSocket.OPEN || this.realtimeSocket.readyState === WebSocket.CONNECTING)) return;
    if (this._realtimeReconnectTimer) { clearTimeout(this._realtimeReconnectTimer); this._realtimeReconnectTimer = null; }
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
    }, 4000);

    socket.onopen = () => {
      if (this._realtimeStopped || this.realtimeSocket !== socket) return;
      this._realtimeSocketClosed = false;
      this._realtimeHealthFailures = 0;
      this._sendRealtime({
        op: 'hello',
        protocol: 1,
        server_instance_id: this.realtimeInstanceId || null,
      });
    };
    socket.onmessage = (event) => {
      const previous = this._realtimeInboundChain || Promise.resolve();
      this._realtimeInboundChain = previous
        .then(() => this._handleRealtimeMessage(event, socket))
        .catch(() => { /* A malformed frame must not poison later frames. */ });
    };
    socket.onerror = () => { /* onclose owns state changes */ };
    socket.onclose = () => {
      // A superseded socket is allowed to close silently. It must never mark
      // the newer, healthy connection as delayed or schedule a second retry.
      if (this._realtimeStopped || this.realtimeSocket !== socket) return;
      this.realtimeSocket = null;
      if (this._realtimeConnectTimer) { clearTimeout(this._realtimeConnectTimer); this._realtimeConnectTimer = null; }
      this._stopRealtimePing();
      this.realtimeReady = false;
      this._realtimeSocketClosed = true;
      this._setRealtimeState('degraded');
      this._ensureRealtimeHealthProbe();
      this._scheduleRealtimeReconnect();
    };
  },

  _scheduleRealtimeReconnect() {
    if (this._realtimeStopped || this._realtimeReconnectTimer) return;
    const delay = this._realtimeReconnectDelay;
    this._realtimeReconnectDelay = Math.min(5000, Math.max(500, delay * 2));
    this._realtimeReconnectTimer = setTimeout(() => {
      this._realtimeReconnectTimer = null;
      this._connectRealtimeNow();
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
      if (this._realtimeStopped || !this.realtimeReady) return;
      this._sendRealtime({ op: 'ping' });
    };
    ping();
    this._realtimePingTimer = setInterval(ping, 1000);
  },

  _stopRealtimePing() {
    if (this._realtimePingTimer) clearInterval(this._realtimePingTimer);
    this._realtimePingTimer = null;
  },

  realtimeSubscribe(topic) {
    if (!topic) return;
    if (!this._realtimeTopics) this._realtimeTopics = new Set(['server']);
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
    if (this.realtimeReady) this._sendRealtime({ op: 'unsubscribe', topics: [topic] });
  },

  _sendRealtimeSubscriptions() {
    const topics = Array.from(this._realtimeTopics || ['server']);
    const resume = {};
    for (const topic of topics) resume[topic] = (this._realtimeCursors || {})[topic] || 0;
    this._sendRealtime({ op: 'subscribe', topics, resume });
  },

  async _handleRealtimeMessage(messageEvent, socket) {
    if (this._realtimeStopped || (socket && this.realtimeSocket !== socket)) return;
    let message;
    try { message = JSON.parse(messageEvent.data); } catch (_) { return; }
    if (!message || typeof message !== 'object') return;
    this._realtimeLastMessageAt = Date.now();

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
      if (this.realtimeReady) this._setRealtimeState('online');
      return;
    }
    if (message.op === 'resync_required') {
      await this._handleRealtimeResync(message, socket);
      return;
    }
    if (message.op !== 'event') return;

    const topic = message.topic;
    const seq = Number(message.seq) || 0;
    if (topic && seq) {
      let last = Number((this._realtimeCursors || {})[topic] || 0);
      if (seq <= last) return;
      if (last && seq > last + 1) {
        await this._handleRealtimeResync({ op: 'resync_required', topics: [topic], reason: 'sequence_gap' }, socket);
        last = Number((this._realtimeCursors || {})[topic] || 0);
        if (seq <= last) return;
      }
      if (!this._realtimeCursors) this._realtimeCursors = {};
      this._realtimeCursors[topic] = seq;
      this._saveRealtimeCursors();
    }
    if (this.realtimeReady) this._setRealtimeState('online');
    this._dispatchRealtimeEvent(message);
  },

  async _handleRealtimeReady(message, socket) {
    if (this._realtimeStopped || this.realtimeSocket !== socket) return;
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
    const ok = await this._refreshRealtimeSnapshot(nextId, socket, { monitorDetail: false });
    if (this._realtimeStopped || this.realtimeSocket !== socket) return;
    if (!ok || this.realtimeInstanceId !== nextId) {
      this._setRealtimeState('degraded');
      this._ensureRealtimeHealthProbe();
      this._scheduleRealtimeSnapshotRetry(nextId);
      return;
    }
    this._finishRealtimeBootstrap(nextId, socket);
  },

  _finishRealtimeBootstrap(instanceId, socket) {
    if (this._realtimeStopped || (socket && this.realtimeSocket !== socket)) return;
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
    if (this.currentRoute === 'monitor-dashboard' && typeof this.refreshMonitorRealtimeDetail === 'function') {
      void this.refreshMonitorRealtimeDetail();
    }
  },

  _scheduleRealtimeSnapshotRetry(instanceId) {
    if (this._realtimeStopped || this._realtimeSnapshotRetryTimer) return;
    const delay = this._realtimeSnapshotRetryDelay;
    this._realtimeSnapshotRetryDelay = Math.min(5000, Math.max(500, delay * 2));
    this._realtimeSnapshotRetryTimer = setTimeout(async () => {
      this._realtimeSnapshotRetryTimer = null;
      if (!this.realtimeSocket || this.realtimeSocket.readyState !== WebSocket.OPEN || this.realtimeInstanceId !== instanceId) return;
      const socket = this.realtimeSocket;
      const ok = await this._refreshRealtimeSnapshot(instanceId, socket, { monitorDetail: false });
      if (ok) this._finishRealtimeBootstrap(instanceId, socket);
      else this._scheduleRealtimeSnapshotRetry(instanceId);
    }, delay);
  },

  async _handleRealtimeResync(message, socket) {
    if (this._realtimeStopped || (socket && this.realtimeSocket !== socket)) return;
    const announcedId = message && message.server_instance_id;
    if (announcedId && announcedId !== this.realtimeInstanceId) {
      this.realtimeInstanceId = announcedId;
      this._saveRealtimeInstanceId();
      this._handleRealtimeServerRestart();
    }
    const topics = Array.isArray(message && message.topics) ? message.topics : [];
    if (typeof this.handleRealtimeResyncRequired === 'function') {
      this.handleRealtimeResyncRequired(topics);
    }
    if (!this._realtimeCursors) this._realtimeCursors = {};
    if (topics.length) topics.forEach(topic => delete this._realtimeCursors[topic]);
    else this._realtimeCursors = {};
    this._saveRealtimeCursors();
    const ok = await this._refreshRealtimeSnapshot(this.realtimeInstanceId, socket, { monitorDetail: false });
    if (!ok && !this._realtimeStopped && (!socket || this.realtimeSocket === socket)) {
      this._setRealtimeState('degraded');
      this._ensureRealtimeHealthProbe();
    } else if (ok && this.currentRoute === 'monitor-dashboard' && typeof this.refreshMonitorRealtimeDetail === 'function') {
      void this.refreshMonitorRealtimeDetail();
    }
  },

  async _refreshRealtimeSnapshot(expectedInstanceId, expectedSocket, options) {
    if (this._realtimeSnapshotPromise) return this._realtimeSnapshotPromise;
    this._realtimeSnapshotPromise = (async () => {
      let timeout = null;
      try {
        const controller = new AbortController();
        this._realtimeSnapshotAbort = controller;
        timeout = setTimeout(() => controller.abort(), 4000);
        const explicitDetail = options && Object.prototype.hasOwnProperty.call(options, 'monitorDetail')
          ? !!options.monitorDetail
          : this.currentRoute === 'monitor-dashboard' && !this.selectedRunDir;
        const query = new URLSearchParams();
        if (explicitDetail) {
          query.set('detail');
          // Zero explicitly requests every compact preview metadata entry.
          // Weak-network mode controls image loading, not list visibility.
          query.set('preview_limit', String(0));
        }
        const url = '/api/realtime/snapshot' + (query.size ? '?' + query.toString() : '');
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        clearTimeout(timeout);
        timeout = null;
        if (!response.ok) return false;
        const body = await response.json();
        if (body.status !== 'success' || !body.data) return false;
        const snapshot = body.data;
        if (this._realtimeStopped || (expectedSocket && this.realtimeSocket !== expectedSocket)) return false;
        if (expectedInstanceId && snapshot.server_instance_id !== expectedInstanceId) return false;
        const previousId = this.realtimeInstanceId;
        const nextId = snapshot.server_instance_id;
        if (nextId && previousId && nextId !== previousId) {
          this.realtimeInstanceId = nextId;
          this._saveRealtimeInstanceId();
          this._handleRealtimeServerRestart();
        }
        this.realtimeSnapshot = snapshot;
        this.realtimeInstanceId = nextId || this.realtimeInstanceId;
        this._saveRealtimeInstanceId();
        this._applyRealtimeSnapshotCursors(snapshot.cursors || {}, options);
        this._saveRealtimeCursors();
        // A dashboard-only detail request may finish after the user leaves
        // that page. Keep the current transport snapshot/cursors, but never
        // let that stale detail overwrite live monitor state off-page.
        const monitorDetailGeneration = explicitDetail
          ? (options && Object.prototype.hasOwnProperty.call(options, 'monitorDetailGeneration')
            ? options.monitorDetailGeneration
            : this._monitorRealtimeDetailGeneration)
          : null;
        const applyMonitor = !explicitDetail || (
          this.currentRoute === 'monitor-dashboard'
          && (monitorDetailGeneration == null
            || monitorDetailGeneration === this._monitorRealtimeDetailGeneration)
        );
        this._applyRealtimeSnapshot(snapshot, { applyMonitor });
        return true;
      } catch (_) {
        return false;
      } finally {
        if (timeout) clearTimeout(timeout);
        this._realtimeSnapshotAbort = null;
        this._realtimeSnapshotPromise = null;
      }
    })();
    return this._realtimeSnapshotPromise;
  },

  async refreshRealtimeAfterTaskStart() {
    // Do not let an older in-flight bootstrap snapshot satisfy this refresh:
    // wait for it, then fetch the post-create task state explicitly.
    // preserveSubscribedCursors: that waited snapshot may predate the new
    // task, so it must not advance subscribed-topic cursors — otherwise the
    // queued server.tasks frame carrying the new task gets dropped as
    // "already seen" and the UI stays stuck on a stale idle/terminated state.
    try {
      if (this._realtimeSnapshotPromise) await this._realtimeSnapshotPromise;
      return await this._refreshRealtimeSnapshot(null, null, { monitorDetail: false, preserveSubscribedCursors: true });
    } finally {
      this._startReconcilePending = false;
    }
  },

  _applyRealtimeSnapshotCursors(snapshotCursors, options) {
    if (!this._realtimeCursors) this._realtimeCursors = {};
    const preserveSubscribed = !!(options && options.preserveSubscribedCursors);
    const subscribed = this._realtimeTopics || new Set();
    for (const [topic, seq] of Object.entries(snapshotCursors || {})) {
      // A dashboard detail snapshot is fetched while task replay is already
      // queued on the WebSocket. Advancing that subscribed topic here would
      // make the inbound handler discard the queued gap as `seq <= last`.
      // Let WebSocket events advance live cursors; the snapshot may still seed
      // topics that are not currently subscribed.
      if (preserveSubscribed && subscribed.has(topic)) continue;
      const numericSeq = Number(seq) || 0;
      if (numericSeq > Number(this._realtimeCursors[topic] || 0)) {
        this._realtimeCursors[topic] = numericSeq;
      }
    }
  },

  _applyRealtimeSnapshot(snapshot, options) {
    // A snapshot fetched before the new task was registered can land after
    // _acceptTrainingStart already painted the shared state (the
    // terminate → start race). Until the post-start refresh settles, a
    // snapshot showing no active task must not clobber that optimistic
    // state — the follow-up snapshot or a queued server.tasks event
    // carries the authoritative verdict.
    const managed = snapshot && snapshot.tasks && snapshot.tasks.managed || [];
    const snapshotHasActive = managed.some(task => task && ['CREATED', 'RUNNING'].includes(task.status));
    if (this._startReconcilePending && !snapshotHasActive) return;
    const server = snapshot.server || {};
    this.trainingActive = !!server.training_active;
    if ((!options || options.applyMonitor !== false) && typeof this.applyRealtimeMonitorSnapshot === 'function') {
      this.applyRealtimeMonitorSnapshot(snapshot);
    }
    if (typeof this.applyRealtimeTrainingSnapshot === 'function') this.applyRealtimeTrainingSnapshot(snapshot);
    if (typeof this.applyRealtimeTaggerSnapshot === 'function') this.applyRealtimeTaggerSnapshot(snapshot);
    if (typeof this.applyRealtimeEnvironmentSnapshot === 'function') this.applyRealtimeEnvironmentSnapshot(snapshot);
  },

  _dispatchRealtimeEvent(event) {
    if (event.type === 'server.tasks' && event.payload) {
      this.trainingActive = !!event.payload.training_active;
    }
    if (typeof this.handleRealtimeMonitorEvent === 'function') this.handleRealtimeMonitorEvent(event);
    if (typeof this.handleRealtimeTrainingEvent === 'function') this.handleRealtimeTrainingEvent(event);
    if (typeof this.handleRealtimeTaggerEvent === 'function') this.handleRealtimeTaggerEvent(event);
    if (typeof this.handleRealtimeEnvironmentEvent === 'function') this.handleRealtimeEnvironmentEvent(event);
  },

  _handleRealtimeServerRestart() {
    // An old detailed snapshot is just as stale as its incremental cursors.
    // Clear it before the fresh instance bootstrap so another page cannot
    // reuse old task/log/curve/hardware state during the transition.
    this.realtimeSnapshot = null;
    this._realtimeCursors = {};
    this._saveRealtimeCursors();
    let hadLiveTask = false;
    if (typeof this.resetRealtimeMonitorState === 'function') hadLiveTask = !!this.resetRealtimeMonitorState() || hadLiveTask;
    if (typeof this.resetRealtimeTrainingState === 'function') hadLiveTask = !!this.resetRealtimeTrainingState() || hadLiveTask;
    if (typeof this.resetRealtimeTaggerState === 'function') hadLiveTask = !!this.resetRealtimeTaggerState() || hadLiveTask;
    if (typeof this.resetRealtimeEnvironmentState === 'function') hadLiveTask = !!this.resetRealtimeEnvironmentState() || hadLiveTask;
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
    const age = Date.now() - this._realtimeLastMessageAt;
    if (age > 2000) {
      this._setRealtimeState('degraded');
      this._ensureRealtimeHealthProbe();
    } else {
      this._setRealtimeState('online');
    }
  },

  _ensureRealtimeHealthProbe() {
    if (this._realtimeStopped || this._realtimeHealthTimer) return;
    const probe = () => this._probeRealtimeHealth();
    probe();
    this._realtimeHealthTimer = setInterval(probe, 2000);
  },

  async _probeRealtimeHealth() {
    if (this._realtimeStopped) return;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const response = await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) throw new Error('health failed');
      const data = await response.json();
      this._realtimeHealthFailures = 0;
      this.trainingActive = !!data.training_active;
      // A healthy HTTP response does not make an absent realtime session green.
      if (this._realtimeSocketClosed) this._setRealtimeState('degraded');
    } catch (_) {
      this._realtimeHealthFailures++;
      if (this._realtimeSocketClosed && this._realtimeHealthFailures >= 2) this._setRealtimeState('offline');
    }
  },

  _setRealtimeState(state) {
    // ``offline`` is terminal until the full WebSocket handshake and compact
    // snapshot succeed. Reconnect probes and health checks otherwise caused
    // an offline -> delayed -> offline loop and duplicate disconnect toasts.
    if (this.realtimeState === 'offline' && state !== 'online') return;
    const wasOffline = this.realtimeState === 'offline';
    this.realtimeState = state;
    if (state === 'online') {
      this.backendConnected = true;
      this.backendDisconnectedAt = null;
      this.backendDisconnectedDuration = '';
      if (this._disconnectedTimer) { clearInterval(this._disconnectedTimer); this._disconnectedTimer = null; }
      if (this._realtimeHealthTimer) { clearInterval(this._realtimeHealthTimer); this._realtimeHealthTimer = null; }
      if (wasOffline) this.toast(this.t('common.backendReconnectedToast'), 'success');
      if (typeof this.setPreviewMediaPaused === 'function') this.setPreviewMediaPaused(false);
      return;
    }
    if (state === 'degraded') {
      // Keep the previous confirmed-connectivity bit. A failed reconnect
      // emits degraded while there is no working backend; setting this true
      // here made every retry generate another offline notification.
      if (typeof this.setPreviewMediaPaused === 'function') this.setPreviewMediaPaused(true);
      return;
    }
    if (state === 'offline') {
      if (typeof this.setPreviewMediaPaused === 'function') this.setPreviewMediaPaused(true);
      if (this.backendConnected) {
        this.backendConnected = false;
        this.backendDisconnectedAt = Date.now();
        if (typeof this._updateDisconnectedDuration === 'function') this._updateDisconnectedDuration();
        if (!this._disconnectedTimer) this._disconnectedTimer = setInterval(() => this._updateDisconnectedDuration(), 1000);
        this.toast(this.t('common.backendDisconnectedToast'), 'error');
      }
    }
  },

  _loadRealtimeState() {
    try { this._realtimeCursors = JSON.parse(sessionStorage.getItem(this._realtimeCursorsStorageKey) || '{}') || {}; }
    catch (_) { this._realtimeCursors = {}; }
    try { this.realtimeInstanceId = sessionStorage.getItem(this._realtimeInstanceStorageKey) || this.realtimeInstanceId || null; }
    catch (_) {}
  },

  _saveRealtimeCursors() {
    try { sessionStorage.setItem(this._realtimeCursorsStorageKey, JSON.stringify(this._realtimeCursors || {})); } catch (_) {}
  },

  _saveRealtimeInstanceId() {
    try {
      if (this.realtimeInstanceId) sessionStorage.setItem(this._realtimeInstanceStorageKey, this.realtimeInstanceId);
      else sessionStorage.removeItem(this._realtimeInstanceStorageKey);
    } catch (_) {}
  },
};
