/* ================================================================
   tag-editor.js — Batch tag editor (dataset-captions)
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.tagEditorMixin = {
  // ── State ──────────────────────────────────────────────
  tagEditorDir: '',
  tagEditorImages: [],
  tagEditorOriginal: {},
  tagEditorModified: false,
  tagEditorDirName: '',

  // ── Methods ────────────────────────────────────────────
  async tagEditorLoad(dir) {
    const d = dir || this.tagEditorDir || this.form?.train_data_dir || './train/aki';
    this.tagEditorDir = d;
    this.startProgress();
    try {
      const r = await fetch('/api/tageditor/images?dir=' + encodeURIComponent(d));
      const j = await r.json();
      if (j.status === 'success') {
        this.tagEditorImages = j.data.images || [];
        this.tagEditorDirName = j.data.dir_name || '';
        this.tagEditorOriginal = {};
        this.tagEditorImages.forEach(img => { this.tagEditorOriginal[img.path] = img.tags; });
        this.tagEditorModified = false;
        this.renderTagEditor();
      } else {
        this.tagEditorImages = [];
        this.renderTagEditor();
      }
    } catch (e) { this.tagEditorImages = []; this.renderTagEditor(); }
    finally { this.finishProgress(); }
  },

  tagEditorSaveAll() {
    if (!this.tagEditorModified) return;
    const images = this.tagEditorImages.map(img => ({ path: img.path, tags: img.tags }));
    fetch('/api/tageditor/save-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    }).then(r => r.json()).then(j => {
      if (j.status === 'success') {
        this.tagEditorOriginal = {};
        this.tagEditorImages.forEach(img => { this.tagEditorOriginal[img.path] = img.tags; });
        this.tagEditorModified = false;
        this.renderTagEditor();
      }
    });
  },

  tagEditorRevert() {
    this.tagEditorImages.forEach(img => {
      if (this.tagEditorOriginal[img.path] !== undefined) img.tags = this.tagEditorOriginal[img.path];
    });
    this.tagEditorModified = false;
    this.renderTagEditor();
  },

  async tagEditorBatchOp(op, args) {
    try {
      const r = await fetch('/api/tageditor/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: this.tagEditorDir, operation: op, args }),
      });
      const j = await r.json();
      if (j.status === 'success') {
        this.tagEditorLoad(); // reload after batch op
      } else {
        alert(j.message || 'Operation failed');
      }
    } catch (e) { alert('Operation failed: ' + e); }
  },

  tagEditorUpdate(imgPath, newTags) {
    const img = this.tagEditorImages.find(i => i.path === imgPath);
    if (img) { img.tags = newTags; this.tagEditorModified = true; }
  },

  renderTagEditor() {
    const el = document.getElementById('tagEditorContainer');
    if (!el) return;
    const imgs = this.tagEditorImages;
    const tt = (k, fb) => this.t('tagEditor.' + k) || fb || k;

    let html = '<div class="tag-editor">';

    html += `<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:8px;align-items:center">
      <span style="font-size:12px;color:var(--text-secondary)">${tt('datasetDir', 'Dataset')}:</span>
      <input type="text" style="flex:1" value="${this.tagEditorDir}" id="tagEditorDirInput"
        @keydown.enter="tagEditorLoad($event.target.value)">
      <button class="btn btn-sm btn-primary" @click="tagEditorLoad(document.getElementById('tagEditorDirInput').value)">${tt('loadImages', 'Load')}</button>
      <span style="font-size:12px;color:var(--text-tertiary)">${imgs.length} images</span>
    </div></div>`;

    if (!imgs.length) {
      html += `<div style="text-align:center;padding:40px;color:var(--text-tertiary)">${tt('noImages', 'No images found, load a dataset first')}</div>`;
      el.innerHTML = html;
      return;
    }

    html += '<div class="card" style="margin-bottom:12px"><div class="batch-toolbar">';
    html += `<input type="text" id="batchVal" placeholder="value" style="width:120px"><input type="text" id="batchVal2" placeholder="${tt('findReplace', 'replace with')}" style="width:120px">`;
    html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('add_prefix',{value:document.getElementById('batchVal').value})">${tt('addPrefix', 'Add Prefix')}</button>`;
    html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('add_suffix',{value:document.getElementById('batchVal').value})">${tt('addSuffix', 'Add Suffix')}</button>`;
    html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('find_replace',{find:document.getElementById('batchVal').value,replace:document.getElementById('batchVal2').value})">${tt('findReplace', 'Find & Replace')}</button>`;
    html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('delete_tag',{value:document.getElementById('batchVal').value})">${tt('deleteTag', 'Delete')}</button>`;
    html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('dedup',{})">${tt('dedup', 'Dedup')}</button>`;
    html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('sort',{})">${tt('sort', 'Sort')}</button>`;
    html += '</div></div>';

    html += '<div class="tag-editor-grid">';
    imgs.forEach((img, idx) => {
      const tagPills = (img.tags || '').split(',').filter(t => t.trim()).map(t =>
        `<span class="tag-pill" @click="tagEditorRemoveTag('${img.path}','${t.trim().replace(/'/g,"\\'")}')" title="${tt('clickToDelete', 'Click to remove')}">${t.trim()}</span>`
      ).join('');
      const isModified = this.tagEditorOriginal[img.path] !== undefined && this.tagEditorOriginal[img.path] !== img.tags;

      html += `<div class="tag-editor-item ${isModified ? 'modified' : ''}">
        <div class="tag-editor-thumb"><img src="${img.thumbnail}" loading="lazy" alt="${img.name}"/></div>
        <div class="tag-editor-info">
          <div class="tag-editor-filename">${img.name}${isModified ? ' *' : ''}</div>
          <div class="tag-editor-tags">${tagPills}</div>
          <textarea class="tag-editor-textarea" id="tagtext-${idx}"
            @input="tagEditorUpdate('${img.path.replace(/'/g,"\\'")}',$event.target.value)"
            @focus="tagEditorMarkDirty('${img.path.replace(/'/g,"\\'")}')"
            rows="2">${img.tags}</textarea>
        </div>
      </div>`;
    });
    html += '</div>';

    html += '</div>';
    el.innerHTML = html;
  },

  tagEditorRemoveTag(imgPath, tag) {
    const img = this.tagEditorImages.find(i => i.path === imgPath);
    if (!img) return;
    const tagList = img.tags.split(',').map(t => t.trim()).filter(t => t && t !== tag);
    img.tags = tagList.join(', ');
    this.tagEditorModified = true;
    this.renderTagEditor();
  },

  tagEditorMarkDirty() {
    this.tagEditorModified = true;
  },
};
