/* Shared resource bar. Selection and updates belong to the calling workspace. */
window.resourceBar = {
  esc: window.utilsMixin.esc,
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
      html += '<select class="m-gpu-select" data-resource-gpu aria-label="GPU">';
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

  render(containerId, {gpu, sys, t, locale, selectedGpuIndex = 0, onSelect}) {
    const bar = document.getElementById(containerId);
    if (!bar) return;
    if (gpu && gpu.gpus && gpu.gpus.length) {
      const device = gpu.gpus.find(item => item.index === selectedGpuIndex) || gpu.gpus[0];
      gpu = Object.assign({}, device, { gpus: gpu.gpus });
    }
    const localeKey = String(locale || '') + ':' + String(sys && sys.cpu_name || '') + ':' + JSON.stringify(gpu ? [gpu.index, gpu.name, gpu.temperature_c != null, gpu.power_w != null, (gpu.gpus || []).map(g => [g.index, g.name])] : null);
    if (!bar.firstElementChild || bar.dataset.locale !== localeKey) {
      bar.dataset.locale = localeKey;
      bar.innerHTML = this._resbarHtml(gpu, sys, t);
    }
    this._patchResbar(gpu, sys, t, containerId);
    const selector = bar.querySelector('[data-resource-gpu]');
    if (selector) selector.onchange = event => onSelect?.(Number(event.target.value));
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
};
