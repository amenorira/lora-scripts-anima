/* ================================================================
   environment-render.js — renderEnvironment + event bindings
   Mixin merged into animaApp Alpine component

   架构：分槽增量渲染。renderEnvironment() 首次建立稳定骨架
   （加载状态 / Hero 总览 / 6 个组件行槽位 / 模型组槽位），
   之后每帧按槽位比对 HTML，只替换变化的槽位 → 进度 tick 不再
   摧毁整页 DOM，折叠动画、输入焦点、日志滚动位置全部存活。

   布局：限宽总览 → 运行环境（自适应双面板）/ 模型库（自适应双列）/ 数据下载。
   组件以"行 + 行内展开详情"取代旧 details 卡片墙；健康组件只占一行。
   ================================================================ */

window.environmentRenderMixin = {
  renderEnvironment() {
    const el = document.getElementById('environmentPage');
    if (!el) return;
    if (this._environmentRenderFrame != null) {
      cancelAnimationFrame(this._environmentRenderFrame);
      this._environmentRenderFrame = null;
    }
    const T = (k, fb) => this.t('environment.' + k) || fb || k;
    this._ensureEnvSkeleton(el, T);
    this._updateEnvSectionTitles(el, T);
    this._syncEnvTabDom(el);
    this._observeEnvModelLayout(el.querySelector('.env-models-grid'));
    if (!this._envTabsBound && el.querySelector('[data-env-tabs]')) {
      this._envTabsBound = true;
      el.querySelectorAll('[data-env-tab]').forEach(btn => {
        btn.addEventListener('click', () => this.envSetTab(btn.dataset.envTab));
      });
    }

    const slots = {
      overview: this._renderOverview(T),
      xf: this._renderXfRow(T),
      fa: this._renderFaRow(T),
      triton: this._renderTritonRow(T),
      mossAccel: this._renderMossAccelRow(T),
      sd: this._renderSdRow(T),
      lycoris: this._renderLycorisRow(T),
      musubi: this._renderMusubiRow(T),
      animaModel: this._renderModelGroup(T, 'Anima'),
      krea2: this._renderModelGroup(T, 'Krea 2'),
      moss: this._renderModelGroup(T, 'MOSS-Image'),
      trainUse: this._renderModelGroup(T, 'Train Use'),
      dictionary: this._renderDictionaryRow(T),
    };
    if (!this._envSlotHtml) this._envSlotHtml = {};
    for (const slot of Object.keys(slots)) {
      const host = el.querySelector('[data-env-slot="' + slot + '"]');
      if (!host) continue;
      const html = slots[slot];
      if (this._envSlotHtml[slot] === html) continue; // 无变化 → DOM 保留
      this._envSlotHtml[slot] = html;
      host.innerHTML = html;
      this._bindSlotEvents(host, slot, T);
    }
    this._autoScrollLogs(el);
  },

  // ── 稳定骨架（只建一次）──────────────────────────────
  _ensureEnvSkeleton(el, T) {
    if (el.dataset.envSkeleton === '1' && el.querySelector('[data-env-slot="overview"]')) return;
    el.dataset.envSkeleton = '1';
    el.innerHTML = ''
      + '<div data-env-slot="overview"></div>'
      + '<div class="env-tabs" role="tablist" data-env-tabs>'
      +   `<button type="button" role="tab" class="env-tab" data-env-tab="env">${this.esc(T('envTabEnv','Environment'))}</button>`
      +   `<button type="button" role="tab" class="env-tab" data-env-tab="models">${this.esc(T('envTabModels','Models'))}</button>`
      +   `<button type="button" role="tab" class="env-tab" data-env-tab="data">${this.esc(T('envTabData','Downloads'))}</button>`
      +   '<span class="env-tab-indicator" aria-hidden="true"></span>'
      + '</div>'
      + '<div class="env-tab-panel" data-env-tab-panel="env">'
      +   '<div class="env-env-grid">'
      +     '<div class="env-col" data-env-anchor-target="accel">'
      +       '<div class="env-section-title" data-env-title="accel"></div>'
      +       '<div class="env-column-head" data-env-columns></div>'
      +       '<div data-env-slot="xf"></div>'
      +       '<div data-env-slot="fa"></div>'
      +       '<div data-env-slot="triton"></div>'
      +       '<div data-env-slot="mossAccel"></div>'
      +     '</div>'
      +     '<div class="env-col" data-env-anchor-target="core">'
      +       '<div class="env-section-title" data-env-title="core"></div>'
      +       '<div class="env-column-head" data-env-columns></div>'
      +       '<div data-env-slot="sd"></div>'
      +       '<div data-env-slot="lycoris"></div>'
      +       '<div data-env-slot="musubi"></div>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      + '<div class="env-tab-panel" data-env-tab-panel="data">'
      +   '<div class="env-models-wrap" data-env-anchor-target="data">'
      +     '<div class="env-section-title"><span data-env-title="data"></span><span class="env-section-note" data-env-note="data"></span></div>'
      +     '<div data-env-slot="dictionary"></div>'
      +   '</div>'
      + '</div>'
      + '<div class="env-tab-panel" data-env-tab-panel="models">'
      +   '<div class="env-models-wrap" data-env-anchor-target="models">'
      +     '<div class="env-section-title"><span data-env-title="models"></span><span class="env-section-note" data-env-note="models"></span></div>'
      +     '<div class="env-models-grid">'
      +       '<div data-env-slot="animaModel"></div>'
      +       '<div data-env-slot="krea2"></div>'
      +       '<div data-env-slot="moss"></div>'
      +       '<div data-env-slot="trainUse"></div>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  },

  _observeEnvModelLayout(grid) {
    if (this._envModelLayoutGrid === grid) return;
    this._envModelLayoutRO?.disconnect();
    this._envModelLayoutGrid = grid;
    const slots = Array.from(grid.children);
    const columns = [document.createElement('div'), document.createElement('div')];
    columns.forEach(column => { column.className = 'env-model-column'; });
    let currentColumns = 1;
    this._envModelLayoutRO = new ResizeObserver(() => {
      if (!grid.getClientRects().length) return;
      const columnCount = Number(getComputedStyle(grid).getPropertyValue('--env-model-columns')) || 1;
      if (columnCount === currentColumns) return;
      currentColumns = columnCount;
      const focused = grid.contains(document.activeElement) ? document.activeElement : null;
      // 双列各自堆叠，展开只影响本列；窄窗口恢复原始顺序及键盘顺序。
      // 仅在跨越断点时移动原节点，不重建内容、事件或展开状态。
      if (columnCount === 2) {
        grid.append(...columns);
        slots.forEach((slot, index) => columns[index % 2].append(slot));
      } else {
        grid.append(...slots);
        columns.forEach(column => column.remove());
      }
      if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
    });
    this._envModelLayoutRO.observe(grid);
  },

  // Tab 状态同步到 DOM（隐藏面板 + active 按钮 + 面板淡入动画）
  _syncEnvTabDom(el) {
    const tab = ['models', 'data'].includes(this.environmentTab) ? this.environmentTab : 'env';
    el.querySelectorAll('[data-env-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.envTab === tab);
      btn.setAttribute('aria-selected', btn.dataset.envTab === tab ? 'true' : 'false');
    });
    el.querySelectorAll('[data-env-tab-panel]').forEach(p => {
      p.hidden = p.dataset.envTabPanel !== tab;
    });
    // 面板初次落位/切换回时播放淡入（避免进度 tick 重渲染反复触发）
    if (this._envVisiblePanel !== tab) {
      this._envVisiblePanel = tab;
      const panel = el.querySelector('[data-env-tab-panel="' + tab + '"]');
      if (panel) {
        panel.classList.remove('env-panel-in');
        void panel.offsetWidth;
        panel.classList.add('env-panel-in');
      }
    }
    if (this._envTabIndicatorScheduled) return;
    this._envTabIndicatorScheduled = true;
    requestAnimationFrame(() => {
      this._envTabIndicatorScheduled = false;
      this._syncEnvTabIndicator();
    });
  },

  // 滑动指示条：跟随激活 tab 的位置与宽度（参照监控台实现）
  _syncEnvTabIndicator() {
    const bar = document.getElementById('environmentPage')?.querySelector('.env-tabs');
    if (!bar) return;
    const indicator = bar.querySelector('.env-tab-indicator');
    const active = bar.querySelector('.env-tab.active');
    if (!indicator || !active || !active.offsetWidth) {
      this._envTabIndicatorGeom = null;
      return;
    }
    if (!this._envTabIndicatorRO) {
      this._envTabIndicatorRO = new ResizeObserver(() => {
        const a = bar.querySelector('.env-tab.active');
        const g = this._envTabIndicatorGeom;
        if (!a || !a.offsetWidth || !g) return;
        if (a.offsetLeft === g.l && a.offsetWidth === g.w) return;
        this._syncEnvTabIndicator();
      });
      bar.querySelectorAll('.env-tab').forEach(btn => this._envTabIndicatorRO.observe(btn));
    }
    const l = active.offsetLeft, w = active.offsetWidth;
    const g = this._envTabIndicatorGeom;
    if (g && g.l === l && g.w === w) return;
    if (!g) {
      bar.classList.add('no-anim');
      indicator.style.width = w + 'px';
      indicator.style.transform = 'translateX(' + l + 'px)';
      void indicator.offsetWidth;
      bar.classList.remove('no-anim');
      bar.classList.add('indicator-ready');
      this._envTabIndicatorGeom = { l, w };
      return;
    }
    indicator.style.width = w + 'px';
    indicator.style.transform = 'translateX(' + l + 'px)';
    this._envTabIndicatorGeom = { l, w };
  },

  _updateEnvSectionTitles(el, T) {
    const set = (key, text) => {
      const n = el.querySelector('[data-env-title="' + key + '"]');
      if (n && n.textContent !== text) n.textContent = text;
    };
    set('accel', T('sectionAccel', 'Performance acceleration'));
    set('core', T('sectionCore', 'Training Core'));
    set('models', T('sectionModels', 'Models'));
    set('data', T('sectionData', 'Downloads'));
    const tabLabels = { env: T('envTabEnv', 'Environment'), models: T('envTabModels', 'Models'), data: T('envTabData', 'Downloads') };
    el.querySelectorAll('[data-env-tab]').forEach(btn => {
      const label = tabLabels[btn.dataset.envTab];
      if (btn.textContent !== label) btn.textContent = label;
    });
    const columns = ['columnComponent', 'columnVersion', 'columnStatus', 'columnActions'];
    const columnHtml = columns.map(key => `<span>${this.esc(T(key))}</span>`).join('');
    el.querySelectorAll('[data-env-columns]').forEach(node => {
      if (node.innerHTML !== columnHtml) node.innerHTML = columnHtml;
    });
    const dataNote = el.querySelector('[data-env-note="data"]');
    const dataNoteText = T('sectionDataNote', 'Available offline after download');
    if (dataNote && dataNote.textContent !== dataNoteText) dataNote.textContent = dataNoteText;
    // 「下载到哪」的极短说明只在区标题行出现一次（文件行已逐行显示目标路径）
    const note = el.querySelector('[data-env-note="models"]');
    const noteText = T('animaModel.destShort', 'Downloads to models/');
    if (note && note.textContent !== noteText) note.textContent = noteText;
  },

  // 页面级加载指示已并入 Hero 骨架（env-load-spinner + env-load-status，
  // 类名为 tests/test_realtime.py 契约），不再单独渲染顶部横条。

  // 分槽渲染只替换变化的槽位 DOM，未变化槽位的 .env-log 滚动位置天然保留；
  // 这里只把"刚重建且内容溢出"的日志滚到底（实时日志持续追加，用户要看最新行）。
  _autoScrollLogs(el) {
    el.querySelectorAll('.env-log').forEach(pre => {
      if (pre.scrollHeight > pre.clientHeight) {
        pre.scrollTop = pre.scrollHeight;
      }
    });
  },

  // ═══════════════════════════════════════════════════════
  //  Hero 总览面板
  // ═══════════════════════════════════════════════════════
  _renderOverview(T) {
    const xfOk = !!(this.xfStatus && this.xfStatus.installed);
    const trOk = !!(this.tritonStatus && this.tritonStatus.installed);
    const accelReady = !!(this.xfStatus && this.tritonStatus && this.faStatus && this.mossAccelStatus);
    const accelDone = [xfOk, trOk, !!this.faStatus?.installed, !!this.mossAccelStatus?.enabled].filter(Boolean).length;

    const sdEngine = this.trainingCores?.engines?.find(i => i.id === 'sd_scripts');
    const sdOk = sdEngine ? !!sdEngine.available : !!this.sdStatus?.local;
    const lyAdapter = this.trainingCores && (this.trainingCores.adapters || []).find(i => i.id === 'lycoris');
    const muEngine = this.trainingCores && (this.trainingCores.engines || []).find(i => i.id === 'musubi_tuner');
    const lyOk = !!(lyAdapter && lyAdapter.available);
    const muOk = !!(muEngine && muEngine.available);
    const coreReady = !!(this.sdStatus && this.trainingCores);
    const coreDone = [sdOk, lyOk, muOk].filter(Boolean).length;

    const files = this.animaModelStatus || [];
    const modelsReady = !!this.animaModelStatus;
    const modelDone = new Set(files.filter(f => f.exists).map(f => f.dest_path || f.filename)).size;

    const dictionaryState = this.tagDictionaryDataState?.();
    const hasError = !!(this.faError || this.xfError || this.tritonError || this.mossAccelError || this.sdError || this.trainingCoresError || this.animaModelError
      || ['failed', 'error'].includes(dictionaryState) || this.tagDictionaryServer?.update?.state === 'error');
    const allLoaded = accelReady && coreReady && modelsReady && dictionaryState !== 'checking';
    const working = this.faBusy || this.xfBusy || this.tritonBusy || this.mossAccelBusy || this.animaModelBusy || dictionaryState === 'installing';

    // 完成查询不等于能运行所有训练：只报告查询与任务状态。
    let heroState, heroTitle, heroSub;
    if (hasError) {
      heroState = 'err';
      heroTitle = T('overview.needsAttention', 'Needs attention');
      heroSub = T('overview.subError', 'Check the highlighted rows for error details.');
    } else if (!allLoaded || this.environmentLoading || working) {
      heroState = 'loading';
      heroTitle = working ? T('overview.working', 'Task in progress') : T('overview.checking', 'Checking environment...');
      heroSub = '';
    } else {
      heroState = 'ok';
      heroTitle = T('overview.checked', 'Check complete');
      heroSub = '';
    }

    // 模型只统计本地文件，不把可选变体总数表现成待完成目标。
    const summary = (done, key, ready, label) => {
      const num = ready ? T(key).replace('{count}', done) : '–';
      return `<span>${label} ${num}</span>`;
    };
    const summaryHtml = `<div class="env-hero-summary">`
      + summary(accelDone, 'overview.availableCount', accelReady, T('overview.accel', 'Acceleration'))
      + `<span class="env-summary-sep">·</span>`
      + summary(coreDone, 'overview.availableCount', coreReady, T('overview.core', 'Training core'))
      + `<span class="env-summary-sep">·</span>`
      + `<span>${T('overview.models', 'Models')} ${modelsReady ? this.esc(T('animaModel.localFileCount', '{count} local files').replace('{count}', modelDone)) : '–'}</span>`
      + `</div>`;

    // 加载态：spinner + 文案并入 Hero 标题行（页面级仅此一个加载指示，
    // env-load-spinner / env-load-status 类名为测试契约，勿改）
    const heroStatusHtml = heroState === 'loading'
      ? `<div class="env-hero-status"><span class="env-load-spinner" aria-hidden="true"></span><span class="env-load-status" role="status" aria-live="polite">${heroTitle}</span></div>`
      : `<div class="env-hero-status">${heroTitle}</div>`;

    return `<section class="env-hero env-hero-${heroState}">`
      + `<div class="env-hero-main">`
      +   `<div class="env-hero-text">`
      +     heroStatusHtml
      +     (heroSub ? `<div class="env-hero-sub">${heroSub}</div>` : '')
      +     summaryHtml
      +   `</div>`
      + `</div>`
      + `<div class="env-hero-side">`
      +   `<button type="button" class="btn btn-sm btn-ghost env-toggle-all" data-env-toggle-all="open">${T('envExpandAll','Expand all')}</button>`
      +   `<button type="button" class="btn btn-sm btn-ghost env-toggle-all" data-env-toggle-all="close">${T('envCollapseAll','Collapse all')}</button>`
      +   `<button class="btn btn-sm btn-secondary env-refresh-all" data-env-refresh-all ${this.environmentLoading ? 'disabled' : ''}>`
      +     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`
      +     `<span>${this.environmentLoading ? T('refreshing', 'Refreshing...') : T('refreshAll', 'Refresh all')}</span></button>`
      + `</div>`
      + `</section>`;
  },

  // ═══════════════════════════════════════════════════════
  //  共享行头：组件用四列，模型/数据用紧凑摘要；操作和详情始终相邻。
  // ═══════════════════════════════════════════════════════
  _renderRowHead(slotId, open, parts) {
    const component = ['xf', 'fa', 'triton', 'mossAccel', 'sd', 'lycoris', 'musubi'].includes(slotId);
    return `<div class="env-row-head${component ? ' env-component-head' : ' env-summary-head'}" role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}" data-env-toggle="${slotId}">`
      + `<div class="env-flow-main">`
      +   `<span class="env-row-name">${parts.name}</span>`
      +   (!component ? (parts.badge || '') : '')
      +   (parts.desc ? `<div class="env-row-desc">${parts.desc}</div>` : '')
      + `</div>`
      + `<div class="env-row-meta">${parts.version || (component ? '<span class="env-text-dim">—</span>' : '')}</div>`
      + (component ? `<div class="env-row-status">${parts.badge || ''}</div>` : '')
      + `<div class="env-row-ops">`
      +   (parts.action || '')
      +   (parts.detailKey
          ? `<button type="button" class="env-text-link env-detail-link" data-env-detail="${parts.detailKey}" aria-expanded="${open ? 'true' : 'false'}">${this.esc(parts.detailLabel || this.t('environment.details','Details'))}<span class="env-caret" aria-hidden="true"></span></button>`
          : '')
      + `</div>`
      + `</div>`;
  },

  _renderRow(slotId, state, open, headHtml, bodyHtml) {
    const hasBody = !!bodyHtml;
    return `<div class="env-trow env-trow-${state}${open && hasBody ? ' env-open' : ''}" data-env-row="${slotId}">`
      + headHtml
      + (hasBody ? `<div class="env-row-body" data-env-body="${slotId}"${open ? '' : ' inert'}><div class="env-row-body-inner">${bodyHtml}</div></div>` : '')
      + `</div>`;
  },

  // 错误条：常驻显示失败原因 + 可选"复制日志"按钮
  _renderErrorBar(T, msg, logKey) {
    const copyBtn = logKey && this[logKey]
      ? `<button class="btn btn-ghost btn-sm env-copy-log" data-env-copy="${logKey}">${T('copyLog', 'Copy log')}</button>`
      : '';
    return `<div class="env-msg env-msg-err env-errorbar"><pre>${this.esc(msg)}</pre>${copyBtn}</div>`;
  },

  // ═══════════════════════════════════════════════════════
  //  Shared render helpers
  // ═══════════════════════════════════════════════════════

  // 详情行：label(42px) + content。
  _renderDetailGroup(label, contentHtml) {
    return `<div class="env-detail-group"><span class="env-detail-label">${label||''}</span><div class="env-detail-content">${contentHtml}</div></div>`;
  },

  // 刷新图标按钮（xf/triton/模型 共用）。
  _renderRefreshBtn(id, disabled, cls) {
    return `<button id="${id}" class="btn-icon ${cls || ''}" ${disabled?'disabled':''} title="${this.t('environment.refresh')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>`;
  },

  // 统一进度面板。opts: {stage, pct, speedMB, downloadedBytes, totalBytes, elapsed, fileIndex, fileTotal}
  //   stage: 'downloading' → 进度条+百分比+速度+大小
  //          'connecting'  → 不定式条 + 连接中文案
  //          'installing'/'working' → spinner + 阶段文案 + 计时
  _renderProgressPanel(opts) {
    const T = (k, fb) => this.t('environment.' + k) || fb || k;
    const stage = opts.stage || 'working';
    const elapsed = this._formatElapsed(opts.elapsed || 0);
    let bar = '', meta = '';

    if (stage === 'downloading' && opts.totalBytes != null && opts.totalBytes > 0) {
      const pct = opts.pct != null ? opts.pct : 0;
      bar = `<div class="env-progress-bar"><div style="width:${pct}%"></div></div>`;
      meta = `<span class="env-progress-pct">${pct}%</span><span class="env-progress-meta-r">${(opts.speedMB||0).toFixed(1)} MB/s · ${this._humanBytes(opts.downloadedBytes||0)}/${this._humanBytes(opts.totalBytes||0)}</span>`;
    } else if (stage === 'downloading') {
      // 有速度但 total 未知（单连接兜底阶段）
      bar = `<div class="env-progress-bar env-progress-indeterminate"><div></div></div>`;
      meta = `<span class="env-progress-stage">${T('downloading','Downloading')}</span><span class="env-progress-meta-r">${(opts.speedMB||0).toFixed(1)} MB/s · ${this._humanBytes(opts.downloadedBytes||0)}</span>`;
    } else if (stage === 'connecting') {
      const fileCount = opts.fileTotal > 1 ? ` ${opts.fileIndex || 1}/${opts.fileTotal}` : '';
      bar = `<div class="env-progress-bar env-progress-indeterminate"><div></div></div>`;
      meta = `<span class="env-progress-stage">${T('connecting','Connecting')}${fileCount}</span>`;
    } else {
      // installing / working
      const stageLabel = opts.stageLabel || (stage === 'installing' ? T('stageInstalling','Installing…') : T('installingHint','Working…'));
      bar = `<div class="env-progress-spinner-wrap"><div class="env-install-spinner"></div><span class="env-progress-stage">${stageLabel}</span></div>`;
      meta = `<span class="env-progress-time">${elapsed}</span>`;
    }
    return `<div class="env-progress-panel">${bar}<div class="env-progress-meta">${meta}</div></div>`;
  },


  // 日志渲染：按行套色（ERROR/RETRY/WARN 红/橙，完成/Successfully 绿），输出到 <pre class="env-log">。
  _renderLog(text) {
    if (!text) return '';
    const lines = String(text).split('\n');
    let html = '';
    for (const raw of lines) {
      if (!raw) { html += '\n'; continue; }
      let cls = '';
      if (/^\[?ERROR\]?|\[ERROR\]|失败|failed|exit code|Traceback|Error:/i.test(raw)) cls = 'env-log-err';
      else if (/^\[?RETRY\]?|\[RETRY\]|重试|retry/i.test(raw)) cls = 'env-log-warn';
      else if (/^\[?WARN\]?|\[WARN\]|WARN|警告/i.test(raw)) cls = 'env-log-warn';
      else if (/完成|Done|Successfully installed|安装成功|已下载|Downloaded|100%/i.test(raw)) cls = 'env-log-ok';
      html += `<span class="env-log-line${cls?' '+cls:''}">${this.esc(raw)}</span>\n`;
    }
    return `<pre class="env-log">${html}</pre>`;
  },

  // 子折叠面板（高级选项 / 下载日志共用）。open 为当前展开状态。
  _renderSubCollapse(key, label, open, innerHtml) {
    return `<div class="env-sub${open ? ' env-open' : ''}" data-env-sub="${key}">`
      + `<div class="env-sub-head" role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}" data-env-sub-head="${key}">`
      + `<span class="env-sub-arrow" aria-hidden="true"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg></span>`
      + `<span>${label}</span></div>`
      + `<div class="env-sub-body"${open ? '' : ' inert'}><div class="env-sub-body-inner">${innerHtml}</div></div>`
      + `</div>`;
  },

  // ═══════════════════════════════════════════════════════
  //  FlashAttention
  _renderFaRow(T) {
    const status = this.faStatus;
    const open = this._envCardOpen('fa');
    const error = this.faError;
    const state = this.faBusy ? 'loading' : error ? 'err' : !status ? 'loading' : status.installed ? 'ok' : 'muted';
    const key = this.faBusy ? 'installing' : error ? 'operationFailed' : !status ? 'loadingShort'
      : status.installed ? 'installed' : 'optionalNotInstalled';
    const disabled = this.faBusy || !status?.can_install;
    const head = this._renderRowHead('fa', open, {
      name: 'FlashAttention 2', desc: T('fa.hint'),
      version: status?.version ? `<span class="env-row-version" title="${this.escapeAttr(status.version)}">v${this.esc(status.version.split('+')[0])}</span>` : '',
      badge: `<span class="env-badge env-badge-${state}">${this.esc(T(key))}</span>`,
      action: status?.installed ? '' : `<button type="button" class="btn btn-sm btn-secondary env-head-btn" data-env-action="fa-install" ${disabled ? 'disabled' : ''}>${this.esc(T('install'))}</button>`,
      detailKey: 'fa', detailLabel: T('details'),
    });
    let body = `<div class="env-msg env-msg-info">${this.esc(T('fa.usage'))}</div>`;
    if (status) {
      const env = status.env || {};
      body += this._renderDetailGroup(T('envLabel'), this.esc(`Python ${env.python || '—'} · PyTorch ${env.torch || '—'} · CUDA ${env.cuda || '—'}`));
      if (!status.can_install) body += `<div class="env-msg">${this.esc(T(status.has_wheel ? 'fa.unsupported' : 'fa.noWheel'))}</div>`;
    }
    if (error) body += this._renderErrorBar(T, error, 'faInstallLog');
    if (this.faBusy) {
      const p = this.faProgress || {};
      body += this._renderProgressPanel({
        stage: p.stage === 'downloading' ? 'downloading' : 'working',
        stageLabel: T(p.stage === 'downloading' ? 'downloading' : 'fa.stage.' + (p.stage || 'resolving')),
        pct: p.total ? Math.min(100, Math.floor((p.downloaded || 0) * 100 / p.total)) : 0,
        downloadedBytes: p.downloaded, totalBytes: p.total, speedMB: (p.speed || 0) / 1048576,
        elapsed: this.faInstallElapsed,
      });
    }
    const sources = { options: ['auto', 'direct', 'mirror'].map(v => ({ v, l: T('fa.source_' + v) })) };
    body += `<div class="env-actions"><div class="env-download-source"><span>${this.esc(T('fa.source'))}</span>
      <div class="anima-select" x-data="animaSelect('${this.escJson(sources)}', '${this.escapeAttr(this.faSource)}')" @click.outside="close()" @anima-select-change="faSource = $event.detail.value">
        <button type="button" class="anima-select-trigger" :class="{ focused: open }" @click="toggle()" aria-label="${this.escapeAttr(T('fa.source'))}" ${this.faBusy ? 'disabled' : ''}>
          <span class="anima-select-trigger-text" x-text="selectedLabel">${this.esc(T('fa.source_' + this.faSource))}</span>
          <svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <template x-if="open"><div class="anima-select-menu" :class="{ 'anima-select-menu-positioned': positioned }"><div class="anima-select-menu-scroll">
          <template x-for="opt in flatOptions" :key="opt.v"><div class="anima-select-option" :class="{ active: opt.v === value }" @click="select(opt.v)"><span class="anima-select-option-label" x-text="opt.l"></span><svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></div></template>
        </div></div></template>
      </div></div>`
      + (status?.installed ? `<button type="button" class="btn btn-sm btn-ghost" data-env-action="fa-install" ${disabled ? 'disabled' : ''}>${this.esc(T('reinstall'))}</button>` : '')
      + `<button type="button" class="btn btn-sm btn-ghost" data-env-action="fa-refresh" ${this.faBusy ? 'disabled' : ''}>${this.esc(T('refresh'))}</button></div>`;
    if (this.faInstallLog) body += this._renderLog(this.faInstallLog);
    return this._renderRow('fa', state, open, head, body);
  },

  //  xformers 行
  // ═══════════════════════════════════════════════════════
  _renderXfRow(T) {
    const xs = this.xfStatus; const xfEnv = xs?.env || {}; const xfInstalled = xs?.installed;
    const open = this._envCardOpen('xf');

    if (this.xfBusy) {
      const head = this._renderRowHead('xf', open, {
        name: 'xformers',
        desc: T('xfHint','Memory-efficient attention'),
        version: '', badge: `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`,
        detailKey: 'xf', detailLabel: T('details','Details'),
      });
      const body = this._renderProgressPanel({ stage: 'working', elapsed: this.xfInstallElapsed, stageLabel: T('xfInstallingHint','Downloading...') })
        + this._renderLog(this.xfInstallLog);
      return this._renderRow('xf', 'loading', open, head, body);
    }

    const state = this.xfError ? 'err' : !xs ? 'loading' : xfInstalled ? 'ok' : 'muted';
    const badge = this.xfError ? `<span class="env-badge env-badge-err">${T('operationFailed','Operation failed')}</span>`
      : !xs ? `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>`
      : xfInstalled ? `<span class="env-badge env-badge-ok">${T('installed','Installed')}</span>`
      : `<span class="env-badge env-badge-muted">${T('optionalNotInstalled','Optional · Not installed')}</span>`;
    const version = xfInstalled && xs.version ? `<span class="env-row-version">v${this.esc(xs.version)}</span>` : '';
    const headBtn = xs ? `<button type="button" class="btn btn-sm ${xfInstalled ? 'btn-ghost' : 'btn-secondary'} env-head-btn" data-env-action="xf">${xfInstalled ? T('reinstall','Reinstall') : T('install','Install')}</button>` : '';
    const head = this._renderRowHead('xf', open, {
      name: 'xformers',
      desc: T('xfHint','Memory-efficient attention'),
      version, badge, action: headBtn,
      detailKey: 'xf', detailLabel: T('details','Details'),
    });

    let body = '';
    if (this.xfError) body += this._renderErrorBar(T, this.xfError, 'xfInstallLog');

    if (xs) {
      const envItems = [];
      if (xfInstalled) envItems.push(`<span class="env-env-item">xformers <em>v${xs.version||'?'}</em></span>`);
      if (xfEnv.python_tag) envItems.push(`<span class="env-env-item"><em>${xfEnv.python_tag}</em></span>`);
      if (xfEnv.torch_ver) envItems.push(`<span class="env-env-item">PyTorch <em>${xfEnv.torch_ver}</em></span>`);
      if (xfEnv.cuda_ver) envItems.push(`<span class="env-env-item">CUDA <em>cu${xfEnv.cuda_ver.replace('.','')}</em></span>`);
      body += this._renderDetailGroup(T('envLabel','Env'), envItems.join(' &middot; ') || `<span class="env-text-dim">${T('notDetected','N/A')}</span>`);

      if (!xfInstalled) body += `<div class="env-msg env-msg-info">${T('xfInstallInfo','Installs latest compatible version from PyPI.')}</div>`;

    }
    body += `<div class="env-actions">${this._renderRefreshBtn('xf-refresh-btn', this.xfBusy)}</div>`;

    return this._renderRow('xf', state, open, head, body);
  },

  // ═══════════════════════════════════════════════════════
  //  训练核心行（sd-scripts / LyCORIS / musubi-tuner）
  // ═══════════════════════════════════════════════════════
  // 行头右侧：版本号（mono，链 GitHub）+ 状态徽标。
  _coreVersionInfo(meta) {
    if (!meta) return { label: '', url: '' };
    const commit = String(meta.local_commit || '');
    const release = meta.describe || meta.tag || meta.version;
    const branch = meta.local_branch && meta.local_branch !== 'HEAD' ? meta.local_branch : '';
    const label = release || (commit ? [branch, commit.slice(0, 7)].filter(Boolean).join(' ') : branch);
    const repoUrl = `https://github.com/${meta.repo}`;
    const url = commit ? `${repoUrl}/commit/${encodeURIComponent(commit)}`
      : meta.tag ? `${repoUrl}/releases/tag/${encodeURIComponent(meta.tag)}`
      : branch ? `${repoUrl}/tree/${encodeURIComponent(branch)}` : repoUrl;
    return { label, url };
  },

  _renderCoreHeadParts(T, meta, available = true, error = null, loaded = !!meta) {
    if (error) return { version: '', badge: `<span class="env-badge env-badge-err">${T('loadFailed', 'Load failed')}</span>` };
    if (!loaded) return { version: '', badge: `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>` };
    if (!available) return { version: '', badge: `<span class="env-badge env-badge-muted">${T('coreNotReady', 'Not configured')}</span>` };
    const info = this._coreVersionInfo(meta);
    const version = info.label
      ? `<a href="${this.escapeAttr(info.url)}" target="_blank" rel="noopener" class="env-row-version env-link"><code>${this.esc(info.label)}</code></a>` : '';
    return { version, badge: `<span class="env-badge env-badge-ok">${T('coreReady','Ready')}</span>` };
  },

  _renderCoreRepositoryDetails(T, meta, fallbackRepo) {
    const repo = meta?.repo || fallbackRepo;
    const repoUrl = `https://github.com/${repo}`;
    const info = this._coreVersionInfo({ ...meta, repo });
    const item = (key, html) => `<div><dt>${this.esc(T(key))}</dt><dd>${html}</dd></div>`;
    const verItems = [
      item('repositoryLabel', `<a href="${repoUrl}" target="_blank" rel="noopener" class="env-link">${this.esc(repo)} &#8599;</a>`),
      meta?.local_branch ? item('branchLabel', this.esc(meta.local_branch)) : '',
      meta?.describe || meta?.tag || meta?.version ? item('columnVersion', `<a href="${this.escapeAttr(info.url)}" target="_blank" rel="noopener" class="env-link"><code>${this.esc(info.label)}</code></a>`) : '',
      meta?.local_commit ? item('commitLabel', `<a href="${repoUrl}/commit/${this.escapeAttr(meta.local_commit)}" target="_blank" rel="noopener" class="env-link"><code>${this.esc(meta.local_commit.slice(0,7))}</code></a>`) : '',
      meta?.sync_date ? item('syncLabel', this.esc(meta.sync_date)) : '',
    ];
    return `<dl class="env-repo-details">${verItems.join('')}</dl>`;
  },

  /* 数据下载：Danbooru 中文词典。数据不进仓库，这里负责下载/更新与进度；
     标签编辑器里那份译文由同一个状态驱动。 */
  _renderDictionaryRow(T) {
    const server = this.tagDictionaryServer;
    const dataState = this.tagDictionaryDataState();
    const open = this._envCardOpen('dictionary');

    const badgeState = dataState === 'installed' && this.tagDictionaryCheckingUpdate ? 'checking'
      : dataState === 'installed' && server?.update?.state === 'available' ? 'checking'
      : dataState === 'installed' && server?.update?.state === 'error' ? 'error'
      : dataState === 'installed' && server?.update?.state === 'unknown' ? 'absent' : dataState;
    const badgeClass = {
      installing: 'env-badge-loading', installed: 'env-badge-ok', checking: 'env-badge-loading',
      failed: 'env-badge-err', error: 'env-badge-err', absent: '',
    }[badgeState] || '';
    const updateKey = { available: 'dictUpdateAvailable', current: 'dictUpToDate',
      unknown: 'dictUpdateUnknown', error: 'dictCheckFailed' }[server?.update?.state];
    const badgeText = (this.tagDictionaryStatusError || !server) && ['failed', 'error'].includes(dataState) ? T('loadFailed')
      : dataState === 'installing' ? this.tagDictionaryInstallText()
      : server?.status === 'failed' ? T(server.installed ? 'dictUpdateFailed' : 'dictDownloadFailed')
      : this.tagDictionaryCheckingUpdate ? T('dictCheckingUpdate')
      : dataState === 'installed' && updateKey ? T(updateKey) : this.tagDictionaryDataLabel();
    const badge = `<span class="env-badge ${badgeClass}">${this.esc(badgeText)}</span>`;

    const parts = [];
    if (server?.installed) {
      parts.push(this.tagDictionaryVersionText(), this.tagDictionaryTagCountText(), this.tagDictionarySizeText());
    }
    const version = parts.filter(Boolean).length
      ? `<span class="env-mgroup-count">${parts.filter(Boolean).map(item => this.esc(item)).join(this.tagDictionaryIsChinese() ? '，' : ', ')}</span>`
      : '';

    let action = this.tagDictionaryDataActionVisible()
      ? `<button class="btn btn-sm btn-secondary" data-env-action="dictionary"${dataState === 'installing' || this.tagDictionaryCheckingUpdate ? ' disabled' : ''}>`
        + `${this.esc(this.tagDictionaryDataActionLabel())}</button>`
      : '';

    if (server?.installed && dataState === 'installed') {
      action += `<button class="btn btn-sm btn-ghost" data-env-action="dictionary-redownload"${this.tagDictionaryCheckingUpdate ? ' disabled' : ''}>${this.esc(T('dictRedownload'))}</button>`;
    }

    const head = this._renderRowHead('dictionary', open, {
      name: T('dictRowName', 'Danbooru Chinese dictionary'),
      desc: T('dictRowDesc', 'Tag translations, colors and notes for the Tag Editor'),
      version, badge, action,
      detailKey: 'dictionary', detailLabel: T('details', 'Details'),
    });

    return this._renderRow('dictionary', dataState === 'installing' ? 'loading'
      : ['failed', 'error'].includes(badgeState) ? 'err' : (dataState === 'installed' ? 'ok' : 'muted'), open, head,
      this._renderDictionaryBody(T, dataState));
  },

  _renderDictionaryBody(T, dataState) {
    const server = this.tagDictionaryServer || {};
    let body = '';
    const category = String(server.current_file || '').replace(/\.csv$/, '');
    const categoryNames = { general: 'dictGeneral', artist: 'dictArtist', copyright: 'dictCopyright',
      character: 'dictCharacter', meta: 'dictMeta' };
    const current = categoryNames[category] ? T(categoryNames[category]) : server.current_file || '';
    if (dataState === 'installing') {
      if (server.status !== 'building' && current && !server.files?.length) {
        const source = server.download_source ? ` (${this.esc(server.download_source)})` : '';
        body += `<div class="env-text-dim">${this.esc(current)} (${Number(server.file_index || 0) + 1}/${Number(server.file_total || 5)})${source}</div>`;
      }
      body += server.status === 'building'
        ? this._renderProgressPanel({ stage: 'installing', stageLabel: this.t('tagEditor.dictBuilding') })
        : this._renderProgressPanel({
            stage: server.phase === 'connecting' ? 'connecting' : 'downloading',
            fileIndex: Math.min(Number(server.file_index || 0) + 1, server.file_total || 5), fileTotal: server.file_total || 5,
            pct: server.percent ?? (server.total_bytes > 0 ? Math.min(100, Math.floor(100 * server.downloaded_bytes / server.total_bytes)) : 0),
            speedMB: server.speed_mb || 0,
            downloadedBytes: server.downloaded_bytes || 0,
            totalBytes: server.total_bytes || 0,
          });
      if (server.status !== 'building') {
        for (const file of server.files || []) {
          const name = String(file.filename || '').replace(/\.csv$/, '');
          const label = categoryNames[name] ? T(categoryNames[name]) : file.filename;
          const progress = file.done ? T('dictFileDone') : file.phase === 'queued' ? T('dictFileQueued')
            : file.total > 0 ? `${Math.min(100, Math.floor(100 * (file.downloaded || 0) / file.total))}%` : T('dictFileConnecting');
          body += this._renderDetailGroup(this.esc(label), this.esc(progress));
        }
      }
    }
    if (dataState === 'failed' || dataState === 'error') {
      const reason = this.tagDictionaryStatusError || !this.tagDictionaryServer ? this.t('tagEditor.dictStatusUnavailable') : T(server.error_kind === 'source' ? 'dictErrorSource'
        : server.error_kind === 'integrity' ? 'dictErrorIntegrity'
        : server.error_kind === 'build' ? 'dictErrorBuild' : 'dictErrorDownload');
      body += `<div class="env-msg env-msg-err">${current ? this.esc(current) + '：' : ''}${this.esc(reason)}</div>`;
    }
    if (server.categories?.length) {
      const number = value => Number(value || 0).toLocaleString();
      body += '<div class="env-dict-table"><table><thead><tr>'
        + ['dictCategory', 'dictTags'].map(key => `<th>${this.esc(T(key))}</th>`).join('')
        + '</tr></thead><tbody>';
      for (const item of server.categories) {
        body += `<tr><th>${this.esc(T(categoryNames[item.name] || 'dictCategory'))}</th>`
          + `<td>${number(item.tag_count)}</td></tr>`;
      }
      body += `<tr><th>${this.esc(T('dictTotal'))}</th><td>${number(server.tag_count)}</td></tr></tbody></table></div>`;
    }
    body += this._renderDetailGroup(T('dictSource'), '<a href="https://huggingface.co/datasets/ame-la/danbooru-tags-data-zh" target="_blank" rel="noopener" class="env-link">ame-la/danbooru-tags-data-zh ↗</a>');
    if (dataState === 'installed' && server.update?.state === 'error') {
      const reason = T(server.update.error_kind === 'source' ? 'dictErrorSource' : 'dictCheckFailed');
      body += `<div class="env-msg env-msg-err">${this.esc(reason)}</div>`;
      if (server.update.message) {
        body += `<details><summary class="env-text-dim">${this.esc(T('dictErrorDetails'))}</summary>${this._renderLog(server.update.message)}</details>`;
      }
    }
    const log = this.tagDictionaryLogText() || this.tagDictionaryInstallError || server.message;
    if (log && (dataState === 'failed' || dataState === 'error')) {
      body += `<details><summary class="env-text-dim">${this.esc(T('dictErrorDetails'))}</summary>${this._renderLog(log)}</details>`;
    }
    return body;
  },

  _renderSdRow(T) {
    const sd = this.sdStatus; const sdLocal = sd?.local || null;
    const open = this._envCardOpen('sd');
    const error = this.sdError || this.trainingCoresError;
    const engine = this.trainingCores?.engines?.find(item => item.id === 'sd_scripts');
    const available = engine ? !!engine.available : !!sdLocal;
    const state = error ? 'err' : !sd ? 'loading' : available ? 'ok' : 'muted';
    const parts = this._renderCoreHeadParts(T, sdLocal, available, error, !!sd);
    const head = this._renderRowHead('sd', open, {
      name: T('sdScriptsTitle','sd-scripts'),
      desc: T('sdScriptsDesc','kohya-ss/sd-scripts'),
      version: parts.version, badge: parts.badge,
      detailKey: 'sd', detailLabel: T('details','Details'),
    });
    const body = (error ? this._renderErrorBar(T, error, null) : '') + (sd ? this._renderCoreRepositoryDetails(T, sdLocal, 'kohya-ss/sd-scripts') : '');
    return this._renderRow('sd', state, open, head, body);
  },

  _renderLycorisRow(T) {
    const registry = this.trainingCores;
    const error = this.trainingCoresError;
    const adapter = registry?.adapters?.find(item => item.id === 'lycoris');
    const available = !!adapter?.available;
    const state = error ? 'err' : !registry ? 'loading' : available ? 'ok' : 'muted';
    const open = this._envCardOpen('lycoris');
    const parts = this._renderCoreHeadParts(T, adapter?.version || null, available, error, !!registry);
    const head = this._renderRowHead('lycoris', open, {
      name: 'LyCORIS',
      desc: T('lycorisDesc', 'LoRA adapter core'),
      version: parts.version, badge: parts.badge,
      detailKey: 'lycoris', detailLabel: T('details','Details'),
    });
    let body = '';
    if (error) body += this._renderErrorBar(T, error, null);
    if (adapter) body += this._renderCoreRepositoryDetails(T, adapter.version, 'KohakuBlueleaf/LyCORIS');
    return this._renderRow('lycoris', state, open, head, body);
  },

  _renderMusubiRow(T) {
    const registry = this.trainingCores;
    const error = this.trainingCoresError;
    const engine = registry?.engines?.find(item => item.id === 'musubi_tuner');
    const available = !!engine?.available;
    const state = error ? 'err' : !registry ? 'loading' : available ? 'ok' : 'muted';
    const open = this._envCardOpen('musubi');
    const parts = this._renderCoreHeadParts(T, engine?.version || null, available, error, !!registry);
    const head = this._renderRowHead('musubi', open, {
      name: 'musubi-tuner',
      desc: T('musubiDesc', 'Krea 2 training core'),
      version: parts.version, badge: parts.badge,
      detailKey: 'musubi', detailLabel: T('details','Details'),
    });
    let body = '';
    if (error) body += this._renderErrorBar(T, error, null);
    if (engine) {
      body += this._renderCoreRepositoryDetails(T, engine.version, 'kohya-ss/musubi-tuner');
      const runtimeErrors = Array.isArray(engine.runtime_errors) ? engine.runtime_errors : [];
      if (runtimeErrors.length) body += `<div class="env-msg env-msg-err"><pre>${this.esc(runtimeErrors.join('\n'))}</pre></div>`;
    }
    return this._renderRow('musubi', state, open, head, body);
  },

  _renderMossAccelRow(T) {
    const status = this.mossAccelStatus;
    const busy = this.mossAccelBusy;
    const error = this.mossAccelError;
    const open = this._envCardOpen('mossAccel');
    const state = error ? 'err' : busy || !status ? 'loading' : status.enabled ? 'ok' : 'muted';
    const label = error ? T('operationFailed') : busy ? T('mossAccelWorking') : !status ? T('loadingShort')
      : status.enabled ? T('mossAccelEnabled') : status.reason ? T('mossAccelUnavailable')
        : status.available ? T('mossAccelDisabled') : T('optionalNotInstalled');
    let action = '';
    if (!busy && status) {
      const command = status.enabled ? 'disable' : status.available ? 'enable' : status.can_install ? 'install' : null;
      if (command) action = `<button type="button" class="btn btn-sm btn-secondary env-head-btn" data-env-action="moss-accel-${command}">${T(command === 'install' ? 'mossAccelInstall' : command === 'enable' ? 'mossAccelEnable' : 'mossAccelDisable')}</button>`;
    }
    const head = this._renderRowHead('mossAccel', open, {
      name: T('mossAccelTitle'), action,
      version: '<span class="env-row-version">FLA 0.5.2 · Conv1D 1.7.0</span>',
      badge: `<span class="env-badge env-badge-${state === 'loading' ? 'loading' : state === 'err' ? 'err' : state === 'ok' ? 'ok' : 'muted'}">${this.esc(label)}</span>`,
      detailKey: 'mossAccel', detailLabel: T('details'),
    });
    let body = `<div class="env-msg env-msg-info">${this.esc(T('mossAccelDesc'))}</div>`
      + this._renderDetailGroup('FLA', this.esc(T('mossAccelFlaInfo')))
      + this._renderDetailGroup('Conv', this.esc(T('mossAccelConvInfo')))
      + `<div class="env-msg">${this.esc(T('mossAccelBenefit'))}</div>`
      + `<div class="env-msg env-msg-info">${this.esc(T('mossAccelInfo'))}</div>`;
    if (error) body += this._renderErrorBar(T, error, 'mossAccelInstallLog');
    if (busy) body += this._renderProgressPanel({ stage: 'working', elapsed: this.mossAccelInstallElapsed,
      stageLabel: T('mossAccelVerifying') }) + this._renderLog(this.mossAccelInstallLog);
    if (status?.reason) body += `<div class="env-msg env-msg-info">${this.esc(T('mossAccelReason_' + status.reason))}</div>`;
    if (status?.verification?.gpu) body += this._renderDetailGroup('GPU', this.esc(status.verification.gpu));
    if (!busy) {
      body += `<div class="env-actions"><button type="button" class="btn btn-sm btn-ghost" data-env-action="moss-accel-refresh">${T('refresh')}</button>`;
      if (status?.installed && status.can_install) body += `<button type="button" class="btn btn-sm btn-ghost" data-env-action="moss-accel-install">${T('mossAccelReinstall')}</button>`;
      body += '</div>';
    }
    return this._renderRow('mossAccel', state, open, head, body);
  },

  // ═══════════════════════════════════════════════════════
  //  Triton 行
  // ═══════════════════════════════════════════════════════
  _renderTritonRow(T) {
    const tr = this.tritonStatus;
    const open = this._envCardOpen('triton');

    // Busy: installing
    if (this.tritonBusy) {
      const head = this._renderRowHead('triton', open, {
        name: 'Triton',
        desc: T('tritonDesc','GPU compile backend for torch.compile'),
        version: '', badge: `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`,
        detailKey: 'triton', detailLabel: T('details','Details'),
      });
      const body = this._renderProgressPanel({ stage: 'working', elapsed: this.tritonInstallElapsed, stageLabel: T('tritonInstallingHint','Downloading...') })
        + this._renderLog(this.tritonInstallLog);
      return this._renderRow('triton', 'loading', open, head, body);
    }

    const state = this.tritonError ? 'err' : !tr ? 'loading' : tr.installed ? 'ok' : 'muted';
    const badge = this.tritonError
      ? `<span class="env-badge env-badge-err">${T('operationFailed','Operation failed')}</span>`
      : !tr
        ? `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>`
        : tr.installed
          ? `<span class="env-badge env-badge-ok">${T('tritonInstalled','Installed')}</span>`
          : `<span class="env-badge env-badge-muted">${T('notInstalled','Not installed')}</span>`;
    const version = tr && tr.installed && tr.version
      ? `<span class="env-row-version">v${this.esc(tr.version)}${tr.package ? ' · ' + this.esc(tr.package) : ''}</span>` : '';
    const headBtn = tr ? `<button type="button" class="btn btn-sm ${tr?.installed ? 'btn-ghost' : 'btn-secondary'} env-head-btn" data-env-action="triton">${tr?.installed ? T('reinstall','Reinstall') : T('install','Install')}</button>` : '';
    const head = this._renderRowHead('triton', open, {
      name: 'Triton',
      desc: T('tritonDesc','GPU compile backend for torch.compile'),
      version, badge, action: headBtn,
      detailKey: 'triton', detailLabel: T('details','Details'),
    });

    let body = '';
    if (this.tritonError) body += this._renderErrorBar(T, this.tritonError, 'tritonInstallLog');

    if (tr) {
      if (tr.installed) {
        body += this._renderDetailGroup(T('verLabel','Ver'), `<span class="env-env-item">${this.esc(tr.package||'triton')} <em>v${this.esc(tr.version||'?')}</em></span>`);
      } else {
        body += `<div class="env-msg env-msg-info">${T('tritonInstallInfo','Enables DiT per-block compilation. Windows installs a triton-windows version matched to PyTorch; Linux installs triton.')}</div>`;
      }
    }
    body += `<div class="env-actions">${this._renderRefreshBtn('triton-refresh-btn', this.tritonBusy)}</div>`;
    return this._renderRow('triton', state, open, head, body);
  },


  // ═══════════════════════════════════════════════════════
  //  Event bindings（按槽位绑定，只有重建的槽位重绑）
  // ═══════════════════════════════════════════════════════
  _bindSlotEvents(host, slot, T) {
    this._bindRowToggle(host);
    this._bindDetailToggles(host);
    this._bindHeadActionEvents(host);
    this._bindSubToggles(host);
    host.querySelectorAll('[data-env-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = window.__anima || this;
        a._envCopyLog(a[btn.dataset.envCopy] || '');
      });
    });
    if (slot === 'overview') this._bindOverviewEvents(host);
    else if (slot === 'xf') this._bindXfEvents(host);
    else if (slot === 'triton') this._bindTritonEvents(host);
    else if (slot === 'animaModel' || slot === 'krea2' || slot === 'moss' || slot === 'trainUse') this._bindModelGroupEvents(host);
  },

  // 所有展开入口共用状态同步，隐藏内容不能留在键盘焦点顺序里。
  _setEnvRowExpanded(row, open) {
    row.classList.toggle('env-open', open);
    row.querySelectorAll('[data-env-toggle], [data-env-detail]').forEach(control => {
      control.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    this._envSetCardOpen(row.dataset.envRow, open);
    const body = row.querySelector('[data-env-body]');
    if (body) {
      body.inert = !open;
      this._animateCollapse(body, !open);
    }
  },

  // 行尾"详情"按钮：与点击行头保持一致。
  _bindDetailToggles(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-detail]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.envDetail;
        const row = host.querySelector('[data-env-row="' + key + '"]');
        if (!row) return;
        const open = !row.classList.contains('env-open');
        a._setEnvRowExpanded(row, open);
      });
    });
  },

  // 行尾主按钮（安装/重装）：xf/triton 直接安装
  _bindHeadActionEvents(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.envAction;
        if (act === 'xf') a.xfInstall();
        else if (act === 'fa-install') a.faInstall();
        else if (act === 'fa-refresh') a.faRefresh();
        else if (act === 'triton') a.tritonInstall();
        else if (act === 'moss-accel-install') a.mossAccelInstall();
        else if (act === 'moss-accel-enable') a.mossAccelSetEnabled(true);
        else if (act === 'moss-accel-disable') a.mossAccelSetEnabled(false);
        else if (act === 'moss-accel-refresh') a.mossAccelRefresh();
        else if (act === 'dictionary') a.tagDictionaryDataAction();
        else if (act === 'dictionary-check') a.tagDictionaryCheckUpdate(true);
        else if (act === 'dictionary-redownload') a.tagDictionaryInstall(true);
      });
    });
  },

  // 行头点击/键盘展开收起。行内 a/button/input 不触发展开（修 summary 链接误触 bug）。
  // 不重渲染：直接在现有 DOM 上做高度动画 + 类/aria 更新 + 覆盖持久化。
  _bindRowToggle(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-toggle]').forEach(head => {
      const doToggle = () => {
        const row = head.parentElement;
        if (!row) return;
        const body = row.querySelector('[data-env-body]');
        if (!body) return;
        const open = !row.classList.contains('env-open');
        a._setEnvRowExpanded(row, open);
      };
      head.addEventListener('click', e => {
        if (e.target.closest('a, button, input, select, textarea')) return;
        doToggle();
      });
      head.addEventListener('keydown', e => {
        if (e.target !== head) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doToggle(); }
      });
    });
  },

  // 子折叠（高级选项 / 下载日志）
  _bindSubToggles(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-sub-head]').forEach(head => {
      const key = head.dataset.envSubHead;
      const doToggle = () => {
        const wrap = head.parentElement;
        const body = wrap.querySelector('.env-sub-body');
        const open = !wrap.classList.contains('env-open');
        wrap.classList.toggle('env-open', open);
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (key === 'animaModelLog') a._envSetCardOpen('animaModelLog', open);
        if (body) {
          body.inert = !open;
          a._animateCollapse(body, !open);
        }
        if (open && key === 'animaModelLog') {
          const pre = wrap.querySelector('.env-log');
          if (pre) pre.scrollTop = pre.scrollHeight;
        }
      };
      head.addEventListener('click', e => {
        if (e.target.closest('a, button, input')) return;
        doToggle();
      });
      head.addEventListener('keydown', e => {
        if (e.target !== head) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doToggle(); }
      });
    });
  },

  _bindOverviewEvents(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-anchor]').forEach(chip => {
      chip.addEventListener('click', () => a._envScrollTo(chip.dataset.envAnchor));
    });
    const btn = host.querySelector('[data-env-refresh-all]');
    if (btn) btn.addEventListener('click', () => {
      btn.disabled = true;
      a._envRefreshAll().finally(() => { btn.disabled = false; });
    });
    host.querySelectorAll('[data-env-toggle-all]').forEach(btn2 => {
      btn2.addEventListener('click', () => a._envToggleAll(btn2.dataset.envToggleAll === 'open'));
    });
  },

  // 全部展开/收起：作用于当前 Tab 的行（组件行 + 模型组），子折叠（高级选项/日志）不受影响。
  // 未渲染的槽位通过覆盖持久化（_envSetCardOpen），渲染时就带上目标状态。
  _envToggleAll(open) {
    const page = document.getElementById('environmentPage');
    if (!page) return;
    const tab = this.environmentTab || 'env';
    const panel = page.querySelector('[data-env-tab-panel="' + tab + '"]');
    if (!panel) return;
    panel.querySelectorAll('.env-trow[data-env-row], .env-mgroup[data-env-row]').forEach(row => {
      // 已处于目标状态的行跳过：不重播动画，也不重复写覆盖
      if (row.classList.contains('env-open') === open) return;
      this._setEnvRowExpanded(row, open);
    });
  },

  // Hero chip 点击：平滑滚动到对应区 + 短暂高亮
  _envScrollTo(anchor) {
    const el = document.getElementById('environmentPage');
    if (!el) return;
    const target = el.querySelector('[data-env-anchor-target="' + anchor + '"]');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('env-flash');
    void target.offsetWidth;
    target.classList.add('env-flash');
  },


  _bindXfEvents(el) {
    const a = window.__anima || this;
    el.querySelector('#xf-refresh-btn')?.addEventListener('click', () => a.xfRefresh());
  },

  _bindTritonEvents(el) {
    const a = window.__anima || this;
    el.querySelector('#triton-refresh-btn')?.addEventListener('click', () => a.tritonRefresh());
  },
};

Object.defineProperties(window.environmentRenderMixin, Object.getOwnPropertyDescriptors(window.environmentModelsRenderMixin));
