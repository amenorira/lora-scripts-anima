/* LyCORIS network configuration panel and native configuration preview.
 * Composed into trainingCoreMixin with property descriptors intact.
 */
window.trainingNetworkPanel = {
  lycorisModalOpen: false,
  renderLycorisPanel() {
    const root = document.getElementById('lycorisConfigContent');
    if (!root) return;
    const trainType = this.form.model_train_type || 'anima-lora';
    const sections = window.getVisibleSections(trainType) || [];
    const fields = sections.flatMap(section => (section.fields || []))
      .filter(field => !field.hidden && field.lycorisGroup);
    const groups = [
      ['basic', 'field.lycorisGroupBasic'],
      ['regularization', 'field.lycorisGroupRegularization'],
      ['algorithm', 'field.lycorisGroupAlgorithm'],
      ['advanced', 'field.lycorisGroupAdvanced'],
    ];
    let html = '<div class="lycoris-panel-fields">';
    groups.forEach(([group, titleKey]) => {
      const grouped = fields.filter(field => field.lycorisGroup === group)
        .sort((a, b) => (a.lycorisOrder || 0) - (b.lycorisOrder || 0));
      if (!grouped.length) return;
      html += `<section class="lycoris-field-group"><div class="lycoris-field-group-title">${this.esc(this.t(titleKey))}</div>`;
      const groupedKeys = new Set(grouped.map(gf => gf.key));
      grouped.forEach(field => {
        // 同组内可见的布局父字段（如 dora_wd → wd_on_output）保留子项层级缩进；
        // 布局父不在本组渲染的字段（如依赖 lycoris_algo 的跨组参数）保持平级。
        const layoutParent = this._fieldLayoutParentKey(field, groupedKeys) || null;
        const panelField = {
          ...field,
          layoutParent,
          lycorisPanel: true,
          hintKey: field.hintKeyPanel || field.hintKey,
        };
        if (!layoutParent) panelField.nested = false;
        html += this.renderField(panelField);
      });
      html += '</section>';
    });
    html += '</div>';
    this._replaceTrainingFormHtml(root, html);
    this._syncAllConditionalFields();
  },

  openLycorisConfig() {
    if (this.form.network_module !== 'lycoris.kohya') return;
    this._openManagedModal('lycorisModalOpen', () => {
      this.renderLycorisPanel();
    });
  },

  closeLycorisConfig() {
    this._closeManagedModal('lycorisModalOpen');
  },

  lycorisSummary() {
    if (this.form.network_module !== 'lycoris.kohya') return '';
    const algo = this.form.lycoris_algo || 'lora';
    const preset = this.form.model_train_type === 'krea2-lora'
      ? this.t(`opt.krea_target_${this.form.krea_target_mode || 'all'}`)
      : (this.form.lycoris_preset || 'full');
    const rank = this.form.network_dim ?? '—';
    const alpha = this.form.network_alpha ?? '—';
    // dora_wd 切换算法后可能残留 true，但实际仅 lora/loha/lokr 消费（adapter 会 pop），摘要需同门控
    const dora = this.form.dora_wd === true && ['lora', 'loha', 'lokr'].includes(String(algo)) ? ' · DoRA' : '';
    const algoLabel = this._lycorisAlgoLabel(algo);
    return `${algoLabel} · ${preset} · Rank ${rank} · Alpha ${alpha}${dora}`;
  },

  // Algo select options carry a per-value i18n key (opt.lycoris_algo_*); the
  // raw value ("lora") is a TOML literal and would confuse users who only see
  // localized labels ("LoCon") in the dropdown.
  _lycorisAlgoLabel(value) {
    const defs = (window.getVisibleSections(this.form.model_train_type || 'anima-lora') || [])
      .flatMap(section => section.fields || []);
    const field = defs.find(item => item.key === 'lycoris_algo');
    const option = (field?.options || []).find(item => item.v === value);
    return option ? this.t(option.dk, option.l || value) : (value || '');
  },
  // LyCORIS 面板字段在主表单渲染时追加"非 lycoris.kohya"条件：原生
  // networks.lora/loha/lokr 下这些字段留在主表单按各自 show_if 显示，
  // lycoris.kohya 下收进 LyCORIS 弹窗（弹窗内字段带 lycorisPanel 标记，不受此追加影响）。
  _lycorisMainFormConditions(field) {
    if (!field.lycorisGroup || field.lycorisPanel) return null;
    const mainOnly = { key: 'network_module', neq: 'lycoris.kohya' };
    const showIf = Array.isArray(field.showIf)
      ? field.showIf.concat(mainOnly)
      : (field.showIf ? [field.showIf, mainOnly] : (field.showIfAny ? undefined : [mainOnly]));
    const showIfAny = field.showIfAny
      ? field.showIfAny.map(group => group.concat(mainOnly))
      : field.showIfAny;
    return { showIf, showIfAny };
  },

  // LyCORIS preset files are root-level TOML documents (the kohya adapter
  // passes the selected preset name/path separately from network_args). Keep
  // this preview faithful to that schema while making the generated CLI
  // arguments explicit, so users can see both layers without changing merge
  // behavior.
  lycorisConfigPreview() {
    if (this.form.network_module !== 'lycoris.kohya') return '';
    const f = this.form;
    const algo = String(f.lycoris_algo || 'lora').toLowerCase();
    const lines = [`algo = "${algo}"`];
    if (f.model_train_type === 'krea2-lora') {
      lines.push(`krea_target_mode = ${JSON.stringify(f.krea_target_mode || 'all')}`);
      const fields = (window.getVisibleSections('krea2-lora') || []).flatMap(s => s.fields || []);
      for (const field of fields) {
        if (!this._fieldShowIfMet(field) || ['lycoris_algo', 'network_args_custom'].includes(field.key)) continue;
        if (!field.lycorisGroup && !['rank_dropout', 'module_dropout', 'krea_target_include', 'krea_target_exclude'].includes(field.key)) continue;
        const value = f[field.key];
        if (value === undefined || value === null || value === '') continue;
        lines.push(`${field.networkArg || field.key} = ${JSON.stringify(value)}`);
      }
      return lines.join('\n');
    }
    const preset = String(f.lycoris_preset || 'full');
    if (preset !== 'full') lines.push(`preset = "${preset}"`);
    if (f.lycoris_preset === 'attn-mlp' && f.lycoris_anima_sd_default === true) {
      // TOML 单引号字面量字符串不处理转义，反斜杠才会按原样进入正则模式；
      // 双引号基本字符串里的 \. 是非法 TOML 转义，加载预设文件会直接报错。
      lines.push(f.lycoris_anima_train_adaln === true
        ? "exclude_name = ['^x_embedder\\.', '^t_embedder\\.', '^final_layer\\.']"
        : "exclude_name = ['^x_embedder\\.', '^t_embedder\\.', '^final_layer\\.', '^blocks\\.[0-9]+\\.adaln_modulation_.*']");
    }
    const fields = [
      ['conv_dim', f.conv_dim], ['conv_alpha', f.conv_alpha],
      ['factor', f.lokr_factor], ['dropout', f.dropout],
      ['rank_dropout', f.rank_dropout], ['module_dropout', f.module_dropout],
    ];
    fields.forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) return;
      if (key === 'factor' && algo !== 'lokr') return;
      const field = (window.getVisibleSections(this.form.model_train_type || 'anima-lora') || [])
        .flatMap(section => section.fields || []).find(item => item.key === key);
      if (field?.default !== undefined && String(value) === String(field.default)) return;
      lines.push(`${key} = ${value}`);
    });
    const bools = [
      ['enable_conv', f.conv_dim !== '' && f.conv_dim !== null && f.conv_dim !== undefined],
      ['use_tucker', f.use_tucker], ['use_scalar', f.use_scalar],
      ['decompose_both', f.decompose_both], ['full_matrix', f.full_matrix],
      ['train_norm', f.train_norm], ['weight_decompose', f.dora_wd],
      ['wd_on_output', f.wd_on_output],
      ['bypass_mode', f.bypass_mode], ['rs_lora', f.rs_lora],
      ['unbalanced_factorization', f.unbalanced_factorization],
      ['train_llm_adapter', f.train_llm_adapter],
    ];
    const DORA_OK_ALGOS = ['lora', 'loha', 'lokr'];
    bools.forEach(([key, value]) => {
      if (key === 'wd_on_output') {
        // wd_on_output 默认即 true：仅当用户显式关闭（false）且 DoRA 生效时才写出，
        // 避免默认值恒显噪音（与 adapter.py 对 dora_wd/wd_on_output 的过滤一致）。
        if (value !== false || !f.dora_wd || !DORA_OK_ALGOS.includes(algo)) return;
        lines.push('wd_on_output = false');
        return;
      }
      if (!value) return;
      if (key === 'weight_decompose' && !DORA_OK_ALGOS.includes(algo)) return;
      if (['use_tucker', 'use_scalar', 'rs_lora'].includes(key) && !['lora', 'loha', 'lokr'].includes(algo)) return;
      if (['decompose_both', 'full_matrix', 'unbalanced_factorization'].includes(key) && algo !== 'lokr') return;
      lines.push(`${key} = true`);
    });
    return lines.join('\n');
  },

  lycorisConfigPreviewHtml() {
    const raw = this.lycorisConfigPreview();
    if (!raw) return '';
    return typeof this._highlightToml === 'function'
      ? this._highlightToml(raw.split('\n'))
      : this.esc(raw);
  },

  lycorisConfigNotes() {
    const f = this.form;
    const notes = [];
    if (f.lycoris_algo === 'lokr' && f.full_matrix) notes.push(this.t('field.lycorisNoteFullMatrixFactor'));
    if (f.train_llm_adapter) notes.push(this.t('field.lycorisNoteTrainLlmAdapter'));
    // Full Matrix 的自动触发条件取决于每一层经过 factor 分解后的尺寸，
    // 前端没有完整模型结构时不能用固定 rank（例如 16）做静态判定。
    if (f.lycoris_algo === 'lokr' && Number(f.network_dim || 0) > 0) notes.push(this.t(
      f.model_train_type === 'krea2-lora' ? 'field.krea_lokr_rankHint' : 'field.lycorisNoteDimFullMatrix'));
    return notes.join('\n');
  },
};
