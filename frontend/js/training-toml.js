/* ================================================================
   training-toml.js — TOML generation, Training start/stop
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.trainingTomlMixin = {
  tomlRaw: '',
  tomlHighlighted: '',
  isTraining: false,
  trainingStarting: false,
  isIdle: true,
  taskId: null,
  statusText: 'Idle',
  _tomlDebounceTimer: null,
  _tomlPreviewIdleHandle: null,
  _tomlPreviewChangedKey: '',
  _tomlPreviewScrollFrame: null,
  _tomlPreviewUserScrollUntil: 0,

  // ── TOML ────────────────────────────────────────────────
  // 按表单分组顺序（getVisibleSections 返回 registry section_order + 字段顺序）
  // 生成 TOML 行，使预览顺序 == 参数设置面板顺序。network_args 插在 network 分组后，
  // optimizer_args 插在 optimizer 分组后。omitDefault 字段在值==默认值时跳过（不显示/不传）。
  updateToml() {
    const trainType = this.form.model_train_type || 'anima-lora';
    if (trainType === 'krea2-lora') {
      this._updateKrea2Toml();
      return;
    }
    // Export the effective settings after imports, undo and field resets as well.
    this._enforceImageAugmentationUiConstraints();
    const allSections = window.getVisibleSections(trainType);
    const fieldByKey = new Map(
      allSections.flatMap(section => (section.fields || []).map(field => [field.key, field]))
    );

    // Collect which LyCORIS UI fields are active (visible in form based on showIf/showIfAny)
    const activeLycorisKeys = new Set();
    const networkModule = this.form.network_module || '';
    const isKohya = networkModule === 'lycoris.kohya';

    // 参数映射和字段目标由后端注册表提供，预览与训练共用同一份定义。

    // 分组桶：key=sectionKey → value=行数组。按 allSections 顺序填充再拼接，保证预览==表单顺序。
    const sectionLines = {};
    allSections.forEach(s => { sectionLines[s.key] = []; });

    const pushLine = (sectionKey, line) => {
      if (sectionLines[sectionKey]) sectionLines[sectionKey].push(line);
    };

    // Portable configs need to retain the application profile selector. The
    // backend consumes it for core routing and filters it before trainer launch.
    pushLine('model', `model_train_type = "${trainType}"`);

    // 遍历 sections → fields，按表单同序处理
    for (const section of allSections) {
      for (const f of (section.fields || [])) {
        const k = f.key;
        if (f.hidden) continue;
        if (!this._fieldShowIfMet(f)) continue;
        if (k === 'sample_prompts' || k.startsWith('_')) continue;

        const v = this.form[k];
        if (v === '' || v === null || v === undefined) continue;

        // omitDefault：值==默认值时不传/不显示（仅 registry default == sd-scripts default 的字段标记）
        if (f.omitDefault && f.default !== undefined && String(v) === String(f.default)) continue;

        // Collect LyCORIS UI fields for network_args formatting
        if (f.networkArg && f.networkModules.includes(networkModule)) {
          activeLycorisKeys.add(k);
          continue; // not added as top-level line
        }

        if (f.target && f.target !== 'toml') continue;

        if (typeof v === 'boolean') { pushLine(section.key, `${k} = ${v}`); }
        else if (typeof v === 'number') { pushLine(section.key, `${k} = ${v}`); }
        else {
          const coerced = (f.valueType || f.type) === 'number' ? this._coerceNum(v) : v;
          if (coerced !== v) { pushLine(section.key, `${k} = ${coerced}`); }
          else { pushLine(section.key, `${k} = "${String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`); }
        }
      }
    }

    // ── Build network_args（插在 network 分组末尾）──────────────
    const LORAPLUS_ARG_KEYS = [
      'loraplus_lr_ratio',
      'loraplus_unet_lr_ratio',
      'loraplus_text_encoder_lr_ratio',
    ];
    const isManagedLoraplusArg = item => {
      const key = String(item).split('=', 1)[0].trim();
      return LORAPLUS_ARG_KEYS.includes(key);
    };
    const netArgsArr = [];
    const netCustom = this.form.network_args_custom;
    if (netCustom && typeof netCustom === 'string') {
      netArgsArr.push(...netCustom.split('\n').map(s => s.trim()).filter(s => s && !isManagedLoraplusArg(s)));
    }
    // AdaLN 调制层开关（Anima）→ include_patterns，与 adapter.py 2.6 节一致：
    // 用户在 network_args_custom 手写的同 key 项必须并集合成单条，
    // 否则 sd-scripts 端 net_kwargs 同 key 后者覆盖前者，会静默丢一边。
    const ADALN_INCLUDE_PATTERN = '.*(adaln_modulation_cross_attn|adaln_modulation_mlp|adaln_modulation_self_attn).*';
    const adalnField = fieldByKey.get('train_adaln');
    if (this.form.train_adaln === true && adalnField && this._fieldShowIfMet(adalnField)) {
      const idx = netArgsArr.findIndex(item => String(item).split('=', 1)[0].trim() === 'include_patterns');
      let patterns = [];
      if (idx >= 0) {
        const raw = String(netArgsArr.splice(idx, 1)[0]).split('=').slice(1).join('=').trim();
        const quoted = [...raw.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map(m => (m[1] !== undefined ? m[1] : m[2]));
        patterns = quoted.length > 0 ? quoted : (raw ? [raw] : []);
      }
      if (!patterns.includes(ADALN_INCLUDE_PATTERN)) patterns.push(ADALN_INCLUDE_PATTERN);
      const literal = '[' + patterns.map(p => `'${String(p).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ') + ']';
      netArgsArr.push(`include_patterns=${literal}`);
    }
    // LyCORIS UI fields → key=value
    for (const k of activeLycorisKeys) {
      const v = this.form[k];
      // 与 adapter.py _is_empty_value 对齐：跳过 None/undefined/空串/NaN。
      // 注意：布尔 False 不跳过（adapter 明确"toggle 关闭时应显式传入 false"）。
      // 默认值已在收集阶段（omitDefault）过滤，此处剩下的都是用户显式设置的非默认值。
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number' && isNaN(v)) continue;
      const argKey = fieldByKey.get(k).networkArg;
      const val = typeof v === 'boolean' ? String(v).toLowerCase() : String(v);
      netArgsArr.push(`${argKey}=${val}`);
    }
    // lycoris_anima_* 是 UI-only：上游 LyCORIS 只在预设文件里消费 exclude_name
    // （create_network 无 kwargs 支持），运行时由后端把内置预设全集 + 排除规则生成
    // 匿名预设文件并以 preset=<文件路径> 生效。导出的 network_args 保持 preset=<名称>。
    // 排除规则在 LyCORIS 面板预览（lycorisConfigPreview）中可见。
    if (netArgsArr.length > 0) {
      const quoted = netArgsArr.map(s => `"${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`).join(', ');
      pushLine('network', `network_args = [${quoted}]`);
    }
    // 排除规则不进 network_args（上游只在预设文件里读 exclude_name，运行时由后端
    // 生成匿名预设文件注入），在 network_args 下方以注释形式展示，便于查看。
    if (isKohya && this.form.lycoris_preset === 'attn-mlp' && this.form.lycoris_anima_sd_default === true) {
      pushLine('network', this.form.lycoris_anima_train_adaln === true
        ? "# exclude_name = ['^x_embedder\\.', '^t_embedder\\.', '^final_layer\\.']"
        : "# exclude_name = ['^x_embedder\\.', '^t_embedder\\.', '^final_layer\\.', '^blocks\\.[0-9]+\\.adaln_modulation_.*']");
    }

    // ── Build optimizer_args（插在 optimizer 分组末尾）──────────
    const optArgsArr = this._buildOptimizerArgs(this.form);
    if (optArgsArr.length > 0) {
      const quoted = optArgsArr.map(s => `"${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`).join(', ');
      pushLine('optimizer', `optimizer_args = [${quoted}]`);
    }

    // ── 按 section_order 拼接所有分组行 ─────────────────────────
    const lines = this._groupTomlSectionLines(allSections, sectionLines);

    this.tomlRaw = lines.join('\n') || '# ' + this.t('common.noConfigs');
    this._renderTomlPreview(lines, this.t('common.noConfigs'));
  },

  // Keep all training-core previews on one renderer.  Krea 2 has a
  // copyable application preset rather than musubi's runtime TOMLs, but it
  // should still look exactly like the SDXL/Anima TOML preview.
  _highlightToml(lines) {
    return lines.map(line => {
      if (line === '') {
        return '<span class="toml-line toml-line-empty" aria-hidden="true">&nbsp;</span>';
      }
      if (line.startsWith('#')) {
        return `<span class="toml-line"><span class="toml-line-content toml-comment">${this.esc(line)}</span></span>`;
      }
      const eq = line.indexOf('=');
      if (eq === -1) {
        return `<span class="toml-line"><span class="toml-line-content">${this.esc(line)}</span></span>`;
      }
      const key = line.substring(0, eq).trim();
      const val = line.substring(eq + 1).trim();
      return `<span class="toml-line" data-param-key="${this._tomlEscapeAttr(key)}"><span class="toml-line-content"><span class="toml-key">${this.esc(key)}</span> <span class="toml-eq">=</span> ${this._highlightTomlValue(key, val)}</span></span>`;
    }).join('');
  },

  _highlightTomlValue(key, value) {
    if ((key === 'network_args' || key === 'optimizer_args') && value.startsWith('[')) {
      const parts = [];
      const pattern = /"((?:\\.|[^"\\])*)"/g;
      let cursor = 0;
      let match;
      while ((match = pattern.exec(value)) !== null) {
        if (match.index > cursor) {
          parts.push(`<span class="toml-num">${this.esc(value.slice(cursor, match.index))}</span>`);
        }
        const argKey = String(match[1]).split('=', 1)[0].trim();
        parts.push(`<span class="toml-arg-token toml-str" data-toml-arg-key="${this._tomlEscapeAttr(argKey)}">${this.esc(match[0])}</span>`);
        cursor = pattern.lastIndex;
      }
      if (cursor > 0) {
        if (cursor < value.length) {
          parts.push(`<span class="toml-num">${this.esc(value.slice(cursor))}</span>`);
        }
        return parts.join('');
      }
    }
    const valueClass = (value.startsWith('"') || value.startsWith("'")) ? 'toml-str' : 'toml-num';
    return `<span class="${valueClass}">${this.esc(value)}</span>`;
  },

  _tomlEscapeAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  queueTomlPreviewChange(key) {
    this._tomlPreviewChangedKey = String(key || '');
  },

  _tomlPreviewOutputKey(key) {
    const sourceKey = String(key || '');
    if (String(this.form && this.form.model_train_type || '') === 'krea2-lora') return sourceKey;
    const argTarget = this._tomlPreviewArgTarget(sourceKey);
    if (argTarget) return argTarget.paramKey;
    if (sourceKey === 'network_args_custom' || sourceKey === 'enable_loraplus' || sourceKey === 'train_adaln') return 'network_args';
    if (sourceKey === 'optimizer_args_custom') return 'optimizer_args';
    return sourceKey;
  },

  _tomlPreviewArgTarget(key) {
    if (String(this.form && this.form.model_train_type || '') === 'krea2-lora') return null;
    const field = this.findFieldDef(key);
    if (field?.networkArg) return { paramKey: 'network_args', argKey: field.networkArg };
    if (field?.argKey) return { paramKey: 'optimizer_args', argKey: field.argKey };
    return null;
  },

  _tomlParamValues(preview) {
    const values = new Map();
    if (!preview || typeof preview.querySelectorAll !== 'function') return values;
    preview.querySelectorAll('[data-param-key]').forEach(line => {
      values.set(String(line.dataset.paramKey || ''), String(line.textContent || ''));
    });
    return values;
  },

  _bindTomlPreviewInteraction(preview) {
    if (!preview || preview._tomlInteractionBound || typeof preview.addEventListener !== 'function') return;
    const noteUserScroll = () => {
      this._tomlPreviewUserScrollUntil = Date.now() + 1800;
      if (this._tomlPreviewScrollFrame !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(this._tomlPreviewScrollFrame);
        this._tomlPreviewScrollFrame = null;
      }
    };
    preview.addEventListener('wheel', noteUserScroll, { passive: true });
    preview.addEventListener('touchstart', noteUserScroll, { passive: true });
    preview.addEventListener('pointerdown', noteUserScroll, { passive: true });
    preview._tomlInteractionBound = true;
  },

  _tomlArgToken(line, argKey) {
    if (!line || !argKey || typeof line.querySelectorAll !== 'function') return null;
    const matches = Array.from(line.querySelectorAll('[data-toml-arg-key]'))
      .filter(item => String(item.dataset.tomlArgKey || '') === String(argKey));
    return matches.length > 0 ? matches[matches.length - 1] : null;
  },

  _flashTomlLine(line, argKey = '') {
    if (!line || typeof line.querySelector !== 'function') return;
    const content = argKey ? this._tomlArgToken(line, argKey) : line.querySelector('.toml-line-content');
    if (!content || !content.classList) return;
    content.classList.remove('toml-change-flash');
    void content.offsetWidth;
    content.classList.add('toml-change-flash');
  },

  _scrollTomlPreview(preview, targetTop, onComplete) {
    const maxTop = Math.max(0, preview.scrollHeight - preview.clientHeight);
    const destination = Math.min(maxTop, Math.max(0, targetTop));
    const start = Number(preview.scrollTop || 0);
    const distance = destination - start;
    const reduceMotion = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || Math.abs(distance) < 2 || typeof window.requestAnimationFrame !== 'function') {
      preview.scrollTop = destination;
      onComplete();
      return;
    }

    if (this._tomlPreviewScrollFrame !== null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(this._tomlPreviewScrollFrame);
    }
    const duration = Math.min(420, 260 + Math.abs(distance) * 0.08);
    let startedAt = null;
    const tick = timestamp => {
      if (startedAt === null) startedAt = timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      preview.scrollTop = start + distance * eased;
      if (progress < 1) {
        this._tomlPreviewScrollFrame = window.requestAnimationFrame(tick);
        return;
      }
      this._tomlPreviewScrollFrame = null;
      preview.scrollTop = destination;
      onComplete();
    };
    this._tomlPreviewScrollFrame = window.requestAnimationFrame(tick);
  },

  _revealTomlPreviewChange(preview, paramKey, argKey = '') {
    if (!preview || !paramKey || typeof preview.querySelectorAll !== 'function') return;
    const line = Array.from(preview.querySelectorAll('[data-param-key]'))
      .find(item => String(item.dataset.paramKey || '') === String(paramKey));
    if (!line || typeof line.getBoundingClientRect !== 'function') return;
    const target = argKey ? this._tomlArgToken(line, argKey) : line;
    if (!target || typeof target.getBoundingClientRect !== 'function') return;
    const previewRect = preview.getBoundingClientRect();
    const lineRect = target.getBoundingClientRect();
    const inset = 8;
    const visible = lineRect.top >= previewRect.top + inset
      && lineRect.bottom <= previewRect.bottom - inset;
    const flash = () => this._flashTomlLine(line, argKey);
    if (visible || Date.now() < this._tomlPreviewUserScrollUntil) {
      flash();
      return;
    }
    const lineMiddle = lineRect.top - previewRect.top + preview.scrollTop + lineRect.height / 2;
    const targetTop = lineMiddle - preview.clientHeight * 0.42;
    this._scrollTomlPreview(preview, targetTop, flash);
  },

  _renderTomlPreview(lines, emptyMessage = '') {
    const html = lines.length === 0
      ? `<span class="toml-comment"># ${this.esc(emptyMessage || this.t('common.noConfigs'))}</span>`
      : this._highlightToml(lines);
    this.tomlHighlighted = html;

    const applyPreview = () => {
      this._tomlPreviewIdleHandle = null;
      const preview = document.getElementById('tomlPreview');
      if (!preview) return;
      this._bindTomlPreviewInteraction(preview);
      const previousValues = preview._tomlParamValues || this._tomlParamValues(preview);
      if (preview._tomlSourceHtml !== this.tomlHighlighted) {
        preview.innerHTML = this.tomlHighlighted;
        preview._tomlSourceHtml = this.tomlHighlighted;
      }
      const nextValues = this._tomlParamValues(preview);
      preview._tomlParamValues = nextValues;

      const changedSourceKey = this._tomlPreviewChangedKey;
      this._tomlPreviewChangedKey = '';
      if (changedSourceKey) {
        const preferredKey = this._tomlPreviewOutputKey(changedSourceKey);
        const argTarget = this._tomlPreviewArgTarget(changedSourceKey);
        const changedKeys = Array.from(nextValues.keys()).filter(key =>
          !previousValues.has(key) || previousValues.get(key) !== nextValues.get(key)
        );
        const targetKey = changedKeys.includes(preferredKey) ? preferredKey : changedKeys[0];
        const targetArgKey = targetKey === preferredKey && argTarget ? argTarget.argKey : '';
        if (targetKey) this._revealTomlPreviewChange(preview, targetKey, targetArgKey);
      }
    };

    // 预览不参与训练参数计算，优先让类型下拉关闭和新表单完成首帧。
    // 非浏览器环境（单元测试）保持同步，便于确定性验证。
    if (typeof window.requestIdleCallback !== 'function') {
      applyPreview();
      return;
    }
    if (this._tomlPreviewIdleHandle !== null) {
      window.cancelIdleCallback(this._tomlPreviewIdleHandle);
    }
    this._tomlPreviewIdleHandle = window.requestIdleCallback(applyPreview, { timeout: 250 });
  },

  _groupTomlSectionLines(sections, sectionLines) {
    const lines = [];
    sections.forEach(section => {
      const grouped = sectionLines[section.key] || [];
      if (grouped.length === 0) return;
      if (lines.length > 0) lines.push('');
      lines.push(`# --- ${section.key} ---`, ...grouped);
    });
    return lines;
  },

  parameterPreviewTitle() {
    const trainType = String(this.form && this.form.model_train_type || 'anima-lora');
    const titleKeys = {
      'sdxl-lora': ['common.sdxlParameterPreview', 'SDXL Parameter Preview'],
      'anima-lora': ['common.animaParameterPreview', 'Anima Parameter Preview'],
      'krea2-lora': ['common.krea2ParameterPreview', 'Krea 2 Parameter Preview'],
    };
    const [key, fallback] = titleKeys[trainType] || ['common.tomlPreview', 'Parameter Preview'];
    return this.t(key, fallback);
  },

  _updateKrea2Toml() {
    // This is a portable application config. The backend writes musubi's
    // separate train and dataset TOMLs when the run is launched.
    const quote = (value) => '"' + String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r\n|\r|\n/g, '\\n') + '"';
    const valueToToml = (value, field) => {
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      const coerced = (field.valueType || field.type) === 'number' ? this._coerceNum(value) : value;
      if (typeof coerced === 'number' && Number.isFinite(coerced)) return String(coerced);
      return quote(value);
    };
    const sections = window.getVisibleSections('krea2-lora');
    const sectionLines = {};
    sections.forEach(section => { sectionLines[section.key] = []; });
    if (sectionLines.model) sectionLines.model.push('model_train_type = "krea2-lora"');

    sections.forEach(section => {
      (section.fields || []).forEach(field => {
        if (field.hidden || field.key === 'model_train_type' || !this._fieldShowIfMet(field)) return;
        const value = this.form[field.key];
        if (value === '' || value === null || value === undefined) return;
        sectionLines[section.key].push(`${field.key} = ${valueToToml(value, field)}`);
      });
    });

    const lines = this._groupTomlSectionLines(sections, sectionLines);
    this.tomlRaw = lines.join('\n');
    this._renderTomlPreview(lines);
  },

  // Debounced TOML update (for x-effect binding, avoids per-keystroke recalc)
  updateTomlDebounced() {
    clearTimeout(this._tomlDebounceTimer);
    this._tomlDebounceTimer = setTimeout(() => this.updateToml(), 250);
  },

  _collectTrainingPayload() {
    const profile = this.form.model_train_type || 'anima-lora';
    const payload = { model_train_type: profile };
    window.getVisibleSections(profile).forEach(section => {
      (section.fields || []).forEach(field => {
        if ((profile === 'krea2-lora' && field.hidden) || !this._fieldShowIfMet(field)) return;
        const value = this.form[field.key];
        if (value === '' || value === null || value === undefined) return;
        if (field.omitDefault && String(value) === String(field.default)) return;
        payload[field.key] = value;
      });
    });
    if (this.form.gpu_ids !== undefined && this.form.gpu_ids !== null) payload.gpu_ids = this.form.gpu_ids;
    return payload;
  },

  _collectTrainingFormSnapshot() {
    return JSON.parse(JSON.stringify(this.form));
  },

  // Helper: check if a field's showIf condition is met
  _fieldShowIfMet(f) {
    const sf = f.showIf;
    if (sf) {
      if (Array.isArray(sf)) {
        // Multi-condition AND: all conditions must match
        return sf.every(c => this._evalShowIfCond(c));
      }
      // Single condition
      return this._evalShowIfCond(sf);
    }
    if (f.showIfAny) {
      // OR-of-ANDs: 任一内层 AND 组全成立
      return f.showIfAny.some(group => group.every(c => this._evalShowIfCond(c)));
    }
    return true;
  },

  copyToml() {
    navigator.clipboard.writeText(this.tomlRaw).then(() => this.toast(this.t('common.copied')));
  },

  /**
   * Portable preview only. Submission keeps form fields; the backend owns merging.
   * Emit explicit values, including defaults, so library defaults cannot change them.
   */
  _buildOptimizerArgs(form) {
    const args = new Map();
    for (const line of (form.optimizer_args_custom || '').split('\n')) {
      const separator = line.indexOf('=');
      if (separator > 0) args.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    for (const section of window.getVisibleSections(form.model_train_type || 'anima-lora')) {
      for (const field of section.fields) {
        if (!field.argKey || !this._fieldShowIfMet(field)) continue;
        const val = form[field.key];
        if (val === undefined || val === null || val === '') continue;
        const defaultValue = field.optimizerDefaults?.[form.optimizer_type];
        const comparable = Array.isArray(defaultValue)
          ? String(val).replace(/[\[\]()]/g, '').split(',').filter(item => item.trim()).map(Number)
          : typeof defaultValue === 'number' ? Number(val) : val;
        const matchesDefault = Array.isArray(defaultValue)
          ? comparable.length === defaultValue.length && comparable.every((item, i) => item === defaultValue[i])
          : comparable === defaultValue;
        if (args.has(field.argKey) && matchesDefault) continue;
        const formatted = typeof val === 'boolean' ? (val ? 'True' : 'False')
          : field.type === 'select' ? JSON.stringify(val) : String(val);
        args.set(field.argKey, formatted);
      }
    }
    return Array.from(args, ([key, value]) => key + '=' + value);
  },

  // ── Krea 2 cache pipeline ──────────────────────────────
  async prepareKrea2Cache() {
    if (this.isTraining || this.trainingStarting || this.regularizationActive) return;
    if ((this.form.model_train_type || '') !== 'krea2-lora') return;
    if (!this.validateForm()) {
      this.toast(this.t('common.formErrors'), 'error');
      return;
    }

    this.trainingStarting = true;
    try {
      const response = await fetch('/api/training/krea2/cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._collectTrainingPayload()),
      });
      const data = await response.json();
      if (!response.ok || data.status !== 'success') {
        this.toast(data.message || 'Failed to prepare Krea 2 cache', 'error');
        return;
      }
      // 缓存任务也是托管任务：走同一条启动边界（清残留 + 订阅 + 轮询接管状态）。
      this._acceptTrainingStart(data.data, 'RUNNING');
      this.toast(this.t('krea2.cacheStarted'));
    } catch (error) {
      this.toast(this.t('common.requestFailed') + ': ' + error.message, 'error');
    } finally {
      this.trainingStarting = false;
    }
  },

  // ── Training ───────────────────────────────────────────
  async startTraining() {
    if (this.isTraining || this.trainingStarting || this.regularizationActive) return;

    // Form validation before starting
    if (!this.validateForm()) {
      this.toast(this.t('common.formErrors'), 'error');
      return;
    }

    this.trainingStarting = true;
    try {
      const outputPathInfo = await this.refreshOutputPathInfo(true);
      if (!outputPathInfo || !outputPathInfo.available || !outputPathInfo.writable || outputPathInfo.path_is_directory === false) {
        this.toast(this.outputPathBlockingText(), 'error');
        return;
      }

      const estimate = await this.refreshStepEstimate(true);
      if (!estimate) {
        this.toast(this.stepEstimateErrorText() || this.t('stepEstimate.failed'), 'error');
        return;
      }

      this.isTraining = true; this.isIdle = false;
      this.statusText = this.t('common.training') + '...';
      const payload = this._collectTrainingPayload();
      payload._form_state = this._collectTrainingFormSnapshot();
      // 一次性放行：用户在缓存过期弹窗里选择"使用旧缓存继续"后置位
      if (this._ignoreTeCacheWarnings) {
        payload.ignore_te_cache_warnings = true;
        this._ignoreTeCacheWarnings = false;
      }

      const resp = await fetch('/api/run', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      const data = await resp.json();
      if (!resp.ok || data.status !== 'success') {
        if (data.data && data.data.errorCode === 'teCacheStale') {
          this._showTeCacheStaleDialog(data.data.warnings || []);
        } else {
          this.toast(data.message || 'Failed', 'error');
        }
        this._applyTaskView('IDLE');
      }
      else {
        this._acceptTrainingStart(data.data); this.toast(this.t('common.trainingStarted'));
        // 弹出适配器警告（如有）
        const warnings = data.data && data.data.warnings;
        if (warnings && warnings.length > 0) {
          setTimeout(() => {
            const msg = warnings.join('\n');
            this.toast('⚠️ ' + this.t('common.adapterWarnings'));
            // 单按钮警告弹窗：必须看到（如 torch_compile 被自动关闭）再关闭
            this.openConfirm(this.t('common.adapterWarnings'), msg, null, this.t('common.acknowledge'), { notice: true });
          }, 500);
        }
      }
    } catch(e) {
      this.toast(this.t('common.requestFailed')+': '+e.message, 'error');
      this._applyTaskView('IDLE');
    } finally {
      this.trainingStarting = false;
    }
  },

  // ── TE 磁盘缓存过期弹窗：删除重建 或 按旧缓存继续 ──
  _showTeCacheStaleDialog(warnings) {
    // 后端只回 {code, 参数}，文案按当前语言渲染（{name} 占位符，同 stepEstimate 惯例）
    const lines = (warnings || [])
      .filter(w => w && w.code)
      .map(w => {
        let text = this.t(`teCache.warn.${w.code}`, '');
        Object.entries(w).forEach(([name, value]) => {
          if (name !== 'code') text = text.replaceAll(`{${name}}`, String(value));
        });
        return text;
      })
      .filter(Boolean);
    this.openConfirm(
      this.t('teCache.staleTitle'),
      lines.join('\n\n'),
      () => this._rebuildTeCacheAndStart(),
      this.t('teCache.rebuildStart'),
      { secondaryLabel: this.t('teCache.useOld'), secondaryCallback: () => this._startWithTeCacheOverride() }
    );
  },

  async _rebuildTeCacheAndStart() {
    const dirs = [this.form.train_data_dir];
    if (this.form.enable_reg_data && this.form.reg_data_dir) dirs.push(this.form.reg_data_dir);
    try {
      const resp = await fetch('/api/training/te-cache/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dirs: dirs.filter(Boolean) }),
      });
      const data = await resp.json();
      if (data.status !== 'success') {
        this.toast(data.message || this.t('teCache.deleteFailed'), 'error');
        return;
      }
    } catch (error) {
      this.toast(this.t('common.requestFailed') + ': ' + error.message, 'error');
      return;
    }
    void this.startTraining();
  },

  _startWithTeCacheOverride() {
    this._ignoreTeCacheWarnings = true;
    void this.startTraining();
  },

  _acceptTrainingStart(data, status) {
    const taskId = data && data.task_id || null;
    if (!taskId) {
      this._applyTaskView('IDLE');
      return false;
    }
    // 启动边界：清上一轮残留、认领任务并切换订阅；后续状态由轮询对账。
    this.beginLiveMonitorTask(taskId, status || 'CREATED');
    this.realtimeTaskStateUnknown = false;
    return true;
  },

  async stopTraining() {
    const taskId = this.liveTaskId || this.taskId;
    if (!taskId || (!this.isTraining && !this.trainingBlocked)) return;
    try {
      const response = await fetch('/api/tasks/terminate/' + encodeURIComponent(taskId));
      if (!response.ok) throw new Error('terminate failed');
      // 后端在 terminate 返回前就已把任务结算为 TERMINATED；立刻对账一次，
      // 终态由轮询写入方统一绘制（补一次轮询让它亚秒级可见）。
      void this._pollTrainingState();
    } catch(e) { this.toast(this.t('common.failed')+': '+e.message); }
  },

  resetRealtimeTrainingState() {
    const wasRunning = !!(this.isTraining || this.taskId || this.activeTaskId || this.trainingBlocked);
    this._applyTaskView(wasRunning ? 'UNKNOWN' : 'IDLE');
    return wasRunning;
  }
};
