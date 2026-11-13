/* Trigger guesses are scoped to captioned subsets; explicit corrections belong to the dataset. */
const promptTriggerScopes = new WeakMap();
const promptTriggerGuesses = new WeakMap();
const promptTriggerMenuAnchors = new WeakMap();
const promptTriggerStorageKey = 'anima-preview-trigger-overrides';
const promptTriggerKey = tag => window.TagDictionary.normalizeKey(tag);

function promptTriggerPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(promptTriggerStorageKey) || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Corrections still work for this session. */ }
  return {};
}

window.trainingPromptTriggersMixin = {
  promptWorkbenchTriggerVersion: 0,
  promptWorkbenchTriggerDataset: '',
  promptWorkbenchTriggerOverrides: [],
  promptWorkbenchAutoTriggers: [],
  promptWorkbenchTriggerMenu: null,

  sortPromptWorkbenchScope(source) {
    const version = this.promptWorkbenchTriggerVersion;
    const cached = promptTriggerScopes.get(this);
    if (cached?.source === source && cached.version === version) return cached.tags;
    const tags = source.map((item, order) => ({item, order, trigger:this.promptWorkbenchIsTrigger(item.tag)}));
    tags.sort((a, b) => Number(b.trigger) - Number(a.trigger) || b.item.count - a.item.count || a.order - b.order);
    const value = tags.map(entry => entry.item);
    promptTriggerScopes.set(this, {source, version, tags:value});
    return value;
  },
  promptWorkbenchTriggerStatus(tag) {
    void this.promptWorkbenchTriggerVersion;
    const key = promptTriggerKey(tag), override = this.promptWorkbenchTriggerOverrides.find(item => item[0] === key);
    if (override) return override[1] ? 'manual' : '';
    return this.promptWorkbenchAutoTriggers.includes(key) ? 'auto' : '';
  },
  promptWorkbenchIsTrigger(tag) { return !!this.promptWorkbenchTriggerStatus(tag); },
  promptWorkbenchTriggerTitle(tag) {
    const status = this.promptWorkbenchTriggerStatus(tag);
    return this.t(status === 'auto' ? 'promptWorkbench.autoTrigger' : status ? 'promptWorkbench.manualTrigger' : 'promptWorkbench.triggerHint');
  },
  promptWorkbenchTriggerCandidateTags() {
    const data = this.promptWorkbenchData;
    if (!data) return [];
    const subsets = data.subsets?.length ? data.subsets : [data];
    const tags = new Set();
    // A repeated subject/style tag is a candidate, not proof of a trigger.
    for (const subset of subsets) {
      if (!(subset.caption_count >= 2)) continue;
      for (const item of subset.tags) if (item.count / subset.caption_count >= .8) tags.add(item.tag);
    }
    return [...tags];
  },
  preparePromptWorkbenchTriggers() {
    this.closePromptWorkbenchTriggerMenu(false);
    const path = String(this.promptWorkbenchData?.dataset_id || this.form.train_data_dir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    this.promptWorkbenchTriggerDataset = /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
    const saved = promptTriggerPreferences()[this.promptWorkbenchTriggerDataset];
    this.promptWorkbenchTriggerOverrides = Array.isArray(saved)
      ? saved.filter(item => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'boolean') : [];
    this.promptWorkbenchAutoTriggers = [];
    promptTriggerGuesses.set(this, {data:this.promptWorkbenchData, resolved:new Map()});
    this.promptWorkbenchTriggerVersion++;
    this.refreshPromptWorkbenchTriggerGuesses();
  },
  releasePromptWorkbenchTriggers() {
    this.closePromptWorkbenchTriggerMenu(false);
    promptTriggerScopes.delete(this);
    promptTriggerGuesses.delete(this);
    promptTriggerMenuAnchors.delete(this);
    this.promptWorkbenchTriggerDataset = '';
    this.promptWorkbenchTriggerOverrides = [];
    this.promptWorkbenchAutoTriggers = [];
    this.promptWorkbenchTriggerVersion++;
  },
  refreshPromptWorkbenchTriggerGuesses() {
    if (!this.promptWorkbenchOpen || !this.promptWorkbenchData || !this.tagDictionaryReady) return;
    let cached = promptTriggerGuesses.get(this);
    if (cached?.data !== this.promptWorkbenchData) promptTriggerGuesses.set(this, cached = {data:this.promptWorkbenchData, resolved:new Map()});
    const common = new Set(promptWorkbenchExclusionRules(promptWorkbenchDefaultExclusions).map(promptTriggerKey));
    const subsets = this.promptWorkbenchData.subsets?.length ? this.promptWorkbenchData.subsets : [this.promptWorkbenchData];
    const leading = new Set(subsets.filter(subset => subset.caption_count >= 2)
      .flatMap(subset => (subset.leading_tags || []).filter(item => item.count / subset.caption_count >= .8).map(item => item.tag)));
    for (const tag of this.promptWorkbenchTriggerCandidateTags()) {
      if (cached.resolved.has(tag)) continue;
      const meta = this.tagDictionaryLookupResultFor?.(tag);
      if (meta === undefined) continue; // Pending lookup must not classify ordinary tags as unknown.
      cached.resolved.set(tag, meta ? [1, 4].includes(meta.category)
        : leading.has(tag) && !common.has(promptTriggerKey(tag)) && /\p{L}/u.test(tag) && tag.length <= 128);
    }
    const guessed = [...new Set([...cached.resolved].filter(([, trigger]) => trigger).map(([tag]) => promptTriggerKey(tag)))];
    if (JSON.stringify(guessed) === JSON.stringify(this.promptWorkbenchAutoTriggers)) return;
    this.promptWorkbenchAutoTriggers = guessed;
    this.promptWorkbenchTriggerVersion++;
    this._promptWorkbenchTagAnchor = '';
    this.refreshPromptWorkbenchOrganization?.();
  },
  setPromptWorkbenchTrigger(tag, value) {
    if (!this.promptWorkbenchTriggerDataset || !tag) return;
    const key = promptTriggerKey(tag);
    this.promptWorkbenchTriggerOverrides = this.promptWorkbenchTriggerOverrides.filter(item => item[0] !== key);
    if (typeof value === 'boolean') this.promptWorkbenchTriggerOverrides.push([key, value]);
    try {
      const saved = promptTriggerPreferences();
      if (this.promptWorkbenchTriggerOverrides.length) saved[this.promptWorkbenchTriggerDataset] = this.promptWorkbenchTriggerOverrides;
      else delete saved[this.promptWorkbenchTriggerDataset];
      localStorage.setItem(promptTriggerStorageKey, JSON.stringify(saved));
    } catch { /* Keep the correction in memory. */ }
    this.promptWorkbenchTriggerVersion++;
    this._promptWorkbenchTagAnchor = '';
    this.closePromptWorkbenchTriggerMenu();
    this.organizePromptWorkbenchTags?.();
  },
  promptWorkbenchTriggerHasOverride(tag) {
    return this.promptWorkbenchTriggerOverrides.some(item => item[0] === promptTriggerKey(tag));
  },
  async openPromptWorkbenchTriggerMenu(event, tag) {
    if (!this.promptWorkbenchOpen || this.promptWorkbenchStructured) return;
    event.preventDefault(); event.stopPropagation();
    this.closePromptWorkbenchTagSuggestions?.();
    const anchor = event.currentTarget, bounds = anchor.getBoundingClientRect();
    const pointer = event.type === 'contextmenu' && (event.clientX || event.clientY);
    let menu = {tag, x:pointer ? event.clientX : bounds.left, y:pointer ? event.clientY : bounds.bottom, positioned:false};
    promptTriggerMenuAnchors.set(this, anchor);
    this.promptWorkbenchTriggerMenu = menu;
    menu = this.promptWorkbenchTriggerMenu;
    await this.$nextTick();
    if (this.promptWorkbenchTriggerMenu !== menu) return;
    const node = document.getElementById('promptWorkbenchTriggerMenu');
    if (!node) return;
    const rect = node.getBoundingClientRect();
    menu.x = Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4));
    menu.y = Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4));
    menu.positioned = true;
    await this.$nextTick();
    if (this.promptWorkbenchTriggerMenu === menu) node.querySelector('button')?.focus({preventScroll:true});
  },
  closePromptWorkbenchTriggerMenu(restoreFocus = true) {
    if (!this.promptWorkbenchTriggerMenu) return;
    const tag = this.promptWorkbenchTriggerMenu.tag;
    this.promptWorkbenchTriggerMenu = null;
    const anchor = promptTriggerMenuAnchors.get(this);
    promptTriggerMenuAnchors.delete(this);
    if (restoreFocus) this.$nextTick(() => {
      if (!this.promptWorkbenchOpen || this.promptWorkbenchTriggerMenu) return;
      const target = anchor?.isConnected ? anchor : [...document.querySelectorAll('#promptWorkbenchDialog [data-pw-trigger-tag]')]
        .find(node => node.dataset.pwTriggerTag === tag && node.getClientRects().length);
      target?.focus({preventScroll:true});
    });
  },
  promptWorkbenchTriggerMenuKey(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return;
    if (event.key === 'Tab') { this.closePromptWorkbenchTriggerMenu(false); return; }
    event.preventDefault(); event.stopPropagation();
    const buttons = [...event.currentTarget.querySelectorAll('button')].filter(node => node.getClientRects().length);
    const index = buttons.indexOf(document.activeElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  },
};
