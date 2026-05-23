/* ================================================================
   monitor.js — Dashboard, real-time logs, training history
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.monitorMixin = {
  // ── State ──────────────────────────────────────────────
  monitorData: null,
  monitorTimer: null,
  monitorPollMs: 2000,
  gpuInfo: null,
  sysInfo: null,
  lossSeries: [],
  trainParams: [],
  previews: [],
  previewStep: 0,
  historyItems: [],
  logAutoScroll: true,
  logLines: [],
  logMaxLines: 5000,
  logSearch: '',
  logErrorsOnly: false,

  // ── Polling ────────────────────────────────────────────
  startMonitorPolling() {
    this.stopMonitorPolling();
    this._monitorFirstFetch = true;
    this.fetchMonitorStatus();
    this.monitorTimer = setInterval(() => this.fetchMonitorStatus(), this.monitorPollMs);
  },

  stopMonitorPolling() {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    this._monitorFirstFetch = false;
    this._dashboardRendered = false;
  },

  async fetchMonitorStatus() {
    try {
      const tid = this.taskId || '';
      const r = await fetch('/api/monitor/status?task_id=' + encodeURIComponent(tid));
      const j = await r.json();
      if (j.status === 'success') {
        this.monitorData = j.data;
        this.gpuInfo = j.data.gpu;
        this.sysInfo = j.data.system;
        this.lossSeries = j.data.tensorboard_loss || [];
        this.trainParams = j.data.train_params || [];
        this.previews = j.data.previews || [];
        if (j.data.state === 'RUNNING') {
          this.isTraining = true; this.isIdle = false; this.statusText = j.data.state_label || j.data.state;
        } else if (j.data.state === 'IDLE') {
          this.isTraining = false; this.isIdle = true; this.statusText = 'Idle';
        }
        if (this.currentRoute === 'monitor-dashboard') this.renderDashboard();
        if (this.currentRoute === 'monitor-logs') this.renderLogs();
      }
      if (this._monitorFirstFetch) {
        this._monitorFirstFetch = false;
        this.finishProgress();
      }
    } catch (e) {
      if (this._monitorFirstFetch) {
        this._monitorFirstFetch = false;
        this.finishProgress();
      }
    }
  },

  // ═══════════════════════════════════════════════════════
  //  Dashboard
  // ═══════════════════════════════════════════════════════

  renderDashboard() {
    const el = document.getElementById('monitorDashboard');
    if (!el) return;
    const d = this.monitorData || {};
    const gpu = this.gpuInfo;
    const sys = this.sysInfo;
    const t = (k, fb) => this.t('monitor.' + k) || fb || k;
    const firstRender = !this._dashboardRendered;
    this._dashboardRendered = true;

    const prevBars = this._prevBarValues || {};
    const vramPct = gpu ? (gpu.vram_total_mb > 0 ? gpu.vram_used_mb / gpu.vram_total_mb * 100 : 0) : 0;
    const loadPct = gpu ? (gpu.gpu_load_pct || 0) : 0;
    const cpuPct = sys ? sys.cpu_pct : 0;
    const ramPct = sys ? sys.ram_pct : 0;
    this._prevBarValues = { vram: vramPct, load: loadPct, cpu: cpuPct, ram: ramPct };

    let html = '<div class="monitor-dashboard">';

    html += '<div class="monitor-row">';
    html += this._statusCard(d, t);
    if (sys) html += this._systemCard(sys, t);
    if (gpu) html += this._gpuCard(gpu, t);
    html += '</div>';

    html += '<div class="card card-params" style="margin-top:12px"><div class="card-header">' + t('trainParams', 'Training Parameters') + '</div>';
    if (this.trainParams.length) {
      html += '<div class="param-grid">';
      this.trainParams.forEach(p => {
        html += `<div class="param-item"><span class="param-label">${p.label}</span><span class="param-value">${p.value}</span></div>`;
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>' + t('noTrainingHint', 'Start training to see parameters here') + '</p></div>';
    }
    html += '</div>';

    html += '<div class="card card-charts" style="margin-top:12px"><div class="card-header">' + t('lossCurve', 'Loss / LR Curves') + '</div>';
    html += '<div class="chart-grid">';
    const chartTags = this.lossSeries.length ? this.lossSeries : [
      { tag: 'loss/average', name: 'loss average', latest: null, points: [] },
      { tag: 'loss/current', name: 'loss current', latest: null, points: [] },
      { tag: 'loss/epoch_average', name: 'loss epoch average', latest: null, points: [] },
      { tag: 'lr/unet', name: 'lr unet', latest: null, points: [] },
    ];
    chartTags.forEach(s => {
      html += `<div class="chart-panel"><div class="chart-title">${s.name} <span class="chart-val">${s.latest != null ? s.latest.toFixed(4) : '--'}</span></div>`;
      html += `<canvas id="chart-${s.tag.replace(/[/.]/g,'-')}" width="360" height="200"></canvas></div>`;
    });
    html += '</div></div>';

    html += '<div class="card card-preview" style="margin-top:12px"><div class="card-header">' + t('previewSamples', 'Preview Samples') + '</div>';
    if (this.previews.length) {
      html += '<div class="preview-controls" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
      html += `<button class="btn btn-sm" @click="previewStep = Math.max(0, previewStep - 1)" :disabled="previewStep <= 0">&larr; Prev</button>`;
      html += `<span style="font-size:13px">Step <b x-text="previewStep + 1"></b> / <b>${this.previews.length}</b></span>`;
      html += `<button class="btn btn-sm" @click="previewStep = Math.min(${this.previews.length - 1}, previewStep + 1)" :disabled="previewStep >= ${this.previews.length - 1}">Next &rarr;</button>`;
      html += '</div>';
      html += '<div class="preview-grid">';
      const p = this.previews[this.previewStep] || this.previews[0];
      html += `<div class="preview-item" style="grid-column:1/-1"><img src="${p.url}" alt="${p.name}" loading="lazy" onclick="window.open('${p.url}')" style="max-height:400px;object-fit:contain"/><span>${p.name}</span></div>`;
      this.previews.forEach((pv, i) => {
        html += `<div class="preview-item" style="cursor:pointer;${i === this.previewStep ? 'border:2px solid var(--primary);' : ''}" @click="previewStep = ${i}"><img src="${pv.url}" alt="${pv.name}" loading="lazy" style="height:60px;object-fit:cover"/></div>`;
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><p>' + t('noTrainingHint', 'Preview images will appear here during training') + '</p></div>';
    }
    html += '</div>';

    html += '</div>';
    el.innerHTML = html;

    const bars = el.querySelectorAll('.monitor-bar-fill[data-bar]');
    if (firstRender) {
      // First load: show actual values immediately, no animation
      bars.forEach(bar => {
        bar.style.transition = 'none';
        bar.style.width = bar.dataset.target + '%';
      });
    } else {
      // Subsequent poll: animate from previous value → new value
      bars.forEach(bar => {
        const key = bar.dataset.bar;
        const prev = prevBars[key] != null ? prevBars[key] : 0;
        bar.style.width = prev + '%';
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          bars.forEach(bar => {
            bar.style.width = bar.dataset.target + '%';
          });
        });
      });
    }

    setTimeout(() => this._drawCharts(), 100);
  },

  _statusCard(d, t) {
    const stateCode = d.state || 'IDLE';
    const stateLabels = { 'RUNNING': t('training','Training'), 'FINISHED': t('finished','Finished'), 'TERMINATED': t('terminated','Terminated'), 'CREATED': t('created','Pending'), 'IDLE': t('idle','Idle') };
    const state = stateLabels[stateCode] || stateCode;
    const isTraining = stateCode === 'RUNNING';
    const color = isTraining ? 'var(--success)' : (d.has_error ? 'var(--danger)' : 'var(--text-secondary)');
    let html = `<div class="card card-status flex-1">
      <div class="card-header">${t('status', 'Training Status')}</div>
      <div style="font-size:20px;font-weight:700;color:${color};margin:8px 0">${state}</div>`;
    if (isTraining) {
      // Progress bar
      if (d.percent > 0) {
        html += `<div class="monitor-bar-track" style="height:8px;margin:8px 0"><div class="monitor-bar-fill low" style="width:${d.percent}%;transition:width 1s ease"></div></div>`;
      }
      if (d.step) html += `<div>${t('step', 'Steps')}: <b>${d.step}</b> / ${d.total_steps || '?'} (${d.percent || 0}%)</div>`;
      if (d.loss) html += `<div>${t('loss', 'Loss')}: <b>${d.loss}</b></div>`;
      if (d.lr) html += `<div>${t('lr', 'LR')}: <b>${d.lr}</b></div>`;
      if (d.epoch) html += `<div>${t('epoch', 'Epoch')}: <b>${d.epoch}</b></div>`;
      if (d.speed) html += `<div>${t('speed', 'Speed')}: <b>${d.speed}</b></div>`;
      if (d.eta) html += `<div>ETA: <b>${d.eta}</b></div>`;
      if (d.output_dir) html += `<div style="margin-top:8px"><a href="#" @click.prevent="navigate('files')" style="font-size:12px;color:var(--primary)">${t('outputDir','Output')}: ${d.output_dir}</a></div>`;
    } else if (d.last_config && d.last_config.name) {
      // Idle: show last training summary
      const lc = d.last_config;
      html += `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${t('lastTraining','Last training')}: <b>${lc.name}</b></div>`;
      html += `<div style="font-size:12px;color:var(--text-tertiary)">${t('historyModel','Model')}: ${lc.model} · LR: ${lc.lr} · Dim: ${lc.dim} · Epochs: ${lc.epochs}</div>`;
    }
    if (d.has_error) html += `<div style="color:var(--danger);margin-top:8px">${d.error_msg || t('error', 'Training Error')}</div>`;
    html += '</div>';
    return html;
  },

  _gpuCard(gpu, t) {
    const vramPct = gpu.vram_total_mb > 0 ? gpu.vram_used_mb / gpu.vram_total_mb * 100 : 0;
    const vramGrade = vramPct > 90 ? 'high' : vramPct > 70 ? 'mid' : 'low';
    const loadPct = gpu.gpu_load_pct || 0;
    const loadGrade = loadPct > 80 ? 'high' : loadPct > 50 ? 'mid' : 'low';
    let html = `<div class="card card-gpu flex-1">
      <div class="card-header">${t('gpu', 'GPU')}</div>
      <div style="font-size:14px;font-weight:600;margin:4px 0">${gpu.name || 'GPU'}</div>`;
    html += `<div class="monitor-stat">${t('vramUsed', 'VRAM')}: <b class="${vramGrade}">${gpu.vram_used_mb} MB (${Math.round(vramPct)}%)</b> / ${gpu.vram_total_mb} MB</div>`;
    html += `<div class="monitor-bar-track"><div class="monitor-bar-fill ${vramGrade}" data-bar="vram" data-target="${vramPct}"></div></div>`;
    html += `<div class="monitor-stat" style="margin-top:8px">${t('gpuLoad', 'Load')}: <b class="${loadGrade}">${loadPct}%</b></div>`;
    html += `<div class="monitor-bar-track"><div class="monitor-bar-fill ${loadGrade}" data-bar="load" data-target="${loadPct}"></div></div>`;
    if (gpu.temperature_c != null) html += `<div style="font-size:12px;margin-top:6px">${t('gpuTemp', 'Temp')}: <b>${gpu.temperature_c}&deg;C</b></div>`;
    if (gpu.power_w != null) html += `<div style="font-size:12px">${t('gpuPower', 'Power')}: <b>${gpu.power_w}W</b></div>`;
    html += '</div>';
    return html;
  },

  _systemCard(sys, t) {
    const cpuGrade = sys.cpu_pct > 80 ? 'high' : sys.cpu_pct > 50 ? 'mid' : 'low';
    const ramGrade = sys.ram_pct > 80 ? 'high' : sys.ram_pct > 50 ? 'mid' : 'low';
    let html = `<div class="card card-system flex-1">
      <div class="card-header">${t('system', 'System')}</div>`;
    if (sys.cpu_name) html += `<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${sys.cpu_name}</div>`;
    html += `<div class="monitor-stat">${t('cpu', 'CPU')}: <b class="${cpuGrade}">${sys.cpu_pct}%</b></div>`;
    html += `<div class="monitor-bar-track"><div class="monitor-bar-fill ${cpuGrade}" data-bar="cpu" data-target="${sys.cpu_pct}"></div></div>`;
    html += `<div class="monitor-stat" style="margin-top:8px">${t('ram', 'RAM')}: <b class="${ramGrade}">${sys.ram_used_gb} GB (${sys.ram_pct}%)</b> / ${sys.ram_total_gb} GB</div>`;
    html += `<div class="monitor-bar-track"><div class="monitor-bar-fill ${ramGrade}" data-bar="ram" data-target="${sys.ram_pct}"></div></div>`;
    html += '</div>';
    return html;
  },

  _drawCharts() {
    this.lossSeries.forEach(s => {
      const id = 'chart-' + s.tag.replace(/[/.]/g, '-');
      const c = document.getElementById(id);
      if (!c || !s.points || s.points.length < 2) return;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      ctx.clearRect(0, 0, W, H);

      const xs = s.points.map(p => p.step);
      const ys = s.points.map(p => p.value);
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const yMin = Math.min(...ys), yMax = Math.max(...ys);
      const pad = { t: 16, r: 16, b: 28, l: 48 };
      const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;

      const sx = (x) => pad.l + (x - xMin) / (xMax - xMin || 1) * pw;
      const sy = (y) => pad.t + (yMax - y) / (yMax - yMin || 1) * ph;

      // Grid lines
      ctx.strokeStyle = 'var(--border-color, #333)';
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= 4; i++) {
        const y = pad.t + i * ph / 4;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
        ctx.fillStyle = 'var(--text-tertiary, #888)';
        ctx.font = '10px monospace';
        ctx.fillText((yMax - i * (yMax - yMin) / 4).toFixed(4), 2, y + 3);
      }

      // Line with gradient
      const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
      grad.addColorStop(0, 'rgba(139, 92, 246, 0.3)');
      grad.addColorStop(1, 'rgba(139, 92, 246, 0.02)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(sx(xs[0]), H - pad.b);
      s.points.forEach((p) => ctx.lineTo(sx(p.step), sy(p.value)));
      ctx.lineTo(sx(xs[xs.length - 1]), H - pad.b);
      ctx.closePath();
      ctx.fill();

      // Line
      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = sx(p.step), y = sy(p.value);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Last point dot
      const last = s.points[s.points.length - 1];
      ctx.fillStyle = '#8b5cf6';
      ctx.beginPath();
      ctx.arc(sx(last.step), sy(last.value), 4, 0, Math.PI * 2);
      ctx.fill();

      // Store data for hover tooltip
      c._chartData = { s, sx, sy, pad };
      c.style.cursor = 'crosshair';
      if (!c._hasHover) {
        c._hasHover = true;
        c.addEventListener('mousemove', (ev) => {
          const rect = c.getBoundingClientRect();
          const mx = ev.clientX - rect.left;
          const my = ev.clientY - rect.top;
          const data = c._chartData;
          if (!data || !data.s.points.length) return;
          // Find nearest point
          let best = data.s.points[0], bestDist = Infinity;
          data.s.points.forEach(p => {
            const dx = data.sx(p.step) - mx, dy = data.sy(p.value) - my;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; best = p; }
          });
          c.title = `Step: ${best.step}  Value: ${best.value.toFixed(6)}`;
        });
        c.addEventListener('mouseleave', () => { c.title = ''; });
      }
    });
  },

  // ═══════════════════════════════════════════════════════
  //  Logs
  // ═══════════════════════════════════════════════════════

  renderLogs() {
    const el = document.getElementById('monitorLogs');
    if (!el) return;
    const t = (k, fb) => this.t('monitor.' + k) || fb || k;
    if (!this.logLines.length) {
      el.innerHTML = '<div class="dashboard-empty" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>'+t('noTrainingHint','No logs yet')+'</p></div>';
      return;
    }
    const search = (this.logSearch || '').toLowerCase();
    const errorsOnly = this.logErrorsOnly;
    let lines = this.logLines;
    if (search) lines = lines.filter(l => l.toLowerCase().includes(search));
    if (errorsOnly) lines = lines.filter(l => l.toLowerCase().includes('error') || l.toLowerCase().includes('traceback'));
    
    let html = '<div class="log-lines">';
    if (!lines.length) {
      html += '<div class="dashboard-empty" style="padding:20px"><p>' + t('noResults','No matching lines') + '</p></div>';
    } else {
      lines.forEach(line => {
        const lower = line.toLowerCase();
        const cls = lower.includes('error') || lower.includes('traceback') ? 'log-error' :
                    lower.includes('warning') ? 'log-warn' : '';
        html += `<div class="log-line ${cls}">${this._escapeHtml(line)}</div>`;
      });
    }
    html += '</div>';
    el.innerHTML = html;
    if (this.logAutoScroll) el.scrollTop = el.scrollHeight;
  },

  copyLogs() {
    const text = this.logLines.join('\n');
    navigator.clipboard.writeText(text).then(() => alert('Copied'));
  },

  clearLogs() { this.logLines = []; this.renderLogs(); },

  _escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  },

  // ═══════════════════════════════════════════════════════
  //  History
  // ═══════════════════════════════════════════════════════

  async loadHistory() {
    try {
      const r = await fetch('/api/monitor/history');
      const j = await r.json();
      if (j.status === 'success') {
        this.historyItems = j.data || [];
        this.renderHistory();
      }
    } catch (e) {
      console.warn('Failed to load history:', e);
    } finally {
      this.finishProgress();
    }
  },

  renderHistory() {
    const el = document.getElementById('historyList');
    if (!el) return;
    const t = (k, fb) => this.t('monitor.' + k) || fb || k;
    if (!this.historyItems.length) {
      el.innerHTML = '<div class="dashboard-empty" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><p>'+t('historyNoRecords','No training history')+'</p><p style="font-size:12px;color:var(--text-tertiary);margin-top:4px">'+t('historyWillAppear','Records will appear after training')+'</p></div>';
      return;
    }
    let html = '<div class="history-grid">';
    this.historyItems.forEach(h => {
      html += `<div class="card history-card">
        <div class="card-header">${h.time}</div>
        <div><b>${h.name}</b></div>
        <div style="font-size:12px;color:var(--text-secondary)">${t('historyModel','Model')}: ${h.model}</div>
        <div style="font-size:12px;color:var(--text-secondary)">${t('historyLR','LR')}: ${h.lr} · ${t('historyDim','Dim')}: ${h.dim} · ${t('historyEpochs','Epochs')}: ${h.epochs}</div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">${h.config_file}</div>
      </div>`;
    });
    html += '</div>';
    el.innerHTML = html;
  },
};
