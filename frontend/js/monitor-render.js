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
    const t = (k,fb) => { const fullKey = k.includes('.') ? k : ('monitor.'+k); return this.t(fullKey, fb)||fb||k; };
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
        shell += this._statusbarHtml(d, t);
      }
      shell += '<div id="monitorTabContent"></div>';
      shell += this._previewLightboxHtml(t);
      shell += '</div>';
      el.innerHTML = shell;
      // 页头右侧资源监控（仅实时模式；历史模式不渲染，#monitorResbar 由 x-show 隐藏）
      if (!isHistory) {
        const resbarEl = document.getElementById('monitorResbar');
        if (resbarEl) resbarEl.innerHTML = this._resbarHtml(gpu, sys, t);
        this._patchResbar(gpu, sys, t);
      }
    } else if (!isHistory) {
      // ── 2. 外壳原地打补丁（每 tick，不重建 DOM）──
      this._patchStatusbar(d, t);
      this._patchResbar(gpu, sys, t);
    }

    // ── 3. 标签页内容 ──
    this._renderTab(tab, d, gpu, sys, t, isHistory);
  },

  // ═══════════════════════════════════════════════════════════
  //  外壳：单行紧凑信息条 + 资源圆环
  // ═══════════════════════════════════════════════════════════
  _statusbarHtml(d, t) {
    const stateCode = d.state || 'IDLE';
    const stateLabels = {'RUNNING':t('training','Training'),'FINISHED':t('finished','Finished'),'TERMINATED':t('terminated','Terminated'),'CREATED':t('created','Pending'),'IDLE':t('idle','Idle')};
    const state = stateLabels[stateCode] || stateCode;
    const isTraining = stateCode === 'RUNNING';
    const stateColor = isTraining ? 'var(--success)' : (d.has_error ? 'var(--danger)' : 'var(--text-secondary)');

    let html = '<div class="m-statusbar">';
    // 左：状态 + 总进度。详细指标只在下方“训练状态”展示，避免重复和不同步。
    html += '<div class="m-sb-left">';
    html += '<span class="m-sb-state" data-field="state" style="color:' + stateColor + '">' + this.esc(state) + '</span>';
    html += '<div class="m-sb-progress" data-role="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + (d.percent||0) + '"' + (isTraining ? '' : ' hidden') + '><div class="m-sb-bar" data-bar="progress" style="width:' + (d.percent||0) + '%"></div></div>';
    html += '<span class="m-sb-pct" data-field="pct"' + (isTraining ? '' : ' hidden') + '>' + (d.percent||0) + '%</span>';
    html += '</div>';

    html += '<span class="m-sb-error" data-role="error"' + (d.has_error ? '' : ' hidden') + '>' + this.esc(d.error_msg || t('error','Error')) + '</span>';

    // 按钮节点常驻，仅切换 hidden，避免状态变化时重建 Alpine 事件绑定。
    html += '<div class="m-sb-right" data-role="actions"' + (isTraining ? '' : ' hidden') + '><button class="btn btn-sm m-sb-stop" @click="stopTraining()">' + this.esc(t('stopTraining','Stop')) + '</button></div>';
    html += '</div>';
    return html;
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
    const fullName = sys.cpu_name || t('cpu','CPU');
    let html = '<div class="m-res-chip" data-res="sys">';
    html += '<span class="m-res-chip-name">' + this.esc(fullName) + '</span>';
    html += '<div class="m-res-stats">';
    html += '<span class="m-res-stat"><span class="m-res-stat-label">' + this.esc(t('cpu','CPU')) + '</span><span class="m-res-stat-val m-res-' + this._resGrade(sys.cpu_pct) + '" data-field="cpu-pct">' + Math.round(sys.cpu_pct) + '%</span></span>';
    html += '<span class="m-res-stat"><span class="m-res-stat-label">' + this.esc(t('ram','RAM')) + '</span><span class="m-res-stat-val m-res-' + this._resGrade(sys.ram_pct) + '" data-field="ram-pct">' + Math.round(sys.ram_pct) + '%</span><span class="m-res-stat-sub" data-field="ram-text">' + sys.ram_used_gb.toFixed(1) + '/' + sys.ram_total_gb.toFixed(1) + 'G</span></span>';
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
    html += '<span class="m-res-chip-name">' + this.esc(fullName) + '</span>';
    html += '<div class="m-res-stats">';
    html += '<span class="m-res-stat"><span class="m-res-stat-label">' + this.esc(t('gpuLoad','Load')) + '</span><span class="m-res-stat-val m-res-' + this._resGrade(loadPct) + '" data-field="load-pct">' + Math.round(loadPct) + '%</span></span>';
    html += '<span class="m-res-stat"><span class="m-res-stat-label">' + this.esc(t('vramUsed','VRAM')) + '</span><span class="m-res-stat-val m-res-' + this._resGrade(vramPct) + '" data-field="vram-pct">' + Math.round(vramPct) + '%</span><span class="m-res-stat-sub" data-field="vram-text">' + (gpu.vram_used_mb / 1024).toFixed(1) + '/' + (gpu.vram_total_mb / 1024).toFixed(1) + 'G</span></span>';
    if (temp != null) html += '<span class="m-res-stat"><span class="m-res-stat-label">' + this.esc(t('gpuTemp','Temp')) + '</span><span class="m-res-stat-val m-res-' + this._resGradeTemp(temp) + '" data-field="temp-val">' + temp + '°</span></span>';
    if (gpu.power_w != null) html += '<span class="m-res-stat"><span class="m-res-stat-label">' + this.esc(t('gpuPower','Power')) + '</span><span class="m-res-stat-val" data-field="power-text">' + gpu.power_w + 'W</span></span>';
    html += '</div>';
    html += '</div>';
    return html;
  },

  _patchResbar(gpu, sys, t) {
    const bar = document.getElementById('monitorResbar');
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
    if (gpu) {
      _set('load-pct', Math.round(gpu.gpu_load_pct || 0) + '%', this._resGrade(gpu.gpu_load_pct||0));
      const vramPct = gpu.vram_total_mb > 0 ? Math.round(gpu.vram_used_mb / gpu.vram_total_mb * 100) : 0;
      _set('vram-pct', vramPct + '%', this._resGrade(vramPct));
      _set('vram-text', (gpu.vram_used_mb / 1024).toFixed(1) + '/' + (gpu.vram_total_mb / 1024).toFixed(1) + 'G');
      if (gpu.temperature_c != null) _set('temp-val', gpu.temperature_c + '°', this._resGradeTemp(gpu.temperature_c));
      if (gpu.power_w != null) _set('power-text', gpu.power_w + 'W');
    }
    if (sys) {
      _set('cpu-pct', Math.round(sys.cpu_pct) + '%', this._resGrade(sys.cpu_pct));
      _set('ram-pct', Math.round(sys.ram_pct) + '%', this._resGrade(sys.ram_pct));
      _set('ram-text', sys.ram_used_gb.toFixed(1) + '/' + sys.ram_total_gb.toFixed(1) + 'G');
    }
  },

  // ── 外壳原地打补丁 ──
  _patchStatusbar(d, t) {
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
    const progressWrap = bar.querySelector('[data-role="progress"]');
    const progressBar = bar.querySelector('[data-bar="progress"]');
    const percent = Math.max(0, Math.min(100, Number(d.percent) || 0));
    if (progressWrap) {
      progressWrap.hidden = !isTraining;
      progressWrap.setAttribute('aria-valuenow', String(percent));
    }
    if (progressBar) progressBar.style.width = percent + '%';
    const pctEl = bar.querySelector('[data-field="pct"]');
    if (pctEl) { pctEl.hidden = !isTraining; pctEl.textContent = percent + '%'; }
    const actions = bar.querySelector('[data-role="actions"]');
    if (actions) actions.hidden = !isTraining;
    const errorEl = bar.querySelector('[data-role="error"]');
    if (errorEl) {
      errorEl.hidden = !d.has_error;
      errorEl.textContent = d.error_msg || t('error','Error');
    }
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
      const sig = 'ov:' + (d.state||'') + ':' + (this.trainParams.length) + ':' + (this.previews.length) + ':' + (d.train_result ? d.train_result.status : '') + ':' + (this.lossSeries.length);
      if (tabChanged || this._builtOverviewSig !== sig) {
        this._builtOverviewSig = sig;
        contentEl.innerHTML = this._renderOverviewTab(d, t, isHistory);
      }
      this._patchOverviewStatus(d);
      this._builtTab = 'overview';
      return;
    }
    if (tab === 'samples') {
      const sig = 'sm:' + (this.previews.length) + ':' + (this.previewsLoading?1:0);
      if (tabChanged || this._builtSamplesSig !== sig) {
        // 保留滚动位置（轮询追加样本时不在视觉上跳回顶部）
        const scrollTop = contentEl.scrollTop || 0;
        this._builtSamplesSig = sig;
        contentEl.innerHTML = this._renderSamplesTab(t);
        contentEl.scrollTop = scrollTop;
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

  _patchOverviewStatus(d) {
    if (!d || d.state !== 'RUNNING') return;
    const root = document.getElementById('monitorTabContent');
    if (!root) return;
    const values = {
      step: (d.step != null ? d.step : '?') + ' / ' + (d.total_steps != null ? d.total_steps : '?') + ' (' + (d.percent != null ? d.percent : 0) + '%)',
      loss: d.loss != null ? d.loss : '--',
      lr: d.lr != null ? d.lr : '--',
      epoch: d.epoch != null ? d.epoch : '--',
      elapsed: d.elapsed || '--',
      eta: d.eta || '--',
      speed: d.speed || '--',
    };
    Object.keys(values).forEach(key => {
      const el = root.querySelector('[data-live-field="' + key + '"]');
      if (el) el.textContent = String(values[key]);
    });
  },

  _renderOverviewTab(d, t, isHistory) {
    let html = '';

    // ── 实时训练状态（仅在训练中显示）──
    const isRunning = d.state === 'RUNNING';
    if (isRunning) {
      html += '<div class="m-section"><div class="m-section-title">' + this.esc(t('status','Training Status')) + '</div><div class="param-grid">';
      const liveFields = [
        ['step', t('step','Steps'), (d.step != null ? d.step : '?') + ' / ' + (d.total_steps != null ? d.total_steps : '?') + ' (' + (d.percent != null ? d.percent : 0) + '%)'],
        ['loss', t('loss','Loss'), d.loss != null ? d.loss : '--'],
        ['lr', t('lr','LR'), d.lr != null ? d.lr : '--'],
        ['epoch', t('epoch','Epoch'), d.epoch != null ? d.epoch : '--'],
        ['elapsed', t('elapsed','Elapsed'), d.elapsed || '--'],
        ['eta', t('remaining','Remaining'), d.eta || '--'],
        ['speed', t('speed','Speed'), d.speed || '--'],
      ];
      liveFields.forEach(item => {
        html += '<div class="param-item"><span class="param-label">' + this.esc(item[1]) + '</span><span class="param-value" data-live-field="' + item[0] + '">' + this.esc(String(item[2])) + '</span></div>';
      });
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

    // ── 训练参数：顶部关键参数高亮卡 + 下方按 section 分组完整展示 ──
    if (this.trainParams.length) {
      // 兼容新旧响应：新结构 {key,desc_key,value,section,type}，旧结构 {label,value,group}
      const byKey = {};
      this.trainParams.forEach(p => { if (p.key) byKey[p.key] = p; });

      // 关键参数：9 个核心字段，模型在高亮卡内取 basename 显示
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
        const p = byKey[kd.key];
        if (!p) return;
        let val = String(p.value == null ? '' : p.value);
        if (kd.basename) {
          const parts = val.replace(/\\/g, '/').split('/');
          val = parts[parts.length - 1] || val;
        }
        if (!val) return;
        // 高亮卡 label 用 short key（简短），title 用 field.* 完整描述句
        keyItems.push({ label: t(kd.short, kd.key), title: t(kd.labelKey, ''), value: val, type: p.type });
      });

      html += '<div class="m-section" style="margin-top:12px"><div class="m-section-title">' + this.esc(t('trainParams','Parameters')) + '</div>';

      // 关键参数高亮卡
      if (keyItems.length) {
        html += '<div class="param-keygrid">';
        keyItems.forEach(it => {
          const titleAttr = it.title && it.title !== it.label ? ' title="' + this.esc(it.title) + '"' : '';
          html += '<div class="param-key-item"' + titleAttr + '><span class="param-key-label">' + this.esc(it.label) + '</span><span class="param-key-value">';
          if (it.type === 'toggle') {
            html += this._paramValueHtml({ value: it.value, type: 'toggle' });
          } else {
            html += this.esc(it.value);
          }
          html += '</span></div>';
        });
        html += '</div>';
      }

      // 全量分组：按 section 归集（新响应用 p.section，旧响应用 p.group 兜底）
      const groups = {};
      const groupOrder = ['model', 'network', 'training', 'optimizer',
                          'regularization', 'caption', 'performance', 'save', 'preview',
                          'basic', 'network', 'training']; // 旧 group 兜底
      this.trainParams.forEach(p => {
        const g = p.section || p.group || '';
        if (!groups[g]) groups[g] = [];
        groups[g].push(p);
      });
      const orderedKeys = Object.keys(groups).sort((a, b) => {
        const ia = groupOrder.indexOf(a), ib = groupOrder.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      orderedKeys.forEach(g => {
        // 新 section 用 t('section.<g>') 取本地化组标题；旧 group 用 paramGroup<Cap> 兜底
        let groupTitle = '';
        if (g && ['model','network','training','optimizer','regularization','caption','performance','save','preview'].includes(g)) {
          groupTitle = t('section.' + g, g);
        } else if (g) {
          const titleKey = 'paramGroup' + g.charAt(0).toUpperCase() + g.slice(1);
          groupTitle = t(titleKey, g);
        }
        if (groupTitle) {
          html += '<div class="param-group"><div class="param-group-title">' + this.esc(groupTitle) + '</div><div class="param-grid">';
        } else {
          html += '<div class="param-group"><div class="param-grid">';
        }
        groups[g].forEach(p => {
          const title = this._paramTitle(p, t);
          html += '<div class="param-item"><span class="param-label"' + (title ? ' title="' + this.esc(title) + '"' : '') + '>' + this._paramLabel(p) + '</span><span class="param-value">' + this._paramValueHtml(p) + '</span></div>';
        });
        html += '</div></div>';
      });

      html += '</div>';
    } else if (!isRunning) {
      // 空闲且无参数：单条紧凑空态提示（不再占用大块垂直空间）
      html += '<div class="m-section" style="margin-top:12px"><div class="m-section-title">' + this.esc(t('trainParams','Parameters')) + '</div>';
      html += '<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('noParamsHint','Start training to see parameters')) + '</p></div>';
      html += '</div>';
    }

    return html;
  },

  // ═══════════════════════════════════════════════════════════
  //  日志标签（增量追加 + 保留滚动位置）
  // ═══════════════════════════════════════════════════════════
  _logsTabShellHtml(t) {
    let html = '<div class="m-section" style="margin-top:12px">';
    const titleKey = this.logMode === 'full' ? 'logFullTitle' : 'logTitle';
    html += '<div class="m-section-title">' + this.esc(t(titleKey,'Logs')) + ' <span class="m-logs-count" data-field="log-count">' + this._logDisplayCount() + '</span></div>';
    html += '<div class="m-section-tools m-logs-tools">';
    if (this.logMode === 'full') {
      html += this._logFullToolbarHtml(t);
    } else {
      html += '<button type="button" class="btn btn-sm btn-secondary" @click="setLogMode(\'full\')">' + this.esc(t('logFullMode','Full log')) + '</button>';
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
    }
    html += '</div>';
    html += '<div id="monitorDashboardLogs" class="monitor-logs-container log-lines"></div></div>';
    return html;
  },

  // 完整日志工具栏：一层操作，直接覆盖浏览、搜索、复制和下载。
  _logFullToolbarHtml(t) {
    let html = '';
    const tailLabel = this.selectedRunDir ? t('logBottom','Bottom') : t('logLiveTail','Live tail');
    html += '<button type="button" class="btn btn-sm btn-primary log-follow-btn" @click="logFullLastPage()">↓ ' + this.esc(tailLabel) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullFirstPage()" :disabled="logFullTotal<=0 || logFullOffset<=0">' + this.esc(t('firstPage','Top')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullPrevPage()" :disabled="logFullOffset<=0">' + this.esc(t('prevPage','‹ Prev')) + '</button>';
    html += '<span class="m-logs-range" x-text="logFullRangeText()"></span>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullNextPage()" :disabled="logFullOffset+logFullLines.length>=logFullTotal">' + this.esc(t('nextPage','Next ›')) + '</button>';
    html += '<input type="number" class="m-logs-goto" min="1" placeholder="' + this.esc(t('gotoLine','Line')) + '" @keydown.enter="logFullGotoLine($event.target.value)">';
    html += '<input type="text" class="m-logs-search m-logs-search-full" x-model="logFullQuery" placeholder="' + this.esc(t('searchFullLog','Search full file...')) + '" @keydown.enter="searchFullLog(logFullQuery)">';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="searchFullLog(logFullQuery)">' + this.esc(t('search','Search')) + '</button>';
    html += '<span class="m-logs-match-nav" x-show="logFullMatches.length>0">';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullPrevMatch()">‹</button>';
    html += '<span class="m-logs-match" x-text="logFullMatchText()"></span>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullNextMatch()">›</button>';
    html += '</span>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="refreshFullLog()">' + this.esc(t('refresh','Refresh')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="copyLogs()">' + this.esc(t('copyPage','Copy page')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="downloadLogs()">' + this.esc(t('downloadFullLog','Download full log')) + '</button>';
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
    const shellInDom = !!contentEl.querySelector('#monitorDashboardLogs');
    const shellStale = this._builtLogMode !== this.logMode;

    // ── 首次 / 标签切换 / 模式切换：重建外壳 + 全量填充 ──
    if (tabChanged || !shellInDom || shellStale) {
      this._builtLogMode = this.logMode;
      contentEl.innerHTML = this._logsTabShellHtml(t);
      this._renderedLogFilterKey = '';
      this._renderedLogCount = 0;
      this._logTrimK = 0;
      this._forceLogRebuild = false;
      this._logChunking = false;
      this._populateLogs(contentEl, true);
      // full 模式首屏/重连：自动拉取末页（async，先渲染 Loading 态，拉完再 renderDashboard）
      if (this.logMode === 'full' && !this.logFullLoading && (!this._logFullLoaded || this._logFullNeedsResync)) {
        // 无日志源（无训练且非历史模式）→ 不触发拉取，避免 toast 误报；保持空态文案。
        // 不标记 _logFullLoaded，以便后续训练启动/SSE 重连时自动重新拉取。
        if (!this._hasLogSource()) {
          this._logFullNeedsResync = false;
        } else {
          this._logFullNeedsResync = false;
          this._logFullLoaded = true;
          this.fetchLogSlice({ tail: true, silent: true });
        }
      }
      this._bindLogScroll(contentEl);
      // tail 全量是分帧的，末帧自会滚底；此处仅在非分帧（full/空）时按需滚动
      this._afterLogsRender(contentEl, this.logMode === 'tail' && !this._logChunking);
      return;
    }

    // ── full 模式：末页 SSE 增量 + 翻页静态；首屏/重连自动拉取末页 ──
    if (this.logMode === 'full') {
      // 首屏未加载或 SSE 重连后需 resync → 自动拉取末页（async，先返回 loading 态，拉完再 renderDashboard）
      if ((!this._logFullLoaded || this._logFullNeedsResync) && !this.logFullLoading) {
        if (!this._hasLogSource()) {
          this._logFullNeedsResync = false;  // 留待有源时再拉
        } else {
          this._logFullNeedsResync = false;
          this._logFullLoaded = true;
          this.fetchLogSlice({ tail: true, silent: true });
        }
      }
      if (this._logFullSlide) {
        this._logFullSlide = false;
        this._populateFullSlide(contentEl);
      } else if (this._forceLogRebuild) {
        this._forceLogRebuild = false;
        this._populateLogs(contentEl, true);
      }
      this._updateLogCount(contentEl);
      return;
    }

    // ── tail 模式 ──
    const search = (this.logSearch || '').toLowerCase();
    const level = this.logLevel || 'all';
    const filterKey = search + '|' + level;
    const filterChanged = this._renderedLogFilterKey !== filterKey;
    const trimmed = this.logLines.length < this._renderedLogCount;
    const wasDirty = this._logDirty;

    // Fix3：非脏且无过滤/裁剪/强制重建 → 跳过日志重排（progress/hardware/loss 不再触碰日志 DOM）
    if (!wasDirty && !filterChanged && !trimmed && !this._forceLogRebuild) {
      this._updateLogCount(contentEl);
      return;
    }

    if (filterChanged || trimmed || this._forceLogRebuild) {
      this._renderedLogFilterKey = filterKey;
      this._renderedLogCount = 0;
      this._logTrimK = 0;
      this._forceLogRebuild = false;
      this._populateLogs(contentEl, true);          // 分帧全量重建
      this._logDirty = false;
      this._updateLogCount(contentEl);
      this._afterLogsRender(contentEl, !this._logChunking); // 末帧自滚底
      return;
    }

    // Fix1：分帧进行中 → 跳过增量（循环实时读 logLines 会吸收新行；裁剪已取消分帧并置 forceRebuild）
    if (this._logChunking) {
      this._logDirty = false;
      this._updateLogCount(contentEl);
      return;
    }

    // 增量 / 滑窗（Fix2）
    if (wasDirty && (this.logLines.length > this._renderedLogCount || this._logTrimK > 0)) {
      this._populateLogs(contentEl, false);
    }
    this._logDirty = false;
    this._updateLogCount(contentEl);
    this._afterLogsRender(contentEl, wasDirty);
  },

  _populateLogs(contentEl, isFullRebuild) {
    if (this.logMode === 'full') { this._populateFullLogs(contentEl); return; }
    const search = (this.logSearch || '').toLowerCase();
    const level = this.logLevel || 'all';
    if (isFullRebuild) this._populateTailFull(contentEl, search, level);
    else this._populateTailIncremental(contentEl, search, level);
  },

  // 行号由 CSS counter（.log-line::before）按 DOM 位置自动生成；full 模式由
  // counter-reset=offset 给出绝对行号。故此处不再创建 num span。
  _buildLogLineDom(line, search, extraClass, lineNo) {
    const div = document.createElement('div');
    div.className = 'log-line' + (extraClass ? ' ' + extraClass : '');
    if (lineNo != null) div.dataset.lineNo = String(lineNo);
    const span = document.createElement('span');
    span.className = 'log-line-text';
    const richSource = this._splitRichLogSource(line);
    if (richSource) {
      span.className += ' log-line-text-split';
      const main = document.createElement('span');
      main.className = 'log-line-main';
      const source = document.createElement('span');
      source.className = 'log-line-source';
      this._highlightLogLine(main, richSource.main, search);
      this._highlightLogLine(source, richSource.source, search);
      span.appendChild(main);
      span.appendChild(source);
    } else {
      this._highlightLogLine(span, line, search);
    }
    div.appendChild(span);
    return div;
  },

  _splitRichLogSource(lineText) {
    const text = String(lineText || '');
    const pathTail = '((?:[A-Za-z]:[\\\\/])?(?:[\\w.@()-]+[\\\\/\\\\]){0,10}(?:[\\w@()-]+\\.){0,12}[\\w@()-]+\\.(?:py|toml|json|yaml|yml|txt|log|js|ts|jsx|tsx|go|rs|cpp|c|h|hpp)(?::\\d+)?)';
    let m;
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (normalized.indexOf('\n') >= 0) {
      m = normalized.match(new RegExp('^(.*)\\n[ \\t]*' + pathTail + '\\s*$', 's'));
    } else {
      // Rich console pads the source column with a long run of spaces. In narrow
      // containers that padding wraps visually; split it into a real right column.
      m = normalized.match(new RegExp('^(.*?)[ \\t]{3,}' + pathTail + '\\s*$'));
    }
    if (!m) return null;
    const main = m[1].replace(/\n[ \t]*$/g, '').trimEnd();
    const source = m[2].trim();
    if (!main || !source) return null;
    return { main, source };
  },

  _isRichContinuationLine(lineText) {
    const text = String(lineText || '');
    if (!text.trim()) return false;
    if (!/^[ \t]{20,}\S/.test(text)) return false;
    if (this._splitRichLogSource(text)) return false;
    return true;
  },

  _coalesceRichLogLines(lines, baseOffset) {
    const src = lines || [];
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const startIdx = i;
      let text = String(src[i] || '');
      const richSource = this._splitRichLogSource(text);
      if (richSource) {
        let main = richSource.main;
        let j = i + 1;
        while (j < src.length && this._isRichContinuationLine(src[j])) {
          main += ' ' + String(src[j] || '').trim();
          j++;
        }
        if (j > i + 1) {
          text = main + '        ' + richSource.source;
          i = j - 1;
        }
      }
      out.push({ text, lineNo: (baseOffset || 0) + startIdx + 1 });
    }
    return out;
  },

  // ── tail：分帧全量重建（Fix1 _logChunking 防竞态；末帧自滚底）──
  _populateTailFull(contentEl, search, level) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    container.querySelectorAll('.log-line, .log-empty').forEach(n => n.remove());
    container.style.counterReset = 'logline 0';   // tail：缓冲内相对行号 1..n
    const lines = this.logLines;
    const entries = this._coalesceRichLogLines(lines, 0);
    const CHUNK = 400;
    const self = this;
    this._logChunking = true;
    let i = 0;
    let firstChunk = true;

    function renderChunk() {
      if (!self._logChunking) return;             // 已被取消（裁剪打断 → forceRebuild）
      const frag = document.createDocumentFragment();
      let count = 0;
      while (i < entries.length && count < CHUNK) {
        const item = entries[i];
        if (self._logLineMatches(item.text, search, level)) {
          frag.appendChild(self._buildLogLineDom(item.text, search, '', item.lineNo));
        }
        i++; count++;
      }
      if (firstChunk) {
        if (entries.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'log-empty dashboard-empty';
          empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>' + self.esc(self._logEmptyMessage(false)) + '</p>';
          container.appendChild(empty);
          self._renderedLogCount = lines.length;
          self._logChunking = false;
          self._afterLogsRender(contentEl, false);
          return;
        }
        firstChunk = false;
      }
      container.appendChild(frag);
      self._renderedLogCount = Math.min(i, entries.length);
      if (i < entries.length) {
        requestAnimationFrame(renderChunk);
      } else {
        self._logChunking = false;
        if (!container.querySelector('.log-line') && entries.length > 0) {
          const empty = document.createElement('div');
          empty.className = 'log-empty dashboard-empty';
          empty.innerHTML = '<p>' + self.esc(self.t('monitor.noResults') || 'No matches') + '</p>';
          container.appendChild(empty);
        }
        self._renderedLogCount = lines.length;
        self._afterLogsRender(contentEl, true);   // 末帧：按需滚底
      }
    }
    requestAnimationFrame(renderChunk);
  },

  // ── tail：增量 + 滑窗（Fix2 删顶补底，O(新增) 而非 O(缓冲)）──
  _populateTailIncremental(contentEl, search, level) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    const lines = this.logLines;

    // 滑窗删顶：环形缓冲裁掉头部 K 行 → 同步删除 DOM 前 K 个 .log-line。
    // CSS counter 自动重编 surviving 行号，无需 JS 重编。仅在 DOM 已同步时执行。
    if (this._logTrimK > 0) {
      const k = Math.min(this._logTrimK, this._renderedLogCount);
      let remove = k;
      while (remove-- > 0) {
        const first = container.querySelector('.log-line');
        if (!first) break;
        first.remove();
      }
      this._renderedLogCount = Math.max(0, this._renderedLogCount - k);
      this._logTrimK = 0;
      const emp = container.querySelector('.log-empty');
      if (emp) emp.remove();
    }

    // 补底：追加新行
    const start = this._renderedLogCount;
    if (start < lines.length) {
      const frag = document.createDocumentFragment();
      let appended = 0;
      for (let i = start; i < lines.length; i++) {
        if (!this._logLineMatches(lines[i], search, level)) continue;
        frag.appendChild(this._buildLogLineDom(lines[i], search, '', i + 1));
        appended++;
      }
      container.appendChild(frag);
      const emp = container.querySelector('.log-empty');
      if (emp && appended > 0) emp.remove();
      this._renderedLogCount = lines.length;
    }
  },

  // ── full：完整日志分页渲染（≤ 一页，静态，绝对行号）──
  _populateFullLogs(contentEl) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    container.querySelectorAll('.log-line, .log-empty').forEach(n => n.remove());
    const offset = this.logFullOffset || 0;
    container.style.counterReset = 'logline ' + offset;  // 首行显示 offset+1
    const lines = this.logFullLines || [];
    const entries = this._coalesceRichLogLines(lines, offset);
    if (this.logFullLoading || !entries.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty dashboard-empty';
      const msg = this._logEmptyMessage(!!this.logFullLoading);
      empty.innerHTML = '<p>' + this.esc(msg) + '</p>';
      container.appendChild(empty);
      this._renderedLogCount = 0;
      return;
    }
    const search = this.logFullQuery || '';
    const matchSet = search ? new Set(this.logFullMatches) : null;
    const frag = document.createDocumentFragment();
    for (const item of entries) {
      const cls = (matchSet && matchSet.has(item.lineNo - 1)) ? 'log-line-match' : '';
      frag.appendChild(this._buildLogLineDom(item.text, search, cls, item.lineNo));
    }
    container.appendChild(frag);
    this._renderedLogCount = lines.length;
    // 跟随（实时末页 / 历史停在末尾）滚底；浏览历史页时停在顶部
    container.scrollTop = (this.logAutoScroll || this._logAtBottom) ? container.scrollHeight : 0;
  },

  // ── full：实时增量 slide（O(新行) 删除顶部 evicted + 追加底部新行，零 HTTP）──
  _populateFullSlide(contentEl) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    const lines = this.logFullLines;

    // 删顶：handleSSELogUpdate 中已 splice + bump offset；同步删除 DOM 前 K 个 .log-line
    if (this._logFullEvictK > 0) {
      const k = Math.min(this._logFullEvictK, this._renderedLogCount);
      let remove = k;
      while (remove-- > 0) {
        const first = container.querySelector('.log-line');
        if (!first) break;
        first.remove();
      }
      this._renderedLogCount = Math.max(0, this._renderedLogCount - k);
      this._logFullEvictK = 0;
      const emp = container.querySelector('.log-empty');
      if (emp) emp.remove();
    }
    // 更新 counter-reset 使 surviving 节点绝对行号与新的 logFullOffset 一致
    container.style.counterReset = 'logline ' + (this.logFullOffset || 0);

    // 补底：追加新行（词内搜索高亮，不加行级 match 背景——match_indices 来自后端快照不覆盖增量行）
    const start = this._renderedLogCount;
    if (start < lines.length) {
      const search = this.logFullQuery || '';
      const frag = document.createDocumentFragment();
      let appended = 0;
      for (let i = start; i < lines.length; i++) {
        frag.appendChild(this._buildLogLineDom(lines[i], search, '', (this.logFullOffset || 0) + i + 1));
        appended++;
      }
      container.appendChild(frag);
      const emp = container.querySelector('.log-empty');
      if (emp && appended > 0) emp.remove();
      this._renderedLogCount = lines.length;
    }
    // 跟随则滚底
    if (this.logAutoScroll || this._logAtBottom) {
      container.scrollTop = container.scrollHeight;
    }
  },

  _updateLogCount(contentEl) {
    const countEl = contentEl.querySelector('[data-field="log-count"]');
    if (countEl) countEl.textContent = this._logDisplayCount();
  },
  _logDisplayCount() {
    return this.logMode === 'full' ? (this.logFullTotal || 0) : this.logLines.length;
  },
  /** 日志空态文案：按场景区分（实时无训练 / 实时训练中等待输出 / 历史无日志 / 加载中） */
  _logEmptyMessage(isLoading) {
    if (isLoading) return this.t('monitor.loading') || 'Loading...';
    if (this.selectedRunDir) {
      return this.t('monitor.noLogsHistoryHint') || 'No log file in this run';
    }
    const state = (this.monitorData && this.monitorData.state) || 'IDLE';
    if (state === 'RUNNING') {
      return this.t('monitor.noLogsRunningHint') || 'Waiting for log output from training...';
    }
    return this.t('monitor.noLogsIdleHint') || 'Start a training task to see real-time logs here';
  },
  // 完整日志工具栏文本（reactive：x-text 调用）
  logFullRangeText() {
    const total = this.logFullTotal || 0;
    if (!total) return '0 / 0';
    const off = this.logFullOffset || 0;
    const end = Math.min(off + (this.logFullLines ? this.logFullLines.length : 0), total);
    return (off + 1) + '–' + end + ' / ' + total;
  },
  logFullMatchText() {
    const n = this.logFullMatches ? this.logFullMatches.length : 0;
    return (this.logFullMatchIdx >= 0 ? (this.logFullMatchIdx + 1) : 0) + '/' + n;
  },

  _bindLogScroll(contentEl) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    if (!this.selectedRunDir) this._logAtBottom = true;
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

  _afterLogsRender(contentEl, doScroll) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    // Fix3：仅在有新日志（doScroll）时才设 scrollTop，避免大 DOM 上每帧强制 reflow
    if (doScroll && (this.logAutoScroll || this._logAtBottom)) {
      container.scrollTop = container.scrollHeight;
      this._logAtBottom = true;
    }
    this._updateLogNavButtons(contentEl);
  },

  // ═══════════════════════════════════════════════════════════
  //  VSCode-style log tokenizer — single regex, one pass per line
  //  Groups: 1=str 2=url 3=domain 4=hex 5=ts 6=lvl 7=path 8=mod 9=exc
  //         10=const 11=num 12=unit 13=kw 14=empty 15=stack
  // ═══════════════════════════════════════════════════════════
  _LOG_TOKEN_RE: (() => {
    // ts 用非捕获括号：(外层 wrapper 已是捕获组 g5，若 ts 再用捕获括号会吞掉 g6，
    // 把 lvl 挤到 g7 → 级别被误染为 log-path 绿色、g===6 重映射失效。)
    const ts   = '(?:\\d{4}[-/]\\d{2}[-/]\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?|\\b\\d{2}[/-]\\d{2}[/-]\\d{4}\\b|\\b\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\b)';
    const lvl  = '(?:ALERT|CRITICAL|EMERGENCY|FATAL|ERROR|FAILURE|FAIL|Fatal|HINT|INFORMATION|NOTICE|Info|WARNING|Warn|DEBUG|Debug|TRACE|Trace|INFO|WARN)\\b';
    // Fix5：dir 段允许点（后接分隔符，无歧义）；文件名 stem 拆为「无点段+.」序列，
    //   消除与 \\.(ext) 边界的互相回溯；重复次数有界，杜绝病态 O(n²)。
    const path = '(?:[\\w.@()-]+[\\/\\\\]){0,10}(?:[\\w@()-]+\\.){0,12}[\\w@()-]+\\.(?:py|toml|json|yaml|yml|txt|log|safetensors|pt|pth|ckpt|bin|csv|tsv|pb|h5|onnx|java|kt|js|ts|jsx|tsx|go|rs|cpp|c|h|hpp|cs|rb|php|swift)(?::\\d+)?';
    const mod  = '\\b[a-zA-Z_]\\w*(?:\\.\\w+){1,20}\\b';
    const exc  = '\\b[A-Z]\\w*(?:Error|Exception|Warning|Fault)\\b';
    const cnst = '\\b(?:true|false|null|undefined|none|NaN|Inf(?:inity)?|N\\/A)\\b';
    const num  = '(?<![\\w.])(?:[+-]?\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)';
    const unit = '(?<=\\d)(?:it\\/s|s\\/it|[sm]s|us|ns|GiB|MiB|KiB|GB|MB|KB|TB|B|%)';
    const kw   = '\\b(?:Traceback|raise|assert|failed|failure|abort|killed|OOM|CUDA out of memory|memory)\\b';
    return new RegExp(
      '(`[^`]*`|"[^"]*"|\'(?:\\\\.|[^\'\\\\])*\')' +  // group 1: quoted strings
      '|(https?:\\/\\/[^\\s,;)\\]}>]+)' +               // group 2: URLs
      // Fix5：domain 段有界重复 + TLD 后置 (?![\\w]) 边界，固化匹配
      '|(\\b(?:[\\w-]+\\.){1,10}(?:com|org|net|io|dev|co|ai|app|gg|xyz|me|info|biz|tv|cc)(?![\\w])(?:\\/[^\\s,;)\\]}>]*)?)' + // group 3: domains
      '|(\\b[0-9a-f]{40}\\b|\\b[0-9a-f]{10}\\b|\\b[0-9a-f]{7}\\b|\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b|\\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b|\\b0x[0-9a-f]+\\b)' + // group 4: hex
      '|(' + ts + ')' +                                  // group 5: timestamp
      '|(' + lvl + ')' +                                 // group 6: log level
      '|(' + path + ')' +                                // group 7: file path
      '|(' + mod + ')' +                                 // group 8: module path
      '|(' + exc + ')' +                                 // group 9: exception
      '|(' + cnst + ')' +                                // group 10: constant
      '|(' + num + ')' +                                 // group 11: number
      '|(' + unit + ')' +                                // group 12: unit
      '|(' + kw + ')' +                                  // group 13: keyword
      '|(\\{\\s*\\}|\\[\\s*\\])' +                       // group 14: empty object/array
      '|(^\\s*at\\s+)',                                  // group 15: stack trace
      'gi'
    );
  })(),

  _highlightLogLine(rootEl, lineText, search) {
    const classes = [
      null,           // 0: (unused)
      'log-str',      // 1: quoted string
      'log-url',      // 2: URL
      'log-url',      // 3: domain
      'log-hex',      // 4: hex/UUID/MAC
      'log-ts',       // 5: timestamp
      'log-lvl-fix',  // 6: log level (class set below from match)
      'log-path',     // 7: file path
      'log-module',   // 8: module path
      'log-exc',      // 9: exception
      'log-const',    // 10: constant
      'log-num',      // 11: number
      'log-unit',     // 12: unit
      'log-kw',       // 13: keyword
      'log-punct',    // 14: empty obj/arr
      'log-exc',      // 15: stack trace "at "
    ];
    const re = this._LOG_TOKEN_RE;
    const lower = search ? search.toLowerCase() : '';
    // Fix4：把 search 高亮并入分词 pass —— 对任意文本段（纯文本或 token 内）按
    //   search 切分并包 <mark>，省掉原先每行一次 TreeWalker 二次遍历。
    const appendText = (parent, text) => {
      if (!lower) { parent.appendChild(document.createTextNode(text)); return; }
      this._appendHighlighted(parent, text, search, lower);
    };
    let lastIdx = 0;
    let m;
    const frag = document.createDocumentFragment();
    while ((m = re.exec(lineText)) !== null) {
      if (m.index > lastIdx) appendText(frag, lineText.slice(lastIdx, m.index));
      // Find which group matched
      let cls = '';
      for (let g = 1; g < m.length; g++) {
        if (m[g] !== undefined) {
          cls = classes[g];
          if (g === 6) { // log level — map to specific VSCode class
            const lv = m[g].toUpperCase();
            if (/^(ERROR|CRITICAL|FATAL|ALERT|EMERGENCY|FAILURE|FAIL)$/.test(lv)) cls = 'log-lvl log-lvl-ERROR';
            else if (/^(WARNING|WARN)$/.test(lv)) cls = 'log-lvl log-lvl-WARN';
            else if (/^(INFO|INFORMATION|NOTICE|HINT)$/.test(lv)) cls = 'log-lvl log-lvl-INFO';
            else if (/^(DEBUG|TRACE)$/.test(lv)) cls = 'log-lvl log-lvl-DEBUG';
          }
          break;
        }
      }
      if (cls) {
        const span = document.createElement('span');
        span.className = cls;
        appendText(span, m[0]);   // token 内命中 search 也高亮（mark 仅加背景，保留 token 颜色）
        frag.appendChild(span);
      } else {
        appendText(frag, m[0]);
      }
      lastIdx = re.lastIndex;
    }
    if (lastIdx < lineText.length) appendText(frag, lineText.slice(lastIdx));
    rootEl.appendChild(frag);
  },

  // 把 text 追加到 parent，其中命中 search 的片段包 <mark>（一次线性扫描）
  _appendHighlighted(parent, text, search, lower) {
    if (!lower) { parent.appendChild(document.createTextNode(text)); return; }
    const lowerText = text.toLowerCase();
    let from = 0, idx = lowerText.indexOf(lower, from);
    if (idx === -1) { parent.appendChild(document.createTextNode(text)); return; }
    while (idx !== -1) {
      if (idx > from) parent.appendChild(document.createTextNode(text.slice(from, idx)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + search.length);
      parent.appendChild(mark);
      from = idx + search.length;
      idx = lowerText.indexOf(lower, from);
    }
    if (from < text.length) parent.appendChild(document.createTextNode(text.slice(from)));
  },

  downloadLogs() {
    if (this.logMode === 'full') {
      const runDir = this._logSliceRunDir ? this._logSliceRunDir() : null;
      const taskId = this._logSliceTaskId ? this._logSliceTaskId() : null;
      if (runDir || taskId) {
        const params = new URLSearchParams();
        if (runDir) params.set('run_dir', runDir);
        else params.set('task_id', taskId);
        this._triggerDownload('/api/monitor/log-download?' + params.toString());
        this.toast(this.t('monitor.logDownloadStarted','Download started'));
        return;
      }
    }

    const lines = this.logMode === 'full' ? (this.logFullLines || []) : (this.logLines || []);
    const content = lines.join('\n');
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
    const showPreviews = this.previews.length > 0;
    const lastIdx = this.previews.length - 1;
    const pageSize = this.previewPageSize || 36;
    const visibleCount = Math.min(this.previews.length, this.previewVisibleCount || pageSize);
    const startIdx = Math.max(0, this.previews.length - visibleCount);
    const visiblePreviews = this.previews.slice(startIdx);

    let html = '<div class="m-section"><div class="m-section-title" style="justify-content:flex-start;gap:10px;">' + this.esc(t('previewSamples','Preview'));
    if (showPreviews) {
      html += '<button type="button" class="btn btn-sm btn-secondary" @click="refreshPreviews()" :disabled="previewsLoading">' + (this.previewsLoading ? (this.esc(t('loading','Loading'))+'…') : ('⟳ ' + this.esc(t('refresh','Refresh')))) + '</button>';
    }
    html += '</div>';
    if (showPreviews) {
      if (startIdx > 0) {
        html += '<div class="preview-controls"><button type="button" class="btn btn-sm btn-secondary" @click="showMorePreviews()">' + this.esc(t('monitor.showOlderSamples','Show older samples')) + '</button><span class="preview-step">' + (startIdx + 1) + '-' + this.previews.length + ' / ' + this.previews.length + '</span></div>';
      }
      html += '<div class="preview-grid">';
      visiblePreviews.forEach((pv, offset) => {
        const i = startIdx + offset;
        const thumbUrl = pv.thumb_url || pv.url;
        html += '<div class="preview-grid-item" @click="openPreviewLightbox(' + i + ')">';
        if (i === lastIdx) html += '<span class="preview-thumb-fresh">' + this.esc(t('latest','Latest')) + '</span>';
        html += '<img src="' + this.esc(thumbUrl) + '" alt="' + this.esc(pv.name) + '" loading="lazy" decoding="async"/>';
        html += '<div class="preview-grid-item-label">' + this.esc(this._parseSampleInfo(pv.name)) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      // 区分空态场景：实时无训练 / 实时训练中未生成样本 / 历史记录无样本
      let hintKey, hintFallback;
      if (isHistory) {
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
      + '<button type="button" class="preview-lightbox-close" @click.stop="closePreviewLightbox()" aria-label="' + this.esc(t('close','Close')) + '">×</button>'
      + '<button type="button" class="preview-lightbox-nav prev" @click.stop="previewLightboxNav(-1)" aria-label="' + this.esc(t('prev','Prev')) + '">‹</button>'
      + '<div class="preview-lightbox-inner" @click.stop>'
      + '<img class="preview-lightbox-img" id="previewLightboxImg" alt=""/>'
      + '<div class="preview-lightbox-bar">'
      + '<span class="preview-lightbox-counter" id="previewLightboxCounter"></span>'
      + '<span class="preview-lightbox-label" id="previewLightboxLabel"></span>'
      + '<span class="preview-lightbox-hint">←/→ ' + this.esc(t('navigate','navigate')) + ' · Esc ' + this.esc(t('close','Close')) + '</span>'
      + '</div>'
      + '</div>'
      + '<button type="button" class="preview-lightbox-nav next" @click.stop="previewLightboxNav(1)" aria-label="' + this.esc(t('next','Next')) + '">›</button>'
      + '</div>';
  },

  openPreviewLightbox(i) {
    if (!this.previews.length) return;
    this.previewStep = Math.max(0, Math.min(i, this.previews.length - 1));
    const box = document.getElementById('previewLightbox');
    if (!box) return;
    box.classList.add('open');
    document.body.style.overflow = 'hidden';
    this._updatePreviewLightbox();
    if (!this._lightboxKeyHandler) {
      this._lightboxKeyHandler = (e) => {
        if (e.key === 'ArrowLeft') { this.previewLightboxNav(-1); }
        else if (e.key === 'ArrowRight') { this.previewLightboxNav(1); }
        else if (e.key === 'Escape') { this.closePreviewLightbox(); }
      };
    }
    document.addEventListener('keydown', this._lightboxKeyHandler);
  },

  closePreviewLightbox() {
    const box = document.getElementById('previewLightbox');
    if (box) box.classList.remove('open');
    document.body.style.overflow = '';
    if (this._lightboxKeyHandler) document.removeEventListener('keydown', this._lightboxKeyHandler);
  },

  previewLightboxNav(dir) {
    if (!this.previews.length) return;
    const n = this.previews.length;
    let next = this.previewStep + dir;
    if (next < 0) next = 0;
    else if (next > n - 1) next = n - 1;
    if (next === this.previewStep) return;
    this.previewStep = next;
    this._updatePreviewLightbox();
  },

  _updatePreviewLightbox() {
    const n = this.previews.length;
    if (!n) return;
    const p = this.previews[this.previewStep] || this.previews[0];
    const img = document.getElementById('previewLightboxImg');
    if (img) { img.src = p.url; img.alt = p.name; }
    const c = document.getElementById('previewLightboxCounter');
    if (c) c.textContent = (this.previewStep + 1) + ' / ' + n;
    const lbl = document.getElementById('previewLightboxLabel');
    if (lbl) lbl.textContent = this._parseSampleInfo(p.name);
    const box = document.getElementById('previewLightbox');
    if (box) {
      const prevBtn = box.querySelector('.preview-lightbox-nav.prev');
      const nextBtn = box.querySelector('.preview-lightbox-nav.next');
      if (prevBtn) prevBtn.disabled = this.previewStep <= 0;
      if (nextBtn) nextBtn.disabled = this.previewStep >= n - 1;
    }
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
    const t = (k, fb) => { const fullKey = k.includes('.') ? k : ('monitor.' + k); return this.t(fullKey, fb) || fb || k; };
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
      html += '<div class="hist-meta">' + this.esc(t('historyLR', 'LR')) + ': ' + this.esc(r.lr || '?') + ' | ' + this.esc(t('historyDim', 'Dim')) + ': ' + this.esc(r.dim || '?') + (r.alpha ? ' / α ' + this.esc(r.alpha) : '') + ' | ' + this.esc(t('historyEpochs', 'Epochs')) + ': ' + this.esc(r.epochs || '?') + '</div>';
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
        html += '<div class="hist-meta">' + this.esc(t('historyLR', 'LR')) + ': ' + this.esc(h.lr || '') + ' | ' + this.esc(t('historyDim', 'Dim')) + ': ' + this.esc(h.dim || '') + (h.alpha ? ' / α ' + this.esc(h.alpha) : '') + ' | ' + this.esc(t('historyEpochs', 'Epochs')) + ': ' + this.esc(h.epochs || '') + '</div>';
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
    const t = (k, fb) => { const fullKey = k.includes('.') ? k : ('monitor.' + k); return this.t(fullKey, fb) || fb || k; };
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
    const t = (k, fb) => { const fullKey = k.includes('.') ? k : ('monitor.' + k); return this.t(fullKey, fb) || fb || k; };

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
    const t = (k, fb) => { const fullKey = k.includes('.') ? k : ('monitor.' + k); return this.t(fullKey, fb) || fb || k; };
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
