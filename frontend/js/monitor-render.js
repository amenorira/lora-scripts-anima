/* ================================================================
   monitor-render.js — Dashboard rendering (compact statusbar + rings + outputs)
   Mixin merged into animaApp Alpine component

   更新策略（消除闪烁）：
     1. 外壳层（单行信息条 + 资源圆环 或 历史横幅）：仅在首次/历史模式切换时构建，
        之后每 tick 原地打补丁（_patchStatusbar）。
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

    // ── 2. 粘性控制台：挂在 Dashboard 滚动区之外，每 tick 只做局部补丁 ──
    const controlEl = document.getElementById('monitorControlbar');
    if (controlEl) {
      const controlMode = isHistory ? 'history' : 'live';
      const controlSignature = isHistory
        ? [controlMode, locale, this.selectedRunDir || '', d.config && d.config.output_name || '', d.train_result && d.train_result.status || '', d.train_result && d.train_result.duration_str || ''].join(':')
        : [controlMode, locale].join(':');
      if (this._controlbarSignature !== controlSignature || !controlEl.firstElementChild) {
        this._controlbarMode = controlMode;
        this._controlbarSignature = controlSignature;
        controlEl.innerHTML = isHistory ? this._historyBannerHtml(d, t) : this._statusbarHtml(d, t);
      }
      if (!isHistory) this._patchStatusbar(d, t);
    }

    // 页头右侧资源监控（仅实时模式；历史模式由 x-show 隐藏）
    if (!isHistory) {
      this._renderResourceBar('monitorResbar', gpu, sys, t, locale);
    }

    // ── 3. 标签页内容 ──
    this._renderTab(tab, d, gpu, sys, t, isHistory);

    // ── 4. Tab 滑动指示条：按钮文本/计数徽标变化时重算位置 ──
    const tabIndicatorSig = tab + '|' + locale + '|' + (this.logFullTotal || this.logTotal || this.logLines.length) + '|' + this.previews.length + '|' + this.outputTabCount;
    if (this._tabIndicatorSig !== tabIndicatorSig) {
      this._tabIndicatorSig = tabIndicatorSig;
      requestAnimationFrame(() => this._syncMonitorTabIndicator());
    }
  },

  // ═══════════════════════════════════════════════════════════
  //  外壳：任务控制条
  // ═══════════════════════════════════════════════════════════
  _statusbarHtml(d, t) {
    const stateCode = d.state || 'IDLE';
    const stateLabels = {'RUNNING':t('training'),'FINISHED':t('finished'),'TERMINATED':t('terminated'),'FAILED':t('error'),'CREATED':t('created'),'UNKNOWN':t('taskStateUnknown'),'IDLE':t('idle')};
    const state = stateLabels[stateCode] || stateCode;
    const isTraining = stateCode === 'RUNNING';
    const isActive = this._isActiveState(stateCode);
    const percent = Math.max(0, Math.min(100, Number(d.percent) || 0));
    const stepText = (d.step != null ? d.step : 0) + ' / ' + (d.total_steps != null ? d.total_steps : 0);
    const connection = this._monitorConnectionMeta(t, stateCode);

    let html = '<div class="m-statusbar" data-state="' + this.esc(stateCode.toLowerCase()) + '">';
    html += '<div class="m-sb-identity">';
    html += '<span class="m-sb-state-icon" aria-hidden="true"></span>';
    html += '<div class="m-sb-state-copy"><strong class="m-sb-state" data-field="state">' + this.esc(state) + '</strong><span class="m-sb-connection" data-role="connection" data-tone="' + connection.tone + '" role="status" aria-live="polite"><i aria-hidden="true"></i><span data-field="connection">' + this.esc(connection.label) + '</span></span></div>';
    html += '</div>';
    html += '<div class="m-sb-progress-block" data-role="progress"' + (isTraining ? '' : ' hidden') + '>';
    html += '<div class="m-sb-progress-meta"><span data-field="step">' + this.esc(stepText) + '</span><strong data-field="pct">' + percent + '%</strong></div>';
    html += '<div class="m-sb-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '"><div class="m-sb-bar" data-bar="progress" style="width:' + percent + '%"></div></div>';
    html += '</div>';
    html += '<span class="m-sb-error" data-role="error"' + (d.has_error ? '' : ' hidden') + '>' + this.esc(d.error_msg || t('error')) + '</span>';
    html += '<span class="m-sb-error" data-role="restart"' + (this.realtimeTaskStateUnknown ? '' : ' hidden') + '>' + this.esc(t('taskStateUnknown')) + '</span>';
    html += '<div class="m-sb-idle-copy" data-role="idle-copy"' + (isActive ? ' hidden' : '') + '>' + this.esc(t('readyToTrain')) + '</div>';
    html += '<div class="m-sb-right" data-role="actions"' + (isActive ? '' : ' hidden') + '><button class="btn btn-sm m-sb-stop" @click="stopTraining()"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>' + this.esc(t('stopTraining')) + '</button></div>';
    html += '</div>';
    return html;
  },

  _monitorConnectionMeta(t, stateCode) {
    if (this.realtimeState === 'online') {
      return this._isActiveState(stateCode)
        ? { label: t('liveConnected'), tone: 'ok' }
        : { label: t('standby'), tone: 'muted' };
    }
    if (this.realtimeState === 'degraded' || this.realtimeState === 'connecting') {
      return { label: t('realtimeDelayed'), tone: 'warn' };
    }
    return { label: t('reconnecting'), tone: 'warn' };
  },

  // ═══════════════════════════════════════════════════════════
  //  右上角常驻资源芯片（写入 #monitorResbar）
  // ═══════════════════════════════════════════════════════════
  _resbarHtml(gpu, sys, t) {
    if (!gpu && !sys) return '';
    let html = '';
    if (sys) html += this._sysChip(sys, t);
    if (gpu) html += this._gpuChip(gpu, t);
    return html;
  },

  // 资源数值颜色等级（统一阈值）
  //   百分比类：≥75% warn(橙)，≥90% danger(红)
  //   温度：    ≥70℃ warn(橙)，≥85℃ danger(红)
  // 返回 'ok'(绿) / 'warn'(橙) / 'danger'(红)
  _resGrade(pct) {
    const v = pct || 0;
    if (v >= 90) return 'danger';
    if (v >= 75) return 'warn';
    return 'ok';
  },
  _resGradeTemp(temp) {
    if (temp == null) return 'ok';
    if (temp >= 85) return 'danger';
    if (temp >= 70) return 'warn';
    return 'ok';
  },

  // 系统资源组：型号 + CPU/内存 文字数值
  _sysChip(sys, t) {
    const fullName = sys.cpu_name || t('cpu');
    let html = '<div class="m-res-chip" data-res="sys">';
    html += '<span class="m-res-chip-name" title="' + this.esc(fullName) + '">' + this.esc(fullName) + '</span>';
    html += '<div class="m-res-stats">';
    html += this._resMeterHtml('cpu', t('cpu'), sys.cpu_pct, 'cpu-pct');
    html += this._resMeterHtml('ram', t('ram'), sys.ram_pct, 'ram-pct', sys.ram_used_gb.toFixed(1) + '/' + sys.ram_total_gb.toFixed(1) + 'G', 'ram-text');
    html += '</div>';
    html += '</div>';
    return html;
  },

  // GPU 资源组：型号 + 负载/显存/温度 文字数值
  _gpuChip(gpu, t) {
    const loadPct = gpu.gpu_load_pct || 0;
    const vramPct = gpu.vram_total_mb > 0 ? (gpu.vram_used_mb / gpu.vram_total_mb * 100) : 0;
    const temp = gpu.temperature_c;
    const fullName = gpu.name || 'GPU';
    let html = '<div class="m-res-chip" data-res="gpu">';
    if (gpu.gpus && gpu.gpus.length > 1) {
      html += '<select class="m-gpu-select" aria-label="GPU" @change="selectedGpuIndex=Number($event.target.value);renderDashboard()">';
      for (const device of gpu.gpus) html += '<option value="' + device.index + '"' + (device.index === gpu.index ? ' selected' : '') + '>GPU ' + device.index + ' · ' + this.esc(device.name) + '</option>';
      html += '</select>';
    } else html += '<span class="m-res-chip-name" title="' + this.esc(fullName) + '">' + this.esc(fullName) + '</span>';
    html += '<div class="m-res-stats">';
    html += this._resMeterHtml('gpu', t('gpuLoad'), loadPct, 'load-pct');
    html += this._resMeterHtml('vram', t('vramUsed'), vramPct, 'vram-pct', (gpu.vram_used_mb / 1024).toFixed(1) + '/' + (gpu.vram_total_mb / 1024).toFixed(1) + 'G', 'vram-text');
    if (temp != null) html += '<span class="m-res-stat"><span class="m-res-stat-label">' + this.esc(t('gpuTemp')) + '</span><span class="m-res-stat-val m-res-' + this._resGradeTemp(temp) + '" data-field="temp-val">' + temp + '°</span></span>';
    if (gpu.power_w != null) html += '<span class="m-res-stat"><span class="m-res-stat-label">' + this.esc(t('gpuPower')) + '</span><span class="m-res-stat-val" data-field="power-text">' + gpu.power_w + 'W</span></span>';
    html += '</div>';
    html += '</div>';
    return html;
  },

  _resMeterHtml(kind, label, pct, valueField, subText, subField) {
    const value = Math.max(0, Math.min(100, Number(pct) || 0));
    let html = '<span class="m-res-stat m-res-meter" data-meter="' + kind + '">';
    html += '<span class="m-res-stat-line"><span class="m-res-stat-label">' + this.esc(label) + '</span><span class="m-res-stat-val m-res-' + (kind === 'gpu' || kind === 'cpu' ? 'ok' : this._resGrade(value)) + '" data-field="' + valueField + '">' + Math.round(value) + '%</span>';
    if (subText) html += '<span class="m-res-stat-sub" data-field="' + subField + '">' + this.esc(subText) + '</span>';
    html += '</span><span class="m-res-mini"><i data-meter-fill="' + kind + '" style="width:' + value + '%"></i></span></span>';
    return html;
  },

  _renderResourceBar(containerId, gpu, sys, t, locale) {
    const bar = document.getElementById(containerId);
    if (!bar) return;
    if (gpu && gpu.gpus && gpu.gpus.length) {
      const device = gpu.gpus.find(item => item.index === this.selectedGpuIndex) || gpu.gpus[0];
      gpu = Object.assign({}, device, { gpus: gpu.gpus });
    }
    const localeKey = String(locale || '') + ':' + String(sys && sys.cpu_name || '') + ':' + JSON.stringify(gpu ? [gpu.index, gpu.name, gpu.temperature_c != null, gpu.power_w != null, (gpu.gpus || []).map(g => [g.index, g.name])] : null);
    if (!bar.firstElementChild || bar.dataset.locale !== localeKey) {
      bar.dataset.locale = localeKey;
      bar.innerHTML = this._resbarHtml(gpu, sys, t);
    }
    this._patchResbar(gpu, sys, t, containerId);
  },

  _patchResbar(gpu, sys, t, containerId = 'monitorResbar') {
    const bar = document.getElementById(containerId);
    if (!bar) return;
    // 若结构未就绪或 GPU 可用性切换，则重建
    const hasGpuChip = !!bar.querySelector('[data-res="gpu"]');
    const hasSysChip = !!bar.querySelector('[data-res="sys"]');
    if ((!!gpu) !== hasGpuChip || (!!sys) !== hasSysChip) {
      bar.innerHTML = this._resbarHtml(gpu, sys, t);
    }
    // 更新数值文本 + 颜色等级 class
    const _set = (key, val, grade) => {
      const e = bar.querySelector('[data-field="' + key + '"]');
      if (!e) return;
      e.textContent = val;
      if (grade) e.className = 'm-res-stat-val m-res-' + grade;
    };
    const _meter = (key, val) => {
      const e = bar.querySelector('[data-meter-fill="' + key + '"]');
      if (e) e.style.width = Math.max(0, Math.min(100, Number(val) || 0)) + '%';
    };
    if (gpu) {
      _set('load-pct', Math.round(gpu.gpu_load_pct || 0) + '%', 'ok');
      _meter('gpu', gpu.gpu_load_pct || 0);
      const vramPct = gpu.vram_total_mb > 0 ? Math.round(gpu.vram_used_mb / gpu.vram_total_mb * 100) : 0;
      _set('vram-pct', vramPct + '%', this._resGrade(vramPct));
      _meter('vram', vramPct);
      _set('vram-text', (gpu.vram_used_mb / 1024).toFixed(1) + '/' + (gpu.vram_total_mb / 1024).toFixed(1) + 'G');
      if (gpu.temperature_c != null) _set('temp-val', gpu.temperature_c + '°', this._resGradeTemp(gpu.temperature_c));
      if (gpu.power_w != null) _set('power-text', gpu.power_w + 'W');
    }
    if (sys) {
      _set('cpu-pct', Math.round(sys.cpu_pct) + '%', 'ok');
      _set('ram-pct', Math.round(sys.ram_pct) + '%', this._resGrade(sys.ram_pct));
      _meter('cpu', sys.cpu_pct);
      _meter('ram', sys.ram_pct);
      _set('ram-text', sys.ram_used_gb.toFixed(1) + '/' + sys.ram_total_gb.toFixed(1) + 'G');
    }
  },

  // ── 外壳原地打补丁 ──
  _patchStatusbar(d, t) {
    const bar = document.querySelector('.m-statusbar');
    if (!bar) return;
    const stateCode = d.state || 'IDLE';
    const stateLabels = {'RUNNING':t('training'),'FINISHED':t('finished'),'TERMINATED':t('terminated'),'FAILED':t('error'),'CREATED':t('created'),'UNKNOWN':t('taskStateUnknown'),'IDLE':t('idle')};
    const state = stateLabels[stateCode] || stateCode;
    const isTraining = stateCode === 'RUNNING';
    const isActive = this._isActiveState(stateCode);
    bar.dataset.state = stateCode.toLowerCase();
    const stateEl = bar.querySelector('[data-field="state"]');
    if (stateEl) stateEl.textContent = state;
    // 进度条 + 百分比
    const progressBlock = bar.querySelector('[data-role="progress"]');
    const progressWrap = bar.querySelector('.m-sb-progress');
    const progressBar = bar.querySelector('[data-bar="progress"]');
    const percent = Math.max(0, Math.min(100, Number(d.percent) || 0));
    if (progressWrap) {
      progressWrap.setAttribute('aria-valuenow', String(percent));
    }
    if (progressBlock) progressBlock.hidden = !isTraining;
    if (progressBar) progressBar.style.width = percent + '%';
    const pctEl = bar.querySelector('[data-field="pct"]');
    if (pctEl) pctEl.textContent = percent + '%';
    const stepEl = bar.querySelector('[data-field="step"]');
    if (stepEl) stepEl.textContent = (d.step != null ? d.step : 0) + ' / ' + (d.total_steps != null ? d.total_steps : 0);
    const connection = this._monitorConnectionMeta(t, stateCode);
    const connectionWrap = bar.querySelector('[data-role="connection"]');
    const connectionEl = bar.querySelector('[data-field="connection"]');
    if (connectionWrap) connectionWrap.dataset.tone = connection.tone;
    if (connectionEl) connectionEl.textContent = connection.label;
    const actions = bar.querySelector('[data-role="actions"]');
    if (actions) actions.hidden = !isActive;
    const idleCopy = bar.querySelector('[data-role="idle-copy"]');
    if (idleCopy) {
      idleCopy.hidden = isActive;
      idleCopy.textContent = stateCode === 'IDLE' ? t('readyToTrain') : (d.train_result && d.train_result.duration_str || '');
    }
    const errorEl = bar.querySelector('[data-role="error"]');
    if (errorEl) {
      errorEl.hidden = !d.has_error;
      errorEl.textContent = d.error_msg || t('error');
    }
    const restartEl = bar.querySelector('[data-role="restart"]');
    if (restartEl) restartEl.hidden = !this.realtimeTaskStateUnknown;
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
    if (d.train_result) {
      const st = d.train_result.status || '';
      const dur = d.train_result.duration_str || '';
      const stClass = st === 'completed' ? 'ok' : (st === 'failed' ? 'danger' : 'muted');
      const stLabel = st === 'completed' ? t('statusCompleted') : (st === 'failed' ? t('statusFailed') : (st === 'terminated' ? t('statusTerminated') : (st === 'running' ? t('statusRunning') : st)));
      html += '<span class="m-badge m-badge-' + stClass + '"><i aria-hidden="true"></i>' + this.esc(stLabel) + '</span>';
      if (dur) html += '<span class="m-history-dur">' + this.esc(dur) + '</span>';
    }
    if (d.artifact_available === false) html += '<span class="m-badge m-badge-danger"><i aria-hidden="true"></i>' + this.esc(t('artifactOffline')) + '</span>';
    html += '<div class="m-history-spacer"></div>';
    html += '<button class="btn btn-sm" @click="clearRunDetail()">← ' + this.esc(t('backToLive')) + '</button>';
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
          // 入场动画期间隐藏滚动条 thumb（动画的向下位移会临时撑大滚动区，导致 thumb 闪现）
          panel.classList.add('scroll-entering');
          clearTimeout(panel._scrollEnteringTimer);
          panel._scrollEnteringTimer = setTimeout(() => panel.classList.remove('scroll-entering'), 520);
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
      const sig = 'ov:' + this._shellLocale + ':' + (d.state||'') + ':' + this.trainParamsVersion + ':' + (d.train_result ? d.train_result.status : '');
      if (panelEmpty || this._builtOverviewSig !== sig) {
        this._builtOverviewSig = sig;
        if (!tabChanged) panel.classList.add('no-enter-anim');
        panel.innerHTML = this._renderOverviewTab(d, t, isHistory);
        delete panel.dataset.diagnosticVersion;
        delete panel.dataset.paramQuery;
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
        const focused = input && document.activeElement === input;
        const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
        if (input) input.remove();
        panel.innerHTML = this._renderOutputsTab(t);
        const replacement = panel.querySelector('.m-output-search-input');
        if (input && replacement) {
          replacement.replaceWith(input);
          if (focused) { input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
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

  // ═══════════════════════════════════════════════════════════
  //  概览标签
  // ═══════════════════════════════════════════════════════════

  // 训练参数标签：用字段 key 名（简洁，与训练表单 field-key 一致）。
  // network_args/optimizer_args 子项用 label_raw（如 algo/preset）。
  // 兼容旧后端响应（p.label 直接用）。
  _paramLabel(p) {
    if (p.label_raw) return this.esc(p.label_raw);
    if (p.label) return this.esc(p.label);
    return this.esc(p.key || '');
  },

  // 训练参数 hover title：用 desc_key 取 i18n 完整描述句，供鼠标悬停提示。
  _paramTitle(p, t) {
    if (p.desc_key) {
      const v = t(p.desc_key, '');
      return v && v !== p.desc_key ? v : '';
    }
    return '';
  },

  // 训练参数值 HTML：toggle 类型渲染 ✓/✕ 徽标，其余正常转义显示。
  _paramValueHtml(p) {
    const v = String(p.value == null ? '' : p.value);
    if (p.type === 'toggle') {
      const on = v === 'true' || v === 'True';
      return '<span class="param-toggle ' + (on ? 'on' : 'off') + '">' + (on ? '✓' : '✕') + '</span>';
    }
    return this.esc(v);
  },

  _patchOverviewStatus(root, d, t, isHistory) {
    if (!d || !root) return;
    const percent = isHistory && d.train_result && d.train_result.status === 'completed'
      ? 100 : Math.max(0, Math.min(100, Number(d.percent) || 0));
    const values = {
      step: (d.step != null ? d.step : '?') + ' / ' + (d.total_steps != null ? d.total_steps : '?') + ' (' + percent + '%)',
      loss: this._seriesLatest('loss/average', d.loss != null ? d.loss : '—'),
      lr: d.lr != null ? this._formatLearningRate(d.lr, String(d.lr)) : this._seriesLatest('lr/unet'),
      epoch: d.epoch != null ? d.epoch : '--',
      elapsed: d.elapsed || (isHistory && d.train_result && d.train_result.duration_str) || '--',
      eta: isHistory || ['FINISHED', 'FAILED', 'TERMINATED'].includes(d.state) ? '—' : (d.eta || '--'),
      speed: d.speed || '--',
    };
    Object.keys(values).forEach(key => {
      const el = root.querySelector('[data-live-field="' + key + '"]');
      if (el) el.textContent = String(values[key]);
    });
    const progress = root.querySelector('[data-overview-progress]');
    const progressValue = root.querySelector('[data-overview-percent]');
    if (progress) progress.style.width = percent + '%';
    if (progressValue) progressValue.textContent = percent + '%';
    this._patchTrainingDiagnostics(root, t, d, isHistory);
    const paramQuery = String(this.monitorParamQuery || '').trim().toLowerCase();
    if (paramQuery && root.dataset.paramQuery !== paramQuery) {
      root.dataset.paramQuery = paramQuery;
      this.filterMonitorParams();
    }
  },

  _renderOverviewTab(d, t, isHistory) {
    let html = '';
    const isRunning = d.state === 'RUNNING';
    html += '<div class="m-overview-grid">';
    html += this._overviewMetricsHtml(d, t, isHistory, isRunning);
    html += this._trainingDiagnosticsHtml(t);
    html += '</div>';
    if (this.trainParams.length) html += this._parametersConsoleHtml(t);
    else if (!isRunning) html += '<div class="m-console-card m-empty-params"><div class="m-card-heading"><span>' + this.esc(t('trainParams')) + '</span></div><div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('noParamsHint')) + '</p></div></div>';
    return html;
  },

  _overviewMetricsHtml(d, t, isHistory, isRunning) {
    const tr = d.train_result || {};
    const completed = tr.status === 'completed' || d.state === 'FINISHED';
    const historyStatus = tr.status === 'completed' ? t('statusCompleted')
      : (tr.status === 'failed' ? t('statusFailed')
        : (tr.status === 'terminated' ? t('statusTerminated')
          : (tr.status === 'running' ? t('statusRunning') : (tr.status || t('finished')))));
    const percent = completed ? 100 : Math.max(0, Math.min(100, Number(d.percent) || 0));
    const loss = this._seriesLatest('loss/average', d.loss != null ? d.loss : '—');
    const lr = d.lr != null ? this._formatLearningRate(d.lr, String(d.lr)) : this._seriesLatest('lr/unet');
    let html = '<section class="m-console-card m-overview-metrics">';
    html += '<div class="m-card-heading"><span>' + this.esc(isHistory || tr.status ? t('runSummary') : t('liveMetrics')) + '</span><span class="m-card-status">' + this.esc(isHistory || tr.status ? historyStatus : (isRunning ? t('live') : d.state === 'CREATED' ? t('created') : t('standby'))) + '</span></div>';
    if (d.state === 'CREATED' && !isHistory) {
      return html + '<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('created')) + '</p></div></section>';
    }
    if (!isRunning && !isHistory && !['FINISHED', 'FAILED', 'TERMINATED'].includes(d.state)) {
      html += '<div class="m-idle-hero"><span class="m-idle-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9l6 3"/><circle cx="12" cy="12" r="9"/></svg></span><div><strong>' + this.esc(t('readyToTrain')) + '</strong><span>' + this.esc(t('readyToTrainHint')) + '</span></div></div>';
      html += '<button type="button" class="btn btn-primary m-start-training" @click="navigate(\'train-basic\')">' + this.esc(t('goToTraining')) + ' →</button>';
      if (d.last_config && d.last_config.name) {
        const lc = d.last_config;
        html += '<div class="m-last-run"><span>' + this.esc(t('lastTraining')) + '</span><strong>' + this.esc(lc.name) + '</strong><small>' + this.esc((lc.model || '') + ' · LR ' + (lc.lr || '--') + ' · ' + (lc.epochs || '--') + ' Epochs') + '</small></div>';
      }
      html += '</section>';
      return html;
    }
    if (isHistory || !isRunning) html += '<div class="m-overview-progress-head"><span>' + this.esc(t('overallProgress')) + '</span><strong data-live-field="step"></strong></div>';
    const metrics = [
      ['loss', t('loss'), loss], ['lr', t('lr'), lr],
      ['epoch', t('epoch'), d.epoch != null ? d.epoch : '--'], ['speed', t('speed'), d.speed || '--'],
      ['elapsed', t('elapsed'), d.elapsed || tr.duration_str || '--'], ['eta', t('remaining'), isHistory ? '—' : (d.eta || '--')],
    ];
    html += '<div class="m-live-metrics">';
    metrics.forEach((item, idx) => {
      html += '<div class="m-live-metric' + (idx < 2 ? ' primary' : '') + '"><span>' + this.esc(item[1]) + '</span><strong data-live-field="' + item[0] + '">' + this.esc(String(item[2])) + '</strong></div>';
    });
    html += '</div></section>';
    return html;
  },

  _seriesLatest(tag, fallback = '—') {
    const series = (this.lossSeries || []).find(item => item.tag === tag);
    if (!series) return fallback;
    const value = series.latest != null ? series.latest : (series.points && series.points.length ? series.points[series.points.length - 1].value : null);
    if (value == null || !Number.isFinite(Number(value))) return fallback;
    const number = Number(value);
    return tag.startsWith('lr/') ? this._formatLearningRate(number, fallback) : number.toFixed(4);
  },

  _formatLearningRate(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    if (!(Math.abs(number) > 0 && Math.abs(number) < 0.001)) return Number(number.toPrecision(6)).toString();
    const parts = number.toExponential(4).split('e');
    const exponent = Number(parts[1]);
    const sign = exponent < 0 ? '-' : '+';
    return Number(parts[0]) + 'e' + sign + String(Math.abs(exponent)).padStart(2, '0');
  },

  _trainingDiagnosticPoints() {
    const series = (this.lossSeries || []).find(item => item.tag === 'loss/average')
      || (this.lossSeries || []).find(item => item.tag === 'loss/current');
    const byStep = new Map();
    ((series && (series.diagnostic_points || series.points)) || []).forEach(point => {
      const rawStep = point && point.step;
      const rawValue = point && point.value;
      const step = Number(rawStep);
      const value = Number(rawValue);
      if (rawStep !== null && rawStep !== '' && rawStep !== undefined && rawValue !== null && rawValue !== '' && rawValue !== undefined && Number.isFinite(step) && Number.isFinite(value)) {
        byStep.set(step, { step, value });
      }
    });
    return {
      tag: series ? series.tag : 'loss/average',
      points: Array.from(byStep.values()).sort((left, right) => left.step - right.step),
    };
  },

  _trainingDiagnosticRules() {
    return {
      minimumPoints: 6,
      windowMax: 60,
      reboundChange: 3,
      volatileCv: 12,
      convergingChange: -2,
      plateauAbsChange: 1,
      plateauCv: 4,
    };
  },

  _trainingDiagnostics(points) {
    const rules = this._trainingDiagnosticRules();
    let sourceTag = 'loss/average';
    let clean;
    if (Array.isArray(points)) {
      const byStep = new Map();
      points.forEach(point => {
        const rawStep = point && point.step;
        const rawValue = point && point.value;
        const step = Number(rawStep);
        const value = Number(rawValue);
        if (rawStep !== null && rawStep !== '' && rawStep !== undefined && rawValue !== null && rawValue !== '' && rawValue !== undefined && Number.isFinite(step) && Number.isFinite(value)) {
          byStep.set(step, { step, value });
        }
      });
      clean = Array.from(byStep.values()).sort((left, right) => left.step - right.step);
    } else {
      const source = this._trainingDiagnosticPoints();
      sourceTag = source.tag;
      clean = source.points;
    }

    const base = {
      code: 'insufficient', tone: 'muted', sourceTag, count: clean.length,
      windowSize: 0, latestStep: clean.length ? clean[clean.length - 1].step : null,
      recentMean: null, previousMean: null, changePct: null, volatilityPct: null,
      bestValue: null, bestStep: null, gapFromBestPct: null,
      previousStartStep: null, previousEndStep: null, recentStartStep: null, recentEndStep: null,
    };
    if (!clean.length) return base;

    let best = clean[0];
    clean.forEach(point => { if (point.value <= best.value) best = point; });
    base.bestValue = best.value;
    base.bestStep = best.step;
    base.gapFromBestPct = (clean[clean.length - 1].value - best.value) / Math.max(Math.abs(best.value), 1e-12) * 100;
    if (clean.length < rules.minimumPoints) return base;

    const desiredWindow = rules.windowMax;
    const windowSize = Math.min(desiredWindow, Math.floor(clean.length / 2));
    const recent = clean.slice(-windowSize);
    const previous = clean.slice(-windowSize * 2, -windowSize);
    const mean = values => values.reduce((sum, point) => sum + point.value, 0) / values.length;
    const recentMean = mean(recent);
    const previousMean = mean(previous);
    const variance = recent.reduce((sum, point) => sum + Math.pow(point.value - recentMean, 2), 0) / recent.length;
    const changePct = (recentMean - previousMean) / Math.max(Math.abs(previousMean), 1e-12) * 100;
    const volatilityPct = Math.sqrt(variance) / Math.max(Math.abs(recentMean), 1e-12) * 100;
    Object.assign(base, {
      windowSize, recentMean, previousMean, changePct, volatilityPct,
      previousStartStep: previous[0].step,
      previousEndStep: previous[previous.length - 1].step,
      recentStartStep: recent[0].step,
      recentEndStep: recent[recent.length - 1].step,
    });

    if (changePct >= rules.reboundChange) Object.assign(base, { code: 'rebound', tone: 'danger' });
    else if (volatilityPct >= rules.volatileCv) Object.assign(base, { code: 'volatile', tone: 'danger' });
    else if (changePct <= rules.convergingChange) Object.assign(base, { code: 'converging', tone: 'ok' });
    else if (Math.abs(changePct) < rules.plateauAbsChange && volatilityPct < rules.plateauCv) Object.assign(base, { code: 'plateau', tone: 'warn' });
    else Object.assign(base, { code: 'steady', tone: 'neutral' });
    return base;
  },

  _formatDiagnosticValue(value) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    if (Math.abs(number) > 0 && Math.abs(number) < 0.001) return number.toExponential(3);
    return number.toFixed(4);
  },

  _formatDiagnosticPercent(value, signed) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    const normalized = Math.abs(number) < 0.05 ? 0 : number;
    return (signed && normalized > 0 ? '+' : '') + normalized.toFixed(1) + '%';
  },

  _diagnosticText(t, code, kind) {
    const copy = {
      insufficient: {
        label: ['diagnosticInsufficient', '数据不足'],
        summary: ['diagnosticInsufficientSummary', '至少需要 6 个有效 Loss 点才能判断近期趋势。'],
        advice: ['diagnosticInsufficientAdvice', '训练开始后诊断会随 Loss 数据自动更新。'],
      },
      converging: {
        label: ['diagnosticConverging', '训练 Loss 持续下降'],
        summary: ['diagnosticConvergingSummary', '近期训练 Loss 平均值持续下降，优化目标仍在改善。'],
        advice: ['diagnosticConvergingAdvice', '可保持当前配置继续观察，并用固定提示词样本确认实际质量变化。'],
      },
      plateau: {
        label: ['diagnosticPlateau', '进入平台期'],
        summary: ['diagnosticPlateauSummary', '近期变化很小且波动不大，Loss 可能进入平台期。'],
        advice: ['diagnosticPlateauAdvice', '结合样本质量判断是否继续；需要细节时打开 TensorBoard。'],
      },
      rebound: {
        label: ['diagnosticRebound', '近期反弹'],
        summary: ['diagnosticReboundSummary', '近期 Loss 平均值明显高于前一段时间。'],
        advice: ['diagnosticReboundAdvice', '先观察下一 Epoch；若持续反弹，再检查学习率与数据。'],
      },
      volatile: {
        label: ['diagnosticVolatile', '波动异常'],
        summary: ['diagnosticVolatileSummary', '近期 Loss 起伏较大，训练稳定性需要关注。'],
        advice: ['diagnosticVolatileAdvice', '优先检查学习率、batch size 和异常样本，不要因为某一步的数值变化就停止训练。'],
      },
      steady: {
        label: ['diagnosticSteady', '平稳运行'],
        summary: ['diagnosticSteadySummary', '近期波动可控，但改善幅度暂不显著。'],
        advice: ['diagnosticSteadyAdvice', '继续关注样本质量和后续窗口变化。'],
      },
    };
    const item = copy[code] || copy.insufficient;
    return t(item[kind][0], item[kind][1]);
  },

  _fillDiagnosticTemplate(template, values) {
    let result = String(template || '');
    Object.keys(values).forEach(key => {
      result = result.split('{' + key + '}').join(String(values[key]));
    });
    return result;
  },

  _diagnosticEvidence(t, diagnostic) {
    const rules = this._trainingDiagnosticRules();
    const values = {
      count: diagnostic.count,
      minimum: rules.minimumPoints,
      window: diagnostic.windowSize,
      change: this._formatDiagnosticPercent(diagnostic.changePct, true),
      magnitude: this._formatDiagnosticPercent(Math.abs(Number(diagnostic.changePct)), false),
      volatility: this._formatDiagnosticPercent(diagnostic.volatilityPct, false),
      rebound: rules.reboundChange,
      volatile: rules.volatileCv,
      converging: Math.abs(rules.convergingChange),
      plateauChange: rules.plateauAbsChange,
      plateauVolatility: rules.plateauCv,
    };
    const copy = {
      insufficient: ['diagnosticEvidenceInsufficient', '当前 {count} 个有效 Loss 点；至少 {minimum} 个点后才会比较两个相邻时间段。'],
      converging: ['diagnosticEvidenceConverging', '近期平均值下降 {magnitude}，达到 ≤ -{converging}% 的下降条件；波动程度 {volatility} 未达到 {volatile}% 异常阈值。'],
      plateau: ['diagnosticEvidencePlateau', '平均值变化幅度 {magnitude} < {plateauChange}%，且波动程度 {volatility} < {plateauVolatility}%，符合平台期条件。'],
      rebound: ['diagnosticEvidenceRebound', '近期平均值上升 {magnitude}，达到 ≥ +{rebound}% 的反弹条件；反弹信号优先判定。'],
      volatile: ['diagnosticEvidenceVolatile', '近期波动程度 {volatility}，达到 ≥ {volatile}% 的异常条件；同期平均值变化为 {change}。'],
      steady: ['diagnosticEvidenceSteady', '平均值变化 {change}、波动程度 {volatility}，不符合下降、反弹、异常波动或平台期条件。'],
    };
    const item = copy[diagnostic.code] || copy.insufficient;
    return this._fillDiagnosticTemplate(t(item[0], item[1]), values);
  },

  _diagnosticWindowEvidence(t, diagnostic) {
    if (!diagnostic.windowSize) return t('diagnosticWindowPending');
    return this._fillDiagnosticTemplate(
      t('diagnosticWindowEvidence'),
      {
        recentStart: Math.round(diagnostic.recentStartStep),
        recentEnd: Math.round(diagnostic.recentEndStep),
        previousStart: Math.round(diagnostic.previousStartStep),
        previousEnd: Math.round(diagnostic.previousEndStep),
        window: diagnostic.windowSize,
      }
    );
  },

  _trainingDiagnosticsHtml(t) {
    const rules = this._trainingDiagnosticRules();
    let html = '<section class="m-console-card m-training-diagnostics">';
    html += '<div class="m-card-heading"><div><span data-diagnostic-field="title">' + this.esc(t('trainingDiagnostics')) + '</span><small data-diagnostic-field="subtitle">' + this.esc(t('diagnosticSubtitle')) + '</small></div><button type="button" class="btn btn-sm btn-secondary m-tensorboard-link" @click="navigate(\'tensorboard\')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V9m7 10V5m7 14v-7"/></svg>' + this.esc(t('openTensorBoard')) + '</button></div>';
    html += '<div class="m-diagnostic-body">';
    html += '<div class="m-diagnostic-verdict" data-diagnostic-tone="muted"><span class="m-diagnostic-eyebrow">' + this.esc(t('convergenceSignal')) + '</span><div class="m-diagnostic-state"><i aria-hidden="true"></i><strong data-diagnostic-field="state">--</strong></div><p data-diagnostic-field="summary">--</p><div class="m-diagnostic-source"><span data-diagnostic-field="source">--</span><span data-diagnostic-field="through-step">--</span></div></div>';
    html += '</div><div class="m-diagnostic-metrics">';
    const metrics = [
      ['change', t('recentLossChange'), t('comparedPreviousWindow')],
      ['volatility', t('lossVolatility'), t('lowerIsMoreStable')],
      ['best', t('bestLoss'), t('bestObservedValue')],
      ['gap', t('gapFromBest'), t('latestVsBest')],
    ];
    metrics.forEach(metric => {
      html += '<div class="m-diagnostic-metric" data-diagnostic-metric="' + metric[0] + '"><span>' + this.esc(metric[1]) + '</span><strong data-diagnostic-field="' + metric[0] + '">--</strong><small data-diagnostic-field="' + metric[0] + '-meta">' + this.esc(metric[2]) + '</small></div>';
    });
    html += '</div>';
    html += '<details class="m-diagnostic-details"><summary>' + this.esc(t('diagnosticMethodTitle')) + '</summary>';
    html += '<div class="m-diagnostic-evidence"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l5-5 4 3 7-8"/><path d="M16 7h4v4"/></svg><div><span>' + this.esc(t('diagnosticEvidence')) + '</span><strong data-diagnostic-field="evidence">--</strong><small data-diagnostic-field="window-evidence">--</small></div></div>';
    html += '<div class="m-diagnostic-guidance"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="4"/></svg><div><span>' + this.esc(t('diagnosticAdvice')) + '</span><strong data-diagnostic-field="advice">--</strong></div></div>';
    html += '<div class="m-diagnostic-method">';
    html += '<div class="m-diagnostic-method-content">';
    html += '<p class="m-diagnostic-boundary"><strong>' + this.esc(t('diagnosticScopeTitle')) + '</strong><span>' + this.esc(t('diagnosticScopeText')) + '</span></p>';
    const methodItems = [
      [t('diagnosticMethodSource'), t('diagnosticMethodSourceText')],
      [t('diagnosticMethodWindow'), t('diagnosticMethodWindowText')],
      [t('diagnosticMethodVolatility'), t('diagnosticMethodVolatilityText')],
    ];
    html += '<div class="m-diagnostic-method-grid">';
    methodItems.forEach(item => { html += '<div><span>' + this.esc(item[0]) + '</span><p>' + this.esc(item[1]) + '</p></div>'; });
    html += '</div><div class="m-diagnostic-rule-title">' + this.esc(t('diagnosticRuleOrder')) + '</div><div class="m-diagnostic-rules">';
    const ruleItems = [
      [t('diagnosticRuleRebound'), this._fillDiagnosticTemplate(t('diagnosticRuleReboundCondition'), { value: rules.reboundChange })],
      [t('diagnosticRuleVolatile'), this._fillDiagnosticTemplate(t('diagnosticRuleVolatileCondition'), { value: rules.volatileCv })],
      [t('diagnosticRuleConverging'), this._fillDiagnosticTemplate(t('diagnosticRuleConvergingCondition'), { value: rules.convergingChange })],
      [t('diagnosticRulePlateau'), this._fillDiagnosticTemplate(t('diagnosticRulePlateauCondition'), { change: rules.plateauAbsChange, volatility: rules.plateauCv })],
      [t('diagnosticRuleSteady'), t('diagnosticRuleOtherwise')],
    ];
    ruleItems.forEach(item => { html += '<div><span>' + this.esc(item[0]) + '</span><code>' + this.esc(item[1]) + '</code></div>'; });
    html += '</div><p class="m-diagnostic-method-note">' + this.esc(t('diagnosticMethodNote')) + '</p></div></div>';
    html += '</details></section>';
    return html;
  },

  _patchTrainingDiagnostics(root, t, d, isHistory) {
    const isPreviousRun = !isHistory && ['FINISHED', 'FAILED', 'TERMINATED'].includes(d && d.state);
    const context = isHistory ? 'history' : (isPreviousRun ? 'previous' : 'live');
    const version = String(this.lossDataVersion) + ':' + String(this._shellLocale || '') + ':' + context;
    if (root.dataset.diagnosticVersion === version) return;
    root.dataset.diagnosticVersion = version;
    const diagnostic = this._trainingDiagnostics();
    const setText = (field, value) => {
      const element = root.querySelector('[data-diagnostic-field="' + field + '"]');
      if (element) element.textContent = value;
    };
    setText('title', isPreviousRun ? t('previousTrainingDiagnostics') : t('trainingDiagnostics'));
    setText('subtitle', isPreviousRun ? t('previousDiagnosticSubtitle') : t('diagnosticSubtitle'));
    const verdict = root.querySelector('.m-diagnostic-verdict');
    if (verdict) verdict.dataset.diagnosticTone = diagnostic.tone;
    setText('state', this._diagnosticText(t, diagnostic.code, 'label'));
    setText('summary', this._diagnosticText(t, diagnostic.code, 'summary'));
    setText('advice', this._diagnosticText(t, diagnostic.code, 'advice'));
    setText('evidence', this._diagnosticEvidence(t, diagnostic));
    setText('window-evidence', this._diagnosticWindowEvidence(t, diagnostic));
    setText('source', diagnostic.sourceTag === 'loss/current' ? t('currentLossSource') : t('averageLossSource'));
    setText('through-step', diagnostic.latestStep == null ? t('waitingData') : t('throughStep').replace('{n}', Math.round(diagnostic.latestStep)));
    setText('change', this._formatDiagnosticPercent(diagnostic.changePct, true));
    setText('volatility', this._formatDiagnosticPercent(diagnostic.volatilityPct, false));
    setText('best', this._formatDiagnosticValue(diagnostic.bestValue));
    setText('gap', this._formatDiagnosticPercent(diagnostic.gapFromBestPct, true));
    setText('change-meta', diagnostic.windowSize ? t('windowComparison').replace('{n}', diagnostic.windowSize) : t('needsMorePoints'));
    setText('volatility-meta', diagnostic.windowSize ? t('recentWindowPoints').replace('{n}', diagnostic.windowSize) : t('lowerIsMoreStable'));
    setText('best-meta', diagnostic.bestStep == null ? t('bestObservedValue') : t('atStep').replace('{n}', Math.round(diagnostic.bestStep)));
    setText('gap-meta', t('latestVsBest'));
    const changeMetric = root.querySelector('[data-diagnostic-metric="change"]');
    const volatilityMetric = root.querySelector('[data-diagnostic-metric="volatility"]');
    const gapMetric = root.querySelector('[data-diagnostic-metric="gap"]');
    const rules = this._trainingDiagnosticRules();
    if (changeMetric) changeMetric.dataset.tone = diagnostic.changePct == null ? 'muted' : (diagnostic.changePct <= rules.convergingChange ? 'ok' : (diagnostic.changePct >= rules.reboundChange ? 'danger' : 'neutral'));
    if (volatilityMetric) volatilityMetric.dataset.tone = diagnostic.volatilityPct == null ? 'muted' : (diagnostic.volatilityPct >= rules.volatileCv ? 'danger' : (diagnostic.volatilityPct < rules.plateauCv ? 'ok' : 'neutral'));
    if (gapMetric) gapMetric.dataset.tone = diagnostic.gapFromBestPct == null ? 'muted' : 'neutral';
  },

  _previewThumbImageHtml(preview) {
    const imageUrl = preview.thumb_url || preview.url;
    const common = ' alt="' + this.esc(preview.name) + '" loading="lazy" decoding="async" fetchpriority="low"';
    if (this.weakNetworkMode) {
      return '<img data-preview-url="' + this.esc(imageUrl) + '"' + common + '/>';
    }
    return '<img src="' + this.esc(imageUrl) + '"' + common + '/>';
  },

  _parametersConsoleHtml(t) {
    const byKey = {};
    this.trainParams.forEach(param => { if (param.key) byKey[param.key] = param; });
    const keyDefs = [
      { key: 'pretrained_model_name_or_path', short: 'historyModel', basename: true }, { key: 'learning_rate', short: 'historyLR' },
      { key: 'network_dim', short: 'historyDim' }, { key: 'network_alpha', short: 'historyAlpha' },
      { key: 'max_train_epochs', short: 'historyEpochs' }, { key: 'optimizer_type', short: 'historyOptimizer' },
      { key: 'train_batch_size', short: 'historyBatch' }, { key: 'resolution', short: 'historyResolution' }, { key: 'seed', short: 'historySeed' },
    ];
    let html = '<section class="m-console-card m-parameters-console"><div class="m-card-heading"><div><span>' + this.esc(t('trainParams')) + '</span><small>' + this.trainParams.length + ' ' + this.esc(t('items')) + '</small></div></div>';
    html += '<div class="param-keygrid">';
    keyDefs.forEach(definition => {
      const param = byKey[definition.key];
      if (!param || param.value == null || param.value === '') return;
      let value = String(param.value);
      if (definition.basename) { const parts = value.replace(/\\/g, '/').split('/'); value = parts[parts.length - 1] || value; }
      html += '<div class="param-key-item"><span class="param-key-label">' + this.esc(t(definition.short, definition.key)) + '</span><span class="param-key-value">' + this._paramValueHtml({ value, type: param.type }) + '</span></div>';
    });
    html += '</div>';
    html += '<div class="m-param-toolbar"><label class="m-param-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input type="search" value="' + this.esc(this.monitorParamQuery || '') + '" placeholder="' + this.esc(t('parameterSearch')) + '" aria-label="' + this.esc(t('parameterSearch')) + '" @input="monitorParamQuery=$event.target.value;filterMonitorParams()"/></label><span class="m-param-match" data-param-match></span><button type="button" class="btn btn-sm btn-secondary" @click="setMonitorParamGroups(true)">' + this.esc(t('expandAll')) + '</button><button type="button" class="btn btn-sm btn-secondary" @click="setMonitorParamGroups(false)">' + this.esc(t('collapseAll')) + '</button></div>';
    const groups = {};
    const order = ['model','network','training','optimizer','regularization','caption','performance','save','preview','basic'];
    this.trainParams.forEach(param => { const group = param.section || param.group || ''; (groups[group] || (groups[group] = [])).push(param); });
    const keys = Object.keys(groups).sort((a, b) => { const ai = order.indexOf(a), bi = order.indexOf(b); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi); });
    html += '<div class="m-param-groups">';
    keys.forEach(group => {
      const groupTitle = group && ['model','network','training','optimizer','regularization','caption','performance','save','preview'].includes(group) ? t('section.' + group, group) : (group || t('other'));
      html += '<details class="m-param-group"><summary><span>' + this.esc(groupTitle) + '</span><small>' + groups[group].length + '</small><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></summary><div class="m-param-list">';
      groups[group].forEach(param => {
        const rawLabel = param.label_raw || param.label || param.key || '';
        const searchText = (rawLabel + ' ' + (param.value == null ? '' : param.value)).toLowerCase();
        const title = this._paramTitle(param, t);
        html += '<div class="m-param-row" data-param-row data-search="' + this.esc(searchText) + '"><span class="param-label"' + (title ? ' title="' + this.esc(title) + '"' : '') + '>' + this._paramLabel(param) + '</span><span class="param-value">' + this._paramValueHtml(param) + '</span></div>';
      });
      html += '</div></details>';
    });
    html += '</div></section>';
    return html;
  },

  filterMonitorParams() {
    const root = document.getElementById('monitorTabContent');
    if (!root) return;
    const query = String(this.monitorParamQuery || '').trim().toLowerCase();
    let matches = 0;
    root.querySelectorAll('[data-param-row]').forEach(row => {
      const show = !query || String(row.dataset.search || '').includes(query);
      row.hidden = !show;
      if (show) matches++;
    });
    root.querySelectorAll('.m-param-group').forEach(group => {
      const count = group.querySelectorAll('[data-param-row]:not([hidden])').length;
      group.hidden = query ? count === 0 : false;
      if (query && count > 0) group.open = true;
    });
    const result = root.querySelector('[data-param-match]');
    if (result) result.textContent = query ? matches + ' ' + this.t('monitor.matches') : '';
  },

  setMonitorParamGroups(open) {
    const root = document.getElementById('monitorTabContent');
    if (!root) return;
    root.querySelectorAll('.m-param-group:not([hidden])').forEach(group => { group.open = !!open; });
  },

  _formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  },

  _artifactLocationHtml(t, d) {
    if (!d || d.artifact_available !== false || !d.artifact_dir) return '';
    let html = '<div class="m-artifact-location is-offline">';
    html += '<span class="m-badge m-badge-danger"><i aria-hidden="true"></i>' + this.esc(t('artifactOffline')) + '</span>';
    html += '<code title="' + this.esc(d.artifact_dir) + '">' + this.esc(d.artifact_dir) + '</code>';
    html += '<small>' + this.esc(t('artifactOfflineHint')) + '</small>';
    html += '</div>';
    return html;
  },

  // ═══════════════════════════════════════════════════════════
  //  样本标签
  // ═══════════════════════════════════════════════════════════
  _renderSamplesTab(t) {
    const isHistory = !!this.selectedRunDir;
    const d = isHistory ? (this.runDetailData||{}) : (this.monitorData||{});
    const showPreviews = this.previews.length > 0;
    const lastIdx = this.previews.length - 1;

    const canRefresh = !!this.currentOutputRunDir;
    let html = '<div class="m-section m-samples-section"><div class="m-view-header"><div class="m-view-heading"><span class="m-view-title">' + this.esc(t('previewSamples')) + '</span>' + (showPreviews ? '<span class="m-logs-count">' + this.previews.length + '</span>' : '') + '</div>';
    html += '<div class="m-view-actions"><div class="m-segmented" role="group" aria-label="' + this.esc(t('sampleOrder')) + '">';
    html += '<button type="button" data-preview-sort="asc" aria-pressed="' + (this.previewSortDir === 'asc' ? 'true' : 'false') + '" class="m-segmented-btn' + (this.previewSortDir === 'asc' ? ' active' : '') + '" @click="setPreviewSort(\'asc\')">' + this.esc(t('trainingOrder')) + '</button>';
    html += '<button type="button" data-preview-sort="desc" aria-pressed="' + (this.previewSortDir === 'desc' ? 'true' : 'false') + '" class="m-segmented-btn' + (this.previewSortDir === 'desc' ? ' active' : '') + '" @click="setPreviewSort(\'desc\')">' + this.esc(t('latestFirst')) + '</button></div>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="refreshPreviews()" :disabled="previewsLoading || !currentOutputRunDir" x-text="previewsLoading ? t(\'monitor.loading\') : t(\'monitor.refresh\')"></button></div>';
    html += '</div>';
    html += this._artifactLocationHtml(t, d);
    if (showPreviews) {
      html += '<div class="preview-grid">';
      const groups = new Set();
      const counts = new Map();
      this.previews.forEach(preview => { const stage = this._sampleMetadata(preview.name).stage; counts.set(stage, (counts.get(stage) || 0) + 1); });
      this._previewDisplayIndices().forEach(i => {
        const pv = this.previews[i];
        const info = this._sampleMetadata(pv.name);
        if (info.stage && counts.get(info.stage) > 1 && !groups.has(info.stage)) {
          groups.add(info.stage);
          html += '<div class="m-preview-group-heading" data-preview-group="' + this.esc(info.stage) + '">' + this.esc(info.stage) + '</div>';
        }
        html += '<button type="button" class="preview-grid-item" data-preview-index="' + i + '" @click="openPreviewLightbox(' + i + ')">';
        if (i === lastIdx) html += '<span class="preview-thumb-fresh">' + this.esc(t('latest')) + '</span>';
        html += this._previewThumbImageHtml(pv);
        html += '<span class="preview-grid-item-label" title="' + this.esc(pv.name) + '"><strong>' + this.esc(counts.get(info.stage) > 1 ? info.prompt : this._parseSampleInfo(pv.name)) + '</strong></span>';
        html += '</button>';
      });
      html += '</div>';
    } else {
      // 区分空态场景：实时无训练 / 实时训练中未生成样本 / 历史记录无样本
      let hintKey, hintFallback;
      if (d.artifact_dir && d.artifact_available === false) {
        hintKey = 'monitor.noPreviewArtifactUnavailableHint';
        hintFallback = 'The output folder is unavailable. Restore the path and refresh to view preview images.';
      } else if (d.preview_enabled === false) {
        hintKey = 'monitor.noPreviewDisabledHint';
        hintFallback = 'Preview generation was not enabled for this run.';
      } else if (isHistory) {
        hintKey = 'monitor.noPreviewHistoryHint';
        hintFallback = 'No preview samples in this run';
      } else if (d.state === 'RUNNING') {
        hintKey = 'monitor.noPreviewRunningHint';
        hintFallback = 'Preview images will appear after the first sample step';
      } else {
        hintKey = 'monitor.noPreviewHint';
        hintFallback = 'Preview images appear during training';
      }
      html += '<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><p>' + this.esc(t(hintKey, hintFallback)) + '</p></div>';
    }
    html += '</div>';
    return html;
  },

  // ═══════════════════════════════════════════════════════════
  //  预览灯箱：DOM 模板 + 开/关/翻页
  // ═══════════════════════════════════════════════════════════
  _previewLightboxHtml(t) {
    // 在 shell 阶段注入一次；通过 .open 类切换显隐，开/关/翻页仅原地填充。
    return '<div class="preview-lightbox" id="previewLightbox" x-cloak @click="closePreviewLightbox()">'
      + '<button type="button" class="preview-lightbox-close" @click.stop="closePreviewLightbox()" aria-label="' + this.esc(t('close')) + '">×</button>'
      + '<button type="button" class="preview-lightbox-nav prev" @click.stop="previewLightboxNav(-1)" aria-label="' + this.esc(t('prev')) + '">‹</button>'
      + '<div class="preview-lightbox-inner" @click.stop>'
      + '<div class="preview-lightbox-images"><img class="preview-lightbox-img" id="previewLightboxImg" alt=""/><img class="preview-lightbox-img" id="previewReferenceImg" hidden alt=""/></div>'
       + '<div class="preview-lightbox-bar">'
       + '<span class="preview-lightbox-counter" id="previewLightboxCounter"></span>'
       + '<span class="preview-lightbox-label" id="previewLightboxLabel"></span>'
       + '<span class="preview-lightbox-label" id="previewReferenceLabel" hidden></span>'
       + '<div class="preview-lightbox-actions">'
       + '<button type="button" class="btn btn-sm btn-secondary" @click="togglePreviewReference()" x-text="previewReference ? t(\'monitor.clearReference\') : t(\'monitor.pinReference\')"></button>'
       + '<button type="button" class="btn btn-sm btn-secondary" id="previewLightboxMetadataButton" @click="togglePreviewMetadata()" aria-expanded="false">' + this.esc(t('previewMetadata')) + '</button>'
       + '<a class="btn btn-sm btn-secondary" id="previewLightboxOriginal" target="_blank" rel="noopener" @click.stop>' + this.esc(t('openOriginal')) + '</a>'
       + '</div>'
       + '<span class="preview-lightbox-hint">←/→ ' + this.esc(t('navigate')) + ' · Esc ' + this.esc(t('close')) + '</span>'
       + '</div>'
       + '<div class="preview-lightbox-metadata" id="previewLightboxMetadata" hidden></div>'
       + '</div>'
      + '<button type="button" class="preview-lightbox-nav next" @click.stop="previewLightboxNav(1)" aria-label="' + this.esc(t('next')) + '">›</button>'
      + '</div>';
  },

  openPreviewLightbox(i) {
    if (!this.previews.length) return;
    this.previewStep = Math.max(0, Math.min(i, this.previews.length - 1));
    const box = document.getElementById('previewLightbox');
    if (!box) return;
    box.classList.add('open');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', this.t('monitor.previewSamples'));
    this._previewReturnFocus = document.activeElement;
    document.body.style.overflow = 'hidden';
    this._updatePreviewLightbox();
    if (!this._lightboxKeyHandler) {
      this._lightboxKeyHandler = (e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.previewLightboxNav(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); this.previewLightboxNav(1); }
        else if (e.key === 'Escape') { this.closePreviewLightbox(); }
        else if (e.key === 'Tab') {
          const items = Array.from(box.querySelectorAll('button:not([disabled]), a[href], summary')).filter(el => el.getClientRects().length);
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
    }
    document.addEventListener('keydown', this._lightboxKeyHandler);
    box.querySelector('.preview-lightbox-close').focus();
  },

  closePreviewLightbox() {
    const box = document.getElementById('previewLightbox');
    if (box) box.classList.remove('open');
    const image = document.getElementById('previewLightboxImg');
    if (image) image.removeAttribute('src');
    const reference = document.getElementById('previewReferenceImg');
    if (reference) { reference.removeAttribute('src'); reference.hidden = true; }
    this.previewReference = null;
    if (typeof this._resetPreviewMetadata === 'function') this._resetPreviewMetadata();
    document.body.style.overflow = '';
    if (this._lightboxKeyHandler) document.removeEventListener('keydown', this._lightboxKeyHandler);
    this._lightboxKeyHandler = null;
    if (this._previewReturnFocus && this._previewReturnFocus.isConnected) this._previewReturnFocus.focus({ preventScroll: true });
    this._previewReturnFocus = null;
  },

  togglePreviewReference() {
    this.previewReference = this.previewReference ? null : this.previews[this.previewStep];
    this._updatePreviewLightbox();
  },

  previewLightboxNav(dir) {
    if (!this.previews.length) return;
    const indices = this._previewDisplayIndices();
    const current = Math.max(0, indices.indexOf(this.previewStep));
    const nextPosition = Math.max(0, Math.min(current + dir, indices.length - 1));
    const next = indices[nextPosition];
    if (next === this.previewStep) return;
    this.previewStep = next;
    this._updatePreviewLightbox();
  },

  _updatePreviewLightbox() {
    const n = this.previews.length;
    if (!n) return;
    const p = this.previews[this.previewStep] || this.previews[0];
    if (typeof this._resetPreviewMetadata === 'function') this._resetPreviewMetadata();
    const img = document.getElementById('previewLightboxImg');
    if (img) { img.src = p.inspect_url || p.url; img.alt = p.name; }
    const reference = document.getElementById('previewReferenceImg');
    if (reference) {
      reference.hidden = !this.previewReference;
      if (this.previewReference) {
        reference.src = this.previewReference.inspect_url || this.previewReference.url;
        reference.alt = this.t('monitor.pinReference') + ': ' + this.previewReference.name;
        reference.title = reference.alt;
      } else reference.removeAttribute('src');
    }
    const referenceLabel = document.getElementById('previewReferenceLabel');
    if (referenceLabel) {
      referenceLabel.hidden = !this.previewReference;
      referenceLabel.textContent = this.previewReference ? this.t('monitor.reference') + ': ' + this._parseSampleInfo(this.previewReference.name) : '';
    }
    const original = document.getElementById('previewLightboxOriginal');
    if (original) {
      original.hidden = !p.url;
      if (p.url) original.href = p.url;
      else original.removeAttribute('href');
    }
    const c = document.getElementById('previewLightboxCounter');
    const indices = this._previewDisplayIndices();
    const displayPosition = Math.max(0, indices.indexOf(this.previewStep));
    if (c) c.textContent = (displayPosition + 1) + ' / ' + n;
    const lbl = document.getElementById('previewLightboxLabel');
    if (lbl) lbl.textContent = this._parseSampleInfo(p.name);
    const box = document.getElementById('previewLightbox');
    if (box) {
      const prevBtn = box.querySelector('.preview-lightbox-nav.prev');
      const nextBtn = box.querySelector('.preview-lightbox-nav.next');
      if (prevBtn) prevBtn.disabled = displayPosition <= 0;
      if (nextBtn) nextBtn.disabled = displayPosition >= n - 1;
    }
  },

  _parseSampleInfo(filename) {
    const info = this._sampleMetadata(filename);
    return [info.stage, info.prompt].filter(Boolean).join(' · ') || filename;
  },


  // ═══════════════════════════════════════════════════════════
  //  输出标签
  // ═══════════════════════════════════════════════════════════
  _renderOutputsTab(t) {
    const d = this.currentArtifactData();
    const runDir = this.currentOutputRunDir;
    const artifactUnavailable = !!runDir && (d.artifact_available === false || this.outputFilesError === 'artifactUnavailable');
    const canUseFiles = !!runDir && !artifactUnavailable && this.outputFiles.length > 0;
    const visibleCount = this._visibleOutputFiles().length;
    let html = '<div class="m-section m-outputs-section">';
    html += '<div class="m-view-header"><div class="m-view-heading"><span class="m-view-title">' + this.esc(t('outputs')) + '</span>' + (this.outputFiles.length ? '<span class="m-logs-count">' + this.outputFiles.length + '</span>' : '') + '</div>';
    html += '<div class="m-view-actions">';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="loadOutputFiles()"' + (!runDir ? ' disabled' : '') + '>' + this.esc(t('refresh')) + '</button>';
    html += '<label class="m-output-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="m-output-search-input" type="search" value="' + this.esc(this.outputSearch) + '" placeholder="' + this.esc(t('searchOutputs')) + '" @input.debounce.180ms="setOutputSearch($event.target.value)"></label>';
    html += '<div class="m-segmented" role="group" aria-label="' + this.esc(t('outputFilter')) + '">';
    [['all', t('filterAll')], ['models', t('filterModels')], ['others', t('filterOthers')]].forEach(item => {
      html += '<button type="button" class="m-segmented-btn' + (this.outputFilter === item[0] ? ' active' : '') + '" @click="setOutputFilter(\'' + item[0] + '\')">' + this.esc(item[1]) + '</button>';
    });
    html += '</div>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="selectAllOutputFiles()"' + (!canUseFiles || !visibleCount ? ' disabled' : '') + '>' + this.esc(t('selectVisible')) + '</button>';
    if (d.artifact_dir) html += '<button type="button" class="btn btn-sm btn-secondary" @click="navigator.clipboard.writeText(currentArtifactData().artifact_dir).then(() => toast(t(\'common.copied\'))).catch(() => toast(t(\'common.failed\'), \'error\'))">' + this.esc(t('copyOutputPath')) + '</button>';
    html += '<button type="button" class="btn btn-sm" @click="downloadAllOutputs()"' + (!canUseFiles ? ' disabled' : '') + '>' + this.esc(t('downloadAll')) + '</button>';
    html += '</div></div>';
    html += this._artifactLocationHtml(t, d);

    if (this.outputFilesLoading) {
      html += '<div class="dashboard-empty" style="padding:48px"><p>' + this.esc(t('loading')) + '</p></div>';
      html += '</div>';
      return html;
    }

    if (!this.outputFiles.length) {
      let emptyKey = 'noOutputsHint';
      let emptyFallback = 'Training outputs will appear here after saving';
      if (!runDir) {
        emptyKey = 'noOutputsNoRunHint';
        emptyFallback = 'Start or select a training run to view its output files.';
      } else if (artifactUnavailable) {
        emptyKey = 'noOutputsArtifactUnavailableHint';
        emptyFallback = 'The output folder is unavailable. Logs and TensorBoard remain available; restore the path to list or download files.';
      } else if (this.outputFilesError === 'loadFailed') {
        emptyKey = 'outputFilesLoadFailed';
        emptyFallback = 'Unable to load output files. Check the folder and try Refresh.';
      }
      html += '<div class="dashboard-empty' + (artifactUnavailable ? ' dashboard-empty-danger' : '') + '" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><p>' + this.esc(t(emptyKey, emptyFallback)) + '</p></div>';
      html += '</div>';
      return html;
    }

    const selectedCount = this.selectedOutputFiles.length;
    html += '<div class="m-output-selection-bar' + (selectedCount > 0 ? ' visible' : '') + '"><span>' + this.esc(t('selected')) + ': <strong>' + selectedCount + '</strong> / ' + this.outputFiles.length + '</span><div><button type="button" class="btn btn-sm btn-secondary" @click="deselectAllOutputFiles()">' + this.esc(t('clearSelection')) + '</button><button type="button" class="btn btn-sm btn-primary" @click="downloadSelectedOutputs()">' + this.esc(t('downloadSelected')) + '</button></div></div>';

    // Scrollable content
    html += '<div class="m-outputs-scroll">';

    const { models, others } = this._sortedOutputs();

    if (!models.length && !others.length) {
      html += '<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('noMatchingOutputs')) + '</p></div>';
    }

    // ── 模型存档区（带 loss + 排序）──
    if (this.outputFilter !== 'others') {
    html += '<div class="m-ckpt-section">';
    html += '<div class="m-section-title"><span>' + this.esc(t('modelCheckpoints')) + ' <span class="m-logs-count">' + models.length + '</span></span></div>';

    if (models.length) {
      const bestPath = this._bestCheckpointPath(this.outputFiles.filter(file => file.category === 'model'));
      html += '<div class="output-list output-table"><div class="output-table-head"><span></span><span></span>' + this._outputSortHeadHtml('models', 'name', t('fileName')) + '<span>' + this.esc(t('checkpoint')) + '</span>' + this._outputSortHeadHtml('models', 'loss', t('loss')) + this._outputSortHeadHtml('models', 'size', t('sortSize')) + this._outputSortHeadHtml('models', 'time', t('modifiedTime')) + '<span>' + this.esc(t('actions')) + '</span></div>';
      models.forEach(f => {
        const isSelected = !!this.outputFilesSelected[f.path];
        const fpJs = this.esc(this.escapeJsString(f.path));
        const isBest = f.path === bestPath;
        html += '<div class="output-item' + (isSelected ? ' selected' : '') + (isBest ? ' m-ckpt-best' : '') + '" @click="toggleOutputFile(\'' + fpJs + '\')">';
        html += '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' @click.stop="toggleOutputFile(\'' + fpJs + '\')">';
        html += this._fileIconSvg(f);
        html += '<span class="output-name" title="' + this.esc(f.name) + '">' + this.esc(f.name) + (isBest ? '<small class="m-best-label">' + this.esc(t('lowestLoss')) + '</small>' : '') + '</span>';
        const badge = this._ckptBadgeHtml(f, t);
        if (badge) html += badge;
        else if (f.is_lora) html += '<span class="badge output-lora-badge">LoRA</span>';
        else html += '<span class="m-ckpt-badge m-muted">—</span>';
        const numericLoss = Number(f.ckpt_loss);
        const hasLoss = f.ckpt_loss != null && Number.isFinite(numericLoss);
        const lossTxt = hasLoss ? (f.loss_approximate ? '≈ ' : '') + numericLoss.toFixed(4) : '--';
        html += '<span title="' + this.esc((f.loss_source || '') + (f.loss_step != null ? ' · step ' + f.loss_step : '')) + '" class="m-ckpt-loss' + (hasLoss ? '' : ' m-muted') + '"><b>' + this.esc(lossTxt) + '</b></span>';
        html += '<span class="output-size">' + this._formatFileSize(f.size) + '</span>';
        html += '<span class="output-time">' + this._formatFileTime(f.mtime) + '</span>';
        html += '<button class="btn btn-sm btn-secondary output-dl-btn" @click.stop="downloadSingleOutput(\'' + fpJs + '\')" title="' + this.esc(t('common.download')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty" style="padding:24px"><p>' + this.esc(t('noModelFiles')) + '</p></div>';
    }
    html += '</div>';
    }

    // ── 其他文件区 ──
    if (this.outputFilter !== 'models' && others.length) {
      html += '<div class="m-ckpt-section" style="margin-top:12px">';
      html += '<div class="m-section-title"><span>' + this.esc(t('otherFiles')) + ' <span class="m-logs-count">' + others.length + '</span></span></div>';
      html += '<div class="output-list output-table output-table-other"><div class="output-table-head"><span></span><span></span>' + this._outputSortHeadHtml('others', 'name', t('fileName')) + this._outputSortHeadHtml('others', 'type', t('fileType')) + this._outputSortHeadHtml('others', 'size', t('sortSize')) + this._outputSortHeadHtml('others', 'time', t('modifiedTime')) + '<span>' + this.esc(t('actions')) + '</span></div>';
      others.forEach(f => {
        const isSelected = !!this.outputFilesSelected[f.path];
        const fpJs = this.esc(this.escapeJsString(f.path));
        const extension = (f.name || '').includes('.') ? (f.name || '').split('.').pop().toUpperCase() : '';
        const fileType = f.is_lora ? 'LoRA' : (f.category || extension || '—');
        html += '<div class="output-item' + (isSelected ? ' selected' : '') + '" @click="toggleOutputFile(\'' + fpJs + '\')">';
        html += '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' @click.stop="toggleOutputFile(\'' + fpJs + '\')">';
        html += this._fileIconSvg(f);
        html += '<span class="output-name" title="' + this.esc(f.name) + '">' + this.esc(f.name) + '</span>';
        html += '<span class="output-kind">' + this.esc(fileType) + '</span>';
        html += '<span class="output-size">' + this._formatFileSize(f.size) + '</span>';
        html += '<span class="output-time">' + this._formatFileTime(f.mtime) + '</span>';
        html += '<button class="btn btn-sm btn-secondary output-dl-btn" @click.stop="downloadSingleOutput(\'' + fpJs + '\')" title="' + this.esc(t('common.download')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
        html += '</div>';
      });
      html += '</div>';
      html += '</div>';
    }
    html += '</div>'; // m-outputs-scroll
    html += '</div>'; // m-section
    return html;
  },

  _outputSortHeadHtml(group, key, label) {
    const modelGroup = group === 'models';
    const activeKey = modelGroup ? this.outputModelSortKey : this.outputOtherSortKey;
    const activeDir = modelGroup ? this.outputModelSortDir : this.outputOtherSortDir;
    const active = activeKey === key;
    let html = '<button type="button" class="output-table-sort' + (active ? ' active' : '') + '" @click="setOutputSort(\'' + group + '\',\'' + key + '\')">' + this.esc(label);
    if (active) html += '<span aria-hidden="true">' + (activeDir === 'asc' ? '↑' : '↓') + '</span>';
    return html + '</button>';
  },

  _bestCheckpointPath(models) {
    const sources = new Set((models || []).filter(f => f.ckpt_loss != null).map(f => f.loss_source || 'unknown'));
    if (sources.size > 1) return null;
    let bestPath = null;
    let bestLoss = Infinity;
    let bestTime = -Infinity;
    (models || []).forEach(file => {
      const loss = Number(file.ckpt_loss);
      if (file.ckpt_loss == null || !Number.isFinite(loss)) return;
      const time = Number(file.mtime) || 0;
      if (loss < bestLoss || (loss === bestLoss && time > bestTime)) {
        bestLoss = loss;
        bestTime = time;
        bestPath = file.path;
      }
    });
    return bestPath;
  },

  _fileIconSvg(f) {
    const cat = f.category || '';
    const ext = (f.name || '').split('.').pop().toLowerCase();
    // Weight icon for model files
    if (cat === 'model') {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
    }
    // Image icon for samples
    if (cat === 'sample' || ['png','jpg','jpeg','webp','gif'].includes(ext)) {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    }
    // Chart icon for tensorboard
    if (cat === 'tensorboard' || ext === 'tfevents') {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>';
    }
    // Document icon for logs and text files
    if (cat === 'log' || ['txt','log','md'].includes(ext)) {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
    }
    // Gear icon for config files
    if (['toml','json','yaml','yml'].includes(ext)) {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
    }
    // Default folder icon
    return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  },

  // checkpoint 类型 → 小标签（Epoch N / Step N / 最终）
  _ckptBadgeHtml(f, t) {
    if (f.ckpt_type === 'epoch' && f.ckpt_epoch != null) {
      return '<span class="m-ckpt-badge m-ckpt-epoch">' + this.esc(t('ckptEpoch').replace('{n}', f.ckpt_epoch)) + '</span>';
    }
    if (f.ckpt_type === 'step' && f.ckpt_step != null) {
      return '<span class="m-ckpt-badge m-ckpt-step">' + this.esc(t('ckptStep').replace('{n}', f.ckpt_step)) + '</span>';
    }
    if (f.ckpt_type === 'final') {
      return '<span class="m-ckpt-badge m-ckpt-final">' + this.esc(t('ckptFinal')) + '</span>';
    }
    return '';
  },

  _formatFileTime(mtime) {
    if (!mtime) return '';
    const d = new Date(mtime * 1000);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  },

  // ═══════════════════════════════════════════════════════════
  //  历史记录页（搜索 / 筛选 / 删除 / 下载）
  // ═══════════════════════════════════════════════════════════
  renderHistory() {
    const el = document.getElementById('historyList');
    try {
    const t = (k, fb) => this.tMonitor(k, fb);
    const hasRunning = this.runningTask && this._isActiveState(this.runningTask.status);
    const items = this.filteredHistoryItems;
    const hasHistory = items && items.length;

    if (!hasRunning && !hasHistory && !(this.historyItems && this.historyItems.length)) {
      el.innerHTML = 
        '<div class="dashboard-empty" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><p>' + this.esc(t('historyNoRecords')) + '</p><p class="m-empty-sub">' + this.esc(t('historyWillAppear')) + '</p></div>';
      return;
    }

    let html = '';
    // Persistent diagnostic banner
    
    if (hasRunning) {
      const r = this.runningTask;
      html += '<div class="card history-card history-running">';
      html += '<div class="card-header">' + this.esc(t('running')) + ' <span class="m-badge m-badge-ok badge-running"><i aria-hidden="true"></i>' + this.esc(t('training')) + '</span>';
      if (r.artifact_available === false) html += '<span class="m-badge m-badge-danger"><i aria-hidden="true"></i>' + this.esc(t('artifactOffline')) + '</span>';
      html += '</div>';
      html += '<div class="hist-name"><b>' + this.esc(r.name || r.id || '') + '</b></div>';
      html += '<div class="hist-meta">' + this.esc(t('historyModel')) + ': ' + this.esc((r.model || '').split(/[\\\/]/).pop() || 'Unknown') + '</div>';
      html += '<div class="hist-meta">' + this.esc(t('historyLR')) + ': ' + this.esc(r.lr || '?') + ' | ' + this.esc(t('historyDim')) + ': ' + this.esc(r.dim || '?') + (r.alpha ? ' / α ' + this.esc(r.alpha) : '') + ' | ' + this.esc(t('historyEpochs')) + ': ' + this.esc(r.epochs || '?') + '</div>';
      if (r.run_dir) html += '<div class="hist-rundir">' + this.esc(t('runDir')) + ': ' + this.esc(r.run_dir) + '</div>';
      if (r.artifact_available === false && r.artifact_dir) html += '<div class="hist-artifact is-offline">' + this.esc(r.artifact_dir) + '</div>';
      html += '<div class="hist-actions"><button class="hist-action hist-action-primary" @click="navigate(\'monitor-dashboard\')">' + this.esc(t('viewDashboard')) + '</button></div>';
      html += '</div>';
    }

    if (this.historyItems && this.historyItems.length) {
      html += '<div class="hist-toolbar">';
      html += '<input type="text" class="hist-search" x-model="historySearch" placeholder="' + this.esc(t('searchHistory')) + '" @input.debounce.200ms="renderHistory()">';
      const filters = [['all', t('logLevelAll')], ['completed', t('statusCompleted')], ['failed', t('statusFailed')], ['terminated', t('statusTerminated')]];
      filters.forEach(f => {
        html += '<button type="button" class="hist-filter-btn" :class="{active:historyFilter===\'' + f[0] + '\'}" @click="historyFilter=\'' + f[0] + '\';renderHistory()">' + this.esc(f[1]) + '</button>';
      });
      html += '</div>';

      if (hasRunning) html += '<div class="hist-section-label">' + this.esc(t('pastRuns')) + '</div>';
      html += '<div class="history-grid">';
      items.forEach(h => {
        const runDirJs = this.esc(this.escapeJsString(h.run_dir || ''));
        const artifactOffline = h.artifact_available === false;
        html += '<div class="card history-card' + (artifactOffline ? ' history-artifact-offline' : '') + '">';
        html += '<div class="hist-card-head">';
        html += '<span class="hist-time">' + this.esc(h.time) + '</span>';
        if (h.status) {
          const statusColors = { completed: 'ok', failed: 'danger', error: 'danger', terminated: 'muted' };
          const statusLabels = { completed: t('statusCompleted'), failed: t('statusFailed'), error: t('statusError'), terminated: t('statusTerminated') };
          html += '<span class="m-badge m-badge-' + (statusColors[h.status] || 'muted') + '"><i aria-hidden="true"></i>' + this.esc(statusLabels[h.status] || h.status) + '</span>';
        }
        if (h.duration) html += '<span class="hist-duration">' + this.esc(h.duration) + '</span>';
        if (artifactOffline) html += '<span class="m-badge m-badge-danger"><i aria-hidden="true"></i>' + this.esc(t('artifactOffline')) + '</span>';
        html += '</div>';
        html += '<div class="hist-card-body" @click="' + (h.run_dir ? 'viewRunDetail(\'' + runDirJs + '\')' : 'navigate(\'monitor-dashboard\')') + '">';
        html += '<div class="hist-name"><b>' + this.esc(h.name || '') + '</b></div>';
        html += '<div class="hist-meta">' + this.esc(t('historyModel')) + ': ' + this.esc(h.model || '') + '</div>';
        html += '<div class="hist-meta">' + this.esc(t('historyLR')) + ': ' + this.esc(h.lr || '') + ' | ' + this.esc(t('historyDim')) + ': ' + this.esc(h.dim || '') + (h.alpha ? ' / α ' + this.esc(h.alpha) : '') + ' | ' + this.esc(t('historyEpochs')) + ': ' + this.esc(h.epochs || '') + '</div>';
        if (h.dataset) html += '<div class="hist-dataset">' + this.esc(t('dataset')) + ': ' + this.esc(h.dataset) + '</div>';
        if (artifactOffline && h.artifact_dir) html += '<div class="hist-artifact is-offline">' + this.esc(h.artifact_dir) + '</div>';
        html += '</div>';
        if (h.run_dir) {
          html += '<div class="hist-actions">';
          html += '<button class="hist-action hist-action-primary" @click.stop="viewRunDetail(\'' + runDirJs + '\')">' + this.esc(t('viewDetails')) + '</button>';
          html += '<button class="hist-action hist-action-secondary" @click.stop="viewSnapshot(\'' + runDirJs + '\')">' + this.esc(t('viewConfig')) + '</button>';
          html += '<button class="hist-action hist-action-secondary" @click.stop="reuseConfig(\'' + runDirJs + '\')">' + this.esc(t('reuseConfig')) + '</button>';
          html += '<span class="hist-actions-spacer" aria-hidden="true"></span>';
          const downloadTitle = artifactOffline ? t('artifactOfflineHint') : t('downloadAll');
          html += '<button class="hist-action hist-action-icon hist-download" @click.stop="downloadRunOutputs(\'' + runDirJs + '\')" title="' + this.esc(downloadTitle) + '" aria-label="' + this.esc(downloadTitle) + '"' + (artifactOffline ? ' disabled' : '') + '><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
          html += '<button class="hist-action hist-action-icon hist-delete" @click.stop="deleteHistoryRun(\'' + runDirJs + '\')" title="' + this.esc(t('deleteHistoryOnly')) + '" aria-label="' + this.esc(t('deleteHistoryOnly')) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>';
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }

    const search = el.querySelector('.hist-search');
    const focused = search && document.activeElement === search;
    const selection = focused ? [search.selectionStart, search.selectionEnd] : null;
    if (search) search.remove();
    el.innerHTML = html;
    const replacement = el.querySelector('.hist-search');
    if (search && replacement) { replacement.replaceWith(search); if (focused) { search.focus({ preventScroll: true }); search.setSelectionRange(...selection); } }
    } catch (e) {
      el.innerHTML = '<div class="dashboard-empty" style="padding:48px"><p>⚠ ' + (this.t ? this.t('monitor.historyRenderError') : 'Error displaying history. Check browser console (F12).') + '</p></div>';
    }
  },

  async downloadRunOutputs(runDir) {
    if (!runDir) return;
    this._triggerDownload('/api/monitor/outputs/download?run_dir=' + encodeURIComponent(runDir));
  },

  async _fetchConfigSnapshot(runDir) {
    const response = await fetch('/api/monitor/config-from-run?run_dir=' + encodeURIComponent(runDir));
    return response.json();
  },

  async viewSnapshot(runDir) {
    const t = (k, fb) => this.tMonitor(k, fb);
    try {
      this.startProgress();
      const j = await this._fetchConfigSnapshot(runDir);
      if (j.status === 'success') {
        this.showSnapshotModal(j.data);
      } else {
        this.toast(j.message || t('configLoadError'), 'error');
      }
    } catch (e) {
      this.toast(t('configLoadError'), 'error');
    } finally {
      this.finishProgress();
    }
  },

  showSnapshotModal(snapshot) {
    const content = document.getElementById('configSnapshotContent');
    if (!content) return;
    const t = (k, fb) => this.tMonitor(k, fb);

    let html = '';
    if (snapshot.params) {
      const p = snapshot.params;
      // 关键参数高亮卡（与概览页同款）：模型取 basename，9 个核心字段
      const keyDefs = [
        { key: 'pretrained_model_name_or_path', labelKey: 'field.pretrained_model_name_or_path', short: 'historyModel', basename: true },
        { key: 'learning_rate', labelKey: 'field.learning_rate', short: 'historyLR' },
        { key: 'network_dim', labelKey: 'field.network_dim', short: 'historyDim' },
        { key: 'network_alpha', labelKey: 'field.network_alpha', short: 'historyAlpha' },
        { key: 'max_train_epochs', labelKey: 'field.max_train_epochs', short: 'historyEpochs' },
        { key: 'optimizer_type', labelKey: 'field.optimizer_type', short: 'historyOptimizer' },
        { key: 'train_batch_size', labelKey: 'field.train_batch_size', short: 'historyBatch' },
        { key: 'resolution', labelKey: 'field.resolution', short: 'historyResolution' },
        { key: 'seed', labelKey: 'field.seed', short: 'historySeed' },
      ];
      const keyItems = [];
      keyDefs.forEach(kd => {
        const raw = p[kd.key];
        if (raw == null || raw === '') return;
        let val = String(raw);
        if (kd.basename) {
          const parts = val.replace(/\\/g, '/').split('/');
          val = parts[parts.length - 1] || val;
        }
        // 高亮卡 label 用 short key（简短），title 用 field.* 完整描述句
        keyItems.push({ label: t(kd.short, kd.key), title: t(kd.labelKey, ''), value: val });
      });
      if (keyItems.length) {
        html += '<div class="param-keygrid" style="margin-bottom:16px">';
        keyItems.forEach(it => {
          const titleAttr = it.title && it.title !== it.label ? ' title="' + this.esc(it.title) + '"' : '';
          html += '<div class="param-key-item"' + titleAttr + '><span class="param-key-label">' + this.esc(it.label) + '</span><span class="param-key-value">' + this.esc(it.value) + '</span></div>';
        });
        html += '</div>';
      }
    }
    if (snapshot.content) {
      html += '<details open><summary class="m-details-summary">' + this.esc(t('rawConfig')) + '</summary>';
      html += '<pre class="m-config-pre">' + this.esc(snapshot.content) + '</pre></details>';
    }
    html += '<div class="m-modal-footer"><button class="btn btn-sm btn-secondary" @click="copyConfigContent()">' + this.esc(t('copyConfig')) + '</button>';
    html += '<button class="btn btn-sm" @click="reuseConfigFromSnapshot(\'' + this.esc(this.escapeJsString(snapshot.run_dir || '')) + '\')">' + this.esc(t('reuseConfig')) + '</button></div>';

    content.innerHTML = html;
    this._currentSnapshot = snapshot;
    this.configSnapshotOpen = true;
  },

  closeSnapshotModal() {
    this.configSnapshotOpen = false;
  },

  copyConfigContent() {
    if (this._currentSnapshot && this._currentSnapshot.content) {
      navigator.clipboard.writeText(this._currentSnapshot.content).then(() => this.toast(this.t('common.copied')));
    }
  },

  async reuseConfig(runDir) {
    const t = (k, fb) => this.tMonitor(k, fb);
    try {
      this.startProgress();
      const j = await this._fetchConfigSnapshot(runDir);
      if (j.status === 'success' && j.data.params) {
        await this._applyConfigToTraining(j.data.params);
        this.toast(t('configLoaded'), 'success');
        this.navigate('train-basic');
      } else {
        this.toast(j.message || t('configLoadError'), 'error');
      }
    } catch (e) {
      this.toast(t('configLoadError'), 'error');
    } finally {
      this.finishProgress();
    }
  },

  reuseConfigFromSnapshot(runDir) {
    this.closeSnapshotModal();
    if (runDir) this.reuseConfig(runDir);
  },

  async _applyConfigToTraining(params) {
    if (!params || !this.form) return;
    if (typeof this._applyImportedFlatConfig === 'function') {
      await this._applyImportedFlatConfig(params);
      return;
    }
    for (const key of Object.keys(params)) {
      if (key === 'sample_prompts' || key.startsWith('_')) continue;
      if (params[key] !== undefined && params[key] !== null && this.form.hasOwnProperty(key)) {
        this.form[key] = String(params[key]);
      }
    }
    if (this.updateToml) this.updateToml();
  }
};
