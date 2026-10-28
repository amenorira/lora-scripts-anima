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


};

Object.defineProperties(window.environmentRenderMixin, Object.getOwnPropertyDescriptors(window.environmentModelsRenderMixin));

Object.defineProperties(window.environmentRenderMixin, Object.getOwnPropertyDescriptors(window.environmentComponentsRenderMixin));

Object.defineProperties(window.environmentRenderMixin, Object.getOwnPropertyDescriptors(window.environmentDictionaryRenderMixin));
