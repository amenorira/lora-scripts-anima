/* Preview prompts: ordered drafts above read-only dataset tag frequencies. */
const promptWorkbenchViews = new WeakMap();
const promptWorkbenchDrags = new WeakMap();
const promptWorkbenchSelections = new WeakMap();
const promptWorkbenchOrganizations = new WeakMap();
const promptWorkbenchDefaultExclusions = '1girl, 1boy, background, standing, portrait, cowboy shot, upper body, looking at viewer, solo, smile, open mouth, closed mouth, blush, nude, nipples, anime, male focus';

function promptWorkbenchParseTags(text, ranges = false) {
  const out = [], stack = [], pairs = {')':'(', ']':'[', '}':'{'};
  let start = 0;
  text = String(text || '');
  const append = end => {
    const tag = text.slice(start, end).trim();
    if (tag) out.push(ranges ? {tag, start, end} : tag);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if ('([{'.includes(ch)) stack.push(ch);
    else if (pairs[ch] && stack.at(-1) === pairs[ch]) stack.pop();
    else if (ch === ',' && !stack.length) { append(i); start = i + 1; }
  }
  append(text.length);
  return out;
}

const promptWorkbenchTagKey = tag => window.TagDictionary.normalizeKey(tag);

function promptWorkbenchExclusionRules(text) {
  const seen = new Set();
  return String(text).split(/[,，\r\n]/).map(value => value.trim()).filter(value => {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function removePromptWorkbenchTags(text, tags) {
  const keys = new Set([...tags].map(promptWorkbenchTagKey));
  for (const part of promptWorkbenchParseTags(text, true).reverse()) {
    if (!keys.has(promptWorkbenchTagKey(part.tag))) continue;
    let {start, end} = part;
    if (start > 0 && text[start - 1] === ',') start--;
    else if (text[end] === ',') end++;
    text = text.slice(0, start) + text.slice(end);
  }
  return text.trim();
}

function finishPromptWorkbenchSort(app, commit = false, focus = true) {
  const drag = promptWorkbenchDrags.get(app);
  if (!drag) return;
  promptWorkbenchDrags.delete(app);
  cancelAnimationFrame(drag.frame);
  for (const [target, type, listener, options] of drag.listeners) target.removeEventListener(type, listener, options);
  drag.preview?.remove();
  drag.list.classList.remove('pw-sorting');
  document.body.classList.remove('pw-prompt-sorting');
  for (const entry of drag.entries || []) {
    entry.node.classList.remove('pw-sort-shift', 'pw-sort-placeholder');
    entry.node.style.transform = '';
  }
  try { drag.handle.releasePointerCapture(drag.pointerId); } catch { /* The browser may already have released it. */ }
  if (commit && drag.active && drag.to !== drag.from) {
    app.movePromptWorkbenchItem(drag.id, drag.entries[drag.to].id, drag.to > drag.from);
  }
  if (drag.active && focus) app.$nextTick(() => drag.handle.isConnected && drag.handle.focus({preventScroll:true}));
}

function paintPromptWorkbenchSort(app, time, finishing = false) {
  const drag = promptWorkbenchDrags.get(app);
  if (!drag?.active) return;
  if (!app.promptWorkbenchOpen || !drag.list.isConnected || !drag.row.isConnected) {
    finishPromptWorkbenchSort(app, false, false);
    return;
  }
  const bounds = drag.list.getBoundingClientRect();
  if (!finishing) {
    const elapsed = Math.min(32, Math.max(0, time - (drag.time ?? time - 16)));
    drag.time = time;
    const edge = Math.min(32, bounds.height / 3);
    const velocity = drag.y < bounds.top + edge ? -Math.min(1, (bounds.top + edge - drag.y) / edge)
      : drag.y > bounds.bottom - edge ? Math.min(1, (drag.y - bounds.bottom + edge) / edge) : 0;
    if (velocity) drag.list.scrollTop = Math.max(0, Math.min(drag.list.scrollHeight - drag.list.clientHeight,
      drag.list.scrollTop + velocity * elapsed * .5));
  }
  // Work in list content coordinates: scrolling must not move the floating row.
  const center = drag.y - drag.offsetY + drag.height / 2 - bounds.top + drag.list.scrollTop;
  const to = drag.entries.filter((entry, index) => index !== drag.from && center > entry.top + entry.height / 2).length;
  const target = drag.entries[to];
  const slotTop = to > drag.from ? target.top + target.height - drag.height : target.top;
  if (to !== drag.to || !drag.painted) {
    drag.to = to;
    drag.painted = true;
    drag.entries.forEach((entry, index) => {
      let shift = 0;
      if (index === drag.from) shift = slotTop - entry.top;
      else if (index > drag.from && index <= to) shift = -drag.step;
      else if (index < drag.from && index >= to) shift = drag.step;
      entry.node.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : '';
    });
  }
  drag.preview.style.transform = `translate3d(${drag.left}px, ${drag.y - drag.offsetY}px, 0)`;
  if (!finishing) drag.frame = requestAnimationFrame(next => paintPromptWorkbenchSort(app, next));
}

window.trainingPromptWorkbenchMixin = {
  promptWorkbenchOpen: false,
  promptWorkbenchRendered: false,
  promptWorkbenchLoading: false,
  promptWorkbenchRefreshFeedback: false,
  _promptWorkbenchRefreshFeedbackTimer: null,
  promptWorkbenchError: '',
  promptWorkbenchData: null,
  promptWorkbenchItems: [],
  promptWorkbenchActiveId: '',
  promptWorkbenchField: '',
  promptWorkbenchProfile: '',
  promptWorkbenchSubset: '',
  promptWorkbenchSearch: '',
  promptWorkbenchLimit: 200,
  promptWorkbenchExcludeEnabled: false,
  promptWorkbenchExcludeText: promptWorkbenchDefaultExclusions,
  promptWorkbenchExclusionsOpen: false,
  promptWorkbenchExclusionDraft: [],
  promptWorkbenchExclusionSelectedId: '',
  promptWorkbenchExclusionEditingId: '',
  promptWorkbenchExclusionValue: '',
  _promptWorkbenchExclusionNextId: 0,
  _promptWorkbenchNextId: 0,
  _promptWorkbenchSeq: 0,
  _promptWorkbenchAbort: null,
  _promptWorkbenchTagAnchor: '',

  get promptWorkbenchSingle() { return this.promptWorkbenchProfile === 'moss-image-lora'; },
  get promptWorkbenchActive() { return this.promptWorkbenchItems.find(item => item.id === this.promptWorkbenchActiveId) || null; },
  get promptWorkbenchStructured() {
    if (!this.promptWorkbenchSingle) return false;
    try { const value = JSON.parse(this.promptWorkbenchActive?.text || ''); return value !== null && typeof value === 'object'; }
    catch { return false; }
  },
  get promptWorkbenchSelectedTags() {
    const text = String(this.promptWorkbenchActive?.text || '');
    const cached = promptWorkbenchSelections.get(this);
    if (cached?.text === text) return cached.tags;
    const tags = new Set(promptWorkbenchParseTags(text).map(promptWorkbenchTagKey));
    promptWorkbenchSelections.set(this, {text, tags});
    return tags;
  },
  promptWorkbenchIsTagSelected(tag) { return this.promptWorkbenchSelectedTags.has(promptWorkbenchTagKey(tag)); },
  get promptWorkbenchScopeTags() {
    const data = this.promptWorkbenchData;
    const tags = this.promptWorkbenchSubset ? data?.subsets.find(subset => subset.id === this.promptWorkbenchSubset)?.tags || [] : data?.tags || [];
    return this.sortPromptWorkbenchScope?.(tags) || tags;
  },
  get promptWorkbenchTags() {
    const data = this.promptWorkbenchData;
    if (!data) return [];
    const key = [this.promptWorkbenchSubset, this.promptWorkbenchSearch, this.promptWorkbenchExcludeEnabled,
      this.promptWorkbenchExcludeText, this.tagDictionaryVersion, this.promptWorkbenchTriggerVersion, this.locale].join('\u0000');
    const cached = promptWorkbenchViews.get(this);
    if (cached?.data === data && cached.key === key) return cached.tags;
    const source = this.promptWorkbenchScopeTags;
    const excluded = this.promptWorkbenchExcludeEnabled
      ? promptWorkbenchExclusionRules(this.promptWorkbenchExcludeText).map(rule => rule.toLowerCase()) : [];
    const search = this.promptWorkbenchSearch.trim().toLowerCase();
    const tags = source.filter(item => !excluded.some(rule => item.tag.toLowerCase().includes(rule)) && (!search
      || item.tag.toLowerCase().includes(search)
      || String(this.tagDictionaryTranslationFor?.(item.tag) || '').toLowerCase().includes(search)));
    promptWorkbenchViews.set(this, {data, key, tags});
    return tags;
  },
  get promptWorkbenchVisibleTags() { return this.promptWorkbenchTags.slice(0, this.promptWorkbenchLimit); },
  get promptWorkbenchSubsetOptions() {
    const data = this.promptWorkbenchData;
    return [{id:'', name:this.t('promptWorkbench.all'), count:data?.tags.length ?? null},
      ...(data?.subsets || []).map(subset => ({id:subset.id, name:subset.name, count:subset.tags.length}))];
  },
  promptWorkbenchSummary() {
    const filled = this.promptWorkbenchItems.filter(item => item.text.trim()).length;
    const blank = this.promptWorkbenchItems.length - filled;
    return blank ? this.t('promptWorkbench.pending').replace('{n}', this.promptWorkbenchItems.length).replace('{empty}', blank)
      : this.t('promptWorkbench.count').replaceAll('{n}', filled);
  },
  promptWorkbenchScanNote() {
    const data = this.promptWorkbenchData;
    if (!data) return '';
    const skipped = data.missing_count + data.unreadable_count + data.structured_count;
    return skipped ? this.t('promptWorkbench.skipped').replace('{n}', skipped) : '';
  },

  async openPromptWorkbench(field = 'positive_prompts') {
    if (!['positive_prompts', 'krea_sample_prompts'].includes(field)) return;
    this.promptWorkbenchRendered = true;
    finishPromptWorkbenchSort(this, false, false);
    this.tagDictionaryCloseHover?.();
    this.promptWorkbenchField = field;
    this.promptWorkbenchProfile = this.form.model_train_type;
    this.initPromptWorkbenchTagTools?.();
    const text = String(this.form[field] || '');
    const entries = this.promptWorkbenchSingle ? [text] : text.split(/\r?\n/).filter(line => line.trim());
    this._promptWorkbenchNextId = 0;
    this.promptWorkbenchItems = (entries.length ? entries : ['']).map(value => ({id:String(++this._promptWorkbenchNextId), text:value}));
    this.promptWorkbenchActiveId = this.promptWorkbenchItems[0].id;
    this.invalidatePromptWorkbenchOrganization();
    this.promptWorkbenchSubset = '';
    this.promptWorkbenchSearch = '';
    this.promptWorkbenchLimit = 200;
    this.promptWorkbenchError = '';
    this.promptWorkbenchData = null;
    this.promptWorkbenchExclusionsOpen = false;
    try {
      const preferences = JSON.parse(localStorage.getItem('anima-preview-tag-exclusions') || 'null');
      this.promptWorkbenchExcludeEnabled = !!preferences?.enabled;
      this.promptWorkbenchExcludeText = typeof preferences?.text === 'string' ? preferences.text : promptWorkbenchDefaultExclusions;
    } catch { this.promptWorkbenchExcludeEnabled = false; this.promptWorkbenchExcludeText = promptWorkbenchDefaultExclusions; }
    this.promptWorkbenchOpen = true;
    this.tagDictionaryInit?.();
    await this.loadPromptWorkbenchTags();
  },
  closePromptWorkbench() {
    finishPromptWorkbenchSort(this, false, false);
    this.closePromptWorkbenchTriggerMenu?.(false);
    this.closePromptWorkbenchTagTools?.();
    this.closePromptWorkbenchExclusions();
    if (!this.promptWorkbenchOpen) return;
    if (this.form.model_train_type === this.promptWorkbenchProfile) {
      const value = this.promptWorkbenchSingle ? (this.promptWorkbenchItems[0]?.text || '')
        : this.promptWorkbenchItems.map(item => item.text.replace(/\s*\r?\n\s*/g, ' ').trim()).filter(Boolean).join('\n');
      this.setField(this.promptWorkbenchField, value);
    }
    this.promptWorkbenchOpen = false;
    ++this._promptWorkbenchSeq;
    this._promptWorkbenchAbort?.abort();
    this.promptWorkbenchLoading = false;
    if (this._promptWorkbenchRefreshFeedbackTimer) clearTimeout(this._promptWorkbenchRefreshFeedbackTimer);
    this._promptWorkbenchRefreshFeedbackTimer = null;
    this.promptWorkbenchRefreshFeedback = false;
    this.tagDictionaryCloseHover?.();
  },
  releasePromptWorkbenchView() {
    // A previous closing animation may finish after the workbench was reopened.
    if (this.promptWorkbenchOpen) return;
    this.promptWorkbenchRendered = false;
    this.promptWorkbenchData = null;
    this.promptWorkbenchItems = [];
    this.promptWorkbenchActiveId = '';
    promptWorkbenchViews.delete(this);
    promptWorkbenchSelections.delete(this);
    this.invalidatePromptWorkbenchOrganization();
    this.releasePromptWorkbenchTagTools?.();
    this.releasePromptWorkbenchTriggers?.();
  },
  async loadPromptWorkbenchTags() {
    this.closePromptWorkbenchTagSuggestions?.();
    this._promptWorkbenchTagAnchor = '';
    const seq = ++this._promptWorkbenchSeq;
    this._promptWorkbenchAbort?.abort();
    this._promptWorkbenchAbort = new AbortController();
    this.promptWorkbenchLoading = true;
    this.promptWorkbenchError = '';
    try {
      const response = await fetch('/api/training/prompt-tags', {
        method:'POST', headers:{'Content-Type':'application/json'}, signal:this._promptWorkbenchAbort.signal,
        body:JSON.stringify(this._trainingDatasetPayload()),
      });
      const result = await response.json();
      if (seq !== this._promptWorkbenchSeq) return;
      if (!response.ok || result.status !== 'success') throw new Error(result.message || this.t('promptWorkbench.failed'));
      this.promptWorkbenchData = result.data;
      this.preparePromptWorkbenchTriggers?.();
      if (this.promptWorkbenchSubset && !result.data.subsets.some(subset => subset.id === this.promptWorkbenchSubset)) this.promptWorkbenchSubset = '';
      this.syncPromptWorkbenchDictionary();
    } catch (error) {
      if (seq === this._promptWorkbenchSeq && error.name !== 'AbortError') this.promptWorkbenchError = error.message;
    } finally {
      if (seq === this._promptWorkbenchSeq) {
        this.promptWorkbenchLoading = false;
        if (!this.promptWorkbenchError) this.refreshPromptWorkbenchOrganization();
      }
    }
  },
  refreshPromptWorkbenchTags() {
    if (!this.promptWorkbenchOpen || this.promptWorkbenchLoading) return;
    this._showRefreshFeedback('promptWorkbench');
    return this.loadPromptWorkbenchTags();
  },
  syncPromptWorkbenchDictionary() {
    if (!this.promptWorkbenchOpen) return;
    this.tagDictionaryEnsureWorker?.();
    this.tagDictionaryLookupTags?.([...(this.promptWorkbenchTriggerCandidateTags?.() || []), ...this.promptWorkbenchVisibleTags.map(item => item.tag),
      ...(this.promptWorkbenchStructured ? [] : this.promptWorkbenchPromptTags || [])]);
  },
  filterPromptWorkbench() {
    this.closePromptWorkbenchTriggerMenu?.(false);
    this._promptWorkbenchTagAnchor = '';
    this.promptWorkbenchLimit = 200;
    this.$nextTick(() => this.syncPromptWorkbenchDictionary());
  },
  setPromptWorkbenchSubset(id) {
    this.invalidatePromptWorkbenchOrganization();
    this.promptWorkbenchSubset = id;
    this.filterPromptWorkbench();
  },
  savePromptWorkbenchExclusions() {
    try { localStorage.setItem('anima-preview-tag-exclusions', JSON.stringify({enabled:this.promptWorkbenchExcludeEnabled, text:this.promptWorkbenchExcludeText})); }
    catch { /* Keep in-memory preferences when storage is unavailable. */ }
    this.filterPromptWorkbench();
  },
  _setPromptWorkbenchExclusionDraft(text) {
    this._promptWorkbenchExclusionNextId = 0;
    this.promptWorkbenchExclusionDraft = promptWorkbenchExclusionRules(text).map(value => ({id:String(++this._promptWorkbenchExclusionNextId), value}));
    this.promptWorkbenchExclusionSelectedId = this.promptWorkbenchExclusionDraft[0]?.id || '';
    this.promptWorkbenchExclusionEditingId = '';
    this.promptWorkbenchExclusionValue = '';
    const list = document.getElementById('promptExclusionList');
    if (list) list.scrollTop = 0;
  },
  openPromptWorkbenchExclusions() {
    this._setPromptWorkbenchExclusionDraft(this.promptWorkbenchExcludeText);
    this.promptWorkbenchExclusionsOpen = true;
  },
  closePromptWorkbenchExclusions() {
    this.commitPromptWorkbenchExclusion();
    this.promptWorkbenchExclusionsOpen = false;
    this.promptWorkbenchExclusionEditingId = '';
    this.promptWorkbenchExclusionValue = '';
  },
  _persistPromptWorkbenchExclusionDraft() {
    const text = promptWorkbenchExclusionRules(this.promptWorkbenchExclusionDraft.map(row => row.value).join('\n')).join('\n');
    if (text === this.promptWorkbenchExcludeText) return;
    this.promptWorkbenchExcludeText = text;
    this.savePromptWorkbenchExclusions();
  },
  resetPromptWorkbenchExclusions() {
    this._setPromptWorkbenchExclusionDraft(promptWorkbenchDefaultExclusions);
    this._persistPromptWorkbenchExclusionDraft();
  },
  selectPromptWorkbenchExclusion(id) {
    if (this.promptWorkbenchExclusionSelectedId === id) return;
    this.commitPromptWorkbenchExclusion();
    this.promptWorkbenchExclusionSelectedId = id;
    document.getElementById('promptExclusionList')?.focus({preventScroll:true});
  },
  editPromptWorkbenchExclusion(id = this.promptWorkbenchExclusionSelectedId) {
    if (this.promptWorkbenchExclusionEditingId !== id) {
      this.commitPromptWorkbenchExclusion();
      const row = this.promptWorkbenchExclusionDraft.find(row => row.id === id);
      if (!row) return;
      this.promptWorkbenchExclusionSelectedId = this.promptWorkbenchExclusionEditingId = id;
      this.promptWorkbenchExclusionValue = row.value;
    }
    this.$nextTick(() => {
      const input = document.getElementById('promptExclusionInput');
      input?.focus({preventScroll:true});
      input?.select();
      input?.scrollIntoView?.({block:'nearest'});
    });
  },
  addPromptWorkbenchExclusion() {
    this.commitPromptWorkbenchExclusion();
    const empty = this.promptWorkbenchExclusionDraft.find(row => !row.value);
    if (empty) { this.editPromptWorkbenchExclusion(empty.id); return; }
    const row = {id:String(++this._promptWorkbenchExclusionNextId), value:''};
    this.promptWorkbenchExclusionDraft.push(row);
    this.editPromptWorkbenchExclusion(row.id);
  },
  commitPromptWorkbenchExclusion() {
    const index = this.promptWorkbenchExclusionDraft.findIndex(row => row.id === this.promptWorkbenchExclusionEditingId);
    if (index < 0) return;
    const old = this.promptWorkbenchExclusionDraft[index];
    const values = promptWorkbenchExclusionRules(this.promptWorkbenchExclusionValue);
    const rows = values.map((value, i) => ({id:i ? String(++this._promptWorkbenchExclusionNextId) : old.id, value}));
    this.promptWorkbenchExclusionEditingId = '';
    this.promptWorkbenchExclusionValue = '';
    this.promptWorkbenchExclusionDraft.splice(index, 1, ...rows);
    // An empty edit disappears without selecting its neighbour: a pending
    // click on Delete must never delete another rule after the input blurs.
    this.promptWorkbenchExclusionSelectedId = rows[0]?.id || '';
    if (values.length || old.value) this._persistPromptWorkbenchExclusionDraft();
  },
  cancelPromptWorkbenchExclusionEdit() {
    const row = this.promptWorkbenchExclusionDraft.find(row => row.id === this.promptWorkbenchExclusionEditingId);
    this.promptWorkbenchExclusionEditingId = '';
    this.promptWorkbenchExclusionValue = '';
    if (row && !row.value) this.deletePromptWorkbenchExclusion();
    this.$nextTick(() => document.getElementById('promptExclusionList')?.focus({preventScroll:true}));
  },
  deletePromptWorkbenchExclusion() {
    const index = this.promptWorkbenchExclusionDraft.findIndex(row => row.id === this.promptWorkbenchExclusionSelectedId);
    if (index < 0) return;
    this.promptWorkbenchExclusionEditingId = '';
    this.promptWorkbenchExclusionValue = '';
    this.promptWorkbenchExclusionDraft.splice(index, 1);
    this.promptWorkbenchExclusionSelectedId = this.promptWorkbenchExclusionDraft[Math.min(index, this.promptWorkbenchExclusionDraft.length - 1)]?.id || '';
    this._persistPromptWorkbenchExclusionDraft();
  },
  promptWorkbenchExclusionKey(event) {
    if (event.target.tagName === 'INPUT') return;
    const rows = this.promptWorkbenchExclusionDraft;
    const index = rows.findIndex(row => row.id === this.promptWorkbenchExclusionSelectedId);
    if (['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      this.promptWorkbenchExclusionSelectedId = rows[next]?.id || '';
      this.$nextTick(() => document.getElementById('pw-exclusion-' + this.promptWorkbenchExclusionSelectedId)?.scrollIntoView?.({block:'nearest'}));
    } else if (event.key === 'Delete') { event.preventDefault(); this.deletePromptWorkbenchExclusion(); }
    else if (['Enter','F2'].includes(event.key)) { event.preventDefault(); this.editPromptWorkbenchExclusion(); }
  },
  morePromptWorkbenchTags() {
    this.promptWorkbenchLimit += 200;
    this.$nextTick(() => this.syncPromptWorkbenchDictionary());
  },
  invalidatePromptWorkbenchOrganization() { promptWorkbenchOrganizations.delete(this); },
  rememberPromptWorkbenchOrganization() {
    const item = this.promptWorkbenchActive;
    if (item) promptWorkbenchOrganizations.set(this, {id:item.id, text:item.text});
  },
  refreshPromptWorkbenchOrganization() {
    const item = this.promptWorkbenchActive, organized = promptWorkbenchOrganizations.get(this);
    if (item && organized?.id === item.id && organized.text === item.text) this.organizePromptWorkbenchTags?.();
  },
  addPromptWorkbenchItem() {
    if (this.promptWorkbenchSingle && this.promptWorkbenchItems.length) return;
    const item = {id:String(++this._promptWorkbenchNextId), text:''};
    this.promptWorkbenchItems.push(item);
    this.editPromptWorkbenchItem(item.id, true);
  },
  editPromptWorkbenchItem(id, focus = false) {
    if (this.promptWorkbenchActiveId !== id) {
      this.invalidatePromptWorkbenchOrganization();
      this._promptWorkbenchTagAnchor = '';
      this.closePromptWorkbenchTagTools?.();
    }
    this.promptWorkbenchActiveId = id;
    this.$nextTick(() => {
      this.syncPromptWorkbenchDictionary();
      document.querySelector?.(`#promptWorkbenchDialog [data-pw-prompt-id="${id}"]`)?.scrollIntoView?.({block:'nearest'});
      if (!focus) return;
      const editor = document.getElementById(this.promptWorkbenchUseTagChips ? 'promptWorkbenchTagAdd' : 'promptWorkbenchEditor');
      editor?.focus({preventScroll:true});
      editor?.setSelectionRange(editor.value.length, editor.value.length);
    });
  },
  updatePromptWorkbenchItem(value) {
    this.invalidatePromptWorkbenchOrganization();
    this._promptWorkbenchTagAnchor = '';
    if (this.promptWorkbenchActive) this.promptWorkbenchActive.text = value;
  },
  deletePromptWorkbenchItem(id) {
    const index = this.promptWorkbenchItems.findIndex(item => item.id === id);
    if (index < 0) return;
    this.invalidatePromptWorkbenchOrganization();
    this.promptWorkbenchItems.splice(index, 1);
    if (this.promptWorkbenchActiveId === id) {
      this.closePromptWorkbenchTagTools?.();
      this.promptWorkbenchActiveId = this.promptWorkbenchItems[Math.min(index, this.promptWorkbenchItems.length - 1)]?.id || '';
      this._promptWorkbenchTagAnchor = '';
    }
  },
  togglePromptWorkbenchTag(tag, event = null) {
    this.closePromptWorkbenchTagSuggestions?.();
    const item = this.promptWorkbenchActive;
    if (!item || this.promptWorkbenchStructured) return;
    this.invalidatePromptWorkbenchOrganization();
    const visible = this.promptWorkbenchVisibleTags;
    const anchor = visible.findIndex(value => value.tag === this._promptWorkbenchTagAnchor);
    const target = visible.findIndex(value => value.tag === tag);
    if (event?.shiftKey && anchor >= 0 && target >= 0) {
      const selected = new Set(this.promptWorkbenchSelectedTags);
      const range = visible.slice(Math.min(anchor, target), Math.max(anchor, target) + 1).map(value => value.tag);
      if (selected.has(promptWorkbenchTagKey(tag))) {
        item.text = removePromptWorkbenchTags(item.text, new Set(range));
        return;
      }
      const added = range.filter(value => {
        const key = promptWorkbenchTagKey(value);
        if (selected.has(key)) return false;
        selected.add(key); return true;
      });
      if (added.length) {
        const text = item.text.trimEnd();
        item.text = text + (text ? (text.endsWith(',') ? ' ' : ', ') : '') + added.join(', ');
      }
      return;
    }
    this._promptWorkbenchTagAnchor = tag;
    if (this.promptWorkbenchIsTagSelected(tag)) {
      // Remove only complete comma-delimited tags, keeping all other spelling/order.
      item.text = removePromptWorkbenchTags(item.text, new Set([tag]));
    } else {
      const text = item.text.trimEnd();
      item.text = text + (text ? (text.endsWith(',') ? ' ' : ', ') : '') + tag;
    }
  },
  startPromptWorkbenchSort(event, id) {
    if (event.button !== 0 || event.isPrimary === false || this.promptWorkbenchItems.length < 2) return;
    finishPromptWorkbenchSort(this, false, false);
    this.closePromptWorkbenchTagSuggestions?.();
    const handle = event.currentTarget;
    const row = handle.closest('.pw-prompt-row');
    const list = row?.closest('.pw-prompt-list');
    if (!list) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    const drag = {id, handle, row, list, pointerId:event.pointerId, startX:event.clientX, startY:event.clientY,
      y:event.clientY, offsetY:event.clientY - rect.top, left:rect.left, height:rect.height, active:false, frame:0, listeners:[]};
    promptWorkbenchDrags.set(this, drag);
    const listen = (target, type, listener, options = false) => {
      target.addEventListener(type, listener, options);
      drag.listeners.push([target, type, listener, options]);
    };
    listen(window, 'pointermove', move => {
      if (move.pointerId !== drag.pointerId) return;
      if (move.pointerType === 'mouse' && move.buttons === 0) { finishPromptWorkbenchSort(this, false); return; }
      drag.y = move.clientY;
      if (!drag.active && Math.hypot(move.clientX - drag.startX, move.clientY - drag.startY) < 5) return;
      move.preventDefault();
      if (!drag.active) {
        const bounds = list.getBoundingClientRect();
        drag.entries = [...list.querySelectorAll(':scope > .pw-prompt-row')].map(node => {
          const size = node.getBoundingClientRect();
          return {node, id:node.dataset.pwPromptId, top:size.top - bounds.top + list.scrollTop, height:size.height};
        });
        drag.from = drag.to = drag.entries.findIndex(entry => entry.node === row);
        if (drag.from < 0) { finishPromptWorkbenchSort(this, false); return; }
        drag.step = drag.height + (parseFloat(getComputedStyle(list).rowGap) || 0);
        // The preview stays in the native dialog's top layer, outside its scroll clip.
        const preview = row.cloneNode(true);
        preview.setAttribute('x-ignore', '');
        preview.setAttribute('aria-hidden', 'true');
        preview.removeAttribute('data-pw-prompt-id');
        for (const node of [preview, ...preview.querySelectorAll('[id]')]) node.removeAttribute('id');
        preview.inert = true;
        preview.classList.add('pw-sort-preview');
        Object.assign(preview.style, {width:`${rect.width}px`, height:`${rect.height}px`,
          transform:`translate3d(${drag.left}px, ${drag.y - drag.offsetY}px, 0)`});
        list.closest('dialog').append(preview);
        drag.preview = preview;
        drag.active = true;
        list.classList.add('pw-sorting');
        document.body.classList.add('pw-prompt-sorting');
        drag.entries.forEach(entry => entry.node.classList.add('pw-sort-shift'));
        row.classList.add('pw-sort-placeholder');
        drag.frame = requestAnimationFrame(time => paintPromptWorkbenchSort(this, time));
      }
    }, {capture:true, passive:false});
    listen(window, 'pointerup', up => {
      if (up.pointerId !== drag.pointerId) return;
      // Resolve the final pointer position without scrolling past the displayed slot.
      if (drag.active) { drag.y = up.clientY; cancelAnimationFrame(drag.frame); paintPromptWorkbenchSort(this, performance.now(), true); }
      finishPromptWorkbenchSort(this, true);
    }, true);
    listen(window, 'pointercancel', cancel => { if (cancel.pointerId === drag.pointerId) finishPromptWorkbenchSort(this, false); }, true);
    listen(handle, 'lostpointercapture', () => finishPromptWorkbenchSort(this, false));
    listen(window, 'keydown', key => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      finishPromptWorkbenchSort(this, false);
    }, true);
    listen(window, 'blur', () => finishPromptWorkbenchSort(this, false, false));
    listen(window, 'resize', () => finishPromptWorkbenchSort(this, false, false));
    handle.focus({preventScroll:true});
    try { handle.setPointerCapture(event.pointerId); } catch { /* Window listeners also cover pointers outside the handle. */ }
  },
  movePromptWorkbenchItem(id, targetId, after = false) {
    if (id === targetId || !this.promptWorkbenchItems.some(item => item.id === id) || !this.promptWorkbenchItems.some(item => item.id === targetId)) return;
    const items = this.promptWorkbenchItems.slice();
    const [item] = items.splice(items.findIndex(value => value.id === id), 1);
    items.splice(items.findIndex(value => value.id === targetId) + (after ? 1 : 0), 0, item);
    this.promptWorkbenchItems = items;
  },
  promptWorkbenchSortKey(event, id) {
    if (!event.altKey || !['ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    finishPromptWorkbenchSort(this, false, false);
    const index = this.promptWorkbenchItems.findIndex(item => item.id === id);
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    const target = this.promptWorkbenchItems[index + direction];
    if (target) this.movePromptWorkbenchItem(id, target.id, direction > 0);
  },
};
