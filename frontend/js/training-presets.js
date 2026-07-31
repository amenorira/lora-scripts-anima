/* ================================================================
   training-presets.js — Preset workspace (双栏 + 解耦编辑器)
   Mixin merged into animaApp Alpine component

   设计要点：
   - 编辑器维护独立 presetEditor.entries，与主训练表单 this.form 完全解耦，
     不再劫持 form/formDefaults/formHistory，根治旧 Edit 模式副作用。
   - 字段元信息复用 window.TRAIN_SECTIONS (buildFieldMap)。
   - Apply 前快照 this.form，应用后弹"撤销"toast。
   - 导入走后端 /api/presets/parse（替代前端残废的 parseToml）。
   ================================================================ */

window.trainingPresetsMixin = {
  // ── 列表/筛选 ─────────────────────────────────────────
  allPresets: [],
  presets: [],
  presetsLoaded: false,
  presetsLoading: false,
  presetSearch: '',
  presetTypeFilter: 'all',        // 'all' | 'anima-lora' | 'sdxl-lora'
  presetSort: 'name',             // 'name' | 'type' | 'params'
  presetSelectedName: '',
  presetBatchMode: false,
  selectedPresets: [],

  // ── 当前应用中的预设徽标（保留供 header preset-badge 复用）──
  currentPreset: null,
  currentPresetName: '',

  // ── 对比/差异高亮（保留供 training-core 表单高亮联动）──
  previewPreset: null,
  diffCounts: { modified: 0, added: 0 },
  formDiffMap: null,

  // ── 编辑器状态 ─────────────────────────────────────────
  presetEditor: {
    mode: 'view',                 // 'view' | 'edit' | 'new'
    tab: 'meta',                  // 'meta' | 'params' | 'diff'
    meta: { name: '', version: '1.0', author: '', train_type: 'anima-lora', description: '' },
    entries: [],                  // [{key, value, def, sectionKey, sectionTitleKey, sectionTitle, advanced, subGroup, hidden, custom, type}]
    paramSearch: '',
    sectionCollapsed: {},         // section 折叠状态
    advancedCollapsed: {}         // advanced 折叠状态（key: sectionKey 或 sectionKey--subGroup）
  },

  // ── 兼容字段（旧弹窗已移除，保留以避免外部赋值报错）──
  showLoadModal: false,
  showSaveModal: false,
  showEditModal: false,
  showConfirmModal: false,
  confirmTitle: '',
  confirmMessage: '',
  confirmCallback: null,
  confirmActionLabel: '',

  // ── 对比勾选 ───────────────────────────────────────────
  presetDiffSelected: [],

  // ── 内部 ───────────────────────────────────────────────
  _presetFieldMap: null,
  _editingOriginalName: '',
  _preApplySnapshot: null,
  _presetDataKeys: null,    // 当前选中预设的原始 data key 集合（仅用于对比 Tab 限定比较范围）
  _importedPreset: null,
  showPresetImportModal: false,

  // ══════════════════════════════════════════════════════
  // 列表加载与筛选
  // ══════════════════════════════════════════════════════
  async loadPresets() {
    this.presetsLoading = true;
    try {
      const r = await fetch('/api/presets');
      const d = await r.json();
      if (d.status === 'success' && d.data && d.data.presets) {
        this.allPresets = d.data.presets;
        this.presetsLoaded = true;
        this._refreshFilteredPresets();
      }
    } catch (e) { /* ignore */ }
    finally { this.presetsLoading = false; }
  },

  _refreshFilteredPresets() {
    const routeCfg = ROUTE_CONFIG[this.currentRoute] || {};
    // 同一训练页可以切换多个训练核心，当前表单类型比路由默认类型更准确。
    const currentType = (this.form && this.form.model_train_type) || routeCfg.trainType || 'anima-lora';
    this.presets = this.allPresets.filter(p =>
      p && p.metadata && (!p.metadata.train_type || p.metadata.train_type === currentType)
    );
  },

  // 列表展示用：应用搜索/过滤/排序后的预设
  get filteredPresetList() {
    const q = (this.presetSearch || '').toLowerCase().trim();
    let list = this.allPresets.filter(p => {
      if (!p || !p.metadata) return false;
      if (this.presetTypeFilter !== 'all') {
        const tt = p.metadata.train_type || 'anima-lora';
        if (tt !== this.presetTypeFilter) return false;
      }
      if (q) {
        const hay = (
          (p.metadata.name || '') + ' ' +
          (p.metadata.description || '') + ' ' +
          (p.metadata.train_type || '')
        ).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sort = this.presetSort;
    list = list.slice().sort((a, b) => {
      if (sort === 'type') {
        const ta = (a.metadata.train_type || '');
        const tb = (b.metadata.train_type || '');
        return (ta < tb ? -1 : ta > tb ? 1 : 0) || a.metadata.name.localeCompare(b.metadata.name);
      }
      if (sort === 'params') {
        const pa = Object.keys(a.data || {}).length;
        const pb = Object.keys(b.data || {}).length;
        return (pb - pa) || a.metadata.name.localeCompare(b.metadata.name);
      }
      return a.metadata.name.localeCompare(b.metadata.name);
    });
    return list;
  },

  // ══════════════════════════════════════════════════════
  // 选中 / 模式切换
  // ══════════════════════════════════════════════════════
  selectPreset(p) {
    if (!p) { this.presetSelectedName = ''; return; }
    this.presetSelectedName = p.metadata.name;
    this._enterViewMode(p);
  },

  _enterViewMode(p) {
    const tt = (p.metadata && p.metadata.train_type) || 'anima-lora';
    this._presetFieldMap = this.buildFieldMap(tt);
    const data = p.data || {};
    this._presetDataKeys = new Set(Object.keys(data));
    this.presetEditor.mode = 'view';
    this.presetEditor.tab = 'meta';
    this.presetEditor.meta = {
      name: p.metadata.name || '',
      version: p.metadata.version || '1.0',
      author: p.metadata.author || '',
      train_type: p.metadata.train_type || tt,
      description: p.metadata.description || ''
    };
    this.presetEditor.entries = this._buildEntries(data, tt);
    this.presetEditor.paramSearch = '';
    this.presetEditor.sectionCollapsed = {};
    this.presetEditor.advancedCollapsed = {};
  },

  openPresetNew() {
    const tt = (ROUTE_CONFIG[this.currentRoute] || {}).trainType ||
               (this.form && this.form.model_train_type) || 'anima-lora';
    this._presetFieldMap = this.buildFieldMap(tt);
    const seedData = (this.form ? { ...this.form } : {});
    this._presetDataKeys = new Set(Object.keys(seedData));
    this.presetEditor.mode = 'new';
    this.presetEditor.tab = 'meta';
    this.presetEditor.meta = { name: '', version: '1.0', author: '', train_type: tt, description: '' };
    // 新建预设默认填入当前训练表单值，方便基于现有配置保存
    this.presetEditor.entries = this._buildEntries(seedData, tt);
    this.presetEditor.paramSearch = '';
    this.presetEditor.sectionCollapsed = {};
    this.presetEditor.advancedCollapsed = {};
    this.presetSelectedName = '';
  },

  openPresetEdit(p) {
    if (!p) return;
    this.presetSelectedName = p.metadata.name;
    const tt = (p.metadata && p.metadata.train_type) || 'anima-lora';
    this._presetFieldMap = this.buildFieldMap(tt);
    this._editingOriginalName = p.metadata.name;
    const data = JSON.parse(JSON.stringify(p.data || {}));
    this._presetDataKeys = new Set(Object.keys(data));
    this.presetEditor.mode = 'edit';
    this.presetEditor.tab = 'meta';
    this.presetEditor.meta = {
      name: p.metadata.name || '',
      version: p.metadata.version || '1.0',
      author: p.metadata.author || '',
      train_type: p.metadata.train_type || tt,
      description: p.metadata.description || ''
    };
    this.presetEditor.entries = this._buildEntries(data, tt);
    this.presetEditor.paramSearch = '';
    this.presetEditor.sectionCollapsed = {};
    this.presetEditor.advancedCollapsed = {};
  },

  cancelPresetEditor() {
    if (this.presetSelectedName) {
      const p = this.allPresets.find(x => x.metadata.name === this.presetSelectedName);
      if (p) { this._enterViewMode(p); return; }
    }
    this.presetEditor.mode = 'view';
    this.presetEditor.entries = [];
  },

  // ══════════════════════════════════════════════════════
  // 字段元信息
  // ══════════════════════════════════════════════════════
  buildFieldMap(trainType) {
    const sections = window.getVisibleSections(trainType || 'anima-lora');
    const map = {};
    sections.forEach(s => {
      (s.fields || []).forEach(f => {
        if (!f.hidden) map[f.key] = Object.assign({}, f, { _sectionKey: s.key, _sectionTitleKey: s.titleKey });
      });
    });
    return map;
  },

  _buildEntries(data, trainType) {
    // 以该 train_type 的可见字段全集为渲染基础（与训练表单一致），
    // 值用预设 data 覆盖默认；预设里多出的非可见字段归入"自定义"分组。
    // 保留 section 与字段的【原生顺序】，不再用 localeCompare。
    const sections = window.getVisibleSections(trainType || 'anima-lora');
    const customTitle = this.t('preset.customKeys');
    const seen = new Set();
    const entries = [];
    sections.forEach(s => {
      (s.fields || []).forEach(f => {
        if (f.hidden && f.key !== 'model_train_type') {
          // hidden 字段（logging_dir/log_with 等）：保留数据用于保存，但不显示。
          // 仍生成 entry，渲染时由 hidden 标志跳过。
          seen.add(f.key);
          entries.push({
            key: f.key, value: data[f.key] !== undefined ? data[f.key] : (f.default !== undefined ? f.default : ''),
            def: f, sectionKey: s.key, sectionTitleKey: s.titleKey, sectionTitle: this.t(s.titleKey) || s.key,
            advanced: !!f.advanced, subGroup: f.subGroup || null, hidden: true, custom: false, type: f.type || 'text'
          });
          return;
        }
        seen.add(f.key);
        let value = data[f.key];
        if (value === undefined || value === null) {
          if (f.default !== undefined && f.default !== null && f.default !== '') value = f.default;
          else if (f.type === 'toggle') value = false;
          else if (f.type === 'select' && f.options && f.options.length) value = f.options[0].v;
          else value = '';
        }
        entries.push({
          key: f.key, value, def: f, sectionKey: s.key, sectionTitleKey: s.titleKey, sectionTitle: this.t(s.titleKey) || s.key,
          advanced: !!f.advanced, subGroup: f.subGroup || null, hidden: !!f.hidden, custom: false, type: f.type || 'text'
        });
      });
    });
    // 预设里多出的、不在可见字段集的 key → 自定义分组
    Object.keys(data).forEach(k => {
      if (seen.has(k)) return;
      let value = data[k];
      let type = 'text';
      if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
        type = 'textarea';
        try { value = JSON.stringify(value); } catch (_) { /* keep */ }
      }
      entries.push({
        key: k, value, def: null, sectionKey: 'custom', sectionTitleKey: '', sectionTitle: customTitle,
        advanced: false, subGroup: null, hidden: false, custom: true, type
      });
    });
    return entries;
  },

  // 参数编辑 Tab 分组：按 section 原生顺序，每 section 拆 basic / advanced / subGroup
  presetEditorGroups() {
    const search = (this.presetEditor.paramSearch || '').toLowerCase().trim();
    const sections = window.getVisibleSections(this.presetEditor.meta.train_type || 'anima-lora');
    const sectionOrder = sections.map(s => s.key);
    const groups = [];
    const idx = {};
    const ensure = (sectionKey, sectionTitle) => {
      if (idx[sectionKey] === undefined) {
        idx[sectionKey] = groups.length;
        groups.push({ sectionKey, sectionTitle, basic: [], advanced: [], subGroups: {} });
      }
      return idx[sectionKey];
    };
    // 自定义分组单独追加（不参与 sectionOrder）
    ensure('custom', this.t('preset.customKeys'));

    for (const e of this.presetEditor.entries) {
      if (e.hidden) continue; // hidden 字段不渲染
      if (search) {
        const label = (e.def && e.def.descKey) ? (this.t(e.def.descKey) || '') : '';
        const hay = (e.key + ' ' + label + ' ' + String(e.value)).toLowerCase();
        if (!hay.includes(search)) continue;
      }
      const gi = ensure(e.sectionKey, e.sectionTitle);
      const g = groups[gi];
      if (e.subGroup) {
        if (!g.subGroups[e.subGroup]) g.subGroups[e.subGroup] = { name: e.subGroup, basic: [], advanced: [] };
        (e.advanced ? g.subGroups[e.subGroup].advanced : g.subGroups[e.subGroup].basic).push(e);
      } else {
        (e.advanced ? g.advanced : g.basic).push(e);
      }
    }
    // 按 sectionOrder 排序，custom 放最后
    groups.sort((a, b) => {
      if (a.sectionKey === 'custom') return 1;
      if (b.sectionKey === 'custom') return -1;
      const ai = sectionOrder.indexOf(a.sectionKey);
      const bi = sectionOrder.indexOf(b.sectionKey);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
    // 过滤空 section
    return groups.filter(g => g.basic.length || g.advanced.length || Object.keys(g.subGroups).length);
  },

  // 子组标题
  presetSubGroupTitle(name) {
    if (name === 'kohya') return this.t('common.lycorisSubgroupTitle') || 'LyCORIS';
    return name;
  },

  // 字段描述（i18n，含 train-type 后缀回退，与训练表单 renderField 一致）
  presetFieldDesc(e) {
    if (!e || !e.def || !e.def.descKey) return e ? e.key : '';
    const tt = this.presetEditor.meta.train_type || 'anima-lora';
    const suffix = tt === 'anima-lora' ? '_anima' : (tt === 'sdxl-lora' ? '_sdxl' : '');
    const specific = this.t(e.def.descKey + suffix);
    if (specific && specific !== (e.def.descKey + suffix)) return specific;
    return this.t(e.def.descKey) || e.def.descKey || e.key;
  },

  // 字段 hint
  presetFieldHint(e) {
    if (!e || !e.def) return '';
    const values = {};
    (this.presetEditor.entries || []).forEach(entry => {
      values[entry.key] = entry.value;
    });
    const trainType = this.presetEditor.meta.train_type || 'anima-lora';
    return this._resolveFieldHintText(e.def, values, trainType);
  },

  // textarea / 文件路径字段用全宽布局（info 在上、控件在下），与训练表 isFullWidth 一致
  presetFieldFullWidth(e) {
    if (!e) return false;
    if (e.type === 'textarea') return true;
    if (e.def && e.def.role && String(e.def.role).startsWith('file-')) return true;
    return false;
  },

  // ── 条件显隐：基于 presetEditor.entries 求值（与训练表 _evalShowIfCond/_fieldVisible 等价）──
  // 按 key 在 entries 中查值。entries 是 Alpine 深响应式数组，访问 entry.value 建立依赖。
  _presetEntryValue(key) {
    const arr = this.presetEditor.entries;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].key === key) return arr[i].value;
    }
    return undefined;
  },

  presetEvalCond(c) {
    const pv = this._presetEntryValue(c.key);
    if (c.eq !== undefined) {
      if (String(pv) === String(c.eq)) return true;
      if (c.or && Array.isArray(c.or)) return c.or.some(v => String(pv) === String(v));
      return false;
    }
    if (c.neq !== undefined) {
      return String(pv) !== String(c.neq) && pv !== null && pv !== undefined && String(pv) !== '';
    }
    return true;
  },

  // 字段在当前预设值下是否可见（综合 showIf/showIfAny）
  presetFieldVisible(e) {
    if (!e || e.hidden) return false;
    const def = e.def;
    if (def && def.showIf) {
      const sf = def.showIf;
      if (Array.isArray(sf)) {
        if (!sf.every(c => this.presetEvalCond(c))) return false;
      } else {
        if (!this.presetEvalCond(sf)) return false;
      }
    }
    if (def && def.showIfAny) {
      if (!def.showIfAny.some(group => group.every(c => this.presetEvalCond(c)))) return false;
    }
    return true;
  },

  // 子组级显隐：取该子组字段的 network_module eq 条件
  presetSubGroupVisible(grpSectionKey, sgName) {
    const arr = this.presetEditor.entries;
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (e.subGroup === sgName && e.def) {
        const sf = e.def.showIf || (e.def.showIfAny && e.def.showIfAny[0] && e.def.showIfAny[0][0]);
        if (sf && sf.key === 'network_module') {
          return this.presetEvalCond(sf);
        }
      }
    }
    return true;
  },

  // select 控件选项（统一为 [{label, options:[{v,l}]}]）
  presetFieldOptions(def) {
    if (!def) return [];
    if (def.options) return [{ label: '', options: def.options }];
    if (def.groups) return def.groups.map(g => ({ label: this.t(g.labelKey) || '', options: g.options }));
    return [];
  },

  togglePresetSection(sk) {
    const cur = this.presetEditor.sectionCollapsed[sk];
    this.presetEditor.sectionCollapsed = { ...this.presetEditor.sectionCollapsed, [sk]: !cur };
  },

  isPresetSectionCollapsed(sk) {
    return !!this.presetEditor.sectionCollapsed[sk];
  },

  togglePresetAdvanced(key) {
    const cur = this.presetEditor.advancedCollapsed[key];
    // undefined（首次）→ false（展开）；true→false；false→true
    const next = cur === undefined ? false : !cur;
    this.presetEditor.advancedCollapsed = { ...this.presetEditor.advancedCollapsed, [key]: next };
  },

  isPresetAdvancedCollapsed(key) {
    // 默认折叠（与训练表单一致：undefined 视为折叠）
    return this.presetEditor.advancedCollapsed[key] !== false;
  },

  // ══════════════════════════════════════════════════════
  // 保存（含重命名）
  // ══════════════════════════════════════════════════════
  async savePresetFromEditor() {
    const meta = this.presetEditor.meta;
    const name = (meta.name || '').trim();
    if (!name) { this.toast(this.t('common.enterConfigName')); return; }
    const data = {};
    for (const e of this.presetEditor.entries) data[e.key] = e.value;

    // 编辑模式下若改名，先调 rename 删旧文件、写新名（含旧 data），再 save 覆盖 data
    if (this.presetEditor.mode === 'edit' && this._editingOriginalName && this._editingOriginalName !== name) {
      try {
        const rr = await fetch('/api/presets/' + encodeURIComponent(this._editingOriginalName) + '/rename', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ new_name: name })
        });
        const rd = await rr.json();
        if (rd.status !== 'success') { this.toast(this.t('common.failed') + ': ' + (rd.message || '')); return; }
      } catch (e) { this.toast(this.t('common.failed') + ': ' + e.message); return; }
    }

    try {
      const r = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          description: meta.description || '',
          version: meta.version || '1.0',
          author: meta.author || '',
          train_type: meta.train_type || '',
          data: data
        })
      });
      const d = await r.json();
      if (d.status !== 'success') { this.toast(this.t('common.failed') + ': ' + (d.message || '')); return; }
      this._editingOriginalName = '';
      // 保存前记下原始 key 集（不包含 _buildEntries 自动填充的默认字段）
      const originalKeys = new Set(this._presetDataKeys || []);
      await this.loadPresets();
      const saved = this.allPresets.find(p => p.metadata.name === name);
      this.presetSelectedName = name;
      if (saved) {
        this._enterViewMode(saved);
        // 恢复原始 key 集，避免重新加载后 _presetDataKeys 被全量字段（140+）撑大
        this._presetDataKeys = originalKeys;
      }
      this.currentPresetName = name;
      this.currentPreset = saved || { metadata: { ...meta }, data };
      this.toast(this.t('common.saved'));
    } catch (e) { this.toast(this.t('common.failed') + ': ' + e.message); }
  },

  // ══════════════════════════════════════════════════════
  // 应用预设到训练表单（带快照撤销）
  // ══════════════════════════════════════════════════════
  // 从右栏应用：用当前编辑器 data/meta 构造临时 preset
  applyPresetFromEditor() {
    const data = {};
    for (const e of this.presetEditor.entries) data[e.key] = e.value;
    const preset = { metadata: { ...this.presetEditor.meta }, data };
    this.applyPresetWithSnapshot(preset);
  },

  // 从列表应用：直接用原 preset
  applyPresetFromList(p) {
    if (!p) return;
    this.applyPresetWithSnapshot(p);
  },

  _capturePresetApplySnapshot() {
    try {
      this._preApplySnapshot = {
        form: JSON.parse(JSON.stringify(this.form || {})),
        formDefaults: JSON.parse(JSON.stringify(this.formDefaults || {})),
        fieldSources: JSON.parse(JSON.stringify(this._fieldSources || {})),
        profileFieldSources: JSON.parse(JSON.stringify(this._profileFieldSources || {})),
        autoValueRules: JSON.parse(JSON.stringify(this._autoValueRules || [])),
        activeTrainType: this._activeTrainType || this.form?.model_train_type || '',
      };
    } catch (_) {
      this._preApplySnapshot = null;
    }
  },

  applyPresetWithSnapshot(preset) {
    if (!preset || !preset.data) return;
    // 快照表单、默认基线和来源状态，用于完整撤销
    this._capturePresetApplySnapshot();
    const count = Object.keys(preset.data || {}).length;
    const name = (preset.metadata && preset.metadata.name) || '';
    this.applyPresetNavigate(preset);
    this.toastWithAction(
      this.t('preset.appliedN').replace('{n}', count).replace('{name}', name),
      this.t('preset.undo'),
      () => this.undoApplyPreset(),
      'success'
    );
  },

  undoApplyPreset() {
    const snapshot = this._preApplySnapshot;
    if (!snapshot || !snapshot.form) { this.toast(this.t('preset.noSnapshot')); return; }
    const restoredTrainType = snapshot.activeTrainType || snapshot.form.model_train_type;
    const currentTrainType = this._activeTrainType || this.form.model_train_type;
    const trainTypeChanged = !!restoredTrainType && restoredTrainType !== currentTrainType;
    if (trainTypeChanged && typeof this._clearProfileFieldWatchers === 'function') {
      this._clearProfileFieldWatchers();
    }
    this.form = JSON.parse(JSON.stringify(snapshot.form));
    this.formDefaults = JSON.parse(JSON.stringify(snapshot.formDefaults || snapshot.form));
    this._fieldSources = JSON.parse(JSON.stringify(snapshot.fieldSources || {}));
    this._profileFieldSources = JSON.parse(JSON.stringify(snapshot.profileFieldSources || {}));
    this._autoValueRules = JSON.parse(JSON.stringify(snapshot.autoValueRules || []));
    this._activeTrainType = restoredTrainType || this.form.model_train_type;
    if (trainTypeChanged) {
      const tt = (this.trainTypes || []).find(item => item.v === this._activeTrainType);
      this.currentTrainTypeDesc = tt ? this.t(tt.dk, tt.l) : '';
      this.currentTrainTypeLabel = tt ? tt.l : '';
    }
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;
    this.formDiffMap = null;
    this.diffCounts = { modified: 0, added: 0 };
    this.previewPreset = null;
    this.currentPreset = null;
    this.currentPresetName = '';
    this._preApplySnapshot = null;
    this.updateToml();
    this.rebuildForm();
    if (trainTypeChanged) {
      if (typeof this.setupAutoValueWatchers === 'function') this.setupAutoValueWatchers();
      if (typeof this.setupShowIfWatchers === 'function') this.setupShowIfWatchers();
      if (typeof this.setupReadonlyWatchers === 'function') this.setupReadonlyWatchers();
    }
    this._captureProfileDraft(this.form.model_train_type, this.form);
    this._persistProfileDrafts();
    this._persistProfileFieldSources();
    this.toast(this.t('preset.undone'));
  },

  // ══════════════════════════════════════════════════════
  // 对比当前训练表单
  // ══════════════════════════════════════════════════════
  // 计算编辑器 data 与当前 this.form 的差异列表
  get presetEditorDiffList() {
    const cur = this.form || {};
    const data = {};
    const customKeys = new Set();
    for (const e of this.presetEditor.entries) {
      data[e.key] = e.value;
      if (e.custom) customKeys.add(e.key);
    }
    // 仅比较预设原始 data 中的 key，忽略 _buildEntries 自动填充的默认字段（避免虚增差异）
    const compareKeys = this._presetDataKeys || new Set(Object.keys(data));
    const out = [];
    for (const k of compareKeys) {
      const cv = cur[k];
      const pv = data[k];
      if (pv === undefined) {
        out.push({ key: k, type: 'removed', oldVal: cv, newVal: undefined });
      } else if (cv === undefined) {
        // 仅自定义键标"新增"；标准字段若表单未初始化（首次启动未进训练页）则不产生假警报
        if (customKeys.has(k)) {
          out.push({ key: k, type: 'added', oldVal: undefined, newVal: pv });
        }
      } else if (String(cv) !== String(pv)) {
        out.push({ key: k, type: 'modified', oldVal: cv, newVal: pv });
      }
    }
    // 修改/新增优先，再按 key
    const rank = { modified: 0, added: 1, removed: 2 };
    out.sort((a, b) => (rank[a.type] - rank[b.type]) || a.key.localeCompare(b.key));
    return out;
  },

  get presetEditorDiffCounts() {
    const list = this.presetEditorDiffList;
    const c = { modified: 0, added: 0, removed: 0 };
    for (const d of list) c[d.type]++;
    return c;
  },

  // ── TOML 预览（与训练侧边栏同款语法着色）──
  get presetEditorToml() {
    const lines = [];
    for (const e of this.presetEditor.entries) {
      if (e.hidden) continue;
      if (e.custom) {
        // 自定义键按字符串输出
        lines.push(`${e.key} = ${typeof e.value === 'string' ? '"' + String(e.value).replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"' : String(e.value)}`);
        continue;
      }
      const v = e.value;
      if (v === '' || v === null || v === undefined) continue;
      if (typeof v === 'boolean') {
        lines.push(`${e.key} = ${v}`);
      } else if (typeof v === 'number') {
        lines.push(`${e.key} = ${v}`);
      } else if (Array.isArray(v)) {
        const arr = v.map(x => {
          const s = String(x);
          if (s.startsWith('"') || s.startsWith("'")) return s;
          return /^\d+\.?\d*$/.test(s) ? s : `"${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
        }).join(', ');
        lines.push(`${e.key} = [${arr}]`);
      } else {
        const s = String(v);
        lines.push(`${e.key} = "${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`);
      }
    }
    // 语法着色（与 updateToml 同款）
    const highlighted = lines.map(line => {
      if (line.startsWith('#')) return `<span class="toml-comment">${this.esc(line)}</span>`;
      const eq = line.indexOf('=');
      if (eq === -1) return this.esc(line);
      const key = line.substring(0, eq).trim();
      const val = line.substring(eq + 1).trim();
      const valCls = (val.startsWith('"') || val.startsWith("'")) ? 'toml-str' : 'toml-num';
      return `<span class="toml-key">${this.esc(key)}</span> <span class="toml-eq">=</span> <span class="${valCls}">${this.esc(val)}</span>`;
    }).join('\n');
    return highlighted || '<span class="toml-comment"># (empty)</span>';
  },

  // 对比 Tab：勾选差异项后选择性应用
  applyPresetDiffSelected(selectedKeys) {
    const data = {};
    for (const e of this.presetEditor.entries) {
      if (selectedKeys.indexOf(e.key) >= 0) data[e.key] = e.value;
    }
    if (Object.keys(data).length === 0) return;
    // 快照
    this._capturePresetApplySnapshot();
    // 选择性覆盖（不切训练类型，避免跨路由复杂度）
    const savedWatcher = this._trainTypeWatcher;
    if (savedWatcher) { savedWatcher(); this._trainTypeWatcher = null; }
    try {
      for (const k of Object.keys(data)) this.form[k] = data[k];
      Object.keys(data).forEach(key => this._setFieldSource(key, 'preset', this.form.model_train_type));
    } finally {
      if (savedWatcher) {
        this._trainTypeWatcher = this.$watch('form.model_train_type', (newVal, oldVal) => {
          if (newVal !== oldVal && !this._switchInProgress) {
            this._switchInProgress = true;
            try { this.switchTrainType(newVal); } finally { this._switchInProgress = false; }
          }
        });
      }
    }
    this.formDefaults = { ...this.form };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;
    this.updateToml();
    this.rebuildForm();
    this._captureProfileDraft(this.form.model_train_type, this.form);
    this._persistProfileDrafts();
    this._persistProfileFieldSources();
    this.toastWithAction(
      this.t('preset.diffAppliedN').replace('{n}', Object.keys(data).length),
      this.t('preset.undo'),
      () => this.undoApplyPreset(),
      'success'
    );
  },

  // ══════════════════════════════════════════════════════
  // 删除 / 批量删除
  // ══════════════════════════════════════════════════════
  confirmDeletePreset(p) {
    if (!p || !p.metadata || !p.metadata.name) return;
    const name = p.metadata.name;
    const self = this;
    this.openConfirm(
      this.t('preset.confirmDelete'),
      this.t('preset.confirmDeleteMsg') + ': ' + name,
      async function () {
        try {
          const r = await fetch('/api/presets/' + encodeURIComponent(name), { method: 'DELETE' });
          const d = await r.json();
          if (d.status !== 'success') { self.toast(self.t('common.failed') + ': ' + (d.message || '')); return; }
          if (self.presetSelectedName === name) { self.presetSelectedName = ''; self.presetEditor.entries = []; self.presetEditor.mode = 'view'; }
          await self.loadPresets();
          self.toast(d.message || self.t('preset.cleared'));
        } catch (e) { self.toast(self.t('common.failed') + ': ' + e.message); }
      }
    );
  },

  toggleBatchMode() {
    this.presetBatchMode = !this.presetBatchMode;
    this.selectedPresets = [];
  },

  togglePresetSelection(p) {
    const name = p.metadata.name;
    const idx = this.selectedPresets.indexOf(name);
    if (idx >= 0) this.selectedPresets.splice(idx, 1);
    else this.selectedPresets.push(name);
  },

  isPresetSelected(p) {
    return this.selectedPresets.indexOf(p.metadata.name) >= 0;
  },

  selectAllPresets() {
    this.selectedPresets = this.filteredPresetList.map(p => p.metadata.name);
  },

  deselectAllPresets() {
    this.selectedPresets = [];
  },

  batchDeletePresets() {
    if (this.selectedPresets.length === 0) return;
    const self = this;
    const names = [...this.selectedPresets];
    this.openConfirm(
      this.t('preset.batchDelete'),
      this.t('preset.confirmBatchDelete').replace('{n}', names.length),
      async function () {
        try {
          const r = await fetch('/api/presets/batch_delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names: names })
          });
          const d = await r.json();
          if (d.status !== 'success') { self.toast(self.t('common.failed') + ': ' + (d.message || '')); return; }
          const deleted = (d.data && d.data.deleted) || 0;
          const failed = (d.data && d.data.failed) || [];
          self.presetBatchMode = false;
          self.selectedPresets = [];
          // 清理已删的选中预设
          if (names.indexOf(self.presetSelectedName) >= 0) {
            self.presetSelectedName = '';
            self.presetEditor.entries = [];
            self.presetEditor.mode = 'view';
          }
          await self.loadPresets();
          if (failed.length) {
            self.toast(self.t('preset.deletedCount').replace('{deleted}', deleted).replace('{total}', names.length) + ' · ' + failed.join(', '));
          } else {
            self.toast(self.t('preset.deletedCount').replace('{deleted}', deleted).replace('{total}', names.length));
          }
        } catch (e) { self.toast(self.t('common.failed') + ': ' + e.message); }
      }
    );
  },

  // ══════════════════════════════════════════════════════
  // 导入 / 导出
  // ══════════════════════════════════════════════════════
  // 预设页：导入文件 → 后端解析 → 分流（保存为新预设 / 填入当前训练表单）
  importPresetFile() {
    document.getElementById('presetFileInput').click();
  },

  handlePresetFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    const self = this;
    reader.onload = async (e) => {
      try {
        const r = await fetch('/api/presets/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: e.target.result })
        });
        const d = await r.json();
        if (d.status !== 'success') { self.toast(self.t('common.failed') + ': ' + (d.message || '')); return; }
        self._importedPreset = { metadata: d.data.metadata || {}, data: d.data.data || {} };
        self.showPresetImportModal = true;
      } catch (err) { self.toast(self.t('common.parseError') + ': ' + err.message); }
    };
    reader.readAsText(file);
    event.target.value = '';
  },

  // 导入分流：作为新预设保存
  async importAsNewPreset() {
    const imp = this._importedPreset;
    if (!imp) return;
    const name = (imp.metadata.name || '').trim();
    if (!name) { this.toast(this.t('common.enterConfigName')); return; }
    try {
      const r = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          description: imp.metadata.description || '',
          version: imp.metadata.version || '1.0',
          author: imp.metadata.author || '',
          train_type: imp.metadata.train_type || '',
          data: imp.data
        })
      });
      const d = await r.json();
      if (d.status !== 'success') { this.toast(this.t('common.failed') + ': ' + (d.message || '')); return; }
      this.showPresetImportModal = false;
      this._importedPreset = null;
      await this.loadPresets();
      const saved = this.allPresets.find(p => p.metadata.name === name);
      if (saved) this.selectPreset(saved);
      this.toast(this.t('common.imported'));
    } catch (e) { this.toast(this.t('common.failed') + ': ' + e.message); }
  },

  // 导入分流：仅填入当前训练表单
  importIntoForm() {
    const imp = this._importedPreset;
    if (!imp) return;
    this.applyPresetWithSnapshot({ metadata: imp.metadata, data: imp.data });
    this.showPresetImportModal = false;
    this._importedPreset = null;
  },

  cancelPresetImport() {
    this.showPresetImportModal = false;
    this._importedPreset = null;
  },

  // 训练页右侧面板：导出当前表单为 TOML 文件下载
  downloadConfig() {
    const blob = new Blob([this.tomlRaw], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const isKrea2Preset = this.form.model_train_type === 'krea2-lora';
    a.href = url;
    a.download = (this.form.output_name || 'config') + (isKrea2Preset ? '-krea2-preset.toml' : '.toml');
    a.click();
    URL.revokeObjectURL(url); this.toast(this.t('common.downloaded'));
  },

  // 训练页右侧面板：导入 TOML 文件填表（走后端解析）
  importConfigFile() { document.getElementById('configFileInput').click(); },

  _applyImportedFlatConfig(parsed) {
    const validTypes = new Set((this.trainTypes || []).map(item => item.v));
    const currentType = String(this.form && this.form.model_train_type || 'anima-lora');
    const importedType = String(parsed.model_train_type || currentType);
    if (!validTypes.has(importedType)) {
      throw new Error(`Unsupported model_train_type: ${importedType}`);
    }

    const applyValues = () => {
      const defaults = this._buildFormDefaults(importedType);
      const validKeys = new Set(['model_train_type']);
      window.getVisibleSections(importedType).forEach(section => {
        (section.fields || []).forEach(field => validKeys.add(field.key));
      });
      const imported = {};
      Object.entries(parsed).forEach(([key, value]) => {
        if (validKeys.has(key)) imported[key] = value;
      });

      this.form = { ...defaults, ...imported, model_train_type: importedType };
      this._activeTrainType = importedType;
      this._replaceProfileFieldSources(importedType, defaults, Object.keys(imported), 'import');
      this._normalizeProfileSelectValues(importedType, defaults);
      if (importedType === 'krea2-lora') this._syncKrea2CacheDir();
      this._captureProfileDraft(importedType, this.form, defaults);
      this.formDefaults = { ...defaults };
      this.formHistory = [this.formDefaults];
      this.formHistoryIdx = 0;
      this.updateToml();
      this.rebuildForm();
      this._captureProfileDraft(importedType, this.form, defaults);
      this._persistProfileDrafts();
      this._persistProfileFieldSources();
    };

    // Switch the runtime profile first so its deferred network ownership check
    // completes before imported adapter choices are restored.
    if (importedType !== currentType) {
      this._switchInProgress = true;
      try { this.switchTrainType(importedType); }
      finally { this._switchInProgress = false; }
      if (typeof this.$nextTick === 'function') {
        return new Promise((resolve, reject) => {
          this.$nextTick(() => {
            try { applyValues(); resolve(); }
            catch (error) { reject(error); }
          });
        });
      }
    }

    applyValues();
    return Promise.resolve();
  },

  handleConfigFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    const self = this;
    reader.onload = async (e) => {
      try {
        const r = await fetch('/api/presets/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: e.target.result })
        });
        const d = await r.json();
        if (d.status !== 'success') { self.toast(self.t('common.parseError') + ': ' + (d.message || '')); return; }
        const parsed = d.data.data || {};
        if (Object.keys(parsed).length === 0) { self.toast(self.t('common.invalidToml')); return; }
        await self._applyImportedFlatConfig(parsed);
        self.toast(self.t('common.imported'));
      } catch (err) { self.toast(self.t('common.parseError') + ': ' + err.message); }
    };
    reader.readAsText(file);
    event.target.value = '';
  },

  // ══════════════════════════════════════════════════════
  // Confirm Modal
  // ══════════════════════════════════════════════════════
  openConfirm(title, message, callback, actionLabel = '') {
    this.confirmTitle = title;
    this.confirmMessage = message;
    this.confirmCallback = callback;
    this.confirmActionLabel = actionLabel;
    this.showConfirmModal = true;
  },
  confirmAction() {
    this.showConfirmModal = false;
    const cb = this.confirmCallback;
    this.confirmCallback = null;
    this.confirmActionLabel = '';
    if (cb) cb();
  },
  cancelConfirm() {
    this.showConfirmModal = false;
    this.confirmCallback = null;
    this.confirmActionLabel = '';
  },

  // ══════════════════════════════════════════════════════
  // toast + 可操作按钮
  // ══════════════════════════════════════════════════════
  toastWithAction(message, actionLabel, actionCallback, type) {
    const c = document.getElementById('toastContainer');
    if (!c) { this.toast(message, type); return; }
    const el = document.createElement('div');
    el.className = 'toast toast-action';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    if (type) el.classList.add(type);
    let icon = '';
    if (type === 'success') {
      icon = '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16.5 9.5"/></svg>';
    }
    el.innerHTML = icon + '<span class="toast-action-msg"></span><button type="button" class="toast-action-btn"></button>';
    el.querySelector('.toast-action-msg').textContent = message;
    const btn = el.querySelector('.toast-action-btn');
    btn.textContent = actionLabel;
    const self = this;
    let done = false;
    btn.addEventListener('click', function () {
      if (done) return; done = true;
      clearTimeout(timer);
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.remove(); }, 140);
      try { actionCallback.call(self); } catch (_) { /* ignore */ }
    });
    c.appendChild(el);
    const timer = setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.remove(); }, 140);
    }, 5200);
  },

  // ══════════════════════════════════════════════════════
  // applyPreset 内核（保留旧实现，被 applyPresetWithSnapshot 包装）
  // ══════════════════════════════════════════════════════
  applyPreset(preset) {
    if (!preset || !preset.data) return;
    if (this.formDiffMap) {
      this.formDiffMap = null;
      this.diffCounts = { modified: 0, added: 0 };
      this.previewPreset = null;
    }
    const data = preset.data;
    // 临时禁用 train-type watcher，避免 switchTrainType 覆盖预设值
    const savedWatcher = this._trainTypeWatcher;
    if (savedWatcher) { savedWatcher(); this._trainTypeWatcher = null; }
    try {
      const presetTrainType = String(data.model_train_type || this.form.model_train_type || 'anima-lora');
      if (presetTrainType !== this.form.model_train_type) {
        this._switchInProgress = true;
        try { this.switchTrainType(presetTrainType); } finally { this._switchInProgress = false; }
      }
      const overrideKeys = Object.keys(data);
      for (const k of overrideKeys) {
        if (k === 'model_train_type') {
          this.form.model_train_type = data.model_train_type;
          continue;
        }
        this.form[k] = data[k];
      }
      overrideKeys.forEach(key => this._setFieldSource(key, 'preset', this.form.model_train_type));
    } finally {
      if (savedWatcher) {
        this._trainTypeWatcher = this.$watch('form.model_train_type', (newVal, oldVal) => {
          if (newVal !== oldVal && !this._switchInProgress) {
            this._switchInProgress = true;
            try { this.switchTrainType(newVal); } finally { this._switchInProgress = false; }
          }
        });
      }
    }
    this.formDefaults = { ...this.form };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;
    this.currentPreset = preset;
    this.currentPresetName = (preset.metadata && preset.metadata.name) || '';
    this.updateToml();
    this.rebuildForm();
    this._captureProfileDraft(this.form.model_train_type, this.form);
    this._persistProfileDrafts();
    this._persistProfileFieldSources();
  },

  applyPresetNavigate(preset) {
    if (!preset || !preset.data) return;
    const tt = (preset.metadata && preset.metadata.train_type) || 'anima-lora';
    const routeMap = { 'sdxl-lora': 'train-basic', 'anima-lora': 'train-anima' };
    const targetRoute = routeMap[tt] || 'train-anima';

    if (this.currentRoute === targetRoute) {
      this.$nextTick(() => this.applyPreset(preset));
    } else {
      this._pendingPreset = preset;
      this.navigate(targetRoute);
    }
  },

  // ══════════════════════════════════════════════════════
  // header preset-badge 快速切换（保留）
  // ══════════════════════════════════════════════════════
  switchPreset(dir) {
    if (this.presets.length < 2) return;
    let idx = this.presets.findIndex(p => p === this.currentPreset);
    if (idx < 0) idx = 0;
    idx = (idx + dir + this.presets.length) % this.presets.length;
    this.applyPreset(this.presets[idx]);
  },

  switchPresetWithDiff(dir) {
    if (this.presets.length < 2) return;
    const oldData = this.currentPreset && this.currentPreset.data ? { ...this.currentPreset.data } : null;
    this.switchPreset(dir);
    const newPreset = this.currentPreset;
    if (oldData && newPreset && newPreset.data) {
      const changes = this.computeChanges(oldData, newPreset.data);
      if (changes.length > 0) {
        const name = (newPreset.metadata && newPreset.metadata.name) || '';
        this.toast(this._formatSwitchToast(changes, name));
      }
    }
  },

  computeChanges(oldData, newData) {
    const changes = [];
    const allKeys = new Set([...Object.keys(oldData || {}), ...Object.keys(newData || {})]);
    for (const k of allKeys) {
      const ov = oldData[k];
      const nv = newData[k];
      if (ov === undefined) { changes.push({ key: k, type: 'added', newVal: nv }); }
      else if (nv === undefined) { changes.push({ key: k, type: 'removed', oldVal: ov }); }
      else if (String(ov) !== String(nv)) { changes.push({ key: k, type: 'modified', oldVal: ov, newVal: nv }); }
    }
    return changes;
  },

  _formatSwitchToast(changes, name) {
    const t = this.t.bind(this);
    const lines = changes.slice(0, 5).map(c => {
      if (c.type === 'modified') {
        return c.key + ': ' + String(c.oldVal) + ' -> ' + String(c.newVal);
      } else if (c.type === 'added') {
        return '+ ' + c.key + ': ' + String(c.newVal) + ' (' + t('preset.diff.added') + ')';
      } else {
        return '- ' + c.key + ': ' + String(c.oldVal);
      }
    });
    if (changes.length > 5) lines.push('...' + t('preset.andMore').replace('{n}', changes.length - 5));
    return t('preset.switched') + ' ' + name + '\n' + lines.join('\n');
  },

  clearPreset() {
    this.formDiffMap = null;
    this.diffCounts = { modified: 0, added: 0 };
    this.previewPreset = null;
    this.currentPreset = null;
    this.currentPresetName = '';
    this.form = { ...this.formDefaults };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;
    this.updateToml();
    this.rebuildForm();
    this.toast(this.t('preset.cleared'));
  },

  // Called after buildTrainForm to show a toast about auto-loaded params
  _markAutoLoaded() {
    if (this._autoLoaded) return;
    if (!this.autoLoadHistory || !this.currentRoute.startsWith('train-')) return;
    this._autoLoaded = true;
    this.toast(this.t('common.autoLoadedHistory'));
  }
};
