/* ================================================================
   monitor-render.js — Dashboard shell and incremental tab orchestration
   Mixin merged into animaApp Alpine component

   更新策略（消除闪烁）：
     1. 外壳层仅在首次/历史模式切换时构建；摘要每 tick 原地更新。
     2. 标签页内容：每个标签独立脏判断，仅自身数据变化时重建。
     3. 日志：增量 DOM 追加 + 保留滚动位置。
   无 Chart.js 依赖。
   ================================================================ */

window.monitorRenderMixin = {
  ...window.monitorLogRenderMixin,

  // CREATED/RUNNING 都算"活跃"：等待启动的任务也要能终止，且不显示待命文案。
  _isActiveState(stateCode) {
    return stateCode === 'RUNNING' || stateCode === 'CREATED';
  },

  // ═══════════════════════════════════════════════════════════
  //  主入口：renderDashboard
  // ═══════════════════════════════════════════════════════════
  renderDashboard() {
    const el = document.getElementById('monitorDashboard');
    if (!el) return;
    const isHistory = !!this.selectedRunDir;
    const d = isHistory ? (this.runDetailData||{}) : (this.monitorData||{});
    const gpu = isHistory ? null : this.gpuInfo;
    const sys = isHistory ? null : this.sysInfo;
    const t = (k, fb) => this.tMonitor(k, fb);
    const tab = this.monitorTab||'overview';
    const locale = String(this.locale || (window.I18N && window.I18N.getLocale ? window.I18N.getLocale() : ''));

    // ── 1. 外壳层：仅在首次或历史模式切换时构建 ──
    if (!this._shellBuilt || this._shellHistoryMode !== isHistory || this._shellLocale !== locale) {
      if (this._shellBuilt) this.closePreviewLightbox();
      this._shellBuilt = true;
      this._shellHistoryMode = isHistory;
      this._shellLocale = locale;
      this._builtTab = null;
      let shell = '<div class="monitor-dashboard">';
      shell += '<div id="monitorTabContent">';
      shell += '<div class="m-tab-panel" data-tab="overview" hidden></div>';
      shell += '<div class="m-tab-panel" data-tab="logs" hidden></div>';
      shell += '<div class="m-tab-panel" data-tab="samples" hidden></div>';
      shell += '<div class="m-tab-panel" data-tab="outputs" hidden></div>';
      shell += '</div>';
      shell += this._previewLightboxHtml(t);
      shell += '</div>';
      el.innerHTML = shell;
    }

    // ── 2. 历史上下文只承担导航；实时状态全部位于摘要 ──
    const historyEl = document.getElementById('monitorHistoryContext');
    if (historyEl) {
      const signature = isHistory
        ? [locale, this.selectedRunDir || '', d.config && d.config.output_name || '', d.train_result && d.train_result.status || '', d.artifact_available].join(':')
        : '';
      if (this._historyContextSignature !== signature) {
        this._historyContextSignature = signature;
        historyEl.innerHTML = isHistory ? this._historyBannerHtml(d, t) : '';
      }
    }

    // 页头右侧资源监控（仅实时模式；历史模式由 x-show 隐藏）
    if (!isHistory) {
      this._renderResourceBar('monitorResbar', gpu, sys, t, locale);
    }

    // ── 3. 标签页内容 ──
    this._renderTab(tab, d, gpu, sys, t, isHistory);

    // ── 4. Tab 滑动指示条：按钮文本/计数徽标变化时重算位置 ──
    const tabIndicatorSig = tab + '|' + locale + '|' + this.logTotal + '|' + this.previews.length + '|' + this.outputTabCount;
    if (this._tabIndicatorSig !== tabIndicatorSig) {
      this._tabIndicatorSig = tabIndicatorSig;
      requestAnimationFrame(() => this._syncMonitorTabIndicator());
    }
  },

  // ═══════════════════════════════════════════════════════════
  //  实时连接状态仅在异常时显示
  // ═══════════════════════════════════════════════════════════
  _monitorConnectionMeta(t) {
    if (!this.realtimeState || this.realtimeState === 'online') return null;
    if (this.realtimeState === 'degraded') return { label: t('realtimeDelayed'), tone: 'warn' };
    return { label: t('reconnecting'), tone: 'warn' };
  },


  // ═══════════════════════════════════════════════════════════
  //  外壳：历史横幅（轻量信息条风格）
  // ═══════════════════════════════════════════════════════════
  _historyBannerHtml(d, t) {
    const runName = (d.config && d.config.output_name) || ((this.selectedRunDir || '').split(/[\\/]/).pop() || '');
    let html = '<div class="m-history-banner">';
    html += '<svg class="m-history-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    html += '<span class="m-history-label">' + this.esc(t('viewingHistory')) + '</span>';
    html += '<b class="m-history-name">' + this.esc(runName) + '</b>';
    const state = this._summaryStatus(d, true).state;
    const stClass = state === 'FINISHED' ? 'ok' : (state === 'FAILED' ? 'danger' : 'muted');
    const stLabel = state === 'FINISHED' ? t('statusCompleted') : state === 'FAILED' ? t('statusFailed') : state === 'TERMINATED' ? t('statusTerminated') : t('statusUnknown');
    html += '<span class="m-badge m-badge-' + stClass + '"><i aria-hidden="true"></i>' + this.esc(stLabel) + '</span>';
    if (d.artifact_available === false) html += '<span class="m-badge m-badge-danger"><i aria-hidden="true"></i>' + this.esc(t('artifactOffline')) + '</span>';
    html += '<div class="m-history-spacer"></div>';
    html += '<button class="btn btn-sm btn-secondary" @click="clearRunDetail()">' + this.esc(t('backToLive')) + '</button>';
    html += '<button class="btn btn-sm" @click="navigate(\'history\')">← ' + this.esc(t('backToHistory')) + '</button>';
    html += '</div>';
    return html;
  },

  // ═══════════════════════════════════════════════════════════
  //  标签页分发
  // ═══════════════════════════════════════════════════════════
  _renderTab(tab, d, gpu, sys, t, isHistory) {
    const contentEl = document.getElementById('monitorTabContent');
    if (!contentEl) return;
    const tabChanged = this._builtTab !== tab;

    // ── 持久面板：切换只翻转激活态（进入动画由 CSS 承担），各面板 DOM 常驻，
    //    切走再切回时滚动位置/展开状态天然保留；内容仅在数据签名变化时重建 ──
    if (tabChanged) {
      const prevTab = this._builtTab;
      this._builtTab = tab;
      // 切离样本标签：取消弱网模式下的后台媒体加载队列（面板 DOM 保留，不释放 object URL）
      if (prevTab === 'samples' && tab !== 'samples') this._cancelPreviewMediaQueue();
      contentEl.querySelectorAll('.m-tab-panel').forEach(panel => {
        const isActive = panel.dataset.tab === tab;
        panel.classList.toggle('active', isActive);
        panel.hidden = !isActive;
        if (isActive) {
          // tab 切换激活：允许进入动画播放（移除内容重建时可能加过的抑制类）
          panel.classList.remove('no-enter-anim');
        }
      });
      requestAnimationFrame(() => this._syncMonitorTabIndicator());
    }

    const panel = contentEl.querySelector('.m-tab-panel[data-tab="' + tab + '"]');
    if (!panel) return;
    const panelEmpty = !panel.firstElementChild;

    if (isHistory && !this.runDetailData) {
      panel.innerHTML = '<div class="dashboard-empty"><p>' + this.esc(this.runDetailError || t('loading')) + '</p>'
        + (this.runDetailError ? '<button class="btn btn-sm" @click="_fetchRunDetail(selectedRunDir)">' + this.esc(t('refresh')) + '</button>' : '') + '</div>';
      this._builtOverviewSig = null;
      return;
    }

    if (tab === 'logs') {
      this._renderLogs(panel, d, t, panelEmpty);
      return;
    }
    if (tab === 'overview') {
      const sig = 'ov:' + this._shellLocale + ':' + this._summaryStatus(d, isHistory).state + ':' + this.trainParamsVersion;
      if (panelEmpty || this._builtOverviewSig !== sig) {
        this._builtOverviewSig = sig;
        if (!tabChanged) panel.classList.add('no-enter-anim');
        panel.innerHTML = this._renderOverviewTab(d, t, isHistory);
        delete panel.dataset.diagnosticVersion;
        delete panel.dataset.sparklineVersion;
        delete panel.dataset.telemetryVersion;
        delete panel.dataset.motionContext;
        if (this.monitorParamQuery) this.filterMonitorParams();
      }
      this._patchOverviewStatus(panel, d, t, isHistory);
      return;
    }
    if (tab === 'samples') {
      const sig = 'sm:' + this._shellLocale + ':' + this.previewsVersion + ':' + (this.weakNetworkMode ? 1 : 0) + ':' + (d.artifact_available === false ? 0 : 1) + ':' + String(d.preview_enabled);
      if (panelEmpty || this._builtSamplesSig !== sig) {
        // 保留滚动位置（实时追加样本时不在视觉上跳回顶部）
        const scrollTop = panel.scrollTop || 0;
        this._cancelPreviewMediaQueue();
        this._releasePreviewMediaObjectUrls();
        this._builtSamplesSig = sig;
        if (!tabChanged) panel.classList.add('no-enter-anim');
        panel.innerHTML = this._renderSamplesTab(t);
        panel.scrollTop = scrollTop;
      }
      this.schedulePreviewMediaLoads(panel);
      return;
    }
    if (tab === 'outputs') {
      if ((this._outputFilesNeedsRefresh || (tabChanged && !this.outputFiles.length)) && !this.outputFilesLoading) this.loadOutputFiles();
      const sig = 'out:' + this._shellLocale + ':' + this.outputFilesVersion + ':' + this.selectedOutputFiles.join('|') + ':' + (this.outputFilesLoading?1:0) + ':' + this.outputSearch + ':' + this.outputFilter + ':' + this.outputModelSortKey + ':' + this.outputModelSortDir + ':' + this.outputOtherSortKey + ':' + this.outputOtherSortDir + ':' + (this.outputFilesError || '') + ':' + (d.artifact_available === false ? 0 : 1);
      if (panelEmpty || this._builtOutputsSig !== sig) {
        // Preserve scroll position across re-renders
        const scrollEl = panel.querySelector('.m-outputs-scroll');
        const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
        this._builtOutputsSig = sig;
        // 进入动画策略：加载/空占位（dashboard-empty）转瞬即逝，不播动画；
        // 真实内容首次落位（替换占位）播放动画；排序/筛选等原地重建抑制，避免整面板闪烁
        const replacingPlaceholder = !!panel.querySelector('.dashboard-empty');
        if (this.outputFilesLoading || (!tabChanged && !panelEmpty && !replacingPlaceholder)) {
          panel.classList.add('no-enter-anim');
        } else {
          panel.classList.remove('no-enter-anim');
        }
        const input = panel.querySelector('.m-output-search-input');
        const activeId = panel.contains(document.activeElement) ? document.activeElement.id : '';
        const focused = input && document.activeElement === input;
        const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
        if (input) input.remove();
        panel.innerHTML = this._renderOutputsTab(t);
        const replacement = panel.querySelector('.m-output-search-input');
        if (input && replacement) {
          replacement.replaceWith(input);
          input.value = this.outputSearch;
          if (focused) { input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
        }
        if (!focused && activeId) {
          const target = document.getElementById(activeId);
          if (target && !target.disabled) target.focus({ preventScroll: true });
          else if (target?.disabled) panel.querySelector('.m-output-search-input')?.focus({ preventScroll: true });
        }
        const newScrollEl = panel.querySelector('.m-outputs-scroll');
        if (newScrollEl) newScrollEl.scrollTop = scrollTop;
      }
      return;
    }
  },

  // 滑动指示条：跟随激活 tab 的位置与宽度（首次定位不播放动画）
  _syncMonitorTabIndicator() {
    const bar = document.querySelector('.monitor-tabs');
    if (!bar) return;
    const indicator = bar.querySelector('.monitor-tab-indicator');
    const active = bar.querySelector('.monitor-tab.active');
    if (!indicator || !active || !active.offsetWidth) {
      // 路由隐藏时布局不可用：清空签名，让下一次 renderDashboard 重新调度定位
      this._tabIndicatorSig = null;
      this._tabIndicatorGeom = null;
      return;
    }
    // 计数徽标出现/位数变化、语言切换等会改变按钮宽度，且响应式 DOM 更新的
    // 时序晚于 renderDashboard 的 rAF 同步（同帧更晚执行），靠"先读几何"永远
    // 会读到旧值。ResizeObserver 在布局变化后、绘制前回调，直接从根源修正：
    // 重写只是平滑改变进行中的动画终点，不打断滑动。
    if (!this._tabIndicatorRO) {
      this._tabIndicatorRO = new ResizeObserver(() => {
        const a = bar.querySelector('.monitor-tab.active');
        const g = this._tabIndicatorGeom;
        if (!a || !a.offsetWidth || !g) return;
        if (a.offsetLeft === g.l && a.offsetWidth === g.w) return;
        this._syncMonitorTabIndicator();
      });
      bar.querySelectorAll('.monitor-tab').forEach(btn => this._tabIndicatorRO.observe(btn));
    }
    const l = active.offsetLeft, w = active.offsetWidth;
    if (!bar.classList.contains('indicator-ready')) {
      bar.classList.add('no-anim');
      indicator.style.width = w + 'px';
      indicator.style.transform = 'translateX(' + l + 'px)';
      void indicator.offsetWidth; // 强制 reflow，确保无动画落位先生效
      bar.classList.remove('no-anim');
      bar.classList.add('indicator-ready');
      this._tabIndicatorGeom = { l, w };
      return;
    }
    const g = this._tabIndicatorGeom;
    if (g && g.l === l && g.w === w) return; // 几何未变，避免重复写入打断进行中的过渡
    indicator.style.width = w + 'px';
    indicator.style.transform = 'translateX(' + l + 'px)';
    this._tabIndicatorGeom = { l, w };
  },


};

Object.defineProperties(window.monitorRenderMixin, Object.getOwnPropertyDescriptors(window.monitorHistoryRenderMixin));

Object.defineProperties(window.monitorRenderMixin, Object.getOwnPropertyDescriptors(window.monitorArtifactsRenderMixin));

Object.defineProperties(window.monitorRenderMixin, Object.getOwnPropertyDescriptors(window.monitorResourcesMixin));

Object.defineProperties(window.monitorRenderMixin, Object.getOwnPropertyDescriptors(window.monitorDiagnosticsMixin));

Object.defineProperties(window.monitorRenderMixin, Object.getOwnPropertyDescriptors(window.monitorSummaryMixin));
