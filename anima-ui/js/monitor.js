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
  historyItems: [],
  logAutoScroll: true,
  logLines: [],
  logMaxLines: 5000,

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

    html += '<div class="card" style="margin-top:12px"><div class="card-header">' + t('trainParams', 'Training Parameters') + '</div>';
    if (this.trainParams.length) {
      html += '<div class="param-grid">';
      this.trainParams.forEach(p => {
        html += `<div class="param-item"><span class="param-label">${p.label}</span><span class="param-value">${p.value}</span></div>`;
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty">' + t('noTrainingHint', 'Start training to see data') + '</div>';
    }
    html += '</div>';

    html += '<div class="card" style="margin-top:12px"><div class="card-header">' + t('lossCurve', 'Loss / LR Curves') + '</div>';
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

    html += '<div class="card" style="margin-top:12px"><div class="card-header">' + t('previewSamples', 'Preview Samples') + '</div>';
    if (this.previews.length) {
      html += '<div class="preview-grid">';
      this.previews.forEach(p => {
        html += `<div class="preview-item"><img src="${p.url}" alt="${p.name}" loading="lazy" onclick="window.open('${p.url}')"/><span>${p.name}</span></div>`;
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty">' + t('noTrainingHint', 'Start training to see data') + '</div>';
    }
    html += '</div>';

    html += '</div>';
    el.innerHTML = html;

    const bars = el.querySelectorAll('.monitor-bar-fill[data-bar]');
    bars.forEach(bar => {
      const key = bar.dataset.bar;
      const prev = firstRender ? 0 : (prevBars[key] != null ? prevBars[key] : 0);
      bar.style.width = prev + '%';
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bars.forEach(bar => {
          bar.style.width = bar.dataset.target + '%';
        });
      });
    });

    setTimeout(() => this._drawCharts(), 100);
  },

  _statusCard(d, t) {
    const stateCode = d.state || 'IDLE';
    const stateLabels = { 'RUNNING': t('training','Training'), 'FINISHED': t('finished','Finished'), 'TERMINATED': t('terminated','Terminated'), 'CREATED': t('created','Pending'), 'IDLE': t('idle','Idle') };
    const state = stateLabels[stateCode] || stateCode;
    const isTraining = stateCode === 'RUNNING';
    const color = isTraining ? 'var(--success)' : (d.has_error ? 'var(--danger)' : 'var(--text-secondary)');
    let html = `<div class="card flex-1">
      <div class="card-header">${t('status', 'Training Status')}</div>
      <div style="font-size:20px;font-weight:700;color:${color};margin:8px 0">${state}</div>`;
    if (isTraining) {
      if (d.step) html += `<div>${t('step', 'Steps')}: <b>${d.step}</b> / ${d.total_steps} (${d.percent}%)</div>`;
      if (d.loss) html += `<div>${t('loss', 'Loss')}: <b>${d.loss}</b></div>`;
      if (d.lr) html += `<div>${t('lr', 'LR')}: <b>${d.lr}</b></div>`;
      if (d.epoch) html += `<div>${t('epoch', 'Epoch')}: <b>${d.epoch}</b></div>`;
      if (d.speed) html += `<div>${t('speed', 'Speed')}: <b>${d.speed}</b></div>`;
      if (d.eta) html += `<div>ETA: <b>${d.eta}</b></div>`;
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
    let html = `<div class="card flex-1">
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
    let html = `<div class="card flex-1">
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

      ctx.strokeStyle = 'var(--border-color, #333)';
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= 4; i++) {
        const y = pad.t + i * ph / 4;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
        ctx.fillStyle = 'var(--text-tertiary, #888)';
        ctx.font = '10px monospace';
        ctx.fillText((yMax - i * (yMax - yMin) / 4).toFixed(4), 2, y + 3);
      }

      ctx.strokeStyle = '#8b5cf6';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = sx(p.step), y = sy(p.value);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      const last = s.points[s.points.length - 1];
      ctx.fillStyle = '#8b5cf6';
      ctx.beginPath();
      ctx.arc(sx(last.step), sy(last.value), 4, 0, Math.PI * 2);
      ctx.fill();
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
      el.innerHTML = '<div class="dashboard-empty" style="padding:40px"><p>'+t('noTrainingHint','No logs yet')+'</p></div>';
      return;
    }
    let html = '<div class="log-lines">';
    this.logLines.forEach(line => {
      const lower = line.toLowerCase();
      const cls = lower.includes('error') || lower.includes('traceback') ? 'log-error' :
                  lower.includes('warning') ? 'log-warn' : '';
      html += `<div class="log-line ${cls}">${this._escapeHtml(line)}</div>`;
    });
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
      el.innerHTML = '<div class="dashboard-empty" style="padding:40px"><p>'+t('historyNoRecords','No training history')+'</p><p style="font-size:12px;color:var(--text-tertiary);margin-top:4px">'+t('historyWillAppear','Records will appear after training')+'</p></div>';
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
