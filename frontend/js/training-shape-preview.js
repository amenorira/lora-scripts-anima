// The backend constructs the actual training network with fake tensors.
// This mixin renders its per-module shapes and aggregate saved-weight estimate.
window.trainingShapePreviewMixin = {
  shapePreviewOpen: false,
  shapePreviewPreviousFocus: null,
  shapeEstimate: null,
  shapeEstimateError: '',
  shapeEstimateLoading: false,
  shapePreviewSelected: '',
  _shapeEstimateSignature: '',
  _shapeEstimateTimer: null,
  _shapeEstimateBusy: false,

  shapePreviewSupported() {
    return String((this.form && this.form.model_train_type) || '') === 'anima-lora';
  },

  // 入口按钮由 training-core.js 的 _getEnvHint('network_module') 追加到字段下方。
  _shapePreviewEntry() {
    if (!this.shapePreviewSupported()) return '';
    return `<div class="shape-preview-entry">
      <button type="button" class="btn btn-ghost btn-sm" @click="openShapePreview()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
        <span x-text="t('shapePreview.open')">Structure preview</span>
      </button>
      <span class="shape-estimate-summary" :title="shapeEstimateError" x-text="shapeEstimateSummary()"></span>
    </div>`;
  },

  _shapeEstimatePayload() {
    const payload = {};
    Object.entries(this.form || {}).forEach(([key, value]) => {
      if (key === 'qwen3') payload[key] = value;
      if (/^(network_|lycoris_|train_adaln$|train_llm_adapter$|model_train_type$|save_precision$|save_model_as$|full_bf16$|full_fp16$|dim_from_weights$|cache_text_encoder_outputs$|conv_|lokr_|use_|dora_|wd_|rs_lora$|decompose_both$|full_matrix$|unbalanced_factorization$|rank_dropout$|module_dropout$|optimizer_type$)/.test(key)) payload[key] = value;
    });
    return payload;
  },

  scheduleShapeEstimate() {
    const signature = JSON.stringify(this._shapeEstimatePayload());
    if (signature === this._shapeEstimateSignature) return;
    this._shapeEstimateSignature = signature;
    this.shapeEstimate = null;
    this.shapeEstimateError = '';
    this.shapeEstimateLoading = this.shapePreviewSupported();
    clearTimeout(this._shapeEstimateTimer);
    if (this.shapePreviewSupported()) this._shapeEstimateTimer = setTimeout(() => this.refreshShapeEstimate(), 500);
  },

  async refreshShapeEstimate() {
    if (this._shapeEstimateBusy || !this.shapePreviewSupported()) return;
    this._shapeEstimateBusy = true;
    const signature = this._shapeEstimateSignature;
    try {
      const response = await fetch('/api/training/shape-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: signature,
      });
      const result = await response.json();
      if (signature !== this._shapeEstimateSignature) return;
      if (!response.ok || result.status !== 'success') throw new Error(result.message || this.t('shapePreview.estimateFailed'));
      this.shapeEstimate = result.data;
      const groups = result.data.groups;
      this.shapePreviewSelected = groups.find(g => g.name === 'blocks.*.self_attn.q_proj')?.id
        || groups.find(g => g.name.startsWith('blocks.*.self_attn.'))?.id || groups[0]?.id || '';
    } catch (error) {
      if (signature === this._shapeEstimateSignature) this.shapeEstimateError = error.message;
    } finally {
      this._shapeEstimateBusy = false;
      if (signature !== this._shapeEstimateSignature) this.refreshShapeEstimate();
      else this.shapeEstimateLoading = false;
    }
  },

  _shapePreviewBytes(bytes) {
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(2)} KiB`;
    return `${(bytes / 1048576).toFixed(2)} MiB`;
  },

  shapeEstimateSummary() {
    if (this.shapeEstimateLoading) return this.t('shapePreview.estimating');
    if (this.shapeEstimateError) return this.t('shapePreview.estimateFailed');
    if (!this.shapeEstimate) return '';
    return `${this.t('shapePreview.estimatedSize')} ${this._shapePreviewBytes(this.shapeEstimate.estimatedBytes)}`;
  },

  openShapePreview() {
    if (!this.shapePreviewSupported()) return;
    if (this.shapeEstimateError) this._shapeEstimateSignature = '';
    this.scheduleShapeEstimate();
    this._openManagedModal('shapePreviewOpen', 'shapePreviewPreviousFocus', '.shape-preview-close');
  },

  closeShapePreview() {
    this._closeManagedModal('shapePreviewOpen', 'shapePreviewPreviousFocus');
  },

  selectShapePreview(value) {
    this.shapePreviewSelected = value;
    // Selecting a module replaces the x-html subtree, including its trigger.
    this.$nextTick(() => document.querySelector('.shape-preview-selector .preview-select-trigger')?.focus());
  },

  _shapePreviewNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  },

  _shapePreviewCount(value) {
    return Number(value).toLocaleString();
  },

  _shapePreviewScale(value) {
    if (!Number.isFinite(value)) return '—';
    return String(Math.round(value * 1000) / 1000);
  },

  _shapePreviewPct(trainable, full) {
    if (!(full > 0)) return '—';
    const pct = (trainable / full) * 100;
    return `${pct < 0.01 ? '<0.01' : pct.toFixed(pct < 1 ? 2 : 1)}%`;
  },

  // ── 数据：当前配置 → 形状、参数、说明 ──────────────────────
  _buildShapePreview() {
    const f = this.form || {};
    const group = this.shapeEstimate?.groups.find(g => g.id === this.shapePreviewSelected || g.name === this.shapePreviewSelected);
    if (!group) return null;
    const module = this.shapeEstimate.module;
    const isLycoris = module === 'lycoris.kohya';
    const algo = group.algo;
    const rank = group.rank;
    const rsLora = group.rsLora;
    const alpha = group.alpha;
    const inDim = group.in;
    const outDim = group.out;
    const fullParams = inDim * outDim;
    const notes = [];
    const t = (key, fallback) => this.t(key, fallback);
    const fill = (key, values) => Object.keys(values)
      .reduce((text, name) => text.replace(`{${name}}`, String(values[name])), t(key));

    const algoLabel = isLycoris
      ? this._fieldOptionLabel('lycoris_algo', algo, algo)
      : (algo === 'loha' ? 'LoHa' : (algo === 'lokr' ? 'LoKr' : 'LoRA'));
    const settings = [
      { label: t('shapePreview.rank'), value: String(rank), hint: t('shapePreview.rankHelp') },
      { label: t('shapePreview.alpha'), value: String(alpha), hint: t('shapePreview.alphaHelp') },
    ];
    const structure = [];
    const size = [];
    const legend = [t('shapePreview.legendMatMul')];

    const trainable = group.params;
    let scaleText = fill(rsLora ? 'shapePreview.scaleFormulaRs' : 'shapePreview.scaleFormula', {
      alpha,
      rank,
      sqrtRank: this._shapePreviewScale(Math.sqrt(rank)),
      value: this._shapePreviewScale(rsLora ? alpha / Math.sqrt(rank) : alpha / rank),
    });
    let caption = [t('shapePreview.loraCaption')];
    let diagram = '';

    if (algo === 'lora' || algo === 'loha') {
      if (algo === 'loha') {
        caption = [t('shapePreview.lohaCaption')];
        legend.push(t('shapePreview.legendHadamard'));
        diagram = this._shapePreviewLohaSvg({ rank, inDim, outDim });
      } else {
        diagram = this._shapePreviewLoraSvg({ rank, inDim, outDim });
      }
      if (isLycoris && f.conv_dim !== '' && f.conv_dim !== null && f.conv_dim !== undefined) {
        notes.push(fill('shapePreview.convNote', { dim: f.conv_dim }));
      }
      if (group.useScalar) notes.push(t('shapePreview.useScalarNote'));
      if (rsLora) notes.push(t('shapePreview.rsLoraNote'));
    } else {
      const factor = group.factor;
      const fullMatrix = group.fullMatrix;
      const shapes = group.shapes;
      const w1LowRank = !!shapes.lokr_w1_a;
      const decomposeBoth = group.decomposeBoth;
      const outL = (shapes.lokr_w1 || shapes.lokr_w1_a)[0];
      const inM = (shapes.lokr_w1 || shapes.lokr_w1_b)[1];
      const outK = (shapes.lokr_w2 || shapes.lokr_w2_a)[0];
      const inN = (shapes.lokr_w2 || shapes.lokr_w2_b)[1];
      // 与训练端一致：rank 未低于第二块尺寸的一半时，w2 直接存完整矩阵。
      const w2Full = group.w2Full;
      // 训练端实际是 ΔW = kron(w1, w2)，w2 为低秩时先乘出 w2 再参与 Kronecker 积，
      // 所以低秩对必须加括号，否则按优先级会被读成 (W1 ⊗ W2a) × W2b。
      caption = [
        fill('shapePreview.kronCaption', { outL, outK, inM, inN }),
        fill('shapePreview.kronFormula', {
          w1: w1LowRank ? '(W1a × W1b)' : 'W1',
          w2: w2Full ? 'W2' : '(W2a × W2b)',
        }),
      ];
      legend.push(t('shapePreview.legendKron'));
      diagram = this._shapePreviewLokrSvg({
        rank, inDim, outDim, outL, outK, inM, inN, w1LowRank, w2Full,
      });
      settings.push({
        label: t('shapePreview.factor'),
        value: factor < 0 ? `${factor} · ${t('shapePreview.factorAuto')}` : String(factor),
        hint: t('shapePreview.factorHelp'),
      });
      structure.push({
        label: t('shapePreview.w1'),
        value: t(w1LowRank ? 'shapePreview.lowRank' : 'shapePreview.fullMatrix'),
        detail: w1LowRank
          ? `W1a ${outL} × ${rank} · W1b ${rank} × ${inM}`
          : `${outL} × ${inM}`,
        hint: t('shapePreview.w1Help'),
      });
      structure.push({
        label: t('shapePreview.w2'),
        value: t(w2Full ? 'shapePreview.fullMatrix' : 'shapePreview.lowRank'),
        detail: w2Full
          ? `${outK} × ${inN}`
          : `W2a ${outK} × ${rank} · W2b ${rank} × ${inN}`,
        hint: t('shapePreview.w2Help'),
      });
      if (w2Full && !fullMatrix) {
        notes.push(fill('shapePreview.w2AutoFullNote', { rank, outK, inN }));
      } else if (fullMatrix) {
        notes.push(t('shapePreview.w2FullMatrixNote'));
      }
      if (decomposeBoth) {
        notes.push(fill(
          w1LowRank ? 'shapePreview.w1LowRankNote' : 'shapePreview.w1StaysFullNote',
          { rank, threshold: Math.max(outL, inM) / 2 }
        ));
      }
      if (rsLora) notes.push(t('shapePreview.rsLoraNote'));
      if (group.unbalanced) notes.push(t('shapePreview.unbalancedNote'));
      if (group.useScalar) notes.push(t('shapePreview.useScalarNote'));
      if (w2Full && !w1LowRank) {
        // LyCORIS 在 w1、w2 都是完整矩阵时把 alpha 固定为 rank；原生 LoKr 的 w1 恒为完整矩阵。
        scaleText = String(this._shapePreviewScale(group.scale));
      }
      structure.push({ label: t('shapePreview.w2ThresholdShort'), value: `Rank ≥ ${Math.max(outK, inN) / 2}`, hint: t('shapePreview.thresholdHelp') });
    }

    if (group.shapes.dora_scale) {
      const onOutput = group.shapes.dora_scale[0] === outDim;
      const axis = onOutput ? t('shapePreview.axisOut') : t('shapePreview.axisIn');
      notes.push(fill('shapePreview.doraNote', {
        count: this._shapePreviewCount(group.shapes.dora_scale.reduce((a, b) => a * b, 1)),
        axis,
      }));
    }

    settings.push({ label: t('shapePreview.scale'), value: scaleText, hint: t('shapePreview.scaleHelp') });
    size.push({ label: t('shapePreview.groupLayerCount'), value: String(group.count) });
    size.push({ label: t('shapePreview.groupSize'), value: this._shapePreviewBytes(group.weightBytes * group.count), hint: t('shapePreview.sizeHelp') });
    structure.push({
      label: t('shapePreview.exampleLayer'),
      value: `${this._shapePreviewCount(inDim)} → ${this._shapePreviewCount(outDim)}`,
    });
    size.push({
      label: t('shapePreview.trainableParams'),
      value: this._shapePreviewCount(trainable)
        + fill('shapePreview.ratio', { value: this._shapePreviewPct(trainable, fullParams) }),
      hint: t('shapePreview.paramHelp'),
    });
    size.push({
      label: t('shapePreview.fullParams'),
      value: this._shapePreviewCount(fullParams),
    });

    const sections = [
      { title: t('shapePreview.settingsSection'), detail: `${isLycoris ? 'LyCORIS' : 'sd-scripts'} · ${algoLabel}`, hint: module, rows: settings },
      { title: t('shapePreview.structureSection'), rows: structure },
      { title: t('shapePreview.sizeSection'), rows: size },
    ];
    return { sections, notes, caption, diagram, legend };
  },

  // ── SVG 示意：尺寸按 log 压缩，数字才是准确值 ───────────────
  _shapePreviewSize(dim) {
    const value = Math.max(2, this._shapePreviewNumber(dim, 2));
    const norm = Math.min(1, Math.log2(value) / 13);
    return 26 + norm * norm * 124;
  },

  _shapePreviewBlockSvg(x, y, w, h, cls) {
    return `<rect class="sp-block ${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3"/>`;
  },

  _shapePreviewTextSvg(x, y, text, cls) {
    return `<text class="sp-${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${this.esc(String(text))}</text>`;
  },

  // 低秩对的成组框：虚线圆角框把「这两块先相乘，再作为整体参与 ⊗」圈在一起。
  // 框要包住块上方的名称与下方的维度标签，所以上下各留 20/22 单位。
  _shapePreviewGroupSvg(left, right, top, bottom) {
    const boxLeft = left - 14;
    const boxRight = right + 14;
    const boxTop = top - 20;
    const boxBottom = bottom + 22;
    return `<rect class="sp-group" x="${boxLeft.toFixed(1)}" y="${boxTop.toFixed(1)}"`
      + ` width="${(boxRight - boxLeft).toFixed(1)}" height="${(boxBottom - boxTop).toFixed(1)}" rx="8"/>`;
  },

  _shapePreviewMatrixSvg(x, y, w, h, cls, name, dimText) {
    return this._shapePreviewBlockSvg(x, y, w, h, cls)
      + this._shapePreviewTextSvg(x + w / 2, y - 7, name, 'name')
      + this._shapePreviewTextSvg(x + w / 2, y + h + 15, dimText, 'dim');
  },

  _shapePreviewSvgWrap(used, top, bottom, parts) {
    const pad = 26;
    const width = Math.max(140, used) + pad * 2;
    const height = Math.max(60, bottom - top) + pad * 2;
    return `<svg class="shape-diagram-svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" preserveAspectRatio="xMidYMid meet" role="img"`
      + ` aria-label="${this.escapeAttr(this.t('shapePreview.diagramAlt'))}">`
      + `<g transform="translate(${pad},${(pad - top).toFixed(1)})">${parts.join('')}</g></svg>`;
  },

  _shapePreviewLoraSvg({ rank, inDim, outDim }) {
    const cy = 0;
    const bw = this._shapePreviewSize(rank);
    const bh = this._shapePreviewSize(outDim);
    const aw = this._shapePreviewSize(inDim);
    const ah = this._shapePreviewSize(rank);
    const dw = this._shapePreviewSize(inDim);
    const dh = this._shapePreviewSize(outDim);
    const gap = 44;
    const parts = [];
    let x = 0;
    parts.push(this._shapePreviewMatrixSvg(x, cy - bh / 2, bw, bh, 'sp-block--b', 'B', `${outDim} × ${rank}`));
    x += bw + gap;
    parts.push(this._shapePreviewTextSvg(x, cy + 6, '×', 'op'));
    x += gap;
    parts.push(this._shapePreviewMatrixSvg(x, cy - ah / 2, aw, ah, 'sp-block--a', 'A', `${rank} × ${inDim}`));
    x += aw + gap;
    parts.push(this._shapePreviewTextSvg(x, cy + 6, '=', 'op'));
    x += gap;
    parts.push(this._shapePreviewMatrixSvg(x, cy - dh / 2, dw, dh, 'sp-block--out', 'ΔW', `${outDim} × ${inDim}`));
    x += dw;
    const half = Math.max(bh, dh) / 2;
    return this._shapePreviewSvgWrap(x, cy - half - 12, cy + half + 22, parts);
  },

  _shapePreviewLohaSvg({ rank, inDim, outDim }) {
    const rows = [0, 168];
    const bw = this._shapePreviewSize(rank);
    const bh = this._shapePreviewSize(outDim);
    const aw = this._shapePreviewSize(inDim);
    const ah = this._shapePreviewSize(rank);
    const dw = this._shapePreviewSize(inDim);
    const dh = this._shapePreviewSize(outDim);
    const gap = 40;
    const parts = [];
    let used = 0;
    rows.forEach((cy, index) => {
      let x = 0;
      parts.push(this._shapePreviewMatrixSvg(x, cy - bh / 2, bw, bh, 'sp-block--b', `B${index + 1}`, `${outDim} × ${rank}`));
      x += bw + gap;
      parts.push(this._shapePreviewTextSvg(x, cy + 6, '×', 'op'));
      x += gap;
      parts.push(this._shapePreviewMatrixSvg(x, cy - ah / 2, aw, ah, 'sp-block--a', `A${index + 1}`, `${rank} × ${inDim}`));
      used = Math.max(used, x + aw);
    });
    const midY = (rows[0] + rows[1]) / 2;
    let x = used + gap;
    parts.push(this._shapePreviewTextSvg(x, midY + 7, '⊙', 'op'));
    x += gap;
    parts.push(this._shapePreviewTextSvg(x, midY + 6, '=', 'op'));
    x += gap;
    parts.push(this._shapePreviewMatrixSvg(x, midY - dh / 2, dw, dh, 'sp-block--out', 'ΔW', `${outDim} × ${inDim}`));
    x += dw;
    return this._shapePreviewSvgWrap(x, rows[0] - bh / 2 - 12, rows[1] + bh / 2 + 22, parts);
  },

  _shapePreviewLokrSvg({ rank, inDim, outDim, outL, outK, inM, inN, w1LowRank, w2Full }) {
    const cy = 0;
    const gap = 40;
    const parts = [];
    const groups = [];
    let maxHalf = 0;
    // 成组框比块再宽 14，第一组左侧留出这段空间。
    let x = w1LowRank ? 14 : 0;

    if (w1LowRank) {
      const b1w = this._shapePreviewSize(rank);
      const b1h = this._shapePreviewSize(outL);
      const a1w = this._shapePreviewSize(inM);
      const a1h = this._shapePreviewSize(rank);
      maxHalf = Math.max(maxHalf, b1h / 2, a1h / 2);
      const pairTop = cy - Math.max(b1h, a1h) / 2;
      const pairBottom = cy + Math.max(b1h, a1h) / 2;
      const pairStart = x;
      parts.push(this._shapePreviewMatrixSvg(x, cy - b1h / 2, b1w, b1h, 'sp-block--b', 'W1a', `${outL} × ${rank}`));
      x += b1w + gap;
      parts.push(this._shapePreviewTextSvg(x, cy + 6, '×', 'op'));
      x += gap;
      parts.push(this._shapePreviewMatrixSvg(x, cy - a1h / 2, a1w, a1h, 'sp-block--a', 'W1b', `${rank} × ${inM}`));
      x += a1w;
      groups.push({ left: pairStart, right: x, top: pairTop, bottom: pairBottom });
    } else {
      const w1w = this._shapePreviewSize(inM);
      const w1h = this._shapePreviewSize(outL);
      maxHalf = Math.max(maxHalf, w1h / 2);
      parts.push(this._shapePreviewMatrixSvg(x, cy - w1h / 2, w1w, w1h, 'sp-block--b', 'W1', `${outL} × ${inM}`));
      x += w1w;
    }

    x += gap;
    parts.push(this._shapePreviewTextSvg(x, cy + 7, '⊗', 'op'));
    x += gap;

    if (w2Full) {
      const w2w = this._shapePreviewSize(inN);
      const w2h = this._shapePreviewSize(outK);
      maxHalf = Math.max(maxHalf, w2h / 2);
      parts.push(this._shapePreviewMatrixSvg(x, cy - w2h / 2, w2w, w2h, 'sp-block--a', 'W2', `${outK} × ${inN}`));
      x += w2w;
    } else {
      const b2w = this._shapePreviewSize(rank);
      const b2h = this._shapePreviewSize(outK);
      const a2w = this._shapePreviewSize(inN);
      const a2h = this._shapePreviewSize(rank);
      maxHalf = Math.max(maxHalf, b2h / 2, a2h / 2);
      const pairTop = cy - Math.max(b2h, a2h) / 2;
      const pairBottom = cy + Math.max(b2h, a2h) / 2;
      const pairStart = x;
      // 训练端是 w2 = w2a @ w2b：a 是 (out_k × rank)，b 是 (rank × in_n)。
      parts.push(this._shapePreviewMatrixSvg(x, cy - b2h / 2, b2w, b2h, 'sp-block--a', 'W2a', `${outK} × ${rank}`));
      x += b2w + gap;
      parts.push(this._shapePreviewTextSvg(x, cy + 6, '×', 'op'));
      x += gap;
      parts.push(this._shapePreviewMatrixSvg(x, cy - a2h / 2, a2w, a2h, 'sp-block--a', 'W2b', `${rank} × ${inN}`));
      x += a2w;
      groups.push({ left: pairStart, right: x, top: pairTop, bottom: pairBottom });
    }

    x += gap;
    parts.push(this._shapePreviewTextSvg(x, cy + 6, '=', 'op'));
    x += gap;
    const dw = this._shapePreviewSize(inDim);
    const dh = this._shapePreviewSize(outDim);
    maxHalf = Math.max(maxHalf, dh / 2);
    parts.push(this._shapePreviewMatrixSvg(x, cy - dh / 2, dw, dh, 'sp-block--out', 'ΔW', `${outDim} × ${inDim}`));
    x += dw;

    let minY = cy - maxHalf - 12;
    let maxY = cy + maxHalf + 22;
    let used = x;
    groups.forEach(group => {
      const boxLeft = group.left - 14;
      const boxRight = group.right + 14;
      const boxTop = group.top - 20;
      const boxBottom = group.bottom + 22;
      parts.push(this._shapePreviewGroupSvg(group.left, group.right, group.top, group.bottom));
      minY = Math.min(minY, boxTop - 8);
      maxY = Math.max(maxY, boxBottom + 8);
      used = Math.max(used, boxRight + 8);
    });
    return this._shapePreviewSvgWrap(used, minY, maxY, parts);
  },

  _shapeModuleLabel(group) {
    const t = key => this.t(`shapePreview.${key}`);
    let path = group.name.replace(/^blocks\.\*\./, '');
    let family = t('otherModules');
    const families = [
      ['adaln_modulation_self_attn.', `${t('adalnModules')} / ${t('selfAttention')}`],
      ['adaln_modulation_cross_attn.', `${t('adalnModules')} / ${t('crossAttention')}`],
      ['adaln_modulation_mlp.', `${t('adalnModules')} / MLP`],
      ['self_attn.', t('selfAttention')], ['cross_attn.', t('crossAttention')],
      ['mlp.', 'MLP'], ['final_layer.', t('finalLayer')],
      ['x_embedder.', t('inputProjection')], ['t_embedder.', t('timeEmbedding')],
      ['llm_adapter.', 'LLM Adapter'], ['qwen3.', t('textEncoder')],
    ];
    const match = families.find(([prefix]) => path.startsWith(prefix));
    if (match) {
      family = match[1];
      path = path.slice(match[0].length);
    }
    const labels = {
      q_proj: t('qProjection'), k_proj: t('kProjection'), v_proj: t('vProjection'),
      output_proj: t('outputProjection'), linear: t('outputProjection'),
      layer1: t('mlpExpand'), layer2: t('mlpContract'),
      '1': t('bottleneck'), '2': t('modulationOutput'),
      'adaln_modulation.1': `AdaLN / ${t('bottleneck')}`,
      'adaln_modulation.2': `AdaLN / ${t('modulationOutput')}`,
      'proj.1': t('inputProjection'), '1.linear_1': t('timeProjection'),
      '1.linear_2': t('modulationOutput'),
    };
    return { family, label: labels[path] || path };
  },

  // ── 弹窗内容（x-html 注入，仅弹窗打开时求值）──────────────
  shapePreviewHtml() {
    const data = this._buildShapePreview();
    const estimate = this.shapeEstimate;
    const hasLokr = estimate?.groups.some(group => group.algo === 'lokr');
    const summary = `<div class="shape-preview-summary" role="status"><strong>${this.esc(this.shapeEstimateSummary())}</strong>`
      + (estimate ? `<span>${this.esc(this.t('shapePreview.totalParams'))}: ${this._shapePreviewCount(estimate.params)} · ${this.esc(this.t('shapePreview.layerCount'))}: ${estimate.moduleCount} · ${this.esc(estimate.precision.toUpperCase())}</span>`
        + (hasLokr ? `<span>${this.esc(this.t('shapePreview.fullW2Count'))}: ${estimate.fullW2Count}</span>` : '') : '')
      + `</div>`;
    if (!data) {
      const message = this.shapeEstimateError || (this.shapeEstimateLoading ? this.t('shapePreview.estimating') : this.t('shapePreview.empty'));
      return summary + `<div class="shape-preview-empty">${this.esc(message)}</div>`;
    }
    const families = new Map();
    for (const group of estimate.groups) {
      const { family, label } = this._shapeModuleLabel(group);
      const variant = estimate.groups.some(other => other.id !== group.id && other.name === group.name)
        ? ` · ${group.algo} R${group.rank} · ${group.paths[0]}` : '';
      if (!families.has(family)) families.set(family, []);
      families.get(family).push({ value: group.id, family, label, detail: `${group.in} → ${group.out}${variant}`,
        selectedLabel: `${family === label ? family : `${family} / ${label}`} · ${group.in} → ${group.out}${variant}` });
    }
    const options = [...families.values()].flat();
    const selector = `<div class="shape-preview-selector" @preview-select="selectShapePreview($event.detail)"><span>${this.esc(this.t('shapePreview.selectModule'))}</span>${window.previewSelectHtml(options, this.shapePreviewSelected, this.t('shapePreview.selectModule'))}</div>`;
    const metaHtml = data.sections.map(section => `<section class="shape-preview-section"><div class="shape-preview-section-title">${this.esc(section.title)}${section.detail ? `<span title="${this.esc(section.hint)}">${this.esc(section.detail)}</span>` : ''}</div><dl class="shape-preview-meta">`
      + section.rows.map(row => `<div ${row.hint ? `aria-label="${this.esc(`${row.label}: ${row.value}. ${row.detail || ''} ${row.hint}`)}" tabindex="0"` : ''}><dt>${this.esc(row.label)}</dt><dd>${this.esc(String(row.value))}${row.detail ? `<small class="shape-preview-dimensions">${this.esc(row.detail)}</small>` : ''}</dd>${row.hint ? `<span class="shape-preview-help" role="tooltip">${this.esc(row.hint)}</span>` : ''}</div>`).join('') + '</dl></section>').join('');
    const notesHtml = data.notes.length
      ? `<div class="shape-preview-notes">${data.notes.map(note =>
        `<div><span aria-hidden="true">•</span><span>${this.esc(note)}</span></div>`).join('')}</div>`
      : '';
    const legendHtml = data.legend.map(item => `<span>${this.esc(item)}</span>`).join('');
    const captionHtml = data.caption.map(line => `<div>${this.esc(line)}</div>`).join('');
    return summary + selector + `<div class="shape-preview-layout">
      <div class="shape-preview-sidebar">
        ${metaHtml}
        <div class="shape-preview-details">
          ${notesHtml}
          <p class="shape-preview-footnote">${this.esc(this.t('shapePreview.footnote'))}</p>
        </div>
      </div>
      <div class="shape-preview-diagram">
        <div class="shape-diagram-caption">${captionHtml}</div>
        ${data.diagram}
        <div class="shape-diagram-legend">${legendHtml}</div>
      </div>
    </div>`;
  },
};
