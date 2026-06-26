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
  // ── 资源指标等级（低=绿 ok / 高=橙 warn，无深红）──
  _ringGrade(pct, mid) { return (pct||0) >= mid ? 'warn' : 'ok'; },
  _ringGradeTemp(temp) { return temp == null ? '' : (temp >= 80 ? 'warn' : 'ok'); },

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
    const t = (k,fb) => { const fullKey = k.includes('.') ? k : ('monitor.'+k); return this.t(fullKey)||fb||k; };
    const tab = this.monitorTab||'overview';

    // ── 1. 外壳层：仅在首次或历史模式切换时构建 ──
    if (!this._shellBuilt || this._shellHistoryMode !== isHistory) {
      this._shellBuilt = true;
      this._shellHistoryMode = isHistory;
      this._builtTab = null;
      let shell = '<div class="monitor-dashboard">';
      if (isHistory) {
        shell += this._historyBannerHtml(d, t);
      } else {
        shell += this._statusbarHtml(d, gpu, sys, t);
      }
      shell += '<div id="monitorTabContent"></div>';
      shell += '</div>';
      el.innerHTML = shell;
    } else if (!isHistory) {
      // ── 2. 外壳原地打补丁（每 tick，不重建 DOM）──
      this._patchStatusbar(d, gpu, sys, t);
    }

    // ── 3. 标签页内容 ──
    this._renderTab(tab, d, gpu, sys, t, isHistory);
  },

  // ═══════════════════════════════════════════════════════════
  //  外壳：单行紧凑信息条 + 资源圆环
  // ═══════════════════════════════════════════════════════════
  _statusbarHtml(d, gpu, sys, t) {
    const stateCode = d.state || 'IDLE';
    const stateLabels = {'RUNNING':t('training','Training'),'FINISHED':t('finished','Finished'),'TERMINATED':t('terminated','Terminated'),'CREATED':t('created','Pending'),'IDLE':t('idle','Idle')};
    const state = stateLabels[stateCode] || stateCode;
    const isTraining = stateCode === 'RUNNING';
    const stateColor = isTraining ? 'var(--success)' : (d.has_error ? 'var(--danger)' : 'var(--text-secondary)');

    let html = '<div class="m-statusbar">';
    // 左：状态 + 进度
    html += '<div class="m-sb-left">';
    html += '<span class="m-sb-state" data-field="state" style="color:' + stateColor + '">' + this.esc(state) + '</span>';
    if (isTraining) {
      if (d.percent > 0) {
        html += '<div class="m-sb-progress"><div class="m-sb-bar" data-bar="progress" style="width:' + (d.percent||0) + '%"></div></div>';
        html += '<span class="m-sb-pct" data-field="pct">' + (d.percent||0) + '%</span>';
      }
    }
    html += '</div>';

    // 中：关键指标（训练中）
    if (isTraining) {
      html += '<div class="m-sb-metrics">';
      html += '<span class="m-sb-m" data-field="step">' + this.esc(t('step','Steps')) + ' <b>' + (d.step != null ? d.step : '?') + '/' + (d.total_steps||'?') + '</b></span>';
      html += '<span class="m-sb-m" data-field="loss">loss <b>' + (d.loss != null ? this.esc(String(d.loss)) : '--') + '</b></span>';
      html += '<span class="m-sb-m" data-field="lr">lr <b>' + (d.lr != null ? this.esc(String(d.lr)) : '--') + '</b></span>';
      html += '<span class="m-sb-m" data-field="epoch">ep <b>' + (d.epoch != null ? this.esc(String(d.epoch)) : '--') + '</b></span>';
      html += '<span class="m-sb-m"><svg class="m-sb-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><b data-field="elapsed">' + (d.elapsed ? this.esc(String(d.elapsed)) : '--') + '</b></span>';
      html += '<span class="m-sb-m"><svg class="m-sb-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 10"/></svg><b data-field="eta">' + (d.eta ? this.esc(String(d.eta)) : '--') + '</b></span>';
      html += '<span class="m-sb-m"><svg class="m-sb-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><b data-field="speed">' + (d.speed ? this.esc(String(d.speed)) : '--') + '</b></span>';
      html += '</div>';
    } else if (d.last_config && d.last_config.name) {
      const lc = d.last_config;
      html += '<div class="m-sb-metrics">';
      html += '<span class="m-sb-m">' + this.esc(t('lastTraining','Last')) + ': <b>' + this.esc(lc.name) + '</b></span>';
      html += '<span class="m-sb-m">' + this.esc(lc.model) + ' · LR ' + this.esc(lc.lr) + ' · Dim ' + this.esc(lc.dim) + '</span>';
      html += '</div>';
    } else if (stateCode === 'IDLE') {
      html += '<div class="m-sb-metrics"><span class="m-sb-m m-sb-hint">' + this.esc(t('noTrainingHint','Start a training task to see real-time progress here')) + '</span></div>';
    }
    if (d.has_error) html += '<span class="m-sb-error">' + this.esc(d.error_msg || t('error','Error')) + '</span>';

    // 右：资源监控面板（环形 + 型号 + 详细数值）
    html += '<div class="m-sb-right">';
    if (isTraining) html += '<button class="btn btn-sm m-sb-stop" @click="stopTraining()">' + this.esc(t('stopTraining','Stop')) + '</button>';
    if (gpu) html += this._gpuPanel(gpu, t);
    if (sys) html += this._sysPanel(sys, t);
    html += '</div>';
    html += '</div>';
    return html;
  },

  // GPU 资源面板：型号 + 环形行 + 数值行
  _gpuPanel(gpu, t) {
    const loadPct = gpu.gpu_load_pct || 0;
    const vramPct = gpu.vram_total_mb > 0 ? (gpu.vram_used_mb / gpu.vram_total_mb * 100) : 0;
    const temp = gpu.temperature_c;
    let html = '<div class="m-res-panel" data-res="gpu">';
    // 型号标题（完整显示，允许换行）
    if (gpu.name) html += '<div class="m-res-name">' + this.esc(gpu.name) + '</div>';
    // 环形行
    html += '<div class="m-res-rings">';
    html += this._ringSvg('load', Math.round(loadPct), '%', this._ringGrade(loadPct, 90), t('gpuLoad','Load'));
    html += this._ringSvg('vram', Math.round(vramPct), '%', this._ringGrade(vramPct, 92), t('vramUsed','VRAM'));
    if (temp != null) html += this._ringSvg('temp', temp, '°', this._ringGradeTemp(temp), t('gpuTemp','Temp'));
    html += '</div>';
    // 数值行：VRAM 绝对值 + 功率
    html += '<div class="m-res-details">';
    html += '<span data-field="vram-text">' + gpu.vram_used_mb + '/' + gpu.vram_total_mb + 'MB</span>';
    if (gpu.power_w != null) html += '<span data-field="power-text">' + gpu.power_w + 'W</span>';
    html += '</div>';
    html += '</div>';
    return html;
  },

  // 系统资源面板：CPU 型号 + 环形行 + 数值行
  _sysPanel(sys, t) {
    let html = '<div class="m-res-panel" data-res="sys">';
    if (sys.cpu_name) html += '<div class="m-res-name">' + this.esc(sys.cpu_name) + '</div>';
    html += '<div class="m-res-rings">';
    html += this._ringSvg('cpu', Math.round(sys.cpu_pct), '%', this._ringGrade(sys.cpu_pct, 85), t('cpu','CPU'));
    html += this._ringSvg('ram', Math.round(sys.ram_pct), '%', this._ringGrade(sys.ram_pct, 85), t('ram','RAM'));
    html += '</div>';
    html += '<div class="m-res-details">';
    html += '<span data-field="ram-text">' + sys.ram_used_gb + '/' + sys.ram_total_gb + 'GB</span>';
    html += '</div>';
    html += '</div>';
    return html;
  },

  // SVG 环形进度（半径 16，stroke 3）
  _ringSvg(key, value, unit, grade, label) {
    const r = 16, c = 2 * Math.PI * r;
    // value 是百分比或温度；温度映射到 0-100（0-100℃）
    const pct = unit === '°' ? Math.min(100, (value / 100) * 100) : Math.max(0, Math.min(100, value));
    const offset = c * (1 - pct / 100);
    const display = unit === '°' ? value + '°' : Math.round(value) + unit;
    return `<div class="m-ring m-ring-${grade}" data-ring="${key}">
      <svg viewBox="0 0 40 40" width="40" height="40">
        <circle class="m-ring-bg" cx="20" cy="20" r="${r}" fill="none" stroke-width="3"/>
        <circle class="m-ring-fg" cx="20" cy="20" r="${r}" fill="none" stroke-width="3"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
          data-ring-offset="${offset.toFixed(2)}" data-ring-c="${c.toFixed(2)}"
          transform="rotate(-90 20 20)"/>
        <text class="m-ring-val" x="20" y="23" text-anchor="middle" data-ring-val>${this.esc(display)}</text>
      </svg>
      <span class="m-ring-label">${this.esc(label)}</span>
    </div>`;
  },

  // ── 外壳原地打补丁 ──
  _patchStatusbar(d, gpu, sys, t) {
    const bar = document.querySelector('.m-statusbar');
    if (!bar) return;
    const stateCode = d.state || 'IDLE';
    const stateLabels = {'RUNNING':t('training','Training'),'FINISHED':t('finished','Finished'),'TERMINATED':t('terminated','Terminated'),'CREATED':t('created','Pending'),'IDLE':t('idle','Idle')};
    const state = stateLabels[stateCode] || stateCode;
    const isTraining = stateCode === 'RUNNING';
    const stateColor = isTraining ? 'var(--success)' : (d.has_error ? 'var(--danger)' : 'var(--text-secondary)');
    const stateEl = bar.querySelector('[data-field="state"]');
    if (stateEl) { stateEl.textContent = state; stateEl.style.color = stateColor; }
    // 进度条 + 百分比
    const progressBar = bar.querySelector('[data-bar="progress"]');
    if (progressBar && d.percent != null) progressBar.style.width = d.percent + '%';
    const pctEl = bar.querySelector('[data-field="pct"]');
    if (pctEl && d.percent != null) pctEl.textContent = d.percent + '%';
    // 步数
    const stepEl = bar.querySelector('[data-field="step"]');
    if (stepEl && d.step != null) stepEl.innerHTML = this.esc(t('step','Steps')) + ' <b>' + d.step + '/' + (d.total_steps||'?') + '</b>';
    // 指标纯文本
    const _set = (key, val) => {
      const e = bar.querySelector('[data-field="' + key + '"] b, [data-field="' + key + '"]');
      if (e && e.tagName === 'B') e.textContent = (val != null && val !== '') ? this.esc(String(val)) : '--';
    };
    _set('loss', d.loss); _set('lr', d.lr); _set('epoch', d.epoch);
    const elEl = bar.querySelector('[data-field="elapsed"] b'); if (elEl) elEl.textContent = d.elapsed ? this.esc(String(d.elapsed)) : '--';
    const etaEl = bar.querySelector('[data-field="eta"] b'); if (etaEl) etaEl.textContent = d.eta ? this.esc(String(d.eta)) : '--';
    const spdEl = bar.querySelector('[data-field="speed"] b'); if (spdEl) spdEl.textContent = d.speed ? this.esc(String(d.speed)) : '--';
    // 圆环 + 数值原地更新
    if (gpu) {
      this._patchRing('load', Math.round(gpu.gpu_load_pct || 0), '%', this._ringGrade(gpu.gpu_load_pct||0, 90));
      const vramPct = gpu.vram_total_mb > 0 ? Math.round(gpu.vram_used_mb / gpu.vram_total_mb * 100) : 0;
      this._patchRing('vram', vramPct, '%', this._ringGrade(vramPct, 92));
      if (gpu.temperature_c != null) this._patchRing('temp', gpu.temperature_c, '°', this._ringGradeTemp(gpu.temperature_c));
      // 绝对值 + 功率
      const vramText = bar.querySelector('[data-field="vram-text"]');
      if (vramText) vramText.textContent = gpu.vram_used_mb + '/' + gpu.vram_total_mb + 'MB';
      const pwText = bar.querySelector('[data-field="power-text"]');
      if (pwText) pwText.textContent = (gpu.power_w != null ? gpu.power_w + 'W' : '');
    }
    if (sys) {
      this._patchRing('cpu', Math.round(sys.cpu_pct), '%', this._ringGrade(sys.cpu_pct, 85));
      this._patchRing('ram', Math.round(sys.ram_pct), '%', this._ringGrade(sys.ram_pct, 85));
      const ramText = bar.querySelector('[data-field="ram-text"]');
      if (ramText) ramText.textContent = sys.ram_used_gb + '/' + sys.ram_total_gb + 'GB';
    }
  },

  _patchRing(key, value, unit, grade) {
    const ring = document.querySelector('.m-ring[data-ring="' + key + '"]');
    if (!ring) return;
    const pct = unit === '°' ? Math.min(100, value) : Math.max(0, Math.min(100, value));
    const fg = ring.querySelector('.m-ring-fg');
    const c = fg ? parseFloat(fg.dataset.ringC) : 0;
    if (fg) fg.style.strokeDashoffset = (c * (1 - pct / 100)).toFixed(2);
    const valEl = ring.querySelector('[data-ring-val]');
    if (valEl) valEl.textContent = unit === '°' ? value + '°' : value + unit;
    ring.className = 'm-ring m-ring-' + grade;
  },

  // ═══════════════════════════════════════════════════════════
  //  外壳：历史横幅（轻量信息条风格）
  // ═══════════════════════════════════════════════════════════
  _historyBannerHtml(d, t) {
    const runName = (d.config && d.config.output_name) || (this.selectedRunDir.split('/').pop() || '');
    let html = '<div class="m-history-banner">';
    html += '<svg class="m-history-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
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
    if (tab === 'overview') {
      const sig = 'ov:' + (this.trainParams.length) + ':' + (this.previews.length) + ':' + (d.train_result ? d.train_result.status : '') + ':' + (this.lossSeries.length);
      if (tabChanged || this._builtOverviewSig !== sig) {
        this._builtOverviewSig = sig;
        contentEl.innerHTML = this._renderOverviewTab(d, t, isHistory);
      }
      this._builtTab = 'overview';
      return;
    }
    if (tab === 'samples') {
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
      if (tabChanged && !this.outputFiles.length && !this.outputFilesLoading) this.loadOutputFiles();
      const sig = 'out:' + (this.outputFiles.length) + ':' + (this.selectedOutputFiles.length) + ':' + (this.outputFilesLoading?1:0) + ':' + (this.outputSortKey) + ':' + (this.outputSortDir);
      if (tabChanged || this._builtOutputsSig !== sig) {
        // Preserve scroll position across re-renders
        const scrollEl = contentEl.querySelector('.m-outputs-scroll');
        const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
        this._builtOutputsSig = sig;
        contentEl.innerHTML = this._renderOutputsTab(t);
        const newScrollEl = contentEl.querySelector('.m-outputs-scroll');
        if (newScrollEl) newScrollEl.scrollTop = scrollTop;
      }
      this._builtTab = 'outputs';
      return;
    }
  },

  // ═══════════════════════════════════════════════════════════
  //  概览标签
  // ═══════════════════════════════════════════════════════════
  _renderOverviewTab(d, t, isHistory) {
    let html = '';

    // ── 实时训练状态（仅在训练中显示）──
    const isRunning = d.state === 'RUNNING';
    if (isRunning) {
      html += '<div class="m-section"><div class="m-section-title">' + this.esc(t('status','Training Status')) + '</div><div class="param-grid">';
      html += '<div class="param-item"><span class="param-label">' + this.esc(t('step','Steps')) + '</span><span class="param-value">' + (d.step||'?') + ' / ' + (d.total_steps||'?') + ' (' + (d.percent||0) + '%)</span></div>';
      if (d.loss != null) html += '<div class="param-item"><span class="param-label">' + this.esc(t('loss','Loss')) + '</span><span class="param-value">' + this.esc(String(d.loss)) + '</span></div>';
      if (d.lr != null) html += '<div class="param-item"><span class="param-label">' + this.esc(t('lr','LR')) + '</span><span class="param-value">' + this.esc(String(d.lr)) + '</span></div>';
      if (d.epoch != null) html += '<div class="param-item"><span class="param-label">' + this.esc(t('epoch','Epoch')) + '</span><span class="param-value">' + this.esc(String(d.epoch)) + '</span></div>';
      if (d.elapsed) html += '<div class="param-item"><span class="param-label">' + this.esc(t('elapsed','Elapsed')) + '</span><span class="param-value">' + this.esc(d.elapsed) + '</span></div>';
      if (d.eta) html += '<div class="param-item"><span class="param-label">' + this.esc(t('remaining','Remaining')) + '</span><span class="param-value">' + this.esc(d.eta) + '</span></div>';
      if (d.speed) html += '<div class="param-item"><span class="param-label">' + this.esc(t('speed','Speed')) + '</span><span class="param-value">' + this.esc(d.speed) + '</span></div>';
      html += '</div></div>';
    }

    // ── 历史训练结果 ──
    if (isHistory && d.train_result) {
      const tr = d.train_result;
      html += '<div class="m-section"><div class="m-section-title">' + this.esc(t('trainResult','Training Result')) + '</div><div class="param-grid">';
      html += '<div class="param-item"><span class="param-label">' + this.esc(t('status','Status')) + '</span><span class="param-value" style="color:' + (tr.status==='completed'?'var(--success)':'var(--danger)') + '">' + this.esc(tr.status||'?') + '</span></div>';
      if (tr.duration_str) html += '<div class="param-item"><span class="param-label">' + this.esc(t('duration','Duration')) + '</span><span class="param-value">' + this.esc(tr.duration_str) + '</span></div>';
      if (tr.exit_code != null) html += '<div class="param-item"><span class="param-label">' + this.esc(t('monitor.exitCode','Exit Code')) + '</span><span class="param-value">' + tr.exit_code + '</span></div>';
      // Show final loss if available from lossSeries
      if (this.lossSeries && this.lossSeries.length && isHistory) {
        const avgSeries = this.lossSeries.find(s => s.tag === 'loss/average');
        if (avgSeries && avgSeries.latest != null) {
          html += '<div class="param-item"><span class="param-label">' + this.esc(t('loss','Final Loss')) + '</span><span class="param-value">' + Number(avgSeries.latest).toFixed(4) + '</span></div>';
        }
      }
      html += '</div></div>';
    }

    // ── 上次训练配置（空闲时显示）──
    if (!isRunning && !isHistory && d.last_config && d.last_config.name) {
      const lc = d.last_config;
      html += '<div class="m-section"><div class="m-section-title">' + this.esc(t('lastTraining','Last Training')) + '</div><div class="param-grid">';
      html += '<div class="param-item"><span class="param-label">' + this.esc(t('outputName','Name')) + '</span><span class="param-value">' + this.esc(lc.name) + '</span></div>';
      html += '<div class="param-item"><span class="param-label">' + this.esc(t('historyModel','Model')) + '</span><span class="param-value">' + this.esc(lc.model||'') + '</span></div>';
      html += '<div class="param-item"><span class="param-label">' + this.esc(t('historyLR','LR')) + '</span><span class="param-value">' + this.esc(lc.lr||'') + '</span></div>';
      html += '<div class="param-item"><span class="param-label">' + this.esc(t('historyDim','Dim')) + '</span><span class="param-value">' + this.esc(lc.dim||'') + '</span></div>';
      html += '<div class="param-item"><span class="param-label">' + this.esc(t('historyEpochs','Epochs')) + '</span><span class="param-value">' + this.esc(lc.epochs||'') + '</span></div>';
      html += '</div></div>';
    }

    // ── 训练参数 ──
    html += '<div class="m-section" style="margin-top:12px"><div class="m-section-title">' + this.esc(t('trainParams','Parameters')) + '</div>';
    if (this.trainParams.length) {
      html += '<div class="param-grid">';
      this.trainParams.forEach(p => { html += '<div class="param-item"><span class="param-label">' + this.esc(p.label) + '</span><span class="param-value">' + this.esc(p.value) + '</span></div>'; });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty"><p>' + this.esc(t('noParamsHint','Start training to see parameters')) + '</p></div>';
    }
    html += '</div>';

    return html;
  },

  // ═══════════════════════════════════════════════════════════
  //  日志标签（增量追加 + 保留滚动位置）
  // ═══════════════════════════════════════════════════════════
  _logsTabShellHtml(t) {
    let html = '<div class="m-section" style="margin-top:12px">';
    html += '<div class="m-section-title">' + this.esc(t('logTitle','Real-time Logs')) + ' <span class="m-logs-count" data-field="log-count">' + this.logLines.length + '</span></div>';
    html += '<div class="m-section-tools">';
    html += '<input type="text" class="m-logs-search" x-model="logSearch" placeholder="' + this.esc(t('logSearch','Search logs...')) + '" @input.debounce.300ms="renderDashboard()">';
    const levels = ['all','info','warn','error'];
    const levelLabels = {all:t('logLevelAll','All'),info:t('logLevelInfo','Info'),warn:t('logLevelWarn','Warn'),error:t('logLevelError','Error')};
    levels.forEach(l => {
      html += '<button type="button" class="log-level-btn" :class="{active:logLevel===\'' + l + '\'}" @click="logLevel=\'' + l + '\';renderDashboard()">' + this.esc(levelLabels[l]) + '</button>';
    });
    html += '<button type="button" class="btn btn-sm" :class="logAutoScroll?\'btn-primary\':\'btn-secondary\'" @click="logAutoScroll=!logAutoScroll"><span x-text="logAutoScroll?\'' + this.esc(t('logAutoScroll','Auto-scroll')) + ': ON\':\'' + this.esc(t('logAutoScroll','Auto-scroll')) + ': OFF\'"></span></button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="copyLogs()">' + this.esc(t('logCopy','Copy')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="confirm(\'' + this.esc(t('monitor.confirmClearLogs','Clear all logs?')).replace(/'/g,"\\'") + '\') && clearLogs()">' + this.esc(t('logClear','Clear')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary log-nav-btn-top" @click="_scrollLogsToTop()">' + this.esc(t('scrollToTop','↑ Top')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary log-nav-btn-bottom" @click="logAutoScroll=true;_scrollLogsToBottom()">' + this.esc(t('scrollToBottom','↓ Bottom')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="downloadLogs()">' + this.esc(t('logDownload','Download')) + '</button>';
    html += '</div>';
    html += '<div id="monitorDashboardLogs" class="monitor-logs-container log-lines"></div></div>';
    return html;
  },

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
      contentEl.innerHTML = this._logsTabShellHtml(t);
      this._renderedLogFilterKey = filterKey;
      this._renderedLogCount = 0;
      this._forceLogRebuild = false;
      this._populateLogs(contentEl, search, level, true);
      this._bindLogScroll(contentEl);
    } else {
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
      const countEl = contentEl.querySelector('[data-field="log-count"]');
      if (countEl) countEl.textContent = this.logLines.length;
    }
    this._afterLogsRender(contentEl);
  },

  _populateLogs(contentEl, search, level, isFull) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    if (isFull) {
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
      // VSCode-style severity classification
      let cls = '';
      if (/\b(error|critical|fatal|exception)\b/i.test(line) || lo.indexOf('traceback') !== -1) {
        cls = 'log-error';
      } else if (/\bwarn(?:ing)?\b/i.test(line)) {
        cls = 'log-warn';
      } else if (/\binfo\b/i.test(line)) {
        cls = 'log-info';
      } else if (/\bdebug\b/i.test(line)) {
        cls = 'log-debug';
      } else if (/\b(?:success|completed|saved|finished|done)\b/i.test(line)) {
        cls = 'log-ok';
      }
      const div = document.createElement('div');
      div.className = 'log-line ' + cls;
      const num = document.createElement('span');
      num.className = 'log-line-num';
      num.textContent = (i + 1);
      const span = document.createElement('span');
      span.className = 'log-line-text';
      this._highlightLogLine(span, line, search);
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
    const navBtns = container.querySelector('.log-nav-buttons');
    if (navBtns) container.insertBefore(frag, navBtns); else container.appendChild(frag);
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
      this._updateLogNavButtons(contentEl);
    };
  },

  _scrollLogsToTop() {
    const container = document.querySelector('#monitorDashboardLogs');
    if (container) { container.scrollTop = 0; this._logAtBottom = false; this.logAutoScroll = false; }
    this._updateLogNavButtons(document.getElementById('monitorTabContent'));
  },

  _scrollLogsToBottom() {
    const container = document.querySelector('#monitorDashboardLogs');
    if (container) { container.scrollTop = container.scrollHeight; this._logAtBottom = true; }
    this._updateLogNavButtons(document.getElementById('monitorTabContent'));
  },

  _updateLogNavButtons(contentEl) {
    if (!contentEl) return;
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    const atTop = container.scrollTop < 30;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
    const topBtn = contentEl.querySelector('.log-nav-btn-top');
    const bottomBtn = contentEl.querySelector('.log-nav-btn-bottom');
    if (topBtn) topBtn.style.display = atTop ? 'none' : '';
    if (bottomBtn) bottomBtn.style.display = atBottom ? 'none' : '';
  },

  _afterLogsRender(contentEl) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    if (this.logAutoScroll || this._logAtBottom) {
      container.scrollTop = container.scrollHeight;
      this._logAtBottom = true;
    }
    this._updateLogNavButtons(contentEl);
  },

  // VSCode-style token regex (single unified pattern, ordered by priority)
  _LOG_TOKEN_RE: (() => {
    const ts  = '(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?|\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?)';
    const lvl = '\\[(INFO|WARNING|WARN|ERROR|DEBUG|CRITICAL|FATAL)\\]';
    const kw  = '\\b(Traceback|raise|Exception|Error|assert)\\b';
    const path= '([\\/][^\\s]+\\.(?:py|toml|json|yaml|yml|txt|log|safetensors|pt|pth|ckpt|bin))';
    return new RegExp(ts + '|' + lvl + '|' + kw + '|' + path, 'gi');
  })(),

  _highlightLogLine(rootEl, lineText, search) {
    /** Build DOM children for a log line — text nodes + highlighted spans.
     *  No innerHTML, no escaping bugs. */
    const re = this._LOG_TOKEN_RE;
    let lastIdx = 0;
    let m;
    const frag = document.createDocumentFragment();
    while ((m = re.exec(lineText)) !== null) {
      // Plain text before match
      if (m.index > lastIdx) {
        frag.appendChild(document.createTextNode(lineText.slice(lastIdx, m.index)));
      }
      // Highlighted token
      const span = document.createElement('span');
      const token = m[0];
      if (m[1]) { // timestamp
        span.className = 'log-ts';
      } else if (m[2]) { // log level [INFO] etc
        span.className = 'log-lvl log-lvl-' + m[2].toUpperCase();
      } else if (m[3]) { // keyword
        span.className = 'log-kw';
      } else if (m[4]) { // file path
        span.className = 'log-path';
      }
      span.textContent = token;
      frag.appendChild(span);
      lastIdx = re.lastIndex;
    }
    // Remaining plain text
    if (lastIdx < lineText.length) {
      frag.appendChild(document.createTextNode(lineText.slice(lastIdx)));
    }
    // Apply search highlight
    if (search) {
      this._highlightSearchInDOM(frag, search);
    }
    rootEl.appendChild(frag);
  },

  _highlightSearchInDOM(frag, search) {
    /** Walk text nodes and wrap search matches in <mark> */
    const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const lower = search.toLowerCase();
    for (const node of nodes) {
      const text = node.textContent;
      const idx = text.toLowerCase().indexOf(lower);
      if (idx === -1) continue;
      const parent = node.parentNode;
      const before = document.createTextNode(text.slice(0, idx));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + search.length);
      const after = document.createTextNode(text.slice(idx + search.length));
      parent.insertBefore(before, node);
      parent.insertBefore(mark, node);
      parent.insertBefore(after, node);
      parent.removeChild(node);
    }
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

  _formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  },

  // ═══════════════════════════════════════════════════════════
  //  样本标签
  // ═══════════════════════════════════════════════════════════
  _renderSamplesTab(t) {
    const isHistory = !!this.selectedRunDir;
    const d = isHistory ? (this.runDetailData||{}) : (this.monitorData||{});
    const showPreviews = this.previews.length && (isHistory || d.state === 'RUNNING');

    let html = '<div class="m-section"><div class="m-section-title">' + this.esc(t('previewSamples','Preview')) + '</div>';
    if (showPreviews) {
      const step = Math.min(this.previewStep, this.previews.length - 1);
      const p = this.previews[step] || this.previews[0];
      html += '<div class="preview-controls"><button class="btn btn-sm" @click="previewStep=Math.max(0,previewStep-1);renderDashboard()" :disabled="previewStep<=0">← ' + this.esc(t('prev','Prev')) + '</button>';
      html += '<span class="preview-step">' + (step + 1) + ' / ' + this.previews.length + '</span>';
      html += '<button class="btn btn-sm" @click="previewStep=Math.min(' + (this.previews.length - 1) + ',previewStep+1);renderDashboard()" :disabled="previewStep>=' + (this.previews.length - 1) + '">' + this.esc(t('next','Next')) + ' →</button></div>';
      html += '<div class="preview-main"><img src="' + this.esc(p.url) + '" alt="' + this.esc(p.name) + '" loading="lazy"/><div class="preview-main-label">' + this.esc(this._parseSampleInfo(p.name)) + '</div></div>';
      html += '<div class="preview-strip">';
      this.previews.forEach((pv, i) => {
        html += '<div class="preview-thumb' + (i === step ? ' active' : '') + '" @click="previewStep=' + i + ';renderDashboard()"><img src="' + this.esc(pv.url) + '" alt="' + this.esc(pv.name) + '" loading="lazy"/><span>' + this.esc(this._parseSampleInfo(pv.name)) + '</span></div>';
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><p>' + this.esc(t('noPreviewHint','Preview images appear during training')) + '</p></div>';
    }
    html += '</div>';
    return html;
  },

  _parseSampleInfo(filename) {
    // Parse epoch from filename like "nanahira_e000004_00_..."
    const em = filename.match(/[eE](\d{6})/);
    const epoch = em ? parseInt(em[1], 10) : null;
    if (epoch == null) return filename;

    // Try to get loss for this epoch from TensorBoard data
    let lossStr = '';
    if (this.lossSeries) {
      const epochAvg = this.lossSeries.find(s => s.tag === 'loss/epoch_average');
      if (epochAvg && epochAvg.points && epoch >= 1 && epoch <= epochAvg.points.length) {
        const loss = epochAvg.points[epoch - 1].value;
        lossStr = '  loss ' + loss.toFixed(4);
      }
    }

    // Try to get step count from train params
    let stepStr = '';
    if (this.trainParams && this.trainParams.length) {
      const epochsParam = this.trainParams.find(p => p.label && p.label.toLowerCase().includes('epoch'));
      const epochTotal = epochsParam ? parseInt(epochsParam.value, 10) : 0;
      if (epochTotal > 0 && this.monitorData && this.monitorData.total_steps) {
        const stepsPerEpoch = Math.round(this.monitorData.total_steps / epochTotal);
        stepStr = '  ~' + (epoch * stepsPerEpoch) + ' steps';
      }
    }

    return 'Epoch ' + epoch + stepStr + lossStr;
  },

  // ═══════════════════════════════════════════════════════════
  //  输出标签
  // ═══════════════════════════════════════════════════════════
  _renderOutputsTab(t) {
    let html = '<div class="m-section m-outputs-section">';
    html += '<div class="m-section-title"><span>' + this.esc(t('outputs','Training Outputs')) + '</span></div>';
    html += '<div class="m-section-tools">';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="loadOutputFiles()">' + this.esc(t('refresh','Refresh')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="selectAllOutputFiles()">' + this.esc(t('selectAll','Select All')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="deselectAllOutputFiles()">' + this.esc(t('deselectAll','Deselect All')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-primary" @click="downloadSelectedOutputs()">' + this.esc(t('downloadSelected','Download Selected')) + '</button>';
    html += '<button type="button" class="btn btn-sm" @click="downloadAllOutputs()">' + this.esc(t('downloadAll','Download All')) + '</button>';
    html += '</div>';

    if (this.outputFilesLoading) {
      html += '<div class="dashboard-empty" style="padding:48px"><p>' + this.esc(t('loading','Loading...')) + '</p></div>';
      html += '</div>';
      return html;
    }

    if (!this.outputFiles.length) {
      html += '<div class="dashboard-empty" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><p>' + this.esc(t('noOutputsHint','Training outputs will appear here after saving')) + '</p></div>';
      html += '</div>';
      return html;
    }

    const selectedCount = this.selectedOutputFiles.length;
    if (selectedCount > 0) {
      html += '<div class="m-outputs-selected">' + this.esc(t('selected','Selected')) + ': ' + selectedCount + ' / ' + this.outputFiles.length + '</div>';
    }

    // Scrollable content
    html += '<div class="m-outputs-scroll">';

    const { models, others } = this._sortedOutputs();

    // ── 模型存档区（带 loss + 排序）──
    html += '<div class="m-ckpt-section">';
    html += '<div class="m-section-title"><span>' + this.esc(t('modelCheckpoints','Model Checkpoints')) + (models.length ? ' <span class="m-logs-count">' + models.length + '</span>' : '') + '</span>';
    html += '<span class="m-section-title-right m-ckpt-sort">';
    const sortKeys = [['loss', t('sortLoss','Loss')], ['time', t('sortTime','Time')], ['size', t('sortSize','Size')], ['name', t('sortName','Name')]];
    sortKeys.forEach(k => {
      const active = this.outputSortKey === k[0];
      html += '<button type="button" class="m-sort-btn' + (active ? ' active' : '') + '" @click="setOutputSort(\'' + k[0] + '\')">' + this.esc(k[1]);
      if (active) html += ' <span class="m-sort-arrow">' + (this.outputSortDir === 'asc' ? '↑' : '↓') + '</span>';
      html += '</button>';
    });
    html += '</span></div>';

    if (models.length) {
      let bestPath = null;
      if (this.outputSortKey === 'loss' && this.outputSortDir === 'asc') {
        let best = null;
        models.forEach(f => { if (f.ckpt_loss != null && (best === null || f.ckpt_loss < best)) { best = f.ckpt_loss; bestPath = f.path; } });
      }
      html += '<div class="output-list">';
      models.forEach(f => {
        const isSelected = !!this.outputFilesSelected[f.path];
        const fpJs = this.escapeJsString(f.path);
        const isBest = f.path === bestPath;
        html += '<div class="output-item' + (isSelected ? ' selected' : '') + (isBest ? ' m-ckpt-best' : '') + '" @click="toggleOutputFile(\'' + fpJs + '\')">';
        html += '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' @click.stop="toggleOutputFile(\'' + fpJs + '\')">';
        html += this._fileIconSvg(f);
        html += '<span class="output-name">' + this.esc(f.name) + '</span>';
        const badge = this._ckptBadgeHtml(f, t);
        if (badge) html += badge; else if (f.is_lora) html += '<span class="badge output-lora-badge">LoRA</span>';
        const lossTxt = f.ckpt_loss != null ? Number(f.ckpt_loss).toFixed(4) : '--';
        html += '<span class="m-ckpt-loss' + (f.ckpt_loss == null ? ' m-muted' : '') + '">loss <b>' + this.esc(lossTxt) + '</b></span>';
        html += '<span class="output-size">' + this._formatFileSize(f.size) + '</span>';
        html += '<span class="output-time">' + this._formatFileTime(f.mtime) + '</span>';
        html += '<button class="btn btn-sm btn-secondary output-dl-btn" @click.stop="downloadSingleOutput(\'' + fpJs + '\')" title="' + this.esc(t('common.download','Download')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty" style="padding:24px"><p>' + this.esc(t('noModelFiles','No model files')) + '</p></div>';
    }
    html += '</div>';

    // ── 其他文件区 ──
    if (others.length) {
      html += '<div class="m-ckpt-section" style="margin-top:12px">';
      html += '<div class="m-section-title"><span>' + this.esc(t('otherFiles','Other Files')) + ' <span class="m-logs-count">' + others.length + '</span></span></div>';
      html += '<div class="output-list">';
      others.forEach(f => {
        const isSelected = !!this.outputFilesSelected[f.path];
        const fpJs = this.escapeJsString(f.path);
        html += '<div class="output-item' + (isSelected ? ' selected' : '') + '" @click="toggleOutputFile(\'' + fpJs + '\')">';
        html += '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' @click.stop="toggleOutputFile(\'' + fpJs + '\')">';
        html += this._fileIconSvg(f);
        html += '<span class="output-name">' + this.esc(f.name) + '</span>';
        if (f.is_lora) html += '<span class="badge output-lora-badge">LoRA</span>';
        html += '<span class="output-size">' + this._formatFileSize(f.size) + '</span>';
        html += '<span class="output-time">' + this._formatFileTime(f.mtime) + '</span>';
        html += '<button class="btn btn-sm btn-secondary output-dl-btn" @click.stop="downloadSingleOutput(\'' + fpJs + '\')" title="' + this.esc(t('common.download','Download')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
        html += '</div>';
      });
      html += '</div>';
      html += '</div>';
    }
    html += '</div>'; // m-outputs-scroll
    html += '</div>'; // m-section
    return html;
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
      return '<span class="m-ckpt-badge m-ckpt-epoch">' + this.esc(t('ckptEpoch','Epoch {n}').replace('{n}', f.ckpt_epoch)) + '</span>';
    }
    if (f.ckpt_type === 'step' && f.ckpt_step != null) {
      return '<span class="m-ckpt-badge m-ckpt-step">' + this.esc(t('ckptStep','Step {n}').replace('{n}', f.ckpt_step)) + '</span>';
    }
    if (f.ckpt_type === 'final') {
      return '<span class="m-ckpt-badge m-ckpt-final">' + this.esc(t('ckptFinal','Final')) + '</span>';
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
    const t = (k, fb) => { const fullKey = k.includes('.') ? k : ('monitor.' + k); return this.t(fullKey) || fb || k; };
    const hasRunning = this.runningTask && this.runningTask.status === 'RUNNING';
    const items = this.filteredHistoryItems;
    const hasHistory = items && items.length;

    if (!hasRunning && !hasHistory && !(this.historyItems && this.historyItems.length)) {
      el.innerHTML = 
        '<div class="dashboard-empty" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><p>' + this.esc(t('historyNoRecords', 'No training history')) + '</p><p class="m-empty-sub">' + this.esc(t('historyWillAppear', 'Records will appear after training')) + '</p></div>';
      return;
    }

    let html = '';
    // Persistent diagnostic banner
    
    if (hasRunning) {
      const r = this.runningTask;
      html += '<div class="card history-card history-running">';
      html += '<div class="card-header">' + this.esc(t('running', 'Running')) + ' <span class="badge badge-running">' + this.esc(t('training', 'Training') || 'Training') + '</span></div>';
      html += '<div class="hist-name"><b>' + this.esc(r.name || r.id || '') + '</b></div>';
      html += '<div class="hist-meta">' + this.esc(t('historyModel', 'Model')) + ': ' + this.esc((r.model || '').split(/[\\\/]/).pop() || 'Unknown') + '</div>';
      html += '<div class="hist-meta">' + this.esc(t('historyLR', 'LR')) + ': ' + this.esc(r.lr || '?') + ' | ' + this.esc(t('historyDim', 'Dim')) + ': ' + this.esc(r.dim || '?') + ' | ' + this.esc(t('historyEpochs', 'Epochs')) + ': ' + this.esc(r.epochs || '?') + '</div>';
      if (r.run_dir) html += '<div class="hist-rundir">' + this.esc(t('runDir', 'Folder') || 'Folder') + ': ' + this.esc(r.run_dir) + '</div>';
      html += '<div class="hist-actions"><button class="btn btn-sm btn-primary" @click="navigate(\'monitor-dashboard\')">' + this.esc(t('viewDashboard','View Dashboard')) + '</button></div>';
      html += '</div>';
    }

    if (this.historyItems && this.historyItems.length) {
      html += '<div class="hist-toolbar">';
      html += '<input type="text" class="hist-search" x-model="historySearch" placeholder="' + this.esc(t('searchHistory','Search history...')) + '" @input.debounce.200ms="renderHistory()">';
      const filters = [['all', t('logLevelAll','All')], ['completed', t('statusCompleted','Completed')], ['failed', t('statusFailed','Failed')], ['terminated', t('statusTerminated','Terminated')]];
      filters.forEach(f => {
        html += '<button type="button" class="hist-filter-btn" :class="{active:historyFilter===\'' + f[0] + '\'}" @click="historyFilter=\'' + f[0] + '\';renderHistory()">' + this.esc(f[1]) + '</button>';
      });
      html += '</div>';

      if (hasRunning) html += '<div class="hist-section-label">' + this.esc(t('pastRuns', 'Past Runs')) + '</div>';
      html += '<div class="history-grid">';
      items.forEach(h => {
        const runDirJs = this.escapeJsString(h.run_dir || '');
        html += '<div class="card history-card">';
        html += '<div class="hist-card-head">';
        html += '<span class="hist-time">' + this.esc(h.time) + '</span>';
        if (h.status) {
          const statusColors = { completed: 'ok', failed: 'danger', error: 'danger', terminated: 'muted' };
          const statusLabels = { completed: t('statusCompleted','✓ Completed'), failed: t('statusFailed','✗ Failed'), error: t('statusError','✗ Error'), terminated: t('statusTerminated','⏹ Terminated') };
          html += '<span class="m-badge m-badge-' + (statusColors[h.status] || 'muted') + '">' + this.esc(statusLabels[h.status] || h.status) + '</span>';
        }
        if (h.duration) html += '<span class="hist-duration">' + this.esc(h.duration) + '</span>';
        html += '</div>';
        html += '<div class="hist-card-body" @click="' + (h.run_dir ? 'viewRunDetail(\'' + runDirJs + '\')' : 'navigate(\'monitor-dashboard\')') + '">';
        html += '<div class="hist-name"><b>' + this.esc(h.name || '') + '</b></div>';
        html += '<div class="hist-meta">' + this.esc(t('historyModel', 'Model')) + ': ' + this.esc(h.model || '') + '</div>';
        html += '<div class="hist-meta">' + this.esc(t('historyLR', 'LR')) + ': ' + this.esc(h.lr || '') + ' | ' + this.esc(t('historyDim', 'Dim')) + ': ' + this.esc(h.dim || '') + ' | ' + this.esc(t('historyEpochs', 'Epochs')) + ': ' + this.esc(h.epochs || '') + '</div>';
        if (h.dataset) html += '<div class="hist-dataset">' + this.esc(t('dataset', 'Dataset') || 'Dataset') + ': ' + this.esc(h.dataset) + '</div>';
        html += '</div>';
        if (h.run_dir) {
          html += '<div class="hist-actions">';
          html += '<button class="btn btn-sm btn-secondary" @click.stop="viewRunDetail(\'' + runDirJs + '\')">' + this.esc(t('viewDetails', 'View Details')) + '</button>';
          html += '<button class="btn btn-sm btn-secondary" @click.stop="viewSnapshot(\'' + runDirJs + '\')">' + this.esc(t('viewConfig', 'View Config')) + '</button>';
          html += '<button class="btn btn-sm btn-secondary" @click.stop="downloadRunOutputs(\'' + runDirJs + '\')" title="' + this.esc(t('downloadAll','Download All')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
          html += '<button class="btn btn-sm" @click.stop="reuseConfig(\'' + runDirJs + '\')">' + this.esc(t('reuseConfig', 'Reuse')) + '</button>';
          html += '<button class="btn btn-sm btn-danger hist-delete" @click.stop="deleteHistoryRun(\'' + runDirJs + '\')" title="' + this.esc(t('common.delete','Delete')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>';
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }

    html += '<div id="configSnapshotModal" class="modal-overlay" style="display:none"><div class="modal" style="max-width:700px"><div class="modal-header"><span>' + this.esc(t('configSnapshot','Config Snapshot')) + '</span><button class="btn btn-sm" @click="closeSnapshotModal()" style="font-size:18px;line-height:1;padding:4px 8px">&times;</button></div><div class="modal-body" id="configSnapshotContent"></div></div></div>';
    el.innerHTML = html;
    } catch (e) {
      el.innerHTML = '<div class="dashboard-empty" style="padding:48px"><p>⚠ ' + (this.t ? this.t('monitor.historyRenderError') || 'Error displaying history. Check browser console (F12).' : 'Error displaying history. Check browser console (F12).') + '</p></div>';
    }
  },

  async downloadRunOutputs(runDir) {
    if (!runDir) return;
    this._triggerDownload('/api/monitor/outputs/download?run_dir=' + encodeURIComponent(runDir));
  },

  async viewSnapshot(runDir) {
    const t = (k, fb) => { const fullKey = k.includes('.') ? k : ('monitor.' + k); return this.t(fullKey) || fb || k; };
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
    const t = (k, fb) => { const fullKey = k.includes('.') ? k : ('monitor.' + k); return this.t(fullKey) || fb || k; };

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
    const t = (k, fb) => { const fullKey = k.includes('.') ? k : ('monitor.' + k); return this.t(fullKey) || fb || k; };
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
