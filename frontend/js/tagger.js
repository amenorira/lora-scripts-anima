/* ================================================================
   tagger.js — Tagger form & API (training-UI-style layout)
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.taggerMixin = {
  // ── State ──────────────────────────────────────────────
  taggerRunning: false,
  taggerStarting: false,
  taggerPollTimer: null,
  taggerTaskId: null,        // 当前运行中的 task_id，用于停止
  _taggerModelsCache: null,  // 缓存模型列表，避免重复请求
  taggerSelectedModel: '',   // 当前选中的 tagger 模型 ID
  taggerPreset: 'macro',     // Camie 阈值预设: macro / micro / custom
  _taggerPresetInitialized: false,

  // ── 单图模式状态 ─────────────────────────────────────
  taggerMode: 'batch',       // 'batch' | 'single'
  singleImage: {
    previewUrl: null,        // base64 预览
    file: null,              // 原始 File 对象
    dragOver: false,
    model: '',               // 模型 ID
    globalThreshold: 0.50,
    categories: {},          // { key: { label, tags:[[name,conf],...], threshold, visible, collapsed, visibleTags:[] } }
    inferring: false,
    inferred: false,
  },

  // ── Camie 阈值预设 ───────────────────────────────────
  CAMIE_PRESETS: {
    macro: { general: '0.492', character: '0.492', copyright: '0.492', artist: '0.492', meta: '0.492', year: '0.492', rating: '0.492' },
    micro: { general: '0.614', character: '0.614', copyright: '0.614', artist: '0.614', meta: '0.614', year: '0.614', rating: '0.614' },
  },
  // ── CL Tagger 阈值预设 ───────────────────────────────
  CL_PRESETS: {
    macro: { general: '0.35', character: '0.6', copyright: '0.35', artist: '0.35', meta: '0.35', quality: '0.35', rating: '0.35' },
    micro: { general: '0.45', character: '0.7', copyright: '0.45', artist: '0.45', meta: '0.45', quality: '0.45', rating: '0.45' },
  },
  // ── 各模型分类定义 ────────────────────────────────────
  CAMIE_CATS: ['general','character','copyright','artist','meta','year','rating'],
  CL_CATS: ['general','character','copyright','artist','meta','quality','rating'],

  /** 将预设切为"自定义"（仅更新当前激活的预设选择器） */
  _camieCustomPreset() {
    this.taggerPreset = 'custom';
    const isCL = this.taggerSelectedModel === 'cl_tagger_1_02';
    const id = isCL ? 'tagger-cl-preset' : 'tagger-preset';
    const el = document.getElementById(id);
    if (el) el.value = 'custom';
  },

  /** 通用阈值步进 */
  _thStepDown() {
    const el = document.getElementById('tagger-threshold');
    if (el) el.stepDown();
  },
  _thStepUp() {
    const el = document.getElementById('tagger-threshold');
    if (el) el.stepUp();
  },
  /** CL 角色阈值步进 */
  _charStepDown() {
    const el = document.getElementById('tagger-char-threshold');
    if (el) el.stepDown();
  },
  _charStepUp() {
    const el = document.getElementById('tagger-char-threshold');
    if (el) el.stepUp();
  },
  /** 分类阈值步进辅助方法（不触发预设切换，由模板显式调用） */
  _catStepDown(prefix, cat) {
    const el = document.getElementById(prefix + '-th-' + cat);
    if (el) el.stepDown();
  },
  _catStepUp(prefix, cat) {
    const el = document.getElementById(prefix + '-th-' + cat);
    if (el) el.stepUp();
  },
  /** checkbox 切换时同步 stepper 按钮 disabled 状态 */
  _catToggleCat(prefix, cat) {
    const cb = document.getElementById(prefix + '-en-' + cat);
    if (!cb) return;
    const disabled = !cb.checked;
    const th = document.getElementById(prefix + '-th-' + cat);
    if (th) th.disabled = disabled;
    const stepper = th ? th.closest('.stepper') : null;
    if (stepper) {
      stepper.querySelectorAll('button').forEach(b => { b.disabled = disabled; });
    }
  },

  applyCamiePreset(preset) {
    if (preset === 'custom') { this.taggerPreset = 'custom'; return; }
    const isCL = this.taggerSelectedModel === 'cl_tagger_1_02';
    const prefix = isCL ? 'tagger-cl' : 'tagger-camie';
    const presets = isCL ? this.CL_PRESETS : this.CAMIE_PRESETS;
    const cats = isCL ? this.CL_CATS : this.CAMIE_CATS;
    const vals = presets[preset];
    if (!vals) return;
    for (const cat of cats) {
      const thEl = document.getElementById(prefix + '-th-' + cat);
      const enEl = document.getElementById(prefix + '-en-' + cat);
      if (thEl) { thEl.value = vals[cat]; thEl.disabled = false; }
      if (enEl) enEl.checked = true;
      const stepper = thEl ? thEl.closest('.stepper') : null;
      if (stepper) {
        stepper.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    }
    this.taggerPreset = preset;
    // 仅同步当前激活的预设选择器（避免两个面板的预设互相覆盖）
    const activePresetId = isCL ? 'tagger-cl-preset' : 'tagger-preset';
    const activeEl = document.getElementById(activePresetId);
    if (activeEl && activeEl.value !== preset) { activeEl.value = preset; }
  },

  // ── Helpers ────────────────────────────────────────────
  // esc() and escJson defined in trainingCoreMixin (shared via mixin merge)

  animaSelectHtml(config, defaultValue, inputId) {
    const enc = this.escJson(config);
    return `<div class="anima-select" x-data="animaSelect('${enc}', '${(defaultValue||'').replace(/'/g, "\\'")}')" x-init="syncToModel()" @click.outside="closeOnOutside()">
      <input type="hidden" x-ref="modelInput" value="${defaultValue||''}" id="${inputId}">
      <button type="button" class="anima-select-trigger" :class="{ focused: open }" @click="open=!open">
        <span class="anima-select-trigger-text" x-text="selectedLabel"></span>
        <svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="anima-select-menu" x-show="open" x-transition>
        <div class="anima-select-menu-scroll">
          <template x-for="opt in flatOptions" :key="opt.v">
            <div class="anima-select-option" :class="{ active: opt.v === value }" @click="select(opt.v)">
              <span x-text="opt.l" :title="opt.l"></span>
              <svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
          </template>
        </div>
      </div>
    </div>`;
  },

  // ── Methods ────────────────────────────────────────────
  async buildTaggerForm() {
    const container = document.getElementById('taggerForm');
    if (!container) return;
    let models = [];
    if (this._taggerModelsCache && this._taggerModelsCache.length) {
      models = this._taggerModelsCache;
    } else {
      try { const r=await fetch('/api/tagger/models'); const d=await r.json(); if(d.status==='success') models=d.data||[]; } catch(e){}
      if (models.length) this._taggerModelsCache = models;
    }
    if (!models.length) {
      container.className = '';
      container.innerHTML = `<div class="card"><div class="card-header">${this.t('tagger.title')}</div><div style="padding:20px;color:var(--text-secondary)">${this.t('common.failed')}: Unable to load model list</div></div>`;
      return;
    }
    const modelOpts = models.map(m=>({v:m.id, l:m.name||m.id}));
    let savedModel = this.taggerSelectedModel || localStorage.getItem('anima-tagger-model') || '';
    if (!savedModel || !modelOpts.find(o => o.v === savedModel)) {
      savedModel = modelOpts[0]?.v || '';
    }
    const modelSelect = this.animaSelectHtml({options: modelOpts}, savedModel, 'tagger-model');
    const conflictOpts = [
      {v:'ignore',l:this.t('tagger.conflictIgnore')},{v:'copy',l:this.t('tagger.conflictCopy')},{v:'prepend',l:this.t('tagger.conflictPrepend')}
    ];
    const conflictSelect = this.animaSelectHtml({options: conflictOpts}, 'copy', 'tagger-conflict-action');
    const presetOpts = [
      {v:'macro',l:this.t('tagger.presetMacro')},
      {v:'micro',l:this.t('tagger.presetMicro')},
      {v:'custom',l:this.t('tagger.presetCustom')},
    ];
    const presetSelect = this.animaSelectHtml({options: presetOpts}, 'macro', 'tagger-preset');
    const clPresetSelect = this.animaSelectHtml({options: presetOpts}, 'macro', 'tagger-cl-preset');

    // ── 辅助：生成 field-row（标签在左，控件在右）────
    const _fieldRow = (labelKey, descKey, controlHtml, extraAttrs, extraClass) => {
      const cls = extraClass ? `field ${extraClass}` : 'field';
      return `<div class="${cls}"${extraAttrs||''}><div class="field-row"><div class="field-info"><div class="field-key">${this.t(labelKey)}</div><div class="field-desc">${this.t(descKey)}</div></div><div class="field-control">${controlHtml}</div></div></div>`;
    };

    // ── 辅助：生成开关项 ─────────────────────────────
    const _toggle = (id, labelKey, checked) => {
      return `<label class="toggle"><input type="checkbox" id="${id}"${checked?' checked':''}><span class="toggle-track"><span class="toggle-thumb"></span></span><span>${this.t(labelKey)}</span></label>`;
    };

    // ── 辅助：分类字段行（field-nested 样式，checkbox+stepper 在右侧）─
    // prefix: 'tagger-camie' 或 'tagger-cl'，用于区分同名的 DOM ID
    const _catField = (prefix, cat, defVal) => {
      const catLabel = this.t('tagger.cat'+cat.charAt(0).toUpperCase()+cat.slice(1));
      return `<div class="field field-nested"><div class="field-row"><div class="field-info"><div class="field-key">${catLabel}</div></div><div class="field-control"><label class="toggle" style="margin-right:6px"><input type="checkbox" id="${prefix}-en-${cat}" checked @change="_catToggleCat('${prefix}','${cat}')"><span class="toggle-track"><span class="toggle-thumb"></span></span></label><div class="stepper"><button type="button" @click="_catStepDown('${prefix}','${cat}');_camieCustomPreset()">−</button><input type="number" id="${prefix}-th-${cat}" value="${defVal}" min="0" max="1" step="0.01" @change="_camieCustomPreset()"><button type="button" @click="_catStepUp('${prefix}','${cat}');_camieCustomPreset()">+</button></div></div></div></div>`;
    };

    const _folderSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

    container.className = '';
    container.innerHTML =
    // ════════════════════════════════════════════════════════
    // Card 1: 基本设置
    // ════════════════════════════════════════════════════════
    `<div class="card"><div class="card-header">${this.t('tagger.basicSettings')}</div>` +
      // 图片文件夹路径 — 全宽布局（标签在上，输入框在下，参照训练界面）
      `<div class="field"><div class="field-info" style="margin-bottom:6px"><div class="field-key">${this.t('tagger.imageDir')}</div><div class="field-desc">${this.t('tagger.imageDirDesc')}</div></div><div class="field-input-row"><div class="field-input-wrap"><input type="text" id="tagger-path" placeholder="./train/aki"><div class="field-input-actions"><button type="button" class="btn-icon" @click="localFilePickerTagger('tagger-path')" title="${this.t('tagger.imageDir')}" aria-label="Browse local files">${_folderSvg}</button></div></div></div></div>` +
      _fieldRow('tagger.model', 'tagger.modelDesc', modelSelect) +
      // 通用阈值 — 仅 WD14 系列可见（CL 和 Camie 用分类阈值代替）
      _fieldRow('tagger.threshold', 'tagger.thresholdDesc',
        `<div class="stepper"><button type="button" @click="_thStepDown()">−</button><input type="number" id="tagger-threshold" value="0.35" min="0" max="1" step="0.01"><button type="button" @click="_thStepUp()">+</button></div>`,
        ` :class="{ 'field-hidden': taggerSelectedModel==='camie-tagger-v2' || taggerSelectedModel==='cl_tagger_1_02' }"`, 'field-conditional') +
      // CL 角色阈值 — 仅 WD14 系列可见（CL 和 Camie 在分类面板中单独设置角色阈值）
      _fieldRow('tagger.characterThreshold', 'tagger.characterThresholdDesc',
        `<div class="stepper"><button type="button" @click="_charStepDown()">−</button><input type="number" id="tagger-char-threshold" value="0.6" min="0" max="1" step="0.01"><button type="button" @click="_charStepUp()">+</button></div>`,
        ` :class="{ 'field-hidden': taggerSelectedModel==='camie-tagger-v2' || taggerSelectedModel==='cl_tagger_1_02' }"`, 'field-conditional') +
    `</div>` +

    // ════════════════════════════════════════════════════════
    // Card 2: Camie 分类阈值（仅 Camie 模型可见）
    // ════════════════════════════════════════════════════════
    `<div class="card field-conditional" :class="{ 'field-hidden': taggerSelectedModel!=='camie-tagger-v2' }"><div class="card-header">${this.t('tagger.presetLabel')}</div>` +
      // 阈值预设选择器
      `<div class="field"><div class="field-row"><div class="field-info"><div class="field-key">${this.t('tagger.presetLabel')}</div><div class="field-desc">${this.t('tagger.presetDesc')}</div></div><div class="field-control">${presetSelect}</div></div></div>` +
      // 说明文字
      `<div class="field" style="border-bottom:none"><div class="field-row"><div class="field-info"><div class="field-desc" style="color:var(--text-tertiary);font-size:12px">${this.t('tagger.categoryThresholdsDesc')}</div></div></div></div>` +
      // 各分类作为嵌套字段（field-nested）
      _catField('tagger-camie','general','0.492') +
      _catField('tagger-camie','character','0.492') +
      _catField('tagger-camie','copyright','0.492') +
      _catField('tagger-camie','artist','0.492') +
      _catField('tagger-camie','meta','0.492') +
      _catField('tagger-camie','year','0.492') +
      _catField('tagger-camie','rating','0.492') +
    `</div>` +

    // ════════════════════════════════════════════════════════
    // Card 2b: CL 分类阈值（仅 CL tagger 可见）
    // ════════════════════════════════════════════════════════
    `<div class="card field-conditional" :class="{ 'field-hidden': taggerSelectedModel!=='cl_tagger_1_02' }"><div class="card-header">${this.t('tagger.clCategoryLabel')}</div>` +
      // 阈值预设选择器
      `<div class="field"><div class="field-row"><div class="field-info"><div class="field-key">${this.t('tagger.presetLabel')}</div><div class="field-desc">${this.t('tagger.clPresetDesc')}</div></div><div class="field-control">${clPresetSelect}</div></div></div>` +
      // 说明文字
      `<div class="field" style="border-bottom:none"><div class="field-row"><div class="field-info"><div class="field-desc" style="color:var(--text-tertiary);font-size:12px">${this.t('tagger.categoryThresholdsDesc')}</div></div></div></div>` +
      // CL 分类字段
      _catField('tagger-cl','general','0.35') +
      _catField('tagger-cl','character','0.6') +
      _catField('tagger-cl','copyright','0.35') +
      _catField('tagger-cl','artist','0.35') +
      _catField('tagger-cl','meta','0.35') +
      _catField('tagger-cl','quality','0.35') +
      _catField('tagger-cl','rating','0.35') +
    `</div>` +

    // ════════════════════════════════════════════════════════
    // Card 3: 输出选项
    // ════════════════════════════════════════════════════════
    `<div class="card"><div class="card-header">${this.t('tagger.outputOptions')}</div>` +
      _fieldRow('tagger.additionalTags', 'tagger.additionalTagsDesc',
        `<input type="text" id="tagger-additional" placeholder="e.g. 1girl, solo">`) +
      _fieldRow('tagger.excludeTags', 'tagger.excludeTagsDesc',
        `<input type="text" id="tagger-exclude" placeholder="e.g. watermark">`) +
      _fieldRow('tagger.conflictAction', 'tagger.conflictActionDesc', conflictSelect) +
      `<div class="field"><div class="toggle-grid" style="padding:4px 0">` +
        _toggle('tagger-replace-underscore', 'tagger.replaceUnderscore', true) +
        _toggle('tagger-escape-tag', 'tagger.escapeTag', true) +
        _toggle('tagger-recursive', 'tagger.recursive', true) +
        _toggle('tagger-remove-dup', 'tagger.removeDuplicated', false) +
        _toggle('tagger-add-rating', 'tagger.addRatingTag', false) +
        _toggle('tagger-add-model', 'tagger.addModelTag', false) +
      `</div></div>` +
    `</div>`;

    // ── 监听模型切换，同步 taggerSelectedModel 并应用预设 ──
    // animaSelect 组件在 select() 时会 dispatch input 事件到 hidden input
    const modelEl = document.getElementById('tagger-model');
    if (modelEl) {
      this.taggerSelectedModel = modelEl.value;
      if (modelEl.value) localStorage.setItem('anima-tagger-model', modelEl.value);
      modelEl.addEventListener('input', () => {
        this.taggerSelectedModel = modelEl.value;
        localStorage.setItem('anima-tagger-model', modelEl.value);
        // 切换到新模型时，读取其预设选择器的当前值并应用
        const newIsCL = modelEl.value === 'cl_tagger_1_02';
        const newPresetId = newIsCL ? 'tagger-cl-preset' : 'tagger-preset';
        const newPresetEl = document.getElementById(newPresetId);
        if (newPresetEl && newPresetEl.value) {
          this.applyCamiePreset(newPresetEl.value);
        }
      });
    }

    // ── 预设 animaSelect 事件监听 ──
    const presetEl = document.getElementById('tagger-preset');
    if (presetEl) {
      presetEl.addEventListener('input', () => {
        this.applyCamiePreset(presetEl.value);
      });
    }
    const clPresetEl = document.getElementById('tagger-cl-preset');
    if (clPresetEl) {
      clPresetEl.addEventListener('input', () => {
        this.applyCamiePreset(clPresetEl.value);
      });
    }
    // 初始化：为当前模型显式应用默认预设
    if (savedModel === 'camie-tagger-v2' || savedModel === 'cl_tagger_1_02') {
      const initPresetId = savedModel === 'cl_tagger_1_02' ? 'tagger-cl-preset' : 'tagger-preset';
      const initPresetEl = document.getElementById(initPresetId);
      if (initPresetEl && initPresetEl.value) {
        this.applyCamiePreset(initPresetEl.value);
      }
    }
  },

  // ── 清除右侧日志面板 ─────────────────────────────────
  clearTaggerLog() {
    const panel = document.getElementById('taggerLogPanel');
    if (!panel) return;
    panel.innerHTML = '';
  },

  // ── 获取日志面板引用 ─────────────────────────────────
  _getTaggerLogPanel() {
    const panel = document.getElementById('taggerLogPanel');
    if (!panel || !panel.isConnected) return null;
    return panel;
  },

  async runTagger() {
    const path = document.getElementById('tagger-path').value;
    const model = document.getElementById('tagger-model').value;
    const thresholdEl = document.getElementById('tagger-threshold');
    const threshold = (model === 'camie-tagger-v2' || model === 'cl_tagger_1_02') ? 0.35 : parseFloat(thresholdEl?.value || '0.35');
    const charThreshold = parseFloat(document.getElementById('tagger-char-threshold')?.value || '0.6');
    const additional = document.getElementById('tagger-additional').value;
    const exclude = document.getElementById('tagger-exclude').value;
    const conflictAction = document.getElementById('tagger-conflict-action')?.value || 'copy';
    const removeDup = document.getElementById('tagger-remove-dup')?.checked || false;
    if (!path) { this.toast(this.t('common.specifyDir')); return; }

    // ── 收集分类阈值 ──────────────────────────
    // 未勾选的分类设阈值为 1.0，使其不输出标签（与 UI 描述一致）
    let categoryThresholds = null;
    if (model === 'camie-tagger-v2') {
      categoryThresholds = {};
      const prefix = 'tagger-camie';
      for (const cat of this.CAMIE_CATS) {
        const enEl = document.getElementById(prefix + '-en-' + cat);
        if (enEl && enEl.checked) {
          const thEl = document.getElementById(prefix + '-th-' + cat);
          if (thEl) categoryThresholds[cat] = parseFloat(thEl.value) || 0.35;
        } else {
          categoryThresholds[cat] = 1.0;
        }
      }
    } else if (model === 'cl_tagger_1_02') {
      categoryThresholds = {};
      const prefix = 'tagger-cl';
      for (const cat of this.CL_CATS) {
        const enEl = document.getElementById(prefix + '-en-' + cat);
        if (enEl && enEl.checked) {
          const thEl = document.getElementById(prefix + '-th-' + cat);
          if (thEl) categoryThresholds[cat] = parseFloat(thEl.value) || 0.35;
        } else {
          categoryThresholds[cat] = 1.0;
        }
      }
    }

    this.taggerStarting = true;
    this.taggerRunning = true;
    const panel = this._getTaggerLogPanel();
    if (panel) { panel.innerHTML = `<div style="color:var(--accent)">${this.t('tagger.running')}</div>`; }

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30000);
    try {
      const body = {path,interrogator_model:model,threshold,character_threshold:charThreshold,additional_tags:additional,exclude_tags:exclude,replace_underscore:document.getElementById('tagger-replace-underscore').checked,batch_input_recursive:document.getElementById('tagger-recursive').checked,batch_output_dir:'',batch_output_action_on_conflict:conflictAction,add_rating_tag:document.getElementById('tagger-add-rating')?.checked||false,add_model_tag:document.getElementById('tagger-add-model')?.checked||false,escape_tag:document.getElementById('tagger-escape-tag')?.checked||false,batch_remove_duplicated_tag:removeDup,batch_output_save_json:false,sort_by_alphabetical_order:false,add_confident_as_weight:false,batch_output_filename_format:'[name].[output_extension]',unload_model_after_running:false};
      if (categoryThresholds && Object.keys(categoryThresholds).length) {
        body.category_thresholds = categoryThresholds;
      }
      const r = await fetch('/api/interrogate',{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,body:JSON.stringify(body)});
      clearTimeout(timeout);
      const d = await r.json();
      if (d.status === 'success' && d.data && d.data.task_id) {
        this.taggerTaskId = d.data.task_id;
        this.pollTaggerProgress(d.data.task_id);
      } else {
        if (panel) { panel.innerHTML = `<div style="color:var(--danger)">Error: ${this.esc(d.message||'Unknown')}</div>`; }
        this.toast(d.message||this.t('common.failed'));
        this.taggerRunning = false;
      }
    } catch(e) {
      clearTimeout(timeout);
      if (panel) {
        const msg = e.name === 'AbortError' ? 'Request timeout' : e.message;
        panel.innerHTML = `<div style="color:var(--danger)">Error: ${this.esc(msg)}</div>`;
      }
      this.toast(this.t('common.failed')+': '+(e.name==='AbortError'?'Timeout':e.message));
      this.taggerRunning = false;
    }
    this.taggerStarting = false;
  },

  async pollTaggerProgress(taskId) {
    const panel = this._getTaggerLogPanel();
    if (!this.taggerRunning) return;
    let delay = 1500; // 默认轮询间隔
    try {
      const r = await fetch(`/api/interrogate/progress?task_id=${taskId}`);
      const d = await r.json();
      if (d.status === 'success' && d.data) {
        const p = d.data;
        if (panel) {
          if (p.status === 'done') {
            // 完成：清理进度行，只保留日志和完成摘要
            const lines = (p.logs || []).slice(-15);
            panel.innerHTML = `<div style="padding:8px 10px;background:var(--accent-soft);border-radius:var(--radius-sm);color:var(--accent);font-weight:600;font-size:13px;margin-bottom:6px">✓ ${this.t('tagger.completed')} — ${p.current}/${p.total} ${this.t('tagger.imagesProcessed')}</div>` + lines.map(l => `<div>${this.esc(l)}</div>`).join('');
          } else if (p.status === 'cancelled') {
            panel.innerHTML = `<div style="color:var(--warning);font-weight:500">⏹ ${this.t('tagger.stop')}</div>`;
          } else {
            // 运行中：蓝色进度行 + 最新日志
            const lines = (p.logs || []).slice(-20);
            const progressLine = p.total > 0 ? `[${p.current}/${p.total}] ${this.esc(p.current_file || '')}` : this.t('tagger.running');
            panel.innerHTML = `<div style="margin-bottom:4px;color:var(--accent);font-weight:600">${progressLine}</div>` + lines.map(l => `<div>${this.esc(l)}</div>`).join('');
          }
          panel.scrollTop = panel.scrollHeight;
        }
        if (p.status === 'done' || p.status === 'cancelled') {
          this.taggerRunning = false;
          this.taggerTaskId = null;
          this.toast(p.status === 'done' ? this.t('tagger.completed') : this.t('tagger.stop'));
          return;
        }
        if (p.status === 'error') {
          this.taggerRunning = false;
          this.taggerTaskId = null;
          this.toast(this.t('common.failed'));
          return;
        }
        // 退避策略：进度停滞时逐步增大间隔，减少无效请求
        if (p.current > 0 && p.total > 0) {
          const ratio = p.current / p.total;
          if (ratio < 0.1) delay = 1500;
          else if (ratio < 0.5) delay = 2000;
          else delay = 3000;
        }
      }
    } catch(e) { delay = 3000; /* 网络错误时加大间隔 */ }
    if (this.taggerRunning) {
      this.taggerPollTimer = setTimeout(() => this.pollTaggerProgress(taskId), delay);
    }
  },

  async stopTagger() {
    this.taggerRunning = false;
    if (this.taggerPollTimer) { clearTimeout(this.taggerPollTimer); this.taggerPollTimer = null; }
    if (this.taggerTaskId) {
      try { await fetch(`/api/interrogate/stop?task_id=${this.taggerTaskId}`, {method:'POST'}); } catch(e) {}
      this.taggerTaskId = null;
    }
    const panel = this._getTaggerLogPanel();
    if (panel) {
      const stopMsg = document.createElement('div');
      stopMsg.style.cssText = 'margin-top:4px;color:var(--warning);font-weight:500';
      stopMsg.textContent = `⏹ ${this.t('tagger.stop')}`;
      panel.appendChild(stopMsg);
      panel.scrollTop = panel.scrollHeight;
    }
    this.toast(this.t('tagger.stop'));
  },

  localFilePickerTagger(inputId) {
    var self = this;
    fetch('/api/pick_file?picker_type=folder').then(r=>r.json()).then(d=>{if(d.status==='success'&&d.data&&d.data.path) document.getElementById(inputId).value=d.data.path;}).catch(function(){ self.toast(self.t('common.localPickerNA')); });
  },

  openTagEditor() { window.open('/proxy/tageditor','_blank'); },

  // ════════════════════════════════════════════════════════
  //  单图模式方法
  // ════════════════════════════════════════════════════════

  switchTaggerMode(mode) {
    this.taggerMode = mode;
    if (mode === 'single') {
      this.$nextTick(() => {
        this.buildSingleModelSelect();
        this.buildSinglePresetSelect();
      });
    }
  },

  /** 构建单图模式模型选择器 */
  async buildSingleModelSelect() {
    const container = document.getElementById('singleModelSelect');
    if (!container || container.children.length > 0) return;
    let models = this._taggerModelsCache;
    if (!models || !models.length) {
      try {
        const r = await fetch('/api/tagger/models');
        const d = await r.json();
        if (d.status === 'success') models = d.data || [];
        if (models.length) this._taggerModelsCache = models;
      } catch (e) { return; }
    }
    if (!models || !models.length) return;
    const modelOpts = models.map(m => ({ v: m.id, l: m.name || m.id }));
    const savedModel = this.taggerSelectedModel || localStorage.getItem('anima-tagger-model') || modelOpts[0]?.v || '';
    this.singleImage.model = savedModel;
    const html = this.animaSelectHtml({ options: modelOpts }, savedModel, 'single-tagger-model');
    container.innerHTML = html;
    this.$nextTick(() => {
      const el = document.getElementById('single-tagger-model');
      if (el) {
        el.addEventListener('input', () => {
          this.singleImage.model = el.value;
        });
      }
    });
  },

  /** 构建单图模式阈值预设选择器 */
  buildSinglePresetSelect() {
    const container = document.getElementById('singlePresetSelect');
    if (!container || container.children.length > 0) return;
    const presetOpts = [
      { v: 'macro', l: this.t('tagger.presetMacro') },
      { v: 'micro', l: this.t('tagger.presetMicro') },
      { v: 'custom', l: this.t('tagger.presetCustom') },
    ];
    const html = this.animaSelectHtml({ options: presetOpts }, 'macro', 'single-preset');
    container.innerHTML = html;
    this.$nextTick(() => {
      const presetEl = document.getElementById('single-preset');
      if (presetEl) {
        presetEl.addEventListener('input', () => {
          this.applySinglePreset(presetEl.value);
        });
      }
    });

    const thEl = document.getElementById('single-init-threshold');
    const thVal = document.getElementById('single-init-th-val');
    if (thEl && thVal) {
      thEl.addEventListener('input', () => {
        thVal.textContent = parseFloat(thEl.value).toFixed(2);
      });
    }
  },

  /** 应用预设到初始阈值 */
  applySinglePreset(preset) {
    const isCL = this.singleImage.model === 'cl_tagger_1_02';
    const isCamie = this.singleImage.model === 'camie-tagger-v2';
    const thEl = document.getElementById('single-init-threshold');
    const thVal = document.getElementById('single-init-th-val');
    if (!thEl) return;

    if (preset === 'custom') return;

    let initVal = '0.50';
    if (isCamie) {
      initVal = this.CAMIE_PRESETS[preset] ? this.CAMIE_PRESETS[preset].general : '0.50';
    } else if (isCL) {
      initVal = this.CL_PRESETS[preset] ? this.CL_PRESETS[preset].general : '0.50';
    } else {
      initVal = preset === 'macro' ? '0.35' : (preset === 'micro' ? '0.45' : '0.50');
    }
    thEl.value = initVal;
    if (thVal) thVal.textContent = parseFloat(initVal).toFixed(2);
  },

  /** 文件选择器 */
  singleFilePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      if (e.target.files && e.target.files[0]) {
        this.loadImageFile(e.target.files[0]);
      }
    };
    input.click();
  },

  /** 拖拽放下图片 */
  handleImageDrop(e) {
    this.singleImage.dragOver = false;
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      this.loadImageFile(file);
    }
  },

  /** Ctrl+V 粘贴图片 */
  handleImagePaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        this.loadImageFile(item.getAsFile());
        break;
      }
    }
  },

  /** 加载图片文件并生成预览 */
  loadImageFile(file) {
    this.singleImage.file = file;
    this.singleImage.inferred = false;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.singleImage.previewUrl = e.target.result;
    };
    reader.onerror = () => {
      this.toast(this.t('common.failed') + ': Failed to read image file');
      this.singleImage.file = null;
    };
    try {
      reader.readAsDataURL(file);
    } catch (e) {
      this.toast(this.t('common.failed') + ': Failed to read image file');
      this.singleImage.file = null;
    }
  },

  /** 执行单图推理 */
  async runSingleInference() {
    if (!this.singleImage.file) {
      this.toast(this.t('tagger.noImage'));
      return;
    }
    this.singleImage.inferring = true;
    try {
      const formData = new FormData();
      formData.append('file', this.singleImage.file);
      formData.append('interrogator_model', this.singleImage.model || 'camie-tagger-v2');

      const r = await fetch('/api/tagger/single', {
        method: 'POST',
        body: formData,
      });
      const d = await r.json();
      if (d.status !== 'success') {
        this.toast(d.message || this.t('common.failed'));
        this.singleImage.inferring = false;
        return;
      }
      if (!d.data || !d.data.categories) {
        this.toast(this.t('common.failed'));
        this.singleImage.inferring = false;
        return;
      }
      const data = d.data;
      const initThEl = document.getElementById('single-init-threshold');
      this.singleImage.globalThreshold = initThEl ? parseFloat(initThEl.value) || 0.50 : 0.50;
      this.singleImage.categories = {};

      for (const [key, tags] of Object.entries(data.categories)) {
        if (!tags || tags.length === 0) continue;
        this.singleImage.categories[key] = {
          label: data.labels[key] || key,
          tags: tags,                                          // 原始数据（不过滤）
          threshold: this.singleImage.globalThreshold,         // 分类独立阈值，初始继承全局
          visible: true,
          collapsed: key !== 'general',                        // 默认只展开 General
          visibleTags: [],                                     // 满足本分类阈值 + 可见的标签（响应式数组）
        };
      }
      this._recalcAllVisibleTags();
      this.singleImage.inferred = true;
    } catch (e) {
      this.toast(this.t('common.failed') + ': ' + e.message);
    }
    this.singleImage.inferring = false;
  },

  /** 全局阈值变更 → 同步所有分类阈值并重新计算可见标签 */
  applyGlobalThreshold() {
    const gt = this.singleImage.globalThreshold;
    for (const key in this.singleImage.categories) {
      this.singleImage.categories[key].threshold = gt;
    }
    this._recalcAllVisibleTags();
  },

  /** 分类阈值变更 → 重新计算该分类可见标签（模板中 @input 调用） */
  recalcCategoryThreshold(key) {
    this._recalcVisibleTags(key);
  },

  /** 分类可见性切换 → 重新计算（模板中 @change 调用） */
  recalcCategoryVisibility(key) {
    this._recalcVisibleTags(key);
  },

  /** 重新计算单个分类的 visibleTags */
  _recalcVisibleTags(key) {
    const cat = this.singleImage.categories[key];
    if (!cat) return;
    if (!cat.visible) {
      cat.visibleTags = [];
      return;
    }
    cat.visibleTags = cat.tags.filter(tag => tag[1] >= cat.threshold);
  },

  /** 重新计算所有分类的 visibleTags */
  _recalcAllVisibleTags() {
    for (const key in this.singleImage.categories) {
      this._recalcVisibleTags(key);
    }
  },

  /** 汇总可见标签数量 */
  summaryTagCount() {
    let count = 0;
    for (const key in this.singleImage.categories) {
      const cat = this.singleImage.categories[key];
      if (cat.visible) {
        count += cat.visibleTags.length;
      }
    }
    return count;
  },

  /** 汇总可见标签文本（逗号分隔） */
  summaryTagsText() {
    const parts = [];
    for (const key in this.singleImage.categories) {
      const cat = this.singleImage.categories[key];
      if (cat.visible) {
        for (const tag of cat.visibleTags) {
          parts.push(tag[0]);
        }
      }
    }
    return parts.join(', ');
  },

  /** 复制标签到剪贴板 */
  async copyTags() {
    const text = this.summaryTagsText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.toast(this.t('tagger.copied'));
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.toast(this.t('tagger.copied'));
    }
  },

  collapseAllCats() {
    for (const key in this.singleImage.categories) {
      this.singleImage.categories[key].collapsed = true;
    }
  },
  expandAllCats() {
    for (const key in this.singleImage.categories) {
      this.singleImage.categories[key].collapsed = false;
    }
  },
  showAllCats() {
    for (const key in this.singleImage.categories) {
      this.singleImage.categories[key].visible = true;
    }
    this._recalcAllVisibleTags();
  },
  hideAllCats() {
    for (const key in this.singleImage.categories) {
      this.singleImage.categories[key].visible = false;
    }
    this._recalcAllVisibleTags();
  },
};
