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

    this._clearTaggerResultState(true);
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

  async restoreTaggerTask(taskId) {
    const route = this.currentRoute;
    try {
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/status`);
      const body = await response.json();
      if (this.currentRoute !== route) return false;
      if (body.status !== 'success') {
        const key = route === 'ai-captioning' ? 'anima-ai-tagger-task-id' : 'anima-tagger-task-id';
        if (localStorage.getItem(key) === taskId) localStorage.removeItem(key);
        return false;
      }
      if ((body.data.engine === 'api') !== (this.currentRoute === 'ai-captioning')) return false;
      this.applyTaggerTaskSnapshot(body.data, '', taskId);
      const mode = this.taggerTaskById(taskId)._mode;
      localStorage.setItem(this._taggerTaskStorageKey(mode), taskId);
      if (body.data.engine === 'api' && this.taggerTaskActive(taskId)) {
        if (body.data.caption_options) {
          const {dry_run, ...settings} = body.data.caption_options;
          this.captionOptions = Object.assign({}, this.captionOptions, settings);
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
    this.taggerItemsTotal = 0;
    this.taggerResultText = '';
    this.taggerResultCategories = {};
    this.taggerCategoryState = {};
    for (const state of Object.values(this._taggerModeStates)) {
      if (!state) continue;
      this._clearStoredTaggerResult(state);
      state.source = null;
      state.items = [];
      state.itemsTotal = 0;
    }
    localStorage.removeItem('anima-ai-tagger-task-id');
    localStorage.removeItem('anima-tagger-task-id');
    this.captionExternalTaggerBusy = false;
    this.captionSourceChanged?.('api-folder');
    return active;
  },

  applyTaggerTaskSnapshot(data, normalizedStatus, taskId = this.taggerTaskId) {
    if (!taskId) return;
    const previous = this.taggerTaskById(taskId);
    // The registry's initial CREATED frame contains no snapshot. It cannot
    // replace a snapshot already restored by HTTP or a reconnect bootstrap.
    if (!Object.keys(data).length && previous?.status && previous.status !== 'created') return;
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
    const now = Date.now();
    // Completion must fetch results even when a recent progress event was throttled.
    // Large candidate lists are deliberately omitted from realtime frames.
    if (current && data.engine !== 'api' && (terminal || now - this._taggerLastItemsFetch > 800)) {
      this._taggerLastItemsFetch = now;
      void this.refreshTaggerItems(false);
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
    const taskId = this.taggerTaskId;
    const sourceMode = this.taggerSourceMode;
    const request = this._taggerItemsRequest = (this._taggerItemsRequest || 0) + 1;
    try {
      const offset = reset || this.taggerFailedOnly ? 0 : Math.max(0, Number(this.taggerTask?.current || 0) - 80);
      const limit = this.taggerFailedOnly ? 500 : 160;
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/items?offset=${offset}&limit=${limit}&failed_only=${this.taggerFailedOnly}`);
      const body = await response.json();
      if (taskId !== this.taggerTaskId || sourceMode !== this.taggerSourceMode || request !== this._taggerItemsRequest) return;
      if (body.status !== 'success') return;
      this.taggerItemsTotal = Number(body.data.total || 0);
      this._mergeTaggerItems(body.data.items || [], reset || this.taggerFailedOnly);
      if (reset && this.taggerItems.length) this.selectTaggerItem(this.taggerItems[0]);
      else {
        const selected = this.taggerItems.find(item => item.index === this.taggerSelectedIndex);
        if (selected?.result) this.setTaggerResult(selected.result);
      }
    } catch (_) {}
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
    if (!this.taggerTaskId || !this.taggerTask || !this.taggerTask.failed) return;
    const taskId = this.taggerTaskId, mode = this.taggerSourceMode;
    try {
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || this.t('tagger.retryRequestFailed'));
      this.attachTaggerTask(body.data.task_id, mode);
    } catch (error) { this.toast(error.message, 'error'); }
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
    const phase = this.taggerTask?.phase || (this.taggerScanning ? 'scanning' : 'ready');
    return this.t('tagger.phase.' + phase, phase.replace(/_/g, ' '));
  },

  taggerVisibleLogs() {
    const logs = Array.isArray(this.taggerTask?.logs) ? this.taggerTask.logs : [];
    return logs.slice(this.taggerLogsOpen ? 0 : -32).map(line => typeof line === 'string' ? {
      time: line.match(/^\[([^\]]+)\]\s*/)?.[1] || '--:--:--', level: 'info',
      message: line.replace(/^\[[^\]]+\]\s*/, ''),
    } : line);
  },

  taggerLogMessage(line) {
    if (this.taggerTask?.engine === 'api' && ['done','cancelled'].includes(line.event)) {
      return this.t('caption.taskSummary').replace(/\{(\w+)\}/g,(_,key) => line[key] ?? '');
    }
    return line.message ?? this.t('tagger.log.' + line.event, line.event)
      .replace(/\{(\w+)\}/g, (_, key) => line[key] ?? '');
  },
};
