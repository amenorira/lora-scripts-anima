/* ================================================================
   tag-editor.js -- Batch tag editor (dataset-captions)
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.tagEditorMixin = {
  // -- State --------------------------------------------------
  tagEditorDir: '',
  tagEditorImages: [],
  tagEditorOriginal: {},
  tagEditorModified: false,
  tagEditorDirName: '',

  // -- Methods ------------------------------------------------
  async tagEditorLoad(dir) {
    var d = dir || this.tagEditorDir || (this.form && this.form.train_data_dir) || './train/aki';
    this.tagEditorDir = d;
    this.startProgress();
    try {
      var r = await fetch('/api/tageditor/images?dir=' + encodeURIComponent(d));
      var j = await r.json();
      if (j.status === 'success') {
        this.tagEditorImages = j.data.images || [];
        this.tagEditorDirName = j.data.dir_name || '';
        this.tagEditorOriginal = {};
        var self = this;
        this.tagEditorImages.forEach(function(img) { self.tagEditorOriginal[img.path] = img.tags; });
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
    var images = this.tagEditorImages.map(function(img) { return { path: img.path, tags: img.tags }; });
    var self = this;
    fetch('/api/tageditor/save-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: images }),
    }).then(function(r) { return r.json(); }).then(function(j) {
      if (j.status === 'success') {
        self.tagEditorOriginal = {};
        self.tagEditorImages.forEach(function(img) { self.tagEditorOriginal[img.path] = img.tags; });
        self.tagEditorModified = false;
        self.renderTagEditor();
      }
    });
  },

  tagEditorRevert() {
    var self = this;
    this.tagEditorImages.forEach(function(img) {
      if (self.tagEditorOriginal[img.path] !== undefined) img.tags = self.tagEditorOriginal[img.path];
    });
    this.tagEditorModified = false;
    this.renderTagEditor();
  },

  async tagEditorBatchOp(op, args) {
    try {
      var r = await fetch('/api/tageditor/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: this.tagEditorDir, operation: op, args: args }),
      });
      var j = await r.json();
      if (j.status === 'success') {
        this.tagEditorLoad();
      } else {
        alert(j.message || 'Operation failed');
      }
    } catch (e) { alert('Operation failed: ' + e); }
  },

  tagEditorUpdate(imgPath, newTags) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (img) { img.tags = newTags; this.tagEditorModified = true; }
  },

  renderTagEditor() {
    var el = document.getElementById('tagEditorContainer');
    if (!el) return;
    var imgs = this.tagEditorImages;
    var self = this;
    var tt = function(k, fb) { return (self.t && self.t('tagEditor.' + k)) || fb || k; };

    var html = '<div class="tag-editor">';

    html += '<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:8px;align-items:center">';
    html += '<span style="font-size:12px;color:var(--text-secondary)">' + tt('datasetDir', 'Dataset') + ':</span>';
    html += '<input type="text" style="flex:1" value="' + this.tagEditorDir + '" id="tagEditorDirInput" @keydown.enter="tagEditorLoad($event.target.value)">';
    html += '<button class="btn btn-sm btn-primary" @click="tagEditorLoad(document.getElementById(\'tagEditorDirInput\').value)">' + tt('loadImages', 'Load') + '</button>';
    html += '<span style="font-size:12px;color:var(--text-tertiary)">' + imgs.length + ' images</span>';
    html += '</div></div>';

    if (!imgs.length) {
      html += '<div style="text-align:center;padding:40px;color:var(--text-tertiary)">' + tt('noImages', 'No images found') + '</div>';
      el.innerHTML = html;
      return;
    }

    html += '<div class="card" style="margin-bottom:12px"><div class="batch-toolbar">';
    html += '<input type="text" id="batchVal" placeholder="value" style="width:120px"><input type="text" id="batchVal2" placeholder="' + tt('findReplace', 'replace with') + '" style="width:120px">';
    html += '<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp(\'add_prefix\',{value:document.getElementById(\'batchVal\').value})">' + tt('addPrefix', 'Add Prefix') + '</button>';
    html += '<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp(\'add_suffix\',{value:document.getElementById(\'batchVal\').value})">' + tt('addSuffix', 'Add Suffix') + '</button>';
    html += '<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp(\'find_replace\',{find:document.getElementById(\'batchVal\').value,replace:document.getElementById(\'batchVal2\').value})">' + tt('findReplace', 'Find & Replace') + '</button>';
    html += '<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp(\'delete_tag\',{value:document.getElementById(\'batchVal\').value})">' + tt('deleteTag', 'Delete') + '</button>';
    html += '<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp(\'dedup\',{})">' + tt('dedup', 'Dedup') + '</button>';
    html += '<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp(\'sort\',{})">' + tt('sort', 'Sort') + '</button>';
    html += '</div></div>';

    html += '<div class="tag-editor-grid">';
    imgs.forEach(function(img, idx) {
      var tagPills = (img.tags || '').split(',').filter(function(t) { return t.trim(); }).map(function(t) {
        var escPath = img.path.replace(/'/g,"\\'");
        var escTag = t.trim().replace(/'/g,"\\'");
        return '<span class="tag-pill" @click="tagEditorRemoveTag(\'' + escPath + '\',\'' + escTag + '\')" title="' + tt('clickToDelete', 'Click to remove') + '">' + t.trim() + '</span>';
      }).join('');
      var isModified = self.tagEditorOriginal[img.path] !== undefined && self.tagEditorOriginal[img.path] !== img.tags;
      var escPath2 = img.path.replace(/'/g,"\\'");

      html += '<div class="tag-editor-item ' + (isModified ? 'modified' : '') + '">';
      html += '<div class="tag-editor-thumb"><img src="' + img.thumbnail + '" loading="lazy" alt="' + img.name + '"/></div>';
      html += '<div class="tag-editor-info">';
      html += '<div class="tag-editor-filename">' + img.name + (isModified ? ' *' : '') + '</div>';
      html += '<div class="tag-editor-tags">' + tagPills + '</div>';
      html += '<textarea class="tag-editor-textarea" id="tagtext-' + idx + '" @input="tagEditorUpdate(\'' + escPath2 + '\',$event.target.value)" @focus="tagEditorMarkDirty()" rows="2">' + img.tags + '</textarea>';
      html += '</div></div>';
    });
    html += '</div>';

    html += '</div>';
    el.innerHTML = html;
  },

  tagEditorRemoveTag(imgPath, tag) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var tagList = img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t && t !== tag; });
    img.tags = tagList.join(', ');
    this.tagEditorModified = true;
    this.renderTagEditor();
  },

  tagEditorMarkDirty() {
    this.tagEditorModified = true;
  },
};
