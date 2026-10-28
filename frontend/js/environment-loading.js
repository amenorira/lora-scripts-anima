/* 环境状态加载队列与页面初始化；由 environment-core.js 装配，共享该工作区的状态。 */
window.environmentLoadingMixin = {
  _waitForEnvironmentPaint() {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      setTimeout(finish, 80);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
  },

  async _commitEnvironmentLoad(loader, outcome) {
    const commit = async () => {
      try {
        if (outcome.ok) loader.apply(outcome.value);
        else if (loader.fail) loader.fail(outcome.error);
      } finally {
        this.environmentLoadCompleted++;
        if (this.currentRoute === 'environment') this.renderEnvironment();
        await this._waitForEnvironmentPaint();
      }
    };
    this._environmentCommitChain = (this._environmentCommitChain || Promise.resolve()).then(commit, commit);
    await this._environmentCommitChain;
  },

  async _runEnvironmentLoadQueue(loaders, concurrency) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < loaders.length) {
        const loader = loaders[cursor++];
        let outcome;
        try {
          outcome = { ok: true, value: await loader.load() };
        } catch (error) {
          outcome = { ok: false, error };
        }
        await this._commitEnvironmentLoad(loader, outcome);
      }
    };
    const workerCount = Math.min(Math.max(1, concurrency || 1), loaders.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  },

  _environmentJsonLoader(url, apply, fail, transform) {
    return {
      load: async () => {
        const response = await fetch(url);
        const payload = await response.json();
        if (!response.ok) throw new Error('Failed to load ' + url);
        return transform ? transform(payload) : payload;
      },
      apply,
      fail,
    };
  },

  async buildEnvironmentPage() {
    const el = document.getElementById('environmentPage');
    if (!el) { this.finishProgress(); return; }
    this._envInitCardState();
    // 词典状态：第一次进来查一次，之后每次进来刷新（数据可能是在别处装的）
    this.tagDictionaryInit();
    // Tab 记忆（用户上次看哪个分区）
    try {
      const savedTab = localStorage.getItem('anima_env_tab');
      if (['models', 'env', 'data'].includes(savedTab)) this.environmentTab = savedTab;
    } catch (_) {}
    if (this._environmentLoadPromise) {
      this.renderEnvironment();
      await this._environmentLoadPromise;
      if (this.currentRoute === 'environment') this.renderEnvironment();
      this.finishProgress();
      return;
    }
    const needsXf = !this.xfStatus, needsSd = !this.sdStatus, needsCores = !this.trainingCores, needsTriton = !this.tritonStatus,
          needsAnimaModel = !this.animaModelStatus, needsFa = !this.faStatus, needsMossAccel = !this.mossAccelStatus;
    if (needsXf || needsSd || needsCores || needsTriton || needsAnimaModel || needsFa || needsMossAccel) {
      // Render the full skeleton immediately, then load in a small queue.
      // This avoids stacking cold imports and disk scans while telemetry is active.
      const loaders = [];
      if (needsFa) loaders.push(this._environmentJsonLoader(
        '/api/flash-attn/status',
        data => { this.faStatus = data; this.faError = null; },
        error => { this.faStatus = null; this.faError = String(error); },
      ));
      if (needsXf) {
        this.xfError = null;
        loaders.push(this._environmentJsonLoader(
          '/api/xformers/status',
          data => { this.xfStatus = data; },
          error => { this.xfError = String(error); this.xfStatus = null; },
        ));
      }
      if (needsTriton) loaders.push(this._environmentJsonLoader(
        '/api/triton/status',
        data => { this.tritonStatus = data; this.tritonError = null; },
        error => { this.tritonStatus = null; this.tritonError = String(error); },
      ));
      if (needsMossAccel) loaders.push(this._environmentJsonLoader(
        '/api/moss-acceleration/status',
        data => { this.mossAccelStatus = data; this.mossAccelError = null; },
        error => { this.mossAccelStatus = null; this.mossAccelError = String(error); },
      ));
      if (needsSd) loaders.push(this._environmentJsonLoader(
        '/api/sd-scripts/status',
        data => { this.sdStatus = data; this.sdError = null; },
        error => { this.sdStatus = null; this.sdError = String(error); },
      ));
      if (needsAnimaModel) {
        this.animaModelError = null;
        loaders.push(this._environmentJsonLoader(
          '/api/anima-model/status',
          data => {
            this.animaModelStatus = data.files || null;
            this.animaModelDestDir = data.dest_dir || 'models/';
          },
          error => { this.animaModelError = String(error); this.animaModelStatus = null; },
        ));
      }
      if (needsCores) {
        this.trainingCoresError = null;
        loaders.push(this._environmentJsonLoader(
          '/api/training/cores',
          data => { this.trainingCores = data; },
          error => { this.trainingCoresError = String(error.message || error); this.trainingCores = null; },
          payload => {
            if (payload.status !== 'success') throw new Error(payload.message || 'Failed to load training cores');
            return payload.data || null;
          },
        ));
      }

      this.environmentLoading = true;
      this.environmentLoadCompleted = 0;
      this.environmentLoadTotal = loaders.length;
      this._environmentCommitChain = Promise.resolve();
      this.renderEnvironment();
      this._environmentLoadPromise = (async () => {
        await this._waitForEnvironmentPaint();
        await this._runEnvironmentLoadQueue(loaders, 2);
      })();
      try {
        await this._environmentLoadPromise;
      } finally {
        this._environmentLoadPromise = null;
        this._environmentCommitChain = null;
        this.environmentLoading = false;
      }
    }
    this.renderEnvironment(); this.finishProgress();
  },

  // Hero「全部刷新」：并行静默刷新各组件状态
  async _envRefreshAll() {
    if (this.environmentLoading) return;
    this.environmentLoading = true;
    this.renderEnvironment();
    const tasks = [
      this.tagDictionaryRefreshStatus().then(status => {
        if (status && ['downloading', 'building'].includes(status.status)) this._tdPollInstall();
        else if (status?.installed) return this.tagDictionaryCheckUpdate(true);
      }),
      this.xfRefresh(true).catch(() => {}),
      this.faRefresh(true),
      this.tritonRefresh(true).catch(() => {}),
      this.mossAccelRefresh(true),
      this.animaModelRefresh(true).catch(() => {}),
      (async () => {
        try { const r = await fetch('/api/sd-scripts/status'); if (!r.ok) throw new Error('HTTP ' + r.status); this.sdStatus = await r.json(); this.sdError = null; }
        catch (e) { this.sdStatus = null; this.sdError = String(e); }
      })(),
      (async () => {
        try {
          const r = await fetch('/api/training/cores');
          const payload = await r.json();
          if (payload.status === 'success') { this.trainingCores = payload.data || null; this.trainingCoresError = null; }
          else { this.trainingCoresError = payload.message || 'Failed to load training cores'; this.trainingCores = null; }
        } catch (e) { this.trainingCoresError = String(e && e.message || e); this.trainingCores = null; }
      })(),
    ];
    try { await Promise.allSettled(tasks); }
    finally { this.environmentLoading = false; this.renderEnvironment(); }
  },
};
