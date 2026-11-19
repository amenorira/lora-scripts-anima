/* 打标任务启动、恢复、订阅及结果同步；由 tagger.js 装配。 */
window.taggerTasksMixin = {
  _taggerTaskStorageKey(mode = this.taggerSourceMode) {
    if (mode === 'api-single') return null;
    return mode === 'api-folder' ? 'anima-ai-tagger-task-id' : 'anima-tagger-task-id';
  },

  taggerTaskById(id) { return id ? this._taggerTasks[id] || null : null; },

  taggerTaskActive(id) { return ['created','running','cancelling'].includes(this.taggerTaskById(id)?.status); },

  taggerHasActiveTask() { return Object.keys(this._taggerTasks).some(id => this.taggerTaskActive(id)); },

  _pruneTaggerTasks() {
    const retained = new Set([this.taggerTaskId, ...Object.values(this._taggerModeStates).map(state => state?.taskId)]);
    for (const id of Object.keys(this._taggerTasks)) if (!retained.has(id)) delete this._taggerTasks[id];
  },

  _clearTaggerTask(mode = this.taggerSourceMode) {
    const state = mode === this.taggerSourceMode ? null : this._taggerModeStates[mode];
    const id = mode === this.taggerSourceMode ? this.taggerTaskId : state?.taskId;
    if (mode === this.taggerSourceMode) this.taggerTaskId = null;
    else if (state) state.taskId = null;
    const key = this._taggerTaskStorageKey(mode);
    if (key && id && localStorage.getItem(key) === id) localStorage.removeItem(key);
    if (this._taggerRealtimeTopic === 'task:' + id) this._setTaggerRealtimeTask(null);
    this._pruneTaggerTasks();
  },

  taggerCanStart() {
    return !!(this.taggerSource && this.taggerSource.total && this.taggerSelectedModel
      && !this.taggerHasActiveTask() && !this.taggerStarting && !this.captionPreviewBusy && !this.trainingActive && !this.regularizationActive);
  },

  taggerStartLabel() {
    if (this.taggerStarting) return this.t('common.starting');
    return this.t('tagger.start');
  },

  async startTagger() {
    if (!this.taggerCanStart()) return;
    const mode = this.taggerSourceMode;

    this.taggerStarting = true;
    this.saveTaggerSettings();
    try {
      const categoryKeys = this.taggerCategoryKeys();
      const categoryEnabled = this.taggerEffectiveCategoryEnabled();
      const categoryOptionEnabled = key => categoryKeys.includes(key) && categoryEnabled[key] !== false;
      const payload = {
        source_token: this.taggerSource.source_token,
        model_id: this.taggerSelectedModel,
        conflict: this.taggerSettings.conflict,
        write_captions: this.taggerSourceMode === 'folder',
        options: {
          precision: this.taggerSettings.precision,
          threshold: Number(this.taggerSettings.threshold),
          character_threshold: Number(this.taggerSettings.characterThreshold),
          category_thresholds: this.taggerEffectiveCategoryThresholds(),
          category_enabled: this.taggerEffectiveCategoryEnabled(),
          replace_underscore: this.taggerSettings.replaceUnderscore,
          escape_tag: this.taggerSettings.escapeTag,
          add_rating_tag: categoryKeys.includes('rating')
            ? categoryOptionEnabled('rating')
            : this.taggerSourceMode === 'folder' && this.taggerSettings.addRatingTag,
          add_model_tag: this.taggerSupportsModelTag() && (
            this.taggerSourceMode === 'folder'
              ? this.taggerSettings.addModelTag
              : this.taggerCategoryEnabled('model')
          ),
          unload_model_after: this.taggerSettings.unloadModel === true,
          remove_duplicated: this.taggerSettings.removeDuplicated,
          additional_tags: this.taggerSourceMode === 'folder' ? this.taggerSettings.additionalTags : '',
          exclude_tags: this.taggerSourceMode === 'folder' ? this.taggerSettings.excludeTags : '',
        },
      };
      const response = await fetch('/api/tagger/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || this.t('tagger.startFailed'));
      this._clearTaggerResultState(mode);
      this.attachTaggerTask(body.data.task_id, mode);
    } catch (error) { this.toast(error.message, 'error'); }
    finally { this.taggerStarting = false; }
  },

  attachTaggerTask(taskId, mode = this.taggerSourceMode) {
    if (mode === this.taggerSourceMode) this.taggerTaskId = taskId;
    else (this._taggerModeStates[mode] ||= {}).taskId = taskId;
    this._taggerTasks[taskId] = {status:'created',engine:mode.startsWith('api-') ? 'api' : this.taggerModel()?.engine,
      _mode:mode};
    localStorage.setItem(this._taggerTaskStorageKey(mode), taskId);
    this._pruneTaggerTasks();
    this._setTaggerRealtimeTask(taskId);
  },

  _taggerSameServer(instanceId, data) {
    const current = this.realtimeInstanceId, responseId = data?.server_instance_id;
    return (!responseId || !current || responseId === current)
      && (instanceId === current || (!instanceId && responseId === current));
  },

  _rememberTaggerServer(data) {
    if (!this.realtimeInstanceId && data?.server_instance_id) {
      this.realtimeInstanceId = data.server_instance_id;
      this._saveRealtimeInstanceId();
      if (this.currentRoute === 'monitor-dashboard' && (this.liveTaskId || !this.currentOutputRunDir)) void this.refreshMonitorRealtimeDetail();
    }
  },

  async restoreTaggerTask(taskId) {
    const route = this.currentRoute;
    const mode = this.taggerSourceMode, version = this._taggerFormVersion;
    const source = this.taggerSource, path = this.taggerSourcePath, currentTaskId = this.taggerTaskId;
    const scanVersion = this._taggerSourceScanVersion, instanceId = this.realtimeInstanceId;
    const key = route === 'ai-captioning' ? 'anima-ai-tagger-task-id' : 'anima-tagger-task-id';
    const stored = localStorage.getItem(key);
    const isCurrent = () => route === this.currentRoute && mode === this.taggerSourceMode
      && version === this._taggerFormVersion && scanVersion === this._taggerSourceScanVersion
      && source === this.taggerSource && path === this.taggerSourcePath && currentTaskId === this.taggerTaskId
      && stored === localStorage.getItem(key);
    try {
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/status`);
      const body = await response.json();
      if (!isCurrent() || !this._taggerSameServer(instanceId, body.data)) return false;
      if (body.status !== 'success') {
        if (localStorage.getItem(key) === taskId) localStorage.removeItem(key);
        return false;
      }
      if ((body.data.engine === 'api') !== (this.currentRoute === 'ai-captioning')) return false;
      this._rememberTaggerServer(body.data);
      this.applyTaggerTaskSnapshot(body.data, '', taskId, false);
      const mode = this.taggerTaskById(taskId)._mode;
      localStorage.setItem(this._taggerTaskStorageKey(mode), taskId);
      if (body.data.engine === 'api' && this.taggerTaskActive(taskId)) {
        if (body.data.caption_options) {
          this.restoreCaptionTaskOptions(body.data.caption_options);
        }
      }
      if (this.taggerTaskActive(taskId)) this._setTaggerRealtimeTask(taskId);
      if (body.data.engine !== 'api' && mode === this.taggerSourceMode) await this.refreshTaggerItems(true);
      return true;
    } catch (_) { return false; }
  },

  _setTaggerRealtimeTask(taskId) {
    const next = taskId ? 'task:' + taskId : null;
    if (next === this._taggerRealtimeTopic) return;
    if (this._taggerRealtimeTopic) this.realtimeUnsubscribe(this._taggerRealtimeTopic);
    this._taggerRealtimeTopic = next;
    if (next) this.realtimeSubscribe(next);
  },

  handleRealtimeTaggerEvent(event) {
    if (!event) return;
    if (event.type === 'hardware.sample' && event.payload) return;
    if (!this._taggerRealtimeTopic || event.topic !== this._taggerRealtimeTopic) return;
    if (!['task.status', 'task.progress', 'task.result'].includes(event.type)) return;
    const envelope = event.payload || {};
    this.applyTaggerTaskSnapshot(envelope.data || {}, envelope.status || '', envelope.task_id || event.topic.slice(5));
  },

  applyRealtimeTaggerSnapshot(snapshot) {
    const ids = new Set([this.taggerTaskId, ...Object.values(this._taggerModeStates).map(state => state?.taskId)]);
    for (const task of snapshot?.tasks?.tracked || []) {
      if (ids.has(task.task_id)) this.applyTaggerTaskSnapshot(task.data || {}, task.status || '', task.task_id);
    }
  },

  resetRealtimeTaggerState() {
    const active = this.taggerHasActiveTask();
    this._setTaggerRealtimeTask(null);
    this._taggerTasks = {};
    this.taggerTaskId = null;
    this.taggerSource = null;
    this.taggerItems = [];
    this.taggerResultText = '';
    this.taggerResultCategories = {};
    this.taggerCategoryState = {};
    for (const state of Object.values(this._taggerModeStates)) {
      if (!state) continue;
      this._clearStoredTaggerResult(state);
      state.source = null;
      state.items = [];
    }
    localStorage.removeItem('anima-ai-tagger-task-id');
    localStorage.removeItem('anima-tagger-task-id');
    this.captionExternalTaggerBusy = false;
    this._invalidateCaptionRescan?.();
    this.captionSourceChanged?.('api-folder');
    return active;
  },

  applyTaggerTaskSnapshot(data, normalizedStatus, taskId = this.taggerTaskId, refreshItems = true) {
    if (!taskId) return;
    const previous = this.taggerTaskById(taskId);
    // The registry's initial CREATED frame contains no snapshot. It cannot
    // replace a snapshot already restored by HTTP or a reconnect bootstrap.
    if (!Object.keys(data).length && previous?.status && previous.status !== 'created') return;
    const order = data.snapshot_revision != null && previous?.snapshot_revision != null ? 'snapshot_revision' : 'updated_at';
    if (data[order] < previous?.[order]) return;
    const status = data.status || {CREATED:'created',RUNNING:'running',FINISHED:'done',FAILED:'error',TERMINATED:'cancelled'}[normalizedStatus] || previous?.status;
    data = {...previous,...data,status};
    const mode = data.engine === 'api' ? 'api-folder' : data.source_kind ? (data.source_kind === 'folder' ? 'folder' : 'single') : previous?._mode || this.taggerSourceMode;
    data._mode = mode;
    this._taggerTasks[taskId] = data;
    const current = mode === this.taggerSourceMode;
    const state = current ? null : (this._taggerModeStates[mode] ||= {});
    if (current) this.taggerTaskId = taskId;
    else state.taskId = taskId;
    let source = current ? this.taggerSource : state.source;
    const sourceToken = data.engine === 'api' ? data.overview_source_token || data.source_token : data.source_token;
    if (sourceToken && (!source || source.source_token !== sourceToken)) {
      source = {source_token:sourceToken,kind:data.source_kind,total:data.total,path:data.source_root || ''};
    }
    if (source && data.source_root) source.path = data.source_root;
    if (current) {
      this.taggerSource = source || null;
      if (data.source_root) this.taggerSourcePath = data.source_root;
    } else {
      state.source = source;
      if (data.source_root) state.sourcePath = data.source_root;
    }
    const terminal = ['done','error','cancelled'].includes(status);
    if (current && data.engine !== 'api' && data.current_result && data.current_result.index === this.taggerSelectedIndex) {
      this.setTaggerResult(data.current_result, false);
    }
    const failedItems = this._taggerItemsError?.taskId === taskId;
    const itemsChanged = data.items_version !== previous?.items_version || (terminal && previous?.status !== status) || failedItems;
    if (refreshItems && current && this.currentRoute === 'tagger' && data.engine !== 'api' && itemsChanged) {
      clearTimeout(this._taggerItemsRefreshTimer);
      const delay = terminal ? 0 : Math.max(0, 800 - (Date.now() - this._taggerLastItemsFetch));
      const reset = failedItems && this._taggerItemsError.reset;
      if (delay) {
        this._taggerItemsRefreshTimer = setTimeout(() => {
          this._taggerItemsRefreshTimer = null;
          if (this.currentRoute === 'tagger' && this.taggerTaskId === taskId && this.taggerSourceMode === mode) void this.refreshTaggerItems(reset);
        }, delay);
      } else void this.refreshTaggerItems(reset);
    }
    if (terminal) {
      if (this._taggerRealtimeTopic === 'task:' + taskId) this._setTaggerRealtimeTask(null);
      if (status === 'done' && previous?.status !== status) this.toast(this.t('tagger.completed'));
    }
    if (data.engine === 'api') this.captionTaskUpdated?.(data, previous, terminal);
    this._pruneTaggerTasks();
  },

  async refreshTaggerItems(reset) {
    if (!this.taggerTaskId) return;
    clearTimeout(this._taggerItemsRefreshTimer);
    this._taggerItemsRefreshTimer = null;
    this._taggerLastItemsFetch = Date.now();
    const taskId = this.taggerTaskId;
    const sourceMode = this.taggerSourceMode;
    const request = this._taggerItemsRequest = (this._taggerItemsRequest || 0) + 1;
    try {
      const offset = reset ? 0 : Math.max(0, Number(this.taggerTask?.current || 0) - 80);
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/items?offset=${offset}&limit=160`);
      const body = await response.json();
      if (taskId !== this.taggerTaskId || sourceMode !== this.taggerSourceMode || request !== this._taggerItemsRequest) return;
      if (!response.ok || body.status !== 'success') throw new Error('tagger items unavailable');
      this._mergeTaggerItems(body.data.items || [], reset);
      if (reset && this.taggerItems.length) this.selectTaggerItem(this.taggerItems[0]);
      else {
        const selected = this.taggerItems.find(item => item.index === this.taggerSelectedIndex);
        if (selected?.result) this.setTaggerResult(selected.result);
      }
      if (this._taggerItemsError?.taskId === taskId) this._taggerItemsError = null;
    } catch (_) {
      if (taskId === this.taggerTaskId && sourceMode === this.taggerSourceMode && request === this._taggerItemsRequest) {
        const previous = this._taggerItemsError;
        this._taggerItemsError = { taskId, reset: !!reset || (previous?.taskId === taskId && previous.reset) };
      }
    }
  },

  _mergeTaggerItems(items, replace) {
    if (replace) {
      this.taggerItems = items;
      return;
    }
    const merged = new Map(this.taggerItems.map(item => [item.index, item]));
    items.forEach(item => merged.set(item.index, item));
    this.taggerItems = Array.from(merged.values()).sort((left, right) => left.index - right.index);
  },

  async cancelTagger() {
    if (!this.taggerTaskId) return;
    try { await fetch(`/api/tagger/tasks/${encodeURIComponent(this.taggerTaskId)}/cancel`, { method: 'POST' }); }
    catch (_) {}
  },

  async retryFailedTagger() {
    if (!this.taggerTaskId || !this.taggerTask?.failed || this.taggerStarting || this.taggerHasActiveTask()) return;
    const taskId = this.taggerTaskId, mode = this.taggerSourceMode;
    const source = this.taggerSource, version = this._taggerFormVersion;
    const route = this.currentRoute, path = this.taggerSourcePath, scanVersion = this._taggerSourceScanVersion;
    const instanceId = this.realtimeInstanceId, storageKey = this._taggerTaskStorageKey(mode);
    const isCurrent = () => taskId === this.taggerTaskId && mode === this.taggerSourceMode
      && source === this.taggerSource && path === this.taggerSourcePath && route === this.currentRoute
      && version === this._taggerFormVersion && scanVersion === this._taggerSourceScanVersion;
    this.taggerStarting = true;
    let responseData;
    try {
      const stored = storageKey ? localStorage.getItem(storageKey) : null;
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' });
      const body = await response.json();
      responseData = body.data;
      const sameServer = this._taggerSameServer(instanceId, responseData);
      if (storageKey && localStorage.getItem(storageKey) !== stored) return;
      // Navigation may outlive the retry itself. Preserve its recovery identity
      // without replacing a newer task, an explicitly cleared source, or a new server instance.
      let keptRecovery = false;
      if (body.status === 'success' && body.data?.task_id && sameServer
          && storageKey && stored === taskId) {
        this._rememberTaggerServer(body.data);
        localStorage.setItem(storageKey, body.data.task_id);
        keptRecovery = true;
      }
      if (!isCurrent() || !sameServer) {
        // Returning to the same source can restore the old failed task before
        // this POST finishes. Reconcile the new task against that current mount.
        if (keptRecovery && route === this.currentRoute && mode === this.taggerSourceMode
            && taskId === this.taggerTaskId && path === this.taggerSourcePath
            && source?.source_token === this.taggerSource?.source_token) {
          await this.restoreTaggerTask(body.data.task_id);
        }
        return;
      }
      if (body.status !== 'success' || !body.data?.task_id) throw new Error(body.message || this.t('tagger.retryRequestFailed'));
      this._rememberTaggerServer(body.data);
      this.attachTaggerTask(body.data.task_id, mode);
    } catch (error) { if (isCurrent() && this._taggerSameServer(instanceId, responseData)) this.toast(error.message, 'error'); }
    finally { this.taggerStarting = false; }
  },

  taggerProgressPercent() {
    if (!this.taggerTask || !this.taggerTask.total) return 0;
    return Math.min(100, Math.round(Number(this.taggerTask.current || 0) * 100 / Number(this.taggerTask.total)));
  },

  taggerTaskProgressText() {
    if (!this.taggerTask) return '';
    return `${this.taggerTask.current || 0} / ${this.taggerTask.total || this.taggerSource?.total || 0}`;
  },

  formatTaggerEta(seconds) {
    if (seconds == null) return '--';
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    return minutes
      ? this.t('tagger.etaMinutesSeconds').replace('{minutes}', minutes).replace('{seconds}', Math.round(value % 60))
      : this.t('tagger.etaSeconds').replace('{seconds}', Math.round(value));
  },

  taggerPhaseLabel() {
    const phase = this.taggerTask?.phase || (this.taggerScanning ? 'scanning' : this.taggerRunning ? 'created' : 'ready');
    return this.t('tagger.phase.' + phase, phase.replace(/_/g, ' '));
  },

  taggerVisibleLogs() {
    const logs = Array.isArray(this.taggerTask?.logs) ? this.taggerTask.logs : [];
    return logs.slice(this.taggerLogsOpen ? 0 : -32).map(line => typeof line === 'string' ? {
      time: line.match(/^\[([^\]]+)\]\s*/)?.[1] || '--:--:--', level: 'info',
      message: line.replace(/^\[[^\]]+\]\s*/, ''),
    } : line);
  },

  taggerWorkspaceLog() {
    return {
      key: this.taggerTaskId,
      title: this.t('tagger.logTitle'),
      phase: this.taggerPhaseLabel(),
      running: this.taggerRunning,
      open: this.taggerLogsOpen,
      lines: this.taggerTask?.logs,
      hasLogs: !!this.taggerTask?.logs?.length,
      error: this.taggerTask?.error_detail,
      empty: this.t('tagger.logsEmpty'),
      entries: () => this.taggerVisibleLogs().map((line, index) => ({
        ...line, key: index, message: this.taggerLogMessage(line),
      })),
    };
  },

  taggerLogMessage(line) {
    if (this.taggerTask?.engine === 'api' && ['done','cancelled'].includes(line.event)) {
      return this.t('caption.taskSummary').replace(/\{(\w+)\}/g,(_,key) => line[key] ?? '');
    }
    return line.message ?? this.t('tagger.log.' + line.event, line.event)
      .replace(/\{(\w+)\}/g, (_, key) => line[key] ?? '');
  },
};
