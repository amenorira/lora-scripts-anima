/* ================================================================
   environment-core.js — State, WebSocket task updates, xformers & sd-scripts
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.environmentCoreMixin = {
  faStatus: null, faBusy: false, faError: null, faSource: 'auto',
  faInstallJobId: null, faInstallLog: '', faInstallElapsed: 0, faProgress: null,
  // ── xformers State ───────────────────────────────────
  xfStatus: null, xfBusy: false, xfError: null,
  xfInstallJobId: null, xfInstallLog: '', xfInstallElapsed: 0,

  // ── sd-scripts State ────────────────────────────────
  sdStatus: null, sdError: null,

  // ── Multi-core Registry State ───────────────────────
  trainingCores: null, trainingCoresError: null,

  // ── Triton State ─────────────────────────────────────
  tritonStatus: null, tritonBusy: false, tritonError: null,
  tritonInstallJobId: null, tritonInstallLog: '', tritonInstallElapsed: 0,
  mossAccelStatus: null, mossAccelBusy: false, mossAccelError: null,
  mossAccelInstallJobId: null, mossAccelInstallLog: '', mossAccelInstallElapsed: 0,

  // ── 模型下载 State ──────────────────────────────────
  animaModelStatus: null,   // models/ 下已有文件清单 [{filename, desc, exists, size_gb, dest_path}]
  animaModelDestDir: '',    // 目标目录（相对仓库根，如 models/），用于"下载到哪里"说明
  animaModelBusy: false,
  animaModelJobId: null,
  animaModelProgress: null, // 后端 progress 字段
  animaModelAggregate: null,// 前端计算的批量整体进度 {pct, fileIndex, fileTotal, label}
  animaModelLog: '',
  animaModelError: null,
  animaModelLogOpen: false, // 日志折叠状态（并入 _envCardOpen 覆盖机制）

  // ── 环境页 Tab（运行环境 / 模型库）───────────────────
  environmentTab: 'env',    // 'env' | 'models'，localStorage 记忆
  _envTabsBound: false,

  // ── Card open/close state ────────────────────────────
  // 覆盖模型：anima_env_cards_v2 只存用户显式展开/收起的槽位；
  // 未覆盖的槽位由 _envDefaultCardOpen 按健康度智能决定默认值。
  _envCardOverrides: null,
  _envSlotHtml: null, // 分槽渲染缓存 {slotId: html}
  _envRealtimeTopics: null,
  environmentLoading: false,
  environmentLoadCompleted: 0,
  environmentLoadTotal: 0,
  _environmentLoadPromise: null,
  _environmentCommitChain: null,
  _environmentRenderFrame: null,

  _envInitCardState() {
    try {
      const v2 = localStorage.getItem('anima_env_cards_v2');
      this._envCardOverrides = (v2 && JSON.parse(v2)) || {};
      // 旧版 key（完整布尔表）迁移为覆盖后删除
      const old = localStorage.getItem('anima_env_cards');
      if (old) {
        const s = JSON.parse(old) || {};
        const map = { xf:'xf', sd:'sd', lycoris:'lycoris', musubi:'musubi', triton:'triton', animaModel:'animaModel', kreaModel:'krea2', animaModelLog:'animaModelLog' };
        for (const k of Object.keys(map)) {
          if (typeof s[k] === 'boolean' && typeof this._envCardOverrides[map[k]] === 'undefined') this._envCardOverrides[map[k]] = s[k];
        }
        if (typeof s.coreRegistry === 'boolean') {
          if (typeof this._envCardOverrides.lycoris === 'undefined') this._envCardOverrides.lycoris = s.coreRegistry;
          if (typeof this._envCardOverrides.musubi === 'undefined') this._envCardOverrides.musubi = s.coreRegistry;
        }
        localStorage.removeItem('anima_env_cards');
        this._envSaveCardState();
      }
    } catch (_) { this._envCardOverrides = this._envCardOverrides || {}; }
  },
  _envSaveCardState() {
    try { localStorage.setItem('anima_env_cards_v2', JSON.stringify(this._envCardOverrides || {})); } catch (_) {}
  },

  // 默认全部收起；仅 busy（安装/下载进行中）自动展开以显示进度。
  // 错误、未安装、未下载都只靠 Hero / 行内色字提示，不默认展开
  // （行上仍有操作按钮，不影响发现性；顶部提供全部展开/收起）。
  _envDefaultCardOpen(slotId) {
    switch (slotId) {
      case 'dictionary': return !!this.tagDictionaryInstalling;
      case 'xf': return !!this.xfBusy;
      case 'fa': return !!this.faBusy;
      case 'triton': return !!this.tritonBusy;
      case 'mossAccel': return !!this.mossAccelBusy;
      case 'sd': return false;
      case 'lycoris':
      case 'musubi': return false;
      case 'animaModel':
      case 'krea2':
      case 'moss':
      case 'trainUse': {
        const groups = { animaModel: 'Anima', krea2: 'Krea 2', moss: 'MOSS-Image', trainUse: 'Train Use' };
        return !!this.animaModelBusy && this.animaModelProgress?.group === groups[slotId];
      }
      case 'animaModelLog': return !!this.animaModelLogOpen;
      default: return false;
    }
  },

  // 当前生效的展开状态 = 用户覆盖 ?? 智能默认
  _envCardOpen(slotId) {
    const o = (this._envCardOverrides || {})[slotId];
    return typeof o === 'boolean' ? o : this._envDefaultCardOpen(slotId);
  },
  _envSetCardOpen(slotId, open) {
    if (!this._envCardOverrides) this._envCardOverrides = {};
    this._envCardOverrides[slotId] = !!open;
    if (slotId === 'animaModelLog') this.animaModelLogOpen = !!open;
    this._envSaveCardState();
  },
  // 进入 busy 时强制展开一次：丢弃该槽覆盖，让智能默认（busy→true）生效
  _envForceOpen(slotId) {
    if (!this._envCardOverrides) return;
    if (slotId in this._envCardOverrides) {
      delete this._envCardOverrides[slotId];
      this._envSaveCardState();
    }
  },

  _formatElapsed(sec) { const m = Math.floor(sec/60), s = Math.floor(sec%60); return m+':'+String(s).padStart(2,'0'); },

  // 字节数 → 人类可读，自适应单位（对齐后端 _human_bytes 风格，但带单位名）。
  // 239MB 显示 "239.11 MB" 而非 "0.23 GB"；5.2GB 仍显示 "5.20 GB"。
  _humanBytes(b) {
    if (!b || b < 0 || !isFinite(b)) return '0 B';
    const units = [['B',1],['KB',1024],['MB',1048576],['GB',1073741824],['TB',1099511627776]];
    for (let i = units.length-1; i >= 0; i--) {
      if (b >= units[i][1]) {
        const v = b / units[i][1];
        const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
        return s + ' ' + units[i][0];
      }
    }
    return b + ' B';
  },

  scheduleEnvironmentRender() {
    if (this.currentRoute !== 'environment' || this._environmentRenderFrame != null) return;
    this._environmentRenderFrame = requestAnimationFrame(() => {
      this._environmentRenderFrame = null;
      if (this.currentRoute === 'environment') this.renderEnvironment();
    });
  },

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

  // 环境页 Tab 切换（内存 + localStorage，重渲染走现有分槽机制）
  envSetTab(tab) {
    const next = ['models', 'data'].includes(tab) ? tab : 'env';
    if (this.environmentTab === next) return;
    this.environmentTab = next;
    try { localStorage.setItem('anima_env_tab', next); } catch (_) {}
    this.renderEnvironment();
  },

  // 复制日志到剪贴板（错误条"复制日志"按钮，xformers/Triton/模型通用）
  _envCopyLog(text) {
    const done = () => this.toast(this.t('environment.copied') || 'Copied', 'success');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text || '').then(done, () => {});
      }
    } catch (_) {}
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

Object.defineProperties(window.environmentCoreMixin, Object.getOwnPropertyDescriptors(window.environmentTasksMixin));

Object.defineProperties(window.environmentCoreMixin, Object.getOwnPropertyDescriptors(window.environmentComponentsMixin));
