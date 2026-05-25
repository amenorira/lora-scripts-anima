/* ================================================================
   tagger.js — Tagger form & API
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.taggerMixin = {
  // ── State ──────────────────────────────────────────────
  taggerRunning: false,
  taggerPollTimer: null,

  // ── Methods ────────────────────────────────────────────
  async buildTaggerForm() {
    const container = document.getElementById('taggerForm');
    if (!container) return;
    let models = [];
    try { const r=await fetch('/api/tagger/models'); const d=await r.json(); if(d.status==='success') models=d.data||[]; } catch(e){}
    if (!models.length) {
      container.innerHTML = `<div class="card-header">${this.t('tagger.title')}</div><div style="padding:20px;color:var(--text-secondary)">${this.t('common.failed')}: Unable to load model list</div>`;
      return;
    }
    const modelOpts = models.map(m=>`<option value="${m.id}">${m.name||m.id}</option>`).join('');
    const conflictOpts = [
      {v:'ignore',l:this.t('tagger.conflictIgnore')},{v:'copy',l:this.t('tagger.conflictCopy')},{v:'prepend',l:this.t('tagger.conflictPrepend')}
    ];
    const conflictSelect = `<select id="tagger-conflict-action">${conflictOpts.map(o=>`<option value="${o.v}" ${o.v==='copy'?'selected':''}>${o.l}</option>`).join('')}</select>`;
    container.innerHTML = `<div class="card-header">${this.t('tagger.title')}</div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.imageDir')}</div><div class="field-desc">${this.t('tagger.imageDirDesc')}</div></div><div class="field-right"><input type="text" id="tagger-path" value="./train/aki" style="flex:1"><div class="field-actions"><button type="button" class="btn-icon" @click="localFilePickerTagger('tagger-path')" title="${this.t('tagger.imageDir')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button></div></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.model')}</div><div class="field-desc">${this.t('tagger.modelDesc')}</div></div><div class="field-right"><select id="tagger-model">${modelOpts}</select></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.threshold')}</div><div class="field-desc">${this.t('tagger.thresholdDesc')}</div></div><div class="field-right"><div class="stepper"><button type="button" onclick="document.getElementById('tagger-threshold').stepDown()">-</button><input type="number" id="tagger-threshold" value="0.35" min="0" max="1" step="0.01"><button type="button" onclick="document.getElementById('tagger-threshold').stepUp()">+</button></div></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.characterThreshold')}</div><div class="field-desc">${this.t('tagger.characterThresholdDesc')}</div></div><div class="field-right"><div class="stepper"><button type="button" onclick="document.getElementById('tagger-char-threshold').stepDown()">-</button><input type="number" id="tagger-char-threshold" value="0.6" min="0" max="1" step="0.01"><button type="button" onclick="document.getElementById('tagger-char-threshold').stepUp()">+</button></div></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.additionalTags')}</div><div class="field-desc">${this.t('tagger.additionalTagsDesc')}</div></div><div class="field-right"><input type="text" id="tagger-additional" placeholder="e.g. 1girl, solo"></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.excludeTags')}</div><div class="field-desc">${this.t('tagger.excludeTagsDesc')}</div></div><div class="field-right"><input type="text" id="tagger-exclude" placeholder="e.g. watermark"></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.replaceUnderscore')}</div><div class="field-desc">${this.t('tagger.replaceUnderscoreDesc')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-replace-underscore" checked><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.escapeTag')}</div><div class="field-desc">${this.t('tagger.escapeTagDesc')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-escape-tag" checked><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.recursive')}</div><div class="field-desc">${this.t('tagger.recursiveDesc')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-recursive" checked><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.removeDuplicated')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-remove-dup"><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.addRatingTag')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-add-rating"><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.addModelTag')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-add-model"><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
      <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.conflictAction')}</div><div class="field-desc">${this.t('tagger.conflictActionDesc')}</div></div><div class="field-right">${conflictSelect}</div></div>
      <div class="mt-4 flex gap-2"><button class="btn btn-primary" @click="runTagger()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> ${this.t('tagger.start')}</button><button class="btn btn-ghost" @click="stopTagger()" id="tagger-stop-btn" disabled><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> ${this.t('tagger.stop')}</button></div>
      <div id="tagger-output" class="mt-2" style="padding:12px;background:var(--bg-preview);border-radius:var(--radius-md);font-family:var(--font-mono);font-size:12px;color:var(--text-preview);min-height:40px;max-height:240px;overflow-y:auto;display:none"></div>`;
  },

  async runTagger() {
    const path = document.getElementById('tagger-path').value;
    const model = document.getElementById('tagger-model').value;
    const threshold = parseFloat(document.getElementById('tagger-threshold').value);
    const charThreshold = parseFloat(document.getElementById('tagger-char-threshold')?.value || '0.6');
    const additional = document.getElementById('tagger-additional').value;
    const exclude = document.getElementById('tagger-exclude').value;
    const conflictAction = document.getElementById('tagger-conflict-action')?.value || 'copy';
    const removeDup = document.getElementById('tagger-remove-dup')?.checked || false;
    if (!path) { this.toast(this.t('common.specifyDir')); return; }
    this.taggerRunning = true; document.getElementById('tagger-stop-btn').disabled = false;
    const out = document.getElementById('tagger-output'); out.style.display='block'; out.textContent=this.t('tagger.running');
    try {
      const r = await fetch('/api/interrogate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,interrogator_model:model,threshold,character_threshold:charThreshold,additional_tags:additional,exclude_tags:exclude,replace_underscore:document.getElementById('tagger-replace-underscore').checked,batch_input_recursive:document.getElementById('tagger-recursive').checked,batch_output_action_on_conflict:conflictAction,add_rating_tag:document.getElementById('tagger-add-rating')?.checked||false,add_model_tag:document.getElementById('tagger-add-model')?.checked||false,escape_tag:document.getElementById('tagger-escape-tag')?.checked||false,batch_remove_duplicated_tag:removeDup,sort_by_alphabetical_order:false,add_confident_as_weight:false,replace_underscore_excludes:'',batch_output_dir:'',batch_output_filename_format:'[name].[output_extension]',batch_output_save_json:false,unload_model_after_running:false})});
      const d = await r.json();
      if (d.status === 'success' && d.data && d.data.task_id) {
        this.pollTaggerProgress(d.data.task_id);
      } else {
        out.textContent = 'Error: '+(d.message||'Unknown');
        this.toast(d.message||this.t('common.failed'));
        this.taggerRunning = false; document.getElementById('tagger-stop-btn').disabled = true;
      }
    } catch(e) { out.textContent='Error: '+e.message; this.toast(this.t('common.failed')+': '+e.message); this.taggerRunning=false; document.getElementById('tagger-stop-btn').disabled=true; }
  },

  async pollTaggerProgress(taskId) {
    const out = document.getElementById('tagger-output');
    if (!this.taggerRunning) return;
    try {
      const r = await fetch(`/api/interrogate/progress?task_id=${taskId}`);
      const d = await r.json();
      if (d.status === 'success' && d.data) {
        const p = d.data;
        const lines = (p.logs || []).slice(-20);
        out.innerHTML = `<div style="margin-bottom:4px;color:var(--accent)">[${p.current}/${p.total}] ${p.current_file || ''}</div>` + lines.map(l => `<div>${l}</div>`).join('');
        out.scrollTop = out.scrollHeight;
        if (p.status === 'done') {
          this.taggerRunning = false; document.getElementById('tagger-stop-btn').disabled = true;
          this.toast(this.t('tagger.completed'));
          return;
        }
        if (p.status === 'error') {
          this.taggerRunning = false; document.getElementById('tagger-stop-btn').disabled = true;
          this.toast(this.t('common.failed'));
          return;
        }
      }
    } catch(e) { /* polling error, ignore */ }
    if (this.taggerRunning) {
      this.taggerPollTimer = setTimeout(() => this.pollTaggerProgress(taskId), 1500);
    }
  },

  stopTagger() {
    this.taggerRunning = false;
    if (this.taggerPollTimer) { clearTimeout(this.taggerPollTimer); this.taggerPollTimer = null; }
    this.toast(this.t('tagger.stop'));
  },

  localFilePickerTagger(inputId) {
    fetch('/api/pick_file?picker_type=folder').then(r=>r.json()).then(d=>{if(d.status==='success'&&d.data&&d.data.path) document.getElementById(inputId).value=d.data.path;}).catch(()=>{});
  },

  openTagEditor() { window.open('/proxy/tageditor','_blank'); },
};
