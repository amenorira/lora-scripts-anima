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

};

window.composeAppMixins(window.environmentCoreMixin, { environmentTasksMixin: window.environmentTasksMixin });

window.composeAppMixins(window.environmentCoreMixin, { environmentComponentsMixin: window.environmentComponentsMixin });

window.composeAppMixins(window.environmentCoreMixin, { environmentModelsMixin: window.environmentModelsMixin });

window.composeAppMixins(window.environmentCoreMixin, { environmentLoadingMixin: window.environmentLoadingMixin });
