/* 环境任务订阅与收尾；由 environment-core.js 装配，共享该工作区的状态。 */
window.environmentTasksMixin = {
  // ── Realtime task bridge ─────────────────────────────
  _setEnvironmentRealtimeTask(slot, jobId) {
    if (!this._envRealtimeTopics) this._envRealtimeTopics = {};
    const next = jobId ? 'task:' + jobId : null;
    const previous = this._envRealtimeTopics[slot] || null;
    if (previous === next) return;
    if (previous) this.realtimeUnsubscribe(previous);
    this._envRealtimeTopics[slot] = next;
    if (next) this.realtimeSubscribe(next);
  },

  _environmentSlotForTopic(topic) {
    if (!topic || !this._envRealtimeTopics) return null;
    return Object.keys(this._envRealtimeTopics).find(slot => this._envRealtimeTopics[slot] === topic) || null;
  },

  handleRealtimeEnvironmentEvent(event) {
    if (!event || (event.type !== 'task.status' && event.type !== 'task.progress')) return;
    const slot = this._environmentSlotForTopic(event.topic);
    if (!slot) return;
    const envelope = event.payload || {};
    this._applyEnvironmentRealtimeUpdate(slot, envelope.data || {}, envelope.status || '');
  },

  applyRealtimeEnvironmentSnapshot(snapshot) {
    const tracked = snapshot && snapshot.tasks && snapshot.tasks.tracked || [];
    const slots = {
      'xformers-install': 'xf',
      'flash-attn-install': 'fa',
      'triton-install': 'triton',
      'moss-acceleration-install': 'mossAccel',
      'model-download': 'animaModel',
    };
    for (const task of tracked) {
      const slot = slots[task.kind];
      if (!slot || !['CREATED', 'RUNNING'].includes(task.status)) continue;
      const idKey = slot === 'animaModel' ? 'animaModelJobId' : slot + 'InstallJobId';
      const busyKey = slot === 'animaModel' ? 'animaModelBusy' : slot + 'Busy';
      if (!this[idKey]) this[idKey] = task.task_id;
      this[busyKey] = true;
      this._setEnvironmentRealtimeTask(slot, task.task_id);
      this._applyEnvironmentRealtimeUpdate(slot, task.data || {}, task.status || '');
    }
  },

  resetRealtimeEnvironmentState() {
    const slots = ['xf', 'fa', 'triton', 'mossAccel', 'animaModel'];
    const hadTasks = slots.some(slot => this[slot + 'Busy'] || this[slot === 'animaModel' ? 'animaModelJobId' : slot + 'InstallJobId']);
    slots.forEach(slot => this._setEnvironmentRealtimeTask(slot, null));
    const unknown = this.t('monitor.taskStateUnknown');
    if (this.xfBusy || this.xfInstallJobId) this.xfError = unknown;
    if (this.faBusy || this.faInstallJobId) this.faError = unknown;
    if (this.tritonBusy || this.tritonInstallJobId) this.tritonError = unknown;
    if (this.mossAccelBusy || this.mossAccelInstallJobId) this.mossAccelError = unknown;
    if (this.animaModelBusy || this.animaModelJobId) this.animaModelError = unknown;
    this.faBusy = this.xfBusy = this.tritonBusy = this.mossAccelBusy = this.animaModelBusy = false;
    this.faInstallJobId = this.xfInstallJobId = this.tritonInstallJobId = this.mossAccelInstallJobId = this.animaModelJobId = null;
    this.scheduleEnvironmentRender();
    return hadTasks;
  },

  _applyEnvironmentRealtimeUpdate(slot, data, normalizedStatus) {
    const terminal = ['FINISHED', 'FAILED', 'TERMINATED'].includes(normalizedStatus) || !!data.done;
    const failed = normalizedStatus === 'FAILED' || data.success === false || data.returncode != null && data.returncode !== 0
      || (data.progress && (data.progress.stage === 'error' || data.progress.phase === 'error'));
    if (slot === 'fa') {
      this.faInstallLog = data.lines || this.faInstallLog;
      this.faInstallElapsed = data.elapsed || 0;
      this.faProgress = data.progress || this.faProgress;
    } else if (slot === 'xf') {
      this.xfInstallLog = data.lines || this.xfInstallLog;
      this.xfInstallElapsed = data.elapsed || 0;
    } else if (slot === 'triton') {
      this.tritonInstallLog = data.lines || this.tritonInstallLog;
      this.tritonInstallElapsed = data.elapsed || 0;
    } else if (slot === 'mossAccel') {
      this.mossAccelInstallLog = data.lines || this.mossAccelInstallLog;
      this.mossAccelInstallElapsed = data.elapsed || 0;
    } else if (slot === 'animaModel') {
      this.animaModelProgress = data.progress || this.animaModelProgress;
      this.animaModelLog = Array.isArray(data.log) ? data.log.join('\n') : (data.log || this.animaModelLog);
      this.animaModelAggregate = this._computeAnimaAggregate(this.animaModelProgress);
    }
    if (!terminal) {
      this.scheduleEnvironmentRender();
      return;
    }
    this._finalizeEnvironmentRealtimeTask(slot, data, failed).catch(() => {});
  },

  // 任务收尾：先刷新状态（silent refresh 会清掉 error 字段），失败时再写回错误，
  // 保证失败原因常驻可见，不被紧随其后的 refresh 吞掉。
  async _finalizeEnvironmentRealtimeTask(slot, data, failed) {
    const idKey = slot === 'animaModel' ? 'animaModelJobId' : slot + 'InstallJobId';
    const busyKey = slot === 'animaModel' ? 'animaModelBusy' : slot + 'Busy';
    this[busyKey] = false;
    this[idKey] = null;
    this._setEnvironmentRealtimeTask(slot, null);
    const fallback = this.t(slot === 'animaModel' ? 'environment.animaModel.failed' : 'environment.installFailed');
    if (slot === 'fa') {
      await this.faRefresh(true);
      if (failed) this.faError = data.error || data.lines || fallback;
    } else if (slot === 'xf') {
      const msg = failed ? (data.error || data.lines || fallback) : null;
      await this.xfRefresh(true).catch(() => {});
      if (failed) this.xfError = msg;
    } else if (slot === 'triton') {
      const msg = failed ? ((Array.isArray(data.lines) && data.lines[data.lines.length - 1]) || data.lines || this.tritonInstallLog || fallback) : null;
      await this.tritonRefresh(true).catch(() => {});
      if (failed) this.tritonError = msg;
    } else if (slot === 'animaModel') {
      const msg = failed ? ((data.progress || {}).error || (Array.isArray(data.log) && data.log[data.log.length - 1]) || fallback) : null;
      if (failed) this.toast(fallback, 'error');
      await this.animaModelRefresh(true).catch(() => {});
      if (failed) this.animaModelError = msg;
    } else if (slot === 'mossAccel') {
      await this.mossAccelRefresh(true);
      if (failed) this.mossAccelError = data.error || data.lines || fallback;
    }
    this.finishProgress();
    this.scheduleEnvironmentRender();
  },
};
