/* 模型文件下载与进度；由 environment-core.js 装配，共享该工作区的状态。 */
window.environmentModelsMixin = {
  // ── Anima 模型下载 Methods ──────────────────────────
  async animaModelRefresh(silent) {
    this.animaModelError = null;
    // 手动刷新时清掉过期任务进度：旧 progress 残留（phase='done'+batch）会让
    // 手动删除的文件被误报为"失败"（bug 3）。silent（任务收尾）时保留，供失败行标红。
    if (!silent && !this.animaModelBusy) { this.animaModelProgress = null; this.animaModelAggregate = null; }
    try {
      const r = await fetch('/api/anima-model/status');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      this.animaModelStatus = data.files || null;
      this.animaModelDestDir = data.dest_dir || 'models/';
    } catch (e) { this.animaModelError = String(e); this.animaModelStatus = null; }
    if (silent) this.scheduleEnvironmentRender(); else { this.renderEnvironment(); this.finishProgress(); }
  },

  async animaModelDownload(file, group) {
    if (this.animaModelBusy) return; // 防止重复点击
    // 界面只允许逐文件下载，拦截陈旧入口的空文件批量调用。
    if (!file) return;
    this.animaModelBusy = true; this.animaModelError = null;
    this.animaModelLog = '';
    this.animaModelProgress = { group: group || (this.animaModelStatus || []).find(f => f.filename === file)?.group, filename: file, batch: [file], phase: 'connecting', file_index: 0, file_total: 1 };
    this.animaModelAggregate = null;
    this.animaModelLogOpen = false;  // 新任务默认收起日志，用户可手动展开
    if (group === 'Krea 2') this._envForceOpen('krea2');
    else if (group === 'Anima') this._envForceOpen('animaModel');
    else if (group === 'Train Use') this._envForceOpen('trainUse');
    else if (group === 'MOSS-Image') this._envForceOpen('moss');
    else { this._envForceOpen('animaModel'); this._envForceOpen('krea2'); }
    this.startProgress(); this.renderEnvironment();
    try {
      const body = JSON.stringify({file: file || null, group: group || null});
      const r = await fetch('/api/anima-model/download', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body
      });
      const result = await r.json();
      if (result.success && result.job_id) {
        this.animaModelJobId = result.job_id;
        this._setEnvironmentRealtimeTask('animaModel', result.job_id);
      } else {
        this.animaModelBusy = false;
        this.animaModelError = result.message || this.t('environment.animaModel.failed');
        this.finishProgress(); this.renderEnvironment();
      }
    } catch (e) {
      this.animaModelBusy = false;
      this.animaModelError = String(e);
      this.finishProgress(); this.renderEnvironment();
    }
  },

  // 由后端 progress dict 计算批量整体进度（前端展示"第 i/n 个 · pct%"）。
  // 策略：已完成文件按 100% 计，当前文件按其 pct 计，未到的按 0% 计，再除以总数。
  _computeAnimaAggregate(p) {
    if (!p) return null;
    const fileTotal = p.file_total || p.batch?.length || 1;
    const fileIndex = (p.file_index != null) ? p.file_index : 0;
    const batch = Array.isArray(p.batch) ? p.batch : null;
    // 当前文件百分比
    let curPct = 0;
    if (p.total > 0 && p.downloaded != null) {
      curPct = Math.max(0, Math.min(100, p.downloaded * 100 / p.total));
    }
    // 整体 = 已完成文件(100) + 当前文件部分(curPct)，再 / fileTotal
    const completed = fileIndex; // 前 fileIndex 个已完成
    const aggregatePct = Math.round((completed * 100 + curPct) / fileTotal);
    return {
      pct: Math.max(0, Math.min(100, aggregatePct)),
      fileIndex: fileIndex + 1,
      fileTotal,
      label: batch ? (p.filename || '') : (p.filename || ''),
      phase: p.phase || '',
    };
  },
};
