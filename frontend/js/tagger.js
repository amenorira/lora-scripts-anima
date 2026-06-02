/* ================================================================
   tagger.js — Tagger form & API (training-UI-style layout)
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.taggerMixin = {
  // ── State ──────────────────────────────────────────────
  taggerRunning: false,
  taggerPollTimer: null,
  taggerTaskId: null,        // 当前运行中的 task_id，用于停止
  _taggerModelsCache: null,  // 缓存模型列表，避免重复请求
  taggerSelectedModel: '',   // 当前选中的 tagger 模型 ID
  taggerPreset: 'macro',     // Camie 阈值预设: macro / micro / custom
  _taggerPresetInitialized: false,

  // ── Camie 阈值预设 ───────────────────────────────────
  CAMIE_PRESETS: {
    macro: { general: '0.492', character: '0.492', copyright: '0.492', artist: '0.492', meta: '0.492', year: '0.492', rating: '0.492' },
    micro: { general: '0.614', character: '0.614', copyright: '0.614', artist: '0.614', meta: '0.614', year: '0.614', rating: '0.614' },
  },

  /** 将预设切为"自定义" */
  _camieCustomPreset() {
    this.taggerPreset = 'custom';
    const el = document.getElementById('tagger-preset');
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
  /** Camie 分类阈值步进辅助方法 */
  _camieStepDown(cat) {
    const el = document.getElementById('tagger-th-' + cat);
    if (el) el.stepDown();
    this._camieCustomPreset();
  },
  _camieStepUp(cat) {
    const el = document.getElementById('tagger-th-' + cat);
    if (el) el.stepUp();
    this._camieCustomPreset();
  },
  /** checkbox 切换时同步 stepper 按钮 disabled 状态 */
  _camieToggleCat(cat) {
    const cb = document.getElementById('tagger-en-' + cat);
    if (!cb) return;
    const disabled = !cb.checked;
    const th = document.getElementById('tagger-th-' + cat);
    if (th) th.disabled = disabled;
    const stepper = th ? th.closest('.stepper') : null;
    if (stepper) {
      stepper.querySelectorAll('button').forEach(b => { b.disabled = disabled; });
    }
    // 仅开关分类不触发自定义，改数值才触发
  },

  applyCamiePreset(preset) {
    if (preset === 'custom') { this.taggerPreset = 'custom'; return; }
    const vals = this.CAMIE_PRESETS[preset];
    if (!vals) return;
    const cats = ['general','character','copyright','artist','meta','year','rating'];
    for (const cat of cats) {
      const thEl = document.getElementById('tagger-th-'+cat);
      const enEl = document.getElementById('tagger-en-'+cat);
      if (thEl) { thEl.value = vals[cat]; thEl.disabled = false; }
      if (enEl) enEl.checked = true;
      const stepper = thEl ? thEl.closest('.stepper') : null;
      if (stepper) {
        stepper.querySelectorAll('button').forEach(b => { b.disabled = false; });
      }
    }
    this.taggerPreset = preset;
    const presetEl = document.getElementById('tagger-preset');
    if (presetEl && presetEl.value !== preset) { presetEl.value = preset; }
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

    // ── 辅助：生成 field-row（标签在左，控件在右）────
    const _fieldRow = (labelKey, descKey, controlHtml, extraAttrs) => {
      return `<div class="field"${extraAttrs||''}><div class="field-row"><div class="field-info"><div class="field-key">${this.t(labelKey)}</div><div class="field-desc">${this.t(descKey)}</div></div><div class="field-control">${controlHtml}</div></div></div>`;
    };

    // ── 辅助：生成开关项 ─────────────────────────────
    const _toggle = (id, labelKey, checked) => {
      return `<label class="toggle"><input type="checkbox" id="${id}"${checked?' checked':''}><span class="toggle-track"><span class="toggle-thumb"></span></span><span>${this.t(labelKey)}</span></label>`;
    };

    // ── 辅助：Camie 分类字段行（field-nested 样式，checkbox+stepper 在右侧）─
    const _camieCatField = (cat, defVal) => {
      const catLabel = this.t('tagger.cat'+cat.charAt(0).toUpperCase()+cat.slice(1));
      return `<div class="field field-nested"><div class="field-row"><div class="field-info"><div class="field-key">${catLabel}</div></div><div class="field-control"><label class="toggle" style="margin-right:6px"><input type="checkbox" id="tagger-en-${cat}" checked @change="_camieToggleCat('${cat}')"><span class="toggle-track"><span class="toggle-thumb"></span></span></label><div class="stepper"><button type="button" @click="_camieStepDown('${cat}')">−</button><input type="number" id="tagger-th-${cat}" value="${defVal}" min="0" max="1" step="0.01" @change="_camieCustomPreset()"><button type="button" @click="_camieStepUp('${cat}')">+</button></div></div></div></div>`;
    };

    const _folderSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

    container.className = '';
    container.innerHTML =
    // ════════════════════════════════════════════════════════
    // Card 1: 基本设置
    // ════════════════════════════════════════════════════════
    `<div class="card"><div class="card-header">${this.t('tagger.basicSettings')}</div>` +
      // 图片文件夹路径 — 全宽布局（标签在上，输入框在下，参照训练界面）
      `<div class="field"><div class="field-info" style="margin-bottom:6px"><div class="field-key">${this.t('tagger.imageDir')}</div><div class="field-desc">${this.t('tagger.imageDirDesc')}</div></div><div class="field-input-row"><div class="field-input-wrap"><input type="text" id="tagger-path" placeholder="./train/aki"><div class="field-input-actions"><button type="button" class="btn-icon" @click="localFilePickerTagger('tagger-path')" title="${this.t('tagger.imageDir')}">${_folderSvg}</button></div></div></div></div>` +
      _fieldRow('tagger.model', 'tagger.modelDesc', modelSelect) +
      // 通用阈值 — 仅非 Camie 非 CL 模型可见
      _fieldRow('tagger.threshold', 'tagger.thresholdDesc',
        `<div class="stepper"><button type="button" @click="_thStepDown()">−</button><input type="number" id="tagger-threshold" value="0.35" min="0" max="1" step="0.01"><button type="button" @click="_thStepUp()">+</button></div>`,
        ` x-show="taggerSelectedModel!=='camie-tagger-v2' && taggerSelectedModel!=='cl_tagger_1_01'" x-transition`) +
      // CL 角色阈值 — 仅 CL tagger 可见
      _fieldRow('tagger.characterThreshold', 'tagger.characterThresholdDesc',
        `<div class="stepper"><button type="button" @click="_charStepDown()">−</button><input type="number" id="tagger-char-threshold" value="0.6" min="0" max="1" step="0.01"><button type="button" @click="_charStepUp()">+</button></div>`,
        ` x-show="taggerSelectedModel==='cl_tagger_1_01'" x-transition`) +
    `</div>` +

    // ════════════════════════════════════════════════════════
    // Card 2: Camie 分类阈值（仅 Camie 模型可见）
    // ════════════════════════════════════════════════════════
    `<div class="card" x-show="taggerSelectedModel==='camie-tagger-v2'" x-transition><div class="card-header">${this.t('tagger.presetLabel')}</div>` +
      // 阈值预设选择器
      `<div class="field"><div class="field-row"><div class="field-info"><div class="field-key">${this.t('tagger.presetLabel')}</div><div class="field-desc">${this.t('tagger.presetDesc')}</div></div><div class="field-control">${presetSelect}</div></div></div>` +
      // 说明文字
      `<div class="field" style="border-bottom:none"><div class="field-row"><div class="field-info"><div class="field-desc" style="color:var(--text-tertiary);font-size:12px">${this.t('tagger.categoryThresholdsDesc')}</div></div></div></div>` +
      // 各分类作为嵌套字段（field-nested）
      _camieCatField('general','0.492') +
      _camieCatField('character','0.492') +
      _camieCatField('copyright','0.492') +
      _camieCatField('artist','0.492') +
      _camieCatField('meta','0.492') +
      _camieCatField('year','0.492') +
      _camieCatField('rating','0.492') +
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

    // ── 监听模型切换，同步 taggerSelectedModel ──────────
    // animaSelect 组件在 select() 时会 dispatch input 事件到 hidden input
    const modelEl = document.getElementById('tagger-model');
    if (modelEl) {
      this.taggerSelectedModel = modelEl.value;
      if (modelEl.value) localStorage.setItem('anima-tagger-model', modelEl.value);
      modelEl.addEventListener('input', () => {
        this.taggerSelectedModel = modelEl.value;
        localStorage.setItem('anima-tagger-model', modelEl.value);
      });
    }

    // ── 预设 animaSelect 事件监听 ──
    const presetEl = document.getElementById('tagger-preset');
    if (presetEl) {
      presetEl.addEventListener('input', () => {
        this.applyCamiePreset(presetEl.value);
      });
    }
    if (savedModel === 'camie-tagger-v2' && !this._taggerPresetInitialized) {
      this.taggerPreset = 'macro';
      this._taggerPresetInitialized = true;
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
    const threshold = (model === 'camie-tagger-v2') ? 0.35 : parseFloat(thresholdEl?.value || '0.35');
    const charThreshold = parseFloat(document.getElementById('tagger-char-threshold')?.value || '0.6');
    const additional = document.getElementById('tagger-additional').value;
    const exclude = document.getElementById('tagger-exclude').value;
    const conflictAction = document.getElementById('tagger-conflict-action')?.value || 'copy';
    const removeDup = document.getElementById('tagger-remove-dup')?.checked || false;
    if (!path) { this.toast(this.t('common.specifyDir')); return; }

    // ── 收集 Camie 分类阈值 ──────────────────────────
    let categoryThresholds = null;
    if (model === 'camie-tagger-v2') {
      categoryThresholds = {};
      const cats = ['general','character','copyright','artist','meta','year','rating'];
      for (const cat of cats) {
        const enEl = document.getElementById('tagger-en-'+cat);
        if (enEl && enEl.checked) {
          const thEl = document.getElementById('tagger-th-'+cat);
          if (thEl) categoryThresholds[cat] = parseFloat(thEl.value) || 0.35;
        }
      }
    }

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
        const lines = (p.logs || []).slice(-20);
        if (panel) {
          panel.innerHTML = `<div style="margin-bottom:4px;color:var(--accent);font-weight:600">[${p.current}/${p.total}] ${this.esc(p.current_file || '')}</div>` + lines.map(l => `<div>${this.esc(l)}</div>`).join('');
          panel.scrollTop = panel.scrollHeight;
        }
        if (p.status === 'done' || p.status === 'cancelled') {
          this.taggerRunning = false;
          this.taggerTaskId = null;
          if (p.status === 'done' && p.total > 0 && panel) {
            const summary = document.createElement('div');
            summary.style.cssText = 'margin-top:8px;padding:8px 10px;background:var(--accent-soft);border-radius:var(--radius-sm);color:var(--accent);font-weight:600;font-size:13px';
            summary.textContent = `✓ ${this.t('tagger.completed')} — ${p.current}/${p.total} ${this.t('tagger.imagesProcessed')}`;
            panel.appendChild(summary);
            panel.scrollTop = panel.scrollHeight;
          }
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
};
