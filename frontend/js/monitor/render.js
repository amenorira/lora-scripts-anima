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
    const locale = String(this.locale || (window.I18N && window.I18N.getLocale ? window.I18N.getLocale() : '')) + ':' + (this.localeRevision || 0);

    // ── 1. 外壳层：仅在首次或历史模式切换时构建 ──
    if (!this._shellBuilt || this._shellHistoryMode !== isHistory || this._shellLocale !== locale) {
      this._disconnectDatasetDiagUI?.();
      // The old shell can still be in the DOM after a route reset has cleared
      // _shellBuilt. Its delayed close callback is lost when we replace it.
      if (document.getElementById('previewLightbox')) {
        this.closePreviewLightbox();
        this.clearPreviewLightbox?.();
      }
      if (document.getElementById('datasetDiagModal')) {
        this.closeDatasetDiagModal?.();
        this.clearDatasetDiagModal?.();
      }
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
      shell += '<div class="m-tab-panel" data-tab="dataset" hidden></div>';
      shell += '</div>';
      shell += this._previewLightboxHtml(t);
      shell += this._datasetDiagModalHtml(t);
      shell += '</div>';
      el.innerHTML = shell;
    }

    // ── 2. 历史上下文只承担导航；实时状态全部位于摘要 ──
    const historyEl = document.getElementById('monitorHistoryContext');
    if (historyEl) {
      const signature = isHistory
        ? [locale, this.selectedRunDir || '', d.config?.output_name, d.train_result?.status, d.artifact_available].join(':')
        : '';
      if (this._historyContextSignature !== signature) {
        this._historyContextSignature = signature;
        historyEl.innerHTML = isHistory ? this._historyBannerHtml(d, t) : '';
      }
    }

    // 页头右侧资源监控（仅实时模式；历史模式由 x-show 隐藏）
    if (!isHistory) {
      this.renderMonitorResourceBar();
    }

    // ── 3. 标签页内容 ──
    this._renderTab(tab, d, gpu, sys, t, isHistory);

    // ── 4. Tab 滑动指示条：按钮文本/计数徽标变化时重算位置 ──
    const tabIndicatorSig = tab + '|' + locale + '|' + this.logTotal + '|' + this.previews.length + '|' + this.outputTabCount + '|' + (this.datasetDiagTabCount || 0);
    if (this._tabIndicatorSig !== tabIndicatorSig) {
      this._tabIndicatorSig = tabIndicatorSig;
      requestAnimationFrame(() => this._syncMonitorTabIndicator());
    }
  },

  renderMonitorResourceBar() {
    window.resourceBar.render('monitorResbar', {
      gpu: this.gpuInfo, sys: this.sysInfo, t: (key, fallback) => this.tMonitor(key, fallback),
      locale: this.locale, localeRevision: this.localeRevision, selectedGpuIndex: this.selectedGpuIndex,
      onSelect: index => { this.selectedGpuIndex = index; this.renderMonitorResourceBar(); },
    });
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
    let html = '<div class="m-history-banner"><div class="m-history-identity">';
    html += '<svg class="m-history-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    html += '<span class="m-history-label">' + this.esc(t('viewingHistory')) + '</span>';
    html += '<b class="m-history-name" title="' + this.esc(runName) + '">' + this.esc(runName) + '</b>';
    const state = this._summaryStatus(d, true).state;
    const stClass = state === 'FINISHED' ? 'ok' : (state === 'FAILED' || state === 'TERMINATED' ? 'danger' : 'muted');
    const stLabel = t({FINISHED: 'statusCompleted', FAILED: 'statusFailed', TERMINATED: 'statusTerminated', STOPPED: 'statusStopped'}[state] || 'statusUnknown');
    html += '<span class="m-badge m-badge-' + stClass + '"><i aria-hidden="true"></i>' + this.esc(stLabel) + '</span>';
    if (d.artifact_available === false) html += '<span class="m-badge m-badge-danger"><i aria-hidden="true"></i>' + this.esc(t('artifactOffline')) + '</span>';
    html += '</div>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="navigate(\'history\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>' + this.esc(t('backToHistory')) + '</button>';
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
      if (prevTab === 'samples' && tab !== 'samples') {
        this._sampleLayoutAction++;
        this._cancelSampleGridMotion?.(contentEl.querySelector('.m-tab-panel[data-tab="samples"]')?.querySelector('.preview-grid'));
        this._cancelPreviewMediaQueue();
        this._disconnectSampleExpansionUI?.();
      }
      if (prevTab === 'dataset' && tab !== 'dataset') {
        this._suspendDatasetDiagnostics?.();
        this.closeDatasetDiagModal?.();
        this._pauseDatasetDiagCharts?.(contentEl.querySelector('.m-tab-panel[data-tab="dataset"]'));
      }
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
      let restoreControlFocus;
      const sig = 'ov:' + this._shellLocale + ':' + this._summaryStatus(d, isHistory).state + ':' + this.trainParamsVersion;
      if (panelEmpty || this._builtOverviewSig !== sig || this._builtParamSchema !== window.TRAIN_SECTIONS) {
        this._builtOverviewSig = sig;
        this._builtParamSchema = window.TRAIN_SECTIONS;
        if (!tabChanged) panel.classList.add('no-enter-anim');
        const paramInput = panel.querySelector('.m-param-toolbar input');
        const paramFocus = paramInput && document.activeElement === paramInput
          ? { start: paramInput.selectionStart, end: paramInput.selectionEnd } : null;
        const overviewContext = isHistory ? 'history:' + this.selectedRunDir : 'live:' + (d.run_dir || this.liveTaskId || d.active_task?.id || '');
        const sameContext = panel.dataset.overviewContext === overviewContext;
        if (sameContext && panel.contains(document.activeElement)) {
          if (document.activeElement.hasAttribute('data-summary-toggle')) restoreControlFocus = '[data-summary-toggle]';
          if (document.activeElement.hasAttribute('data-summary-stop')) restoreControlFocus = '[data-summary-stop]';
        }
        const method = panel.querySelector('.m-diagnostic-details');
        const methodOpen = method?.open;
        const methodFocused = method && document.activeElement === method.querySelector('summary');
        const scrollTop = panel.scrollTop;
        panel.innerHTML = this._renderOverviewTab(d, t, isHistory);
        panel.dataset.overviewContext = overviewContext;
        delete panel.dataset.diagnosticVersion;
        delete panel.dataset.matrixVersion;
        delete panel.dataset.telemetryVersion;
        delete panel.dataset.motionContext;
        this.initMonitorParams(panel);
        if (sameContext) {
          const method = panel.querySelector('.m-diagnostic-details');
          if (method) method.open = !!methodOpen;
          panel.scrollTop = scrollTop;
          if (paramFocus) {
            const input = panel.querySelector('.m-param-toolbar input');
            input?.focus({ preventScroll: true });
            input?.setSelectionRange(paramFocus.start, paramFocus.end);
          } else if (methodFocused) method?.querySelector('summary')?.focus({ preventScroll: true });
        }
      }
      this._patchOverviewStatus(panel, d, t, isHistory);
      if (restoreControlFocus) panel.querySelector(restoreControlFocus + ':not([hidden])')?.focus({preventScroll:true});
      return;
    }
    if (tab === 'samples') {
      let freshlyRendered = false;
      // Loss mode/data update captions and Alpine overlays in place; rebuilding
      // this panel would destroy the sidebar viewport and restart its image.
      const sig = 'sm:' + this._shellLocale + ':' + this.previewsVersion + ':' + (this.weakNetworkMode ? 1 : 0) + ':' + (d.artifact_available === false ? 0 : 1) + ':' + String(d.preview_enabled);
      if (panelEmpty || this._builtSamplesSig !== sig) {
        // Removing a pressed card prevents the browser from dispatching click.
        // Pointer completion retries this render after the original click.
        if (this._sampleGridPointer && !this._sampleGridPointer.cancelled) {
          this._sampleGridPointer.renderPending = true;
          return;
        }
        this._disconnectSampleExpansionUI?.(true);
        this._sampleLayoutAction++;
        const grid = panel.querySelector('.preview-grid');
        const motionContext = JSON.stringify([this.currentOutputRunDir || '', this.selectedRunDir || '', this.sampleBatchSortDir,
          this._shellLocale, this.weakNetworkMode]);
        const before = grid && !tabChanged && !this._sampleResetScroll && panel._sampleMotionContext === motionContext
          ? this._captureSampleLayout(grid) : null;
        this._cancelSampleGridMotion?.(grid);
        const wasOverview = !!grid?.classList.contains('m-sample-batches');
        const scrollTop = grid?.scrollTop || 0;
        const focusedId = panel.contains(document.activeElement) ? document.activeElement.id : '';
        let anchor = null;
        if (grid && scrollTop > 0 && !this._sampleResetScroll) {
          // Recompute after a resize: the same scrollTop can now show a
          // different row when the number of grid columns changes.
          anchor = window.AnimaSampleLayout.captureAnchor(grid, null, this._sampleScrollAnchor);
        }
        const mediaRoot = document.getElementById('monitorDashboard') || panel;
        const loadedMedia = this._capturePreviewMedia(mediaRoot);
        this._cancelPreviewMediaQueue();
        this._builtSamplesSig = sig;
        panel._sampleMotionContext = motionContext;
        if (!tabChanged) panel.classList.add('no-enter-anim');
        panel.innerHTML = this._renderSamplesTab(t);
        freshlyRendered = true;
        delete panel._sampleLossVersion;
        window.AnimaSampleLayout.update(panel.querySelector('.m-samples-workspace'));
        const nextGrid = panel.querySelector('.preview-grid');
        this._restorePreviewMedia(mediaRoot, loadedMedia);
        const nextIsOverview = !!nextGrid?.classList.contains('m-sample-batches');
        const selectedBatch = nextIsOverview ? this._sampleSelectedBatch() : null;
        const latestBatch = nextIsOverview ? this._sampleDataModel().batches.at(-1) : null;
        const followLatest = nextIsOverview && !this.sampleLossSortKey && selectedBatch?.id === latestBatch?.id && this._sampleOverviewAtEnd !== false;
        this._sampleScrollAnchor = null;
        if (nextIsOverview && followLatest) {
          nextGrid.scrollTop = this._sampleOverviewLatestScrollTop(nextGrid);
        } else if (nextIsOverview && (!wasOverview || this._sampleResetScroll)) {
          this._scrollOverviewToBatch?.(panel, selectedBatch);
        } else if (nextGrid && !this._sampleResetScroll) {
          nextGrid.scrollTop = scrollTop;
          this._sampleScrollAnchor = window.AnimaSampleLayout.restoreAnchor(nextGrid, anchor);
        } else this._sampleScrollAnchor = null;
        this._sampleResetScroll = false;
        if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
        this._refreshSampleGroupOutline?.(panel);
        if (before && nextGrid && Array.from(nextGrid.querySelectorAll('.m-sample-tile')).some(item => !before.has(item.dataset.sampleTileKey))) {
          this._animateSampleLayout(nextGrid, before, '', {revealNew: true});
        }
      }
      this._patchSampleBatchOrder?.(panel, freshlyRendered);
      this._patchSampleLossCaptions?.(panel, freshlyRendered);
      this._connectSampleExpansionUI?.(panel);
      if (freshlyRendered || tabChanged || this._previewMediaRetryNeeded) {
        this._previewMediaRetryNeeded = false;
        this.schedulePreviewMediaLoads(document.getElementById('monitorDashboard') || panel);
      }
      return;
    }
    if (tab === 'outputs') {
      if ((this._outputFilesNeedsRefresh || (tabChanged && !this.outputFiles.length)) && !this.outputFilesLoading) this.loadOutputFiles();
      const sig = ['out', this._shellLocale, this.outputFilesVersion, this.selectedOutputFiles.join('|'),
        !this.outputFiles.length && this.outputFilesLoading && !this._outputFilesLoaded ? 1 : 0,
        this.outputSearch, this.outputFilter, this.outputModelSortKey, this.outputModelSortDir,
        this.outputStateSortKey, this.outputStateSortDir, this.outputOtherSortKey, this.outputOtherSortDir,
        this.outputFilesError || '', d.artifact_available === false ? 0 : 1].join(':');
      if (panelEmpty || this._builtOutputsSig !== sig) {
        // Preserve scroll position across re-renders
        const scrollEl = panel.querySelector('.m-outputs-scroll');
        const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
        this._builtOutputsSig = sig;
        // 仅在切换标签时淡入；加载完成和原地更新保持工具栏稳定。
        if (this.outputFilesLoading || (!tabChanged && !panelEmpty)) {
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
    if (tab === 'dataset') {
      const source = this._datasetDiagSource();
      if (this._datasetDiagSourceKey !== source.key
        || (!this._datasetDiagRequest && (this._datasetDiagNeedsRefresh || !this._datasetDiagLoaded))) {
        void this.loadDatasetDiagnostics({ renderStart: false, silent: this._datasetDiagLoaded });
      }
      if (!isHistory) this._syncDatasetDiagPolling?.();
      const data = this.datasetDiagData;
      const dataSig = this._datasetDiagSnapshotVersion;
      if (!source.key || !data || !data.available) {
        const emptySig = [
          'ddEmpty', this._shellLocale, dataSig,
          this.datasetDiagLoading ? 1 : 0, this.datasetDiagError || '',
          data?.reason || '', source.key,
          (!this.selectedRunDir && this.liveTaskId) ? 1 : 0,
        ].join(':');
        if (panelEmpty || panel.dataset.ddEmptySig !== emptySig) {
          panel._ddHeroRO?.disconnect();
          panel._ddHeroRO = null;
          if (!tabChanged && !panelEmpty) panel.classList.add('no-enter-anim');
          else panel.classList.remove('no-enter-anim');
          panel.innerHTML = this._renderDatasetDiagTab(t);
          panel.dataset.ddEmptySig = emptySig;
          panel._ddHeadingSig = '';
          panel._ddAnalysisSig = '';
          panel._ddImagesSig = '';
        }
        return;
      }

      const gfKey = this.datasetDiagGroupFilter ? (this.datasetDiagGroupFilter.dim + ':' + this.datasetDiagGroupFilter.key) : '';
      let shell = panel.querySelector('[data-dd-shell="1"]');
      if (!shell) {
        if (!tabChanged && !panelEmpty) panel.classList.add('no-enter-anim');
        else panel.classList.remove('no-enter-anim');
        panel.innerHTML = this._datasetDiagShellHtml(t);
        shell = panel.querySelector('[data-dd-shell="1"]');
        panel.dataset.ddEmptySig = '';
        panel._ddHeadingSig = '';
        panel._ddAnalysisSig = '';
        panel._ddImagesSig = '';
        panel._ddRenderedSearch = '';
      } else {
        panel.classList.add('no-enter-anim');
      }

      const headingSlot = shell.querySelector('[data-dd-slot="heading"]');
      const analysisSlot = shell.querySelector('[data-dd-slot="analysis"]');
      const imagesSlot = shell.querySelector('[data-dd-slot="images"]');
      const scrollTop = panel.scrollTop;

      const headingSig = JSON.stringify([
        this._shellLocale, dataSig, this.datasetDiagLoading, this.datasetDiagError,
        this.datasetDiagMinCount, this.datasetDiagRunId, source.key,
      ]);
      if (headingSlot && panel._ddHeadingSig !== headingSig) {
        panel._ddHeadingSig = headingSig;
        const activeId = (document.activeElement && headingSlot.contains(document.activeElement)) ? document.activeElement.id : '';
        headingSlot.innerHTML = this._renderDatasetDiagHeading(t, data);
        if (activeId) document.getElementById(activeId)?.focus({ preventScroll: true });
      }

      const analysisMode = this._ddActiveAnalysisMode
        ? this._ddActiveAnalysisMode(data)
        : (this.datasetDiagHeroMode === 'timestep' ? 'timestep' : 'quadrant');
      const analysisSig = JSON.stringify([
        this._shellLocale, dataSig, analysisMode,
        analysisMode === 'groups' ? this.datasetDiagGroupDim : '',
        analysisMode === 'groups' ? gfKey : '',
        source.key,
      ]);
      if (analysisSlot && panel._ddAnalysisSig !== analysisSig) {
        panel._ddAnalysisSig = analysisSig;
        const activeAnalysisId = (document.activeElement && analysisSlot.contains(document.activeElement)) ? document.activeElement.id : '';
        this._pauseDatasetDiagCharts(panel);
        analysisSlot.innerHTML = this._renderDatasetDiagAnalysisCard(t, data);
        if (activeAnalysisId) {
          const target = document.getElementById(activeAnalysisId);
          if (target && !target.disabled) target.focus({ preventScroll: true });
        }
      }

      const imagesSig = JSON.stringify([
        this._shellLocale, dataSig, this.datasetDiagPreset, gfKey,
        this.datasetDiagSearch, this.datasetDiagRegMode, this.datasetDiagSort,
        this.datasetDiagViewMode, this.datasetDiagDisplayLimit, source.key,
      ]);
      if (imagesSlot && panel._ddImagesSig !== imagesSig) {
        panel._ddImagesSig = imagesSig;
        const input = imagesSlot.querySelector('.m-output-search-input');
        const activeId = imagesSlot.contains(document.activeElement) ? document.activeElement.id : '';
        const focused = input && document.activeElement === input;
        const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
        const searchChanged = panel._ddRenderedSearch !== this.datasetDiagSearch;
        panel._ddRenderedSearch = this.datasetDiagSearch;
        if (input) input.remove();
        imagesSlot.innerHTML = this._renderDatasetDiagImagesCard(t, data);
        const replacement = imagesSlot.querySelector('.m-output-search-input');
        if (input && replacement) {
          replacement.replaceWith(input);
          if (searchChanged && input.value !== this.datasetDiagSearch) input.value = this.datasetDiagSearch;
          if (focused) { input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
        }
        if (!focused && activeId) {
          const target = document.getElementById(activeId);
          if (target && !target.disabled) target.focus({ preventScroll: true });
        }
      }
      panel.scrollTop = scrollTop;
      this._bindDatasetDiagCharts(panel);
      return;
    }
  },

  _disconnectDatasetDiagUI() {
    const panel = document.querySelector?.('.m-tab-panel[data-tab="dataset"]');
    this._pauseDatasetDiagCharts?.(panel);
    const modal = document.getElementById('datasetDiagModalRight');
    if (modal) {
      (modal._ddModalROs || []).forEach(observer => observer.disconnect());
      modal._ddModalROs = [];
    }
  },

  // 滑动指示条：跟随激活 tab 的位置与宽度（首次定位不播放动画）
  _syncMonitorTabIndicator() {
    const bar = document.querySelector('.monitor-tabs');
    if (!bar) return;
    const indicator = bar.querySelector('.ui-tab-indicator');
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

window.composeAppMixins(window.monitorRenderMixin, { logs: window.monitorLogRenderMixin, history: window.monitorHistoryRenderMixin });

window.composeAppMixins(window.monitorRenderMixin, { monitorArtifactsRenderMixin: window.monitorArtifactsRenderMixin });

window.composeAppMixins(window.monitorRenderMixin, { monitorDiagnosticsMixin: window.monitorDiagnosticsMixin });

window.composeAppMixins(window.monitorRenderMixin, { monitorSummaryMixin: window.monitorSummaryMixin });

window.composeAppMixins(window.monitorRenderMixin, { monitorDatasetDiagRenderMixin: window.monitorDatasetDiagRenderMixin });
