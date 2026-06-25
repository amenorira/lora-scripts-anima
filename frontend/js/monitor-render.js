/* ================================================================
   monitor-render.js — Dashboard rendering (three-tier update)
   Mixin merged into animaApp Alpine component

   更新策略（消除闪烁）：
     1. 外壳层（状态/GPU/系统卡 或 历史横幅）：仅在首次/历史模式切换时构建，
        之后每 tick 原地打补丁（_patchCardValues）。
     2. 标签页内容：每个标签独立脏判断，仅自身数据变化时重建。
     3. 日志：增量 DOM 追加 + 保留滚动位置（修复"自动回顶"）。
     4. 图表：实例只创建一次，数据变化仅 update('none')，<2 点显示占位。
   ================================================================ */

window.monitorRenderMixin = {
  // ── 占位图表标签（无数据时显示）──
  _placeholderTags(t) {
    return [
      {tag:'loss/average', name: t('chartLossAverage','loss average'), latest:null, points:[]},
      {tag:'loss/current', name: t('chartLossCurrent','loss current'), latest:null, points:[]},
      {tag:'loss/epoch_average', name: t('chartLossEpochAvg','loss epoch average'), latest:null, points:[]},
      {tag:'lr/unet', name: t('chartLrUnet','lr unet'), latest:null, points:[]},
    ];
  },

  // ── 性能指标等级（语义重定义：训练仪表盘里高利用率=好）──
  // 返回 'ok' | 'warn' | 'danger' | 'muted'
  _gradeLoad(pct)  { return (pct||0) < 20 ? 'muted' : 'ok'; },        // GPU 利用率：低=未充分利用，高=满载工作
  _gradeVram(pct)  { return (pct||0) < 92 ? 'ok' : 'warn'; },         // VRAM：接近满=OOM 风险
  _gradeCpuRam(pct){ return (pct||0) < 85 ? 'ok' : 'warn'; },         // CPU/RAM：接近满=风险
  _gradeTemp(temp) { return temp == null ? '' : (temp < 75 ? 'ok' : temp < 85 ? 'warn' : 'danger'); }, // 温度：高温才是危险

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
    const t = (k,fb) => this.t('monitor.'+k)||fb||k;
    const tab = this.monitorTab||'overview';

    // ── 1. 外壳层：仅在首次或历史模式切换时构建 ──
    if (!this._shellBuilt || this._shellHistoryMode !== isHistory) {
      this._shellBuilt = true;
      this._shellHistoryMode = isHistory;
      this._builtTab = null;        // 外壳重建后强制标签重建
      this._builtChartsSig = null;  // 图表签名重置
      let shell = '<div class="monitor-dashboard">';
      if (isHistory) {
        shell += this._historyBannerHtml(d, t);
      } else {
        shell += '<div class="monitor-row" id="monitorCardsRow">';
        shell += this._statusCard(d, t);
        if (sys) shell += this._systemCard(sys, t);
        if (gpu) shell += this._gpuCard(gpu, t);
        shell += '</div>';
      }
      shell += '<div id="monitorTabContent"></div>';
      shell += '</div>';
      el.innerHTML = shell;
      if (!isHistory) this._initShellBars();
    } else if (!isHistory) {
      // ── 2. 外壳值原地打补丁（每 tick，不重建 DOM）──
      this._patchCardValues(d, gpu, sys, t);
    }

    // ── 3. 标签页内容 ──
    this._renderTab(tab, d, gpu, sys, t, isHistory);
  },

  // ═══════════════════════════════════════════════════════════
  //  标签页分发
  // ═══════════════════════════════════════════════════════════
  _renderTab(tab, d, gpu, sys, t, isHistory) {
    const contentEl = document.getElementById('monitorTabContent');
    if (!contentEl) return;
    const tabChanged = this._builtTab !== tab;

    if (tab === 'logs') {
      this._renderLogs(contentEl, d, t, tabChanged);
      this._builtTab = 'logs';
      return;
    }
    if (tab === 'charts') {
      this._renderCharts(contentEl, d, t, tabChanged);
      this._builtTab = 'charts';
      return;
    }
    if (tab === 'overview') {
      const sig = 'ov:' + (this.trainParams.length) + ':' + (this.previews.length) + ':' + (d.train_result ? d.train_result.status : '');
      if (tabChanged || this._builtOverviewSig !== sig) {
        this._builtOverviewSig = sig;
        contentEl.innerHTML = this._renderOverviewTab(d, t, isHistory);
      }
      this._builtTab = 'overview';
      return;
    }
    if (tab === 'samples') {
      // 预览步进越界保护
      if (this.previews.length && this.previewStep >= this.previews.length) this.previewStep = Math.max(0, this.previews.length - 1);
      const sig = 'sm:' + (this.previews.length) + ':' + (this.previewStep);
      if (tabChanged || this._builtSamplesSig !== sig) {
        this._builtSamplesSig = sig;
        contentEl.innerHTML = this._renderSamplesTab(t);
      }
      this._builtTab = 'samples';
      return;
    }
    if (tab === 'outputs') {
      // 首次进入 outputs 时自动加载文件列表
      if (tabChanged && !this.outputFiles.length && !this.outputFilesLoading) this.loadOutputFiles();
      const sig = 'out:' + (this.outputFiles.length) + ':' + (this.selectedOutputFiles.length) + ':' + (this.outputFilesLoading?1:0);
      if (tabChanged || this._builtOutputsSig !== sig) {
        this._builtOutputsSig = sig;
        contentEl.innerHTML = this._renderOutputsTab(t);
      }
      this._builtTab = 'outputs';
      return;
    }
  },

  // ═══════════════════════════════════════════════════════════
  //  外壳：历史横幅
  // ═══════════════════════════════════════════════════════════
  _historyBannerHtml(d, t) {
    const runName = (d.config && d.config.output_name) || (this.selectedRunDir.split('/').pop() || '');
    let html = '<div class="m-history-banner">';
    html += '<span class="m-history-icon">📜</span>';
    html += '<span class="m-history-label">' + this.esc(t('viewingHistory','Viewing history')) + '</span>';
    html += '<b class="m-history-name">' + this.esc(runName) + '</b>';
    if (d.train_result) {
      const st = d.train_result.status || '';
      const dur = d.train_result.duration_str || '';
      const stClass = st === 'completed' ? 'ok' : (st === 'failed' ? 'danger' : 'muted');
      html += '<span class="m-badge m-badge-' + stClass + '">' + this.esc(st) + '</span>';
      if (dur) html += '<span class="m-history-dur">' + this.esc(dur) + '</span>';
    }
    html += '<div class="m-history-spacer"></div>';
    html += '<button class="btn btn-sm" @click="clearRunDetail()">← ' + this.esc(t('backToLive','Back to live')) + '</button>';
    html += '</div>';
    return html;
  },

  // ═══════════════════════════════════════════════════════════
  //  外壳：状态卡 / GPU 卡 / 系统卡
  // ═══════════════════════════════════════════════════════════
  _statusCard(d, t) {
    const stateCode = d.state || 'IDLE';
    const stateLabels = {'RUNNING':t('training','Training'),'FINISHED':t('finished','Finished'),'TERMINATED':t('terminated','Terminated'),'CREATED':t('created','Pending'),'IDLE':t('idle','Idle')};
    const state = stateLabels[stateCode] || stateCode;
    const isTraining = stateCode === 'RUNNING';
    const color = isTraining ? 'var(--success)' : (d.has_error ? 'var(--danger)' : 'var(--text-secondary)');
    let html = '<div class="card card-status flex-1"><div class="card-header">' + this.esc(t('status','Status')) + '</div>';
    html += '<div class="m-state" data-field="state" style="color:' + color + '">' + this.esc(state) + '</div>';
    if (isTraining) {
      // 进度条 + 百分比右贴
      if (d.percent > 0) {
        html += '<div class="m-progress-row"><div class="monitor-bar-track m-progress"><div class="monitor-bar-fill ok" data-bar="progress" style="width:' + (d.percent||0) + '%"></div></div>';
        html += '<span class="m-progress-pct" data-field="pct">' + (d.percent||0) + '%</span></div>';
      }
      // 步数行
      html += '<div class="m-step-row" data-field="step">' + this.esc(t('step','Steps')) + ': <b>' + (d.step != null ? d.step : '?') + ' / ' + (d.total_steps||'?') + '</b></div>';
      // 指标网格 3 列：Loss / LR / Epoch
      html += '<div class="m-stat-grid">';
      html += '<div class="m-stat-cell"><span class="m-stat-label">' + this.esc(t('loss','Loss')) + '</span><span class="m-stat-val" data-field="loss">' + (d.loss != null ? this.esc(String(d.loss)) : '--') + '</span></div>';
      html += '<div class="m-stat-cell"><span class="m-stat-label">' + this.esc(t('lr','LR')) + '</span><span class="m-stat-val" data-field="lr">' + (d.lr != null ? this.esc(String(d.lr)) : '--') + '</span></div>';
      html += '<div class="m-stat-cell"><span class="m-stat-label">' + this.esc(t('epoch','Epoch')) + '</span><span class="m-stat-val" data-field="epoch">' + (d.epoch != null ? this.esc(String(d.epoch)) : '--') + '</span></div>';
      html += '</div>';
      // 时间行：已运行 + 剩余并排
      html += '<div class="m-time-row">';
      html += '<span class="m-time-item"><span class="m-time-icon">⏱</span>' + this.esc(t('elapsed','Elapsed')) + ': <b data-field="elapsed">' + (d.elapsed ? this.esc(String(d.elapsed)) : '--') + '</b></span>';
      html += '<span class="m-time-item"><span class="m-time-icon">⏳</span>' + this.esc(t('remaining','Remaining')) + ': <b data-field="eta">' + (d.eta ? this.esc(String(d.eta)) : '--') + '</b></span>';
      html += '</div>';
      // 速度行
      if (d.speed) html += '<div class="m-speed-row"><span class="m-time-icon">⚡</span>' + this.esc(t('speed','Speed')) + ': <b data-field="speed">' + this.esc(String(d.speed)) + '</b></div>';
      html += '<button class="btn btn-sm m-stop-btn" @click="stopTraining()">' + this.esc(t('stopTraining','Stop Training')) + '</button>';
    } else if (d.last_config && d.last_config.name) {
      const lc = d.last_config;
      html += '<div class="m-last">' + this.esc(t('lastTraining','Last')) + ': <b>' + this.esc(lc.name) + '</b></div>';
      html += '<div class="m-last-sub">' + this.esc(lc.model) + ' · LR:' + this.esc(lc.lr) + ' · Dim:' + this.esc(lc.dim) + ' · ' + this.esc(t('historyEpochs','Epochs')) + ':' + this.esc(lc.epochs) + '</div>';
    } else if (stateCode === 'IDLE' && !d.last_config) {
      html += '<div class="m-idle-hint">' + this.esc(t('noTrainingHint','Start a training task to see real-time progress here')) + '</div>';
      html += '<button class="btn btn-primary m-go-train" @click="navigate(\'train-basic\')">' + this.esc(t('goToTraining','Go to Training')) + '</button>';
    }
    if (d.has_error) html += '<div class="m-error">' + this.esc(d.error_msg || t('error','Error')) + '</div>';
    html += '</div>';
    return html;
  },

  _gpuCard(gpu, t) {
    const vramPct = gpu.vram_total_mb > 0 ? (gpu.vram_used_mb / gpu.vram_total_mb * 100) : 0;
    const loadPct = gpu.gpu_load_pct || 0;
    const vramGrade = this._gradeVram(vramPct);
    const loadGrade = this._gradeLoad(loadPct);
    let html = '<div class="card card-gpu flex-1"><div class="card-header">' + this.esc(t('gpu','GPU')) + '</div>';
    html += '<div class="m-gpu-name">' + this.esc(gpu.name || 'GPU') + '</div>';
    html += '<div class="monitor-stat">' + this.esc(t('vramUsed','VRAM')) + ': <b class="' + vramGrade + '" data-field="vram-text">' + gpu.vram_used_mb + ' MB (' + Math.round(vramPct) + '%) / ' + gpu.vram_total_mb + ' MB</b></div>';
    html += '<div class="monitor-bar-track"><div class="monitor-bar-fill ' + vramGrade + '" data-bar="vram" data-target="' + vramPct + '"></div></div>';
    html += '<div class="monitor-stat" style="margin-top:8px">' + this.esc(t('gpuLoad','Load')) + ': <b class="' + loadGrade + '" data-field="load-text">' + Math.round(loadPct) + '%</b></div>';
    html += '<div class="monitor-bar-track"><div class="monitor-bar-fill ' + loadGrade + '" data-bar="load" data-target="' + loadPct + '"></div></div>';
    if (gpu.temperature_c != null) {
      const tGrade = this._gradeTemp(gpu.temperature_c);
      html += '<div class="monitor-stat" style="margin-top:8px">' + this.esc(t('gpuTemp','Temp')) + ': <b class="' + tGrade + '" data-field="temp-text">' + gpu.temperature_c + '°C</b></div>';
    }
    if (gpu.power_w != null) html += '<div class="monitor-stat">' + this.esc(t('gpuPower','Power')) + ': <b>' + gpu.power_w + 'W</b></div>';
    html += '</div>';
    return html;
  },

  _systemCard(sys, t) {
    const cpuGrade = this._gradeCpuRam(sys.cpu_pct);
    const ramGrade = this._gradeCpuRam(sys.ram_pct);
    let html = '<div class="card card-system flex-1"><div class="card-header">' + this.esc(t('system','System')) + '</div>';
    if (sys.cpu_name) html += '<div class="m-cpu-name">' + this.esc(sys.cpu_name) + '</div>';
    html += '<div class="monitor-stat">' + this.esc(t('cpu','CPU')) + ': <b class="' + cpuGrade + '" data-field="cpu-text">' + Math.round(sys.cpu_pct) + '%</b></div>';
    html += '<div class="monitor-bar-track"><div class="monitor-bar-fill ' + cpuGrade + '" data-bar="cpu" data-target="' + sys.cpu_pct + '"></div></div>';
    html += '<div class="monitor-stat" style="margin-top:8px">' + this.esc(t('ram','RAM')) + ': <b class="' + ramGrade + '" data-field="ram-text">' + sys.ram_used_gb + ' GB (' + sys.ram_pct + '%) / ' + sys.ram_total_gb + ' GB</b></div>';
    html += '<div class="monitor-bar-track"><div class="monitor-bar-fill ' + ramGrade + '" data-bar="ram" data-target="' + sys.ram_pct + '"></div></div>';
    html += '</div>';
    return html;
  },

  // 外壳首次构建后初始化进度条（无动画跳到目标值）
  _initShellBars() {
    const el = document.getElementById('monitorDashboard');
    if (!el) return;
    el.querySelectorAll('.monitor-bar-fill[data-bar]').forEach(bar => {
      bar.style.transition = 'none';
      bar.style.width = (bar.dataset.target || 0) + '%';
      requestAnimationFrame(() => { bar.style.transition = ''; });
    });
  },

  // ── 外壳值原地打补丁（每 tick）──
  _patchCardValues(d, gpu, sys, t) {
    const statusEl = document.querySelector('.card-status');
    if (statusEl) {
      const stateCode = d.state || 'IDLE';
      const stateLabels = {'RUNNING':t('training','Training'),'FINISHED':t('finished','Finished'),'TERMINATED':t('terminated','Terminated'),'CREATED':t('created','Pending'),'IDLE':t('idle','Idle')};
      const state = stateLabels[stateCode] || stateCode;
      const isTraining = stateCode === 'RUNNING';
      const color = isTraining ? 'var(--success)' : (d.has_error ? 'var(--danger)' : 'var(--text-secondary)');
      const stateEl = statusEl.querySelector('[data-field="state"]');
      if (stateEl) { stateEl.textContent = state; stateEl.style.color = color; }
      // 进度条 + 百分比
      const progressBar = statusEl.querySelector('.monitor-bar-fill[data-bar="progress"]');
      if (progressBar && d.percent != null) progressBar.style.width = d.percent + '%';
      const pctEl = statusEl.querySelector('[data-field="pct"]');
      if (pctEl && d.percent != null) pctEl.textContent = d.percent + '%';
      // 步数行
      const stepEl = statusEl.querySelector('[data-field="step"]');
      if (stepEl && d.step != null) stepEl.innerHTML = this.esc(t('step','Steps')) + ': <b>' + d.step + ' / ' + (d.total_steps||'?') + '</b>';
      // 指标网格：Loss / LR / Epoch（纯文本更新，保留 data-field 容器）
      const _setVal = (key, val) => {
        const el = statusEl.querySelector('[data-field="' + key + '"]');
        if (el) el.textContent = (val != null && val !== '') ? this.esc(String(val)) : '--';
      };
      _setVal('loss', d.loss); _setVal('lr', d.lr); _setVal('epoch', d.epoch);
      // 时间行：已运行 + 剩余
      _setVal('elapsed', d.elapsed); _setVal('eta', d.eta);
      // 速度行
      _setVal('speed', d.speed);
    }

    if (gpu) {
      const gpuEl = document.querySelector('.card-gpu');
      if (gpuEl) {
        const vramPct = gpu.vram_total_mb > 0 ? (gpu.vram_used_mb / gpu.vram_total_mb * 100) : 0;
        const loadPct = gpu.gpu_load_pct || 0;
        const vramGrade = this._gradeVram(vramPct), loadGrade = this._gradeLoad(loadPct);
        const vramBar = gpuEl.querySelector('[data-bar="vram"]');
        if (vramBar) { vramBar.dataset.target = vramPct; vramBar.className = 'monitor-bar-fill ' + vramGrade; vramBar.style.width = vramPct + '%'; }
        const loadBar = gpuEl.querySelector('[data-bar="load"]');
        if (loadBar) { loadBar.dataset.target = loadPct; loadBar.className = 'monitor-bar-fill ' + loadGrade; loadBar.style.width = loadPct + '%'; }
        const vramText = gpuEl.querySelector('[data-field="vram-text"]');
        if (vramText) { vramText.textContent = gpu.vram_used_mb + ' MB (' + Math.round(vramPct) + '%) / ' + gpu.vram_total_mb + ' MB'; vramText.className = vramGrade; }
        const loadText = gpuEl.querySelector('[data-field="load-text"]');
        if (loadText) { loadText.textContent = Math.round(loadPct) + '%'; loadText.className = loadGrade; }
        if (gpu.temperature_c != null) {
          const tGrade = this._gradeTemp(gpu.temperature_c);
          const tempText = gpuEl.querySelector('[data-field="temp-text"]');
          if (tempText) { tempText.textContent = gpu.temperature_c + '°C'; tempText.className = tGrade; }
        }
      }
    }

    if (sys) {
      const sysEl = document.querySelector('.card-system');
      if (sysEl) {
        const cpuPct = sys.cpu_pct, ramPct = sys.ram_pct;
        const cpuGrade = this._gradeCpuRam(cpuPct), ramGrade = this._gradeCpuRam(ramPct);
        const cpuBar = sysEl.querySelector('[data-bar="cpu"]');
        if (cpuBar) { cpuBar.dataset.target = cpuPct; cpuBar.className = 'monitor-bar-fill ' + cpuGrade; cpuBar.style.width = cpuPct + '%'; }
        const ramBar = sysEl.querySelector('[data-bar="ram"]');
        if (ramBar) { ramBar.dataset.target = ramPct; ramBar.className = 'monitor-bar-fill ' + ramGrade; ramBar.style.width = ramPct + '%'; }
        const cpuText = sysEl.querySelector('[data-field="cpu-text"]');
        if (cpuText) { cpuText.textContent = Math.round(cpuPct) + '%'; cpuText.className = cpuGrade; }
        const ramText = sysEl.querySelector('[data-field="ram-text"]');
        if (ramText) { ramText.textContent = sys.ram_used_gb + ' GB (' + ramPct + '%) / ' + sys.ram_total_gb + ' GB'; ramText.className = ramGrade; }
      }
    }

    // 图表增量更新（若当前在图表标签或数据脏）
    if (this._chartsDirty || this.monitorTab === 'charts') this._syncCharts();
  },

  // ═══════════════════════════════════════════════════════════
  //  概览标签
  // ═══════════════════════════════════════════════════════════
  _renderOverviewTab(d, t, isHistory) {
    let html = '';
    if (isHistory && d.train_result) {
      const tr = d.train_result;
      html += '<div class="card" style="margin-top:12px"><div class="card-header">' + this.esc(t('trainResult','Training Result')) + '</div><div class="param-grid">';
      html += '<div class="param-item"><span class="param-label">' + this.esc(t('status','Status')) + '</span><span class="param-value" style="color:' + (tr.status==='completed'?'var(--success)':'var(--danger)') + '">' + this.esc(tr.status||'?') + '</span></div>';
      if (tr.duration_str) html += '<div class="param-item"><span class="param-label">' + this.esc(t('duration','Duration')) + '</span><span class="param-value">' + this.esc(tr.duration_str) + '</span></div>';
      if (tr.exit_code != null) html += '<div class="param-item"><span class="param-label">' + this.esc(t('monitor.exitCode','Exit Code')) + '</span><span class="param-value">' + tr.exit_code + '</span></div>';
      html += '</div></div>';
    }
    html += '<div class="card card-params" style="margin-top:12px"><div class="card-header">' + this.esc(t('trainParams','Parameters')) + '</div>';
    if (this.trainParams.length) {
      html += '<div class="param-grid">';
      this.trainParams.forEach(p => { html += '<div class="param-item"><span class="param-label">' + this.esc(p.label) + '</span><span class="param-value">' + this.esc(p.value) + '</span></div>'; });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>' + this.esc(t('noParamsHint','Start training to see parameters')) + '</p></div>';
    }
    html += '</div>';
    if (this.previews.length) {
      html += '<div class="card card-preview" style="margin-top:12px"><div class="card-header">' + this.esc(t('previewSamples','Preview')) + '</div><div class="preview-grid">';
      this.previews.slice(0, 6).forEach(p => {
        html += '<div class="preview-item" @click="monitorTab=\'samples\';renderDashboard()" style="cursor:pointer"><img src="' + this.esc(p.url) + '" alt="' + this.esc(p.name) + '" loading="lazy"/><span class="preview-name">' + this.esc(p.name) + '</span></div>';
      });
      html += '</div></div>';
    }
    return html;
  },

  // ═══════════════════════════════════════════════════════════
  //  日志标签（增量追加 + 保留滚动位置）
  // ═══════════════════════════════════════════════════════════
  _logsTabShellHtml(t) {
    let html = '<div class="card card-logs" style="margin-top:12px">';
    html += '<div class="card-header m-logs-header">';
    html += '<span>' + this.esc(t('logTitle','Real-time Logs')) + ' <span class="m-logs-count" data-field="log-count">' + this.logLines.length + '</span></span>';
    html += '<div class="m-logs-tools">';
    html += '<input type="text" class="m-logs-search" x-model="logSearch" placeholder="' + this.esc(t('logSearch','Search logs...')) + '" @input.debounce.300ms="renderDashboard()">';
    const levels = ['all','info','warn','error'];
    const levelLabels = {all:t('logLevelAll','All'),info:t('logLevelInfo','Info'),warn:t('logLevelWarn','Warn'),error:t('logLevelError','Error')};
    levels.forEach(l => {
      html += '<button type="button" class="log-level-btn" :class="{active:logLevel===\'' + l + '\'}" @click="logLevel=\'' + l + '\';renderDashboard()">' + this.esc(levelLabels[l]) + '</button>';
    });
    html += '<button type="button" class="btn btn-sm" :class="logAutoScroll?\'btn-primary\':\'btn-secondary\'" @click="logAutoScroll=!logAutoScroll"><span x-text="logAutoScroll?\'' + this.esc(t('logAutoScroll','Auto-scroll')) + ': ON\':\'' + this.esc(t('logAutoScroll','Auto-scroll')) + ': OFF\'"></span></button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="copyLogs()">' + this.esc(t('logCopy','Copy')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="confirm(\'' + this.esc(t('monitor.confirmClearLogs','Clear all logs?')).replace(/'/g,"\\'") + '\') && clearLogs()">' + this.esc(t('logClear','Clear')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="downloadLogs()">' + this.esc(t('logDownload','Download')) + '</button>';
    html += '</div></div>';
    html += '<div id="monitorDashboardLogs" class="monitor-logs-container log-lines">';
    html += '<button type="button" class="log-scroll-bottom" @click="logAutoScroll=true;_scrollLogsToBottom()" style="display:none">' + this.esc(t('scrollToBottom','↓ Bottom')) + '</button>';
    html += '</div></div>';
    return html;
  },

  // 日志行是否匹配过滤
  _logLineMatches(line, search, level) {
    const lower = line.toLowerCase();
    if (search && lower.indexOf(search) === -1) return false;
    if (level === 'error') {
      return lower.indexOf('error') !== -1 || lower.indexOf('traceback') !== -1 || lower.indexOf('exception') !== -1 || /\bcuda\b.*\berror\b/i.test(line) || /\bfail\b/i.test(line);
    } else if (level === 'warn') {
      return lower.indexOf('warning') !== -1 || lower.indexOf('warn') !== -1 || /\bdeprecated\b/i.test(line);
    } else if (level === 'info') {
      return !(lower.indexOf('error') !== -1 || lower.indexOf('traceback') !== -1 || lower.indexOf('exception') !== -1 || lower.indexOf('warning') !== -1 || lower.indexOf('warn') !== -1);
    }
    return true;
  },

  _renderLogs(contentEl, d, t, tabChanged) {
    const search = (this.logSearch || '').toLowerCase();
    const level = this.logLevel || 'all';
    const filterKey = search + '|' + level;
    const shellInDom = !!contentEl.querySelector('#monitorDashboardLogs');

    if (tabChanged || !shellInDom) {
      // 构建日志标签外壳（含搜索框等头部 + 滚动容器）
      contentEl.innerHTML = this._logsTabShellHtml(t);
      this._renderedLogFilterKey = filterKey;
      this._renderedLogCount = 0;
      this._forceLogRebuild = false;
      this._populateLogs(contentEl, search, level, true);
      this._bindLogScroll(contentEl);
    } else {
      // 外壳已存在：按需重建或增量追加
      const filterChanged = this._renderedLogFilterKey !== filterKey;
      const trimmed = this.logLines.length < this._renderedLogCount;
      if (filterChanged || trimmed || this._forceLogRebuild) {
        this._renderedLogFilterKey = filterKey;
        this._renderedLogCount = 0;
        this._forceLogRebuild = false;
        this._populateLogs(contentEl, search, level, true);
      } else if (this.logLines.length > this._renderedLogCount) {
        this._populateLogs(contentEl, search, level, false);
      }
      // 更新计数
      const countEl = contentEl.querySelector('[data-field="log-count"]');
      if (countEl) countEl.textContent = this.logLines.length;
    }
    this._afterLogsRender(contentEl);
  },

  // 填充日志行：isFull=true 清空后全量，false 仅追加新增
  _populateLogs(contentEl, search, level, isFull) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    if (isFull) {
      // 清空已有日志行与空态（保留滚动到底按钮）
      container.querySelectorAll('.log-line, .log-empty').forEach(n => n.remove());
    }
    const lines = this.logLines;
    const start = isFull ? 0 : this._renderedLogCount;
    const frag = document.createDocumentFragment();
    let appended = 0;

    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (!this._logLineMatches(line, search, level)) continue;
      const lo = line.toLowerCase();
      const cls = (lo.indexOf('error') !== -1 || lo.indexOf('traceback') !== -1) ? 'log-error' : (lo.indexOf('warning') !== -1 ? 'log-warn' : '');
      const div = document.createElement('div');
      div.className = 'log-line ' + cls;
      const num = document.createElement('span');
      num.className = 'log-line-num';
      num.textContent = (i + 1);
      const span = document.createElement('span');
      span.className = 'log-line-text';
      span.innerHTML = this._formatLogLine(line, search);
      div.appendChild(num);
      div.appendChild(span);
      frag.appendChild(div);
      appended++;
    }

    if (isFull) {
      if (lines.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'log-empty dashboard-empty';
        empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>' + this.esc(this.t('monitor.noLogsHint','No logs yet')) + '</p>';
        frag.appendChild(empty);
      } else if (appended === 0) {
        const empty = document.createElement('div');
        empty.className = 'log-empty dashboard-empty';
        empty.innerHTML = '<p>' + this.esc(this.t('monitor.noResults','No matches')) + '</p>';
        frag.appendChild(empty);
      }
    }
    // 滚动到底按钮保持在容器末尾
    const btn = container.querySelector('.log-scroll-bottom');
    if (btn) container.insertBefore(frag, btn); else container.appendChild(frag);
    this._renderedLogCount = lines.length;
  },

  _bindLogScroll(contentEl) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    this._logAtBottom = true;
    container.onscroll = () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
      this._logAtBottom = atBottom;
      if (this.logAutoScroll && !atBottom) this.logAutoScroll = false;
      else if (!this.logAutoScroll && atBottom) this.logAutoScroll = true;
      this._updateLogScrollButton(contentEl);
    };
  },

  _scrollLogsToBottom() {
    const container = document.querySelector('#monitorDashboardLogs');
    if (container) { container.scrollTop = container.scrollHeight; this._logAtBottom = true; }
    this._updateLogScrollButton(document.getElementById('monitorTabContent'));
  },

  _updateLogScrollButton(contentEl) {
    if (!contentEl) return;
    const btn = contentEl.querySelector('.log-scroll-bottom');
    if (btn) btn.style.display = this._logAtBottom ? 'none' : 'flex';
  },

  _afterLogsRender(contentEl) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    // 仅当用户在底部（或开启自动滚动）时滚到底；用户上滚阅读时保持原位（修复"回顶"）
    if (this.logAutoScroll || this._logAtBottom) {
      container.scrollTop = container.scrollHeight;
      this._logAtBottom = true;
    }
    this._updateLogScrollButton(contentEl);
  },

  _highlightSearch(escapedHtml, escapedSearch) {
    if (!escapedSearch) return escapedHtml;
    if (!this._searchRegex || this._cachedSearch !== escapedSearch) {
      this._cachedSearch = escapedSearch;
      this._searchRegex = new RegExp('(' + escapedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    }
    return escapedHtml.replace(this._searchRegex, '<mark>$1</mark>');
  },

  _formatLogLine(line, search) {
    let displayLine = this.esc(line);
    if (search) displayLine = this._highlightSearch(displayLine, this.esc(search));
    return displayLine;
  },

  downloadLogs() {
    const content = this.logLines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'training-logs-' + new Date().toISOString().slice(0,19).replace(/[T:]/g,'-') + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.toast(this.t('common.downloaded','Downloaded!'));
  },

  // ═══════════════════════════════════════════════════════════
  //  图表标签（实例复用 + 占位 + 消除竞态）
  // ═══════════════════════════════════════════════════════════
  _renderCharts(contentEl, d, t, tabChanged) {
    const tags = this.lossSeries.length ? this.lossSeries : this._placeholderTags(t);
    const tagSig = tags.map(s => s.tag).join(',');
    if (tabChanged || this._builtChartsSig !== tagSig) {
      this._builtChartsSig = tagSig;
      // 标签集合变化：重建 canvas HTML 并销毁旧实例
      this._destroyCharts();
      contentEl.innerHTML = this._chartsTabShellHtml(tags, t);
    }
    // 同步图表数据（创建/更新/占位），每次调用都安全
    this._syncCharts();
    this._chartsDirty = false;
  },

  _chartsTabShellHtml(tags, t) {
    let html = '<div class="card card-charts"><div class="card-header m-charts-header"><span>' + this.esc(t('lossCurve','Loss/LR')) + '</span>';
    html += '<label class="m-smooth"><span>' + this.esc(t('smooth','Smooth')) + '</span><input type="range" min="0" max="0.99" step="0.01" x-model="chartSmoothing" @input="chartSmoothing=$event.target.value;_syncCharts()" @change="renderDashboard()" value="' + (this.chartSmoothing||0) + '"></label></div>';
    html += '<div class="chart-grid">';
    tags.forEach(s => {
      const id = 'chart-' + s.tag.replace(/[/.]/g, '-');
      html += '<div class="chart-panel" id="panel-' + id + '"><div class="chart-title">' + this.esc(s.name) + ' <span class="chart-val">' + (s.latest != null ? s.latest.toFixed(4) : '--') + '</span></div><canvas id="' + id + '" width="360" height="200"></canvas><div class="chart-placeholder">' + this.esc(this.t('monitor.waitingData','Waiting for data…')) + '</div></div>';
    });
    html += '</div></div>';
    return html;
  },

  _smoothedPoints(s) {
    const smoothing = this.chartSmoothing || 0;
    if (smoothing <= 0 || !s.points || s.points.length <= 1) return s.points || [];
    const out = [];
    let ema = s.points[0].value;
    const alpha = 1 - smoothing;
    s.points.forEach((p, i) => { if (i === 0) ema = p.value; else ema = alpha * p.value + (1 - alpha) * ema; out.push({ step: p.step, value: ema }); });
    return out;
  },

  // 统一同步：有≥2点则创建/更新实例，<2点则显示占位（幂等，可每帧调用）
  _syncCharts() {
    if (!this._chartInstances) this._chartInstances = {};
    const isDark = this.resolvedTheme === 'dark';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const textColor = isDark ? '#a1a1a6' : '#6e6e73';
    const tooltipBg = isDark ? '#1c1c1e' : '#ffffff';
    const tooltipBorder = isDark ? '#48484a' : '#d2d2d7';
    const colors = ['#BF5AF2','#64D2FF','#FF9F0A','#30D158','#FF453A','#5DA0F7'];
    const t = (k, fb) => this.t('monitor.' + k) || fb || k;

    this.lossSeries.forEach((s, idx) => {
      const id = 'chart-' + s.tag.replace(/[/.]/g, '-');
      const canvas = document.getElementById(id);
      if (!canvas) return;
      const panel = canvas.closest('.chart-panel');
      const hasEnough = s.points && s.points.length >= 2;
      let chart = this._chartInstances[id];
      const valEl = panel ? panel.querySelector('.chart-val') : null;

      if (!hasEnough) {
        // 数据不足：销毁实例（若有）并显示占位
        if (chart) { try { chart.destroy(); } catch(_){} delete this._chartInstances[id]; chart = null; }
        if (panel) panel.classList.add('chart-empty');
        if (valEl) valEl.textContent = '--';
        return;
      }
      if (panel) panel.classList.remove('chart-empty');
      const points = this._smoothedPoints(s);
      const chartData = points.map(p => ({ x: p.step, y: p.value }));
      const xs = points.map(p => p.step);
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const color = colors[idx % colors.length];

      if (!chart) {
        const ctx = canvas.getContext('2d');
        this._chartInstances[id] = new Chart(ctx, {
          type: 'line',
          plugins: [{ id: 'gradientFill' + id, beforeDatasetsDraw(chart) { const { ctx: gctx, chartArea } = chart; if (!chartArea) return; const grad = gctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom); grad.addColorStop(0, color + '40'); grad.addColorStop(1, color + '05'); chart.data.datasets[0].backgroundColor = grad; } }],
          data: { datasets: [{ label: s.name, data: chartData, borderColor: color, fill: true, tension: 0.3, pointRadius: 0, pointHitRadius: 8, pointHoverRadius: 5, pointHoverBackgroundColor: color, borderWidth: 1.8 }] },
          options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'nearest', intersect: false }, layout: { padding: { top: 4, right: 8, bottom: 0, left: 0 } },
            plugins: { legend: { display: false }, tooltip: { backgroundColor: tooltipBg, titleColor: textColor, bodyColor: textColor, borderColor: tooltipBorder, borderWidth: 1, padding: 8, displayColors: false, callbacks: { title: (items) => t('stepPrefix','Step ') + items[0].parsed.x, label: (item) => item.dataset.label + ': ' + item.parsed.y.toFixed(6) } } },
            scales: { x: { type: 'linear', min: xMin, max: xMax, grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 }, maxTicksLimit: 8, callback: (v) => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v } }, y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 }, maxTicksLimit: 6, callback: (v) => parseFloat(v.toFixed(4)) } } } }
        });
        chart = this._chartInstances[id];
      } else {
        chart.data.datasets[0].data = chartData;
        chart.data.datasets[0].label = s.name;
        chart.options.scales.x.min = xMin;
        chart.options.scales.x.max = xMax;
        chart.update('none');
      }
      if (valEl && s.latest != null) valEl.textContent = s.latest.toFixed(4);
    });

    // 占位标签（无 lossSeries 时）—— 确保占位显示
    if (!this.lossSeries.length) {
      document.querySelectorAll('.chart-panel').forEach(p => p.classList.add('chart-empty'));
    }
  },

  // 兼容旧调用名
  _updateCharts() { this._syncCharts(); },
  _drawCharts() { this._syncCharts(); },

  // ═══════════════════════════════════════════════════════════
  //  样本标签
  // ═══════════════════════════════════════════════════════════
  _renderSamplesTab(t) {
    let html = '<div class="card card-preview"><div class="card-header">' + this.esc(t('previewSamples','Preview')) + '</div>';
    if (this.previews.length) {
      const step = Math.min(this.previewStep, this.previews.length - 1);
      const p = this.previews[step] || this.previews[0];
      html += '<div class="preview-controls"><button class="btn btn-sm" @click="previewStep=Math.max(0,previewStep-1);renderDashboard()" :disabled="previewStep<=0">← ' + this.esc(this.t('monitor.prev','Prev')) + '</button>';
      html += '<span class="preview-step">Step <b x-text="previewStep+1"></b> / ' + this.previews.length + '</span>';
      html += '<button class="btn btn-sm" @click="previewStep=Math.min(' + (this.previews.length - 1) + ',previewStep+1);renderDashboard()" :disabled="previewStep>=' + (this.previews.length - 1) + '">' + this.esc(this.t('monitor.next','Next')) + ' →</button></div>';
      html += '<div class="preview-grid">';
      html += '<div class="preview-item preview-main"><img src="' + this.esc(p.url) + '" alt="' + this.esc(p.name) + '" loading="lazy" onclick="window.open(\'' + this.esc(p.url).replace(/'/g, '&#39;') + '\')"/><span>' + this.esc(p.name) + '</span></div>';
      this.previews.forEach((pv, i) => {
        html += '<div class="preview-item preview-thumb' + (i === step ? ' active' : '') + '" @click="previewStep=' + i + ';renderDashboard()"><img src="' + this.esc(pv.url) + '" alt="' + this.esc(pv.name) + '" loading="lazy"/></div>';
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><p>' + this.esc(t('noPreviewHint','Preview images appear during training')) + '</p></div>';
    }
    html += '</div>';
    return html;
  },

  // ═══════════════════════════════════════════════════════════
  //  输出标签
  // ═══════════════════════════════════════════════════════════
  _renderOutputsTab(t) {
    let html = '<div class="card card-outputs" style="margin-top:12px">';
    html += '<div class="card-header m-outputs-header">';
    html += '<span>' + this.esc(t('outputs','Training Outputs')) + '</span>';
    html += '<div class="m-outputs-tools">';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="loadOutputFiles()">' + this.esc(t('refresh','Refresh')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="selectAllOutputFiles()">' + this.esc(t('selectAll','Select All')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="deselectAllOutputFiles()">' + this.esc(t('deselectAll','Deselect All')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-primary" @click="downloadSelectedOutputs()">' + this.esc(t('downloadSelected','Download Selected')) + '</button>';
    html += '<button type="button" class="btn btn-sm" @click="downloadAllOutputs()">' + this.esc(t('downloadAll','Download All')) + '</button>';
    html += '</div></div>';

    if (this.outputFilesLoading) {
      html += '<div class="dashboard-empty" style="padding:48px"><p>' + this.esc(t('loading','Loading...')) + '</p></div>';
    } else if (this.outputFiles.length) {
      const selectedCount = this.selectedOutputFiles.length;
      if (selectedCount > 0) {
        html += '<div class="m-outputs-selected">' + this.esc(t('selected','Selected')) + ': ' + selectedCount + ' / ' + this.outputFiles.length + '</div>';
      }
      html += '<div class="output-list">';
      this.outputFiles.forEach(f => {
        const isSelected = !!this.outputFilesSelected[f.path];
        const fpJs = this.escapeJsString(f.path);
        html += '<div class="output-item' + (isSelected ? ' selected' : '') + '" @click="toggleOutputFile(\'' + fpJs + '\')">';
        html += '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' @click.stop="toggleOutputFile(\'' + fpJs + '\')">';
        html += '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
        html += '<span class="output-name">' + this.esc(f.name) + '</span>';
        if (f.is_lora) html += '<span class="badge output-lora-badge">LoRA</span>';
        html += '<span class="output-size">' + this._formatFileSize(f.size) + '</span>';
        html += '<span class="output-time">' + this._formatFileTime(f.mtime) + '</span>';
        html += '<button class="btn btn-sm btn-secondary output-dl-btn" @click.stop="downloadSingleOutput(\'' + fpJs + '\')" title="' + this.esc(t('common.download','Download')) + '">⬇</button>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><p>' + this.esc(t('noOutputsHint','Training outputs will appear here after saving')) + '</p></div>';
    }
    html += '</div>';
    return html;
  },

  _formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
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
    if (!el) return;
    const t = (k, fb) => this.t('monitor.' + k) || fb || k;
    const hasRunning = this.runningTask && this.runningTask.status === 'RUNNING';
    const items = this.filteredHistoryItems;
    const hasHistory = items && items.length;

    if (!hasRunning && !hasHistory && !(this.historyItems && this.historyItems.length)) {
      el.innerHTML = '<div class="dashboard-empty" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><p>' + this.esc(t('historyNoRecords', 'No training history')) + '</p><p class="m-empty-sub">' + this.esc(t('historyWillAppear', 'Records will appear after training')) + '</p></div>';
      return;
    }

    let html = '';

    // 运行中任务卡片（置顶高亮）
    if (hasRunning) {
      const r = this.runningTask;
      html += '<div class="card history-card history-running">';
      html += '<div class="card-header">' + this.esc(t('running', 'Running')) + ' <span class="badge badge-running">' + this.esc(t('training', 'Training') || 'Training') + '</span></div>';
      html += '<div class="hist-name"><b>' + this.esc(r.name || r.id || '') + '</b></div>';
      html += '<div class="hist-meta">' + this.esc(t('historyModel', 'Model')) + ': ' + this.esc((r.model || '').split(/[\\\/]/).pop() || 'Unknown') + '</div>';
      html += '<div class="hist-meta">' + this.esc(t('historyLR', 'LR')) + ': ' + this.esc(r.lr || '?') + ' | ' + this.esc(t('historyDim', 'Dim')) + ': ' + this.esc(r.dim || '?') + ' | ' + this.esc(t('historyEpochs', 'Epochs')) + ': ' + this.esc(r.epochs || '?') + '</div>';
      if (r.run_dir) html += '<div class="hist-rundir">' + this.esc(t('runDir', 'Folder') || 'Folder') + ': ' + this.esc(r.run_dir) + '</div>';
      html += '<div class="hist-actions"><button class="btn btn-sm btn-primary" @click="navigate(\'monitor-dashboard\')">' + this.esc(t('monitor.viewDashboard','View Dashboard')) + '</button></div>';
      html += '</div>';
    }

    // 工具栏：搜索 + 状态筛选
    if (this.historyItems && this.historyItems.length) {
      html += '<div class="hist-toolbar">';
      html += '<input type="text" class="hist-search" x-model="historySearch" placeholder="' + this.esc(t('monitor.searchHistory','Search history...')) + '" @input.debounce.200ms="renderHistory()">';
      const filters = [['all', t('logLevelAll','All')], ['completed', t('monitor.statusCompleted','Completed')], ['failed', t('monitor.statusFailed','Failed')], ['terminated', t('monitor.statusTerminated','Terminated')]];
      filters.forEach(f => {
        html += '<button type="button" class="hist-filter-btn" :class="{active:historyFilter===\'' + f[0] + '\'}" @click="historyFilter=\'' + f[0] + '\';renderHistory()">' + this.esc(f[1]) + '</button>';
      });
      html += '</div>';

      if (hasRunning) html += '<div class="hist-section-label">' + this.esc(t('pastRuns', 'Past Runs')) + '</div>';
      html += '<div class="history-grid">';
      items.forEach(h => {
        const runDirJs = this.escapeJsString(h.run_dir || '');
        html += '<div class="card history-card">';
        // 头部：时间 + 状态徽章 + 时长
        html += '<div class="hist-card-head">';
        html += '<span class="hist-time">' + this.esc(h.time) + '</span>';
        if (h.status) {
          const statusColors = { completed: 'ok', failed: 'danger', error: 'danger', terminated: 'muted' };
          const statusLabels = { completed: t('monitor.statusCompleted','✓ Completed'), failed: t('monitor.statusFailed','✗ Failed'), error: t('monitor.statusError','✗ Error'), terminated: t('monitor.statusTerminated','⏹ Terminated') };
          html += '<span class="m-badge m-badge-' + (statusColors[h.status] || 'muted') + '">' + this.esc(statusLabels[h.status] || h.status) + '</span>';
        }
        if (h.duration) html += '<span class="hist-duration">' + this.esc(h.duration) + '</span>';
        html += '</div>';
        // 主体：可点击查看详情
        html += '<div class="hist-card-body" @click="' + (h.run_dir ? 'viewRunDetail(\'' + runDirJs + '\')' : 'navigate(\'monitor-dashboard\')') + '">';
        html += '<div class="hist-name"><b>' + this.esc(h.name || '') + '</b></div>';
        html += '<div class="hist-meta">' + this.esc(t('historyModel', 'Model')) + ': ' + this.esc(h.model || '') + '</div>';
        html += '<div class="hist-meta">' + this.esc(t('historyLR', 'LR')) + ': ' + this.esc(h.lr || '') + ' | ' + this.esc(t('historyDim', 'Dim')) + ': ' + this.esc(h.dim || '') + ' | ' + this.esc(t('historyEpochs', 'Epochs')) + ': ' + this.esc(h.epochs || '') + '</div>';
        if (h.dataset) html += '<div class="hist-dataset">' + this.esc(t('dataset', 'Dataset') || 'Dataset') + ': ' + this.esc(h.dataset) + '</div>';
        html += '</div>';
        // 操作按钮
        if (h.run_dir) {
          html += '<div class="hist-actions">';
          html += '<button class="btn btn-sm btn-secondary" @click.stop="viewRunDetail(\'' + runDirJs + '\')">' + this.esc(t('viewDetails', 'View Details')) + '</button>';
          html += '<button class="btn btn-sm btn-secondary" @click.stop="viewSnapshot(\'' + runDirJs + '\')">' + this.esc(t('viewConfig', 'View Config')) + '</button>';
          html += '<button class="btn btn-sm btn-secondary" @click.stop="downloadRunOutputs(\'' + runDirJs + '\')" title="' + this.esc(t('downloadAll','Download All')) + '">⬇</button>';
          html += '<button class="btn btn-sm" @click.stop="reuseConfig(\'' + runDirJs + '\')">' + this.esc(t('reuseConfig', 'Reuse')) + '</button>';
          html += '<button class="btn btn-sm btn-danger hist-delete" @click.stop="deleteHistoryRun(\'' + runDirJs + '\')" title="' + this.esc(t('common.delete','Delete')) + '">✕</button>';
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }

    // 配置快照弹窗占位
    html += '<div id="configSnapshotModal" class="modal-overlay" style="display:none"><div class="modal" style="max-width:700px"><div class="modal-header"><span>' + this.esc(t('configSnapshot','Config Snapshot')) + '</span><button class="btn btn-sm" @click="closeSnapshotModal()" style="font-size:18px;line-height:1;padding:4px 8px">&times;</button></div><div class="modal-body" id="configSnapshotContent"></div></div></div>';

    el.innerHTML = html;
  },

  // 从历史页直接下载某次训练的全部产物
  async downloadRunOutputs(runDir) {
    if (!runDir) return;
    this._triggerDownload('/api/monitor/outputs/download?run_dir=' + encodeURIComponent(runDir));
  },

  async viewSnapshot(runDir) {
    const t = (k, fb) => this.t('monitor.' + k) || fb || k;
    try {
      this.startProgress();
      const r = await fetch('/api/monitor/config-from-run?run_dir=' + encodeURIComponent(runDir));
      const j = await r.json();
      if (j.status === 'success') {
        this.showSnapshotModal(j.data);
      } else {
        this.toast(j.message || t('configLoadError', 'Failed to load config'), 'error');
      }
    } catch (e) {
      this.toast(t('configLoadError', 'Failed to load config'), 'error');
    } finally {
      this.finishProgress();
    }
  },

  showSnapshotModal(snapshot) {
    const modal = document.getElementById('configSnapshotModal');
    const content = document.getElementById('configSnapshotContent');
    if (!modal || !content) return;
    const t = (k, fb) => this.t('monitor.' + k) || fb || k;

    let html = '';
    if (snapshot.params) {
      const p = snapshot.params;
      html += '<div class="param-grid" style="margin-bottom:16px">';
      const keyParams = [
        { label: t('historyModel', 'Model'), value: p.pretrained_model_name_or_path || '' },
        { label: t('historyLR', 'Learning Rate'), value: p.learning_rate || '' },
        { label: t('historyDim', 'Network Dim'), value: p.network_dim || '' },
        { label: t('historyEpochs', 'Epochs'), value: p.max_train_epochs || '' },
        { label: t('batchSize', 'Batch Size'), value: p.train_batch_size || '' },
        { label: t('outputName', 'Output Name'), value: p.output_name || '' },
      ];
      keyParams.forEach(kv => { if (kv.value) html += '<div class="param-item"><span class="param-label">' + this.esc(kv.label) + '</span><span class="param-value">' + this.esc(String(kv.value)) + '</span></div>'; });
      html += '</div>';
    }
    if (snapshot.content) {
      html += '<details open><summary class="m-details-summary">' + this.esc(t('rawConfig', 'Raw Config (TOML)')) + '</summary>';
      html += '<pre class="m-config-pre">' + this.esc(snapshot.content) + '</pre></details>';
    }
    html += '<div class="m-modal-footer"><button class="btn btn-sm btn-secondary" @click="copyConfigContent()">' + this.esc(t('copyConfig', 'Copy Config')) + '</button>';
    html += '<button class="btn btn-sm" @click="reuseConfigFromSnapshot(\'' + this.escapeJsString(snapshot.run_dir || '') + '\')">' + this.esc(t('reuseConfig', 'Reuse Config')) + '</button></div>';

    content.innerHTML = html;
    modal.style.display = 'flex';
    this._currentSnapshot = snapshot;
  },

  closeSnapshotModal() {
    const modal = document.getElementById('configSnapshotModal');
    if (modal) modal.style.display = 'none';
  },

  copyConfigContent() {
    if (this._currentSnapshot && this._currentSnapshot.content) {
      navigator.clipboard.writeText(this._currentSnapshot.content).then(() => this.toast(this.t('common.copied') || 'Copied!'));
    }
  },

  async reuseConfig(runDir) {
    const t = (k, fb) => this.t('monitor.' + k) || fb || k;
    try {
      this.startProgress();
      const r = await fetch('/api/monitor/config-from-run?run_dir=' + encodeURIComponent(runDir));
      const j = await r.json();
      if (j.status === 'success' && j.data.params) {
        this._applyConfigToTraining(j.data.params);
        this.toast(t('configLoaded', 'Config loaded! Redirecting to training page...'), 'success');
        this.navigate('train-basic');
      } else {
        this.toast(j.message || t('configLoadError', 'Failed to load config'), 'error');
      }
    } catch (e) {
      this.toast(t('configLoadError', 'Failed to load config'), 'error');
    } finally {
      this.finishProgress();
    }
  },

  reuseConfigFromSnapshot(runDir) {
    this.closeSnapshotModal();
    if (runDir) this.reuseConfig(runDir);
  },

  _applyConfigToTraining(params) {
    if (!params || !this.form) return;
    for (const key of Object.keys(params)) {
      if (key === 'sample_prompts' || key.startsWith('_')) continue;
      if (params[key] !== undefined && params[key] !== null && this.form.hasOwnProperty(key)) {
        this.form[key] = String(params[key]);
      }
    }
    if (this.updateToml) this.updateToml();
  }
};
