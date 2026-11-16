/* Prompt-local tag tools reuse the Tag Editor dictionary, completion rows and chips. */
const promptTagFrequencyCache = new WeakMap();
const promptTagDrags = new WeakMap();

function promptTagFrequency(app) {
  const source = app.promptWorkbenchScopeTags;
  const cached = promptTagFrequencyCache.get(app);
  if (cached?.source === source) return cached;
  const exact = new Map(), normalized = new Map();
  for (const [order, item] of source.entries()) {
    const stat = {count:item.count, order};
    exact.set(item.tag, stat);
    const key = window.TagDictionary.normalizeKey(item.tag);
    if (!normalized.has(key) || normalized.get(key).count < item.count) normalized.set(key, stat);
  }
  const value = {source, exact, normalized};
  promptTagFrequencyCache.set(app, value);
  return value;
}

function promptTagStat(app, tag) {
  const counts = promptTagFrequency(app);
  return counts.exact.get(tag) ?? counts.normalized.get(window.TagDictionary.normalizeKey(tag));
}

// Resolve a wrapped chip row first, then a horizontal insertion position.
function promptTagInsertion(entries, x, y) {
  if (!entries.length) return 0;
  const rows = [];
  entries.forEach((entry, index) => {
    let row = rows.at(-1);
    if (!row || Math.abs(row.top - entry.rect.top) > 2) rows.push(row = {top:entry.rect.top, bottom:entry.rect.bottom, items:[]});
    row.bottom = Math.max(row.bottom, entry.rect.bottom);
    row.items.push({...entry, index});
  });
  if (y < rows[0].top) return 0;
  if (y > rows.at(-1).bottom) return entries.length;
  const distance = row => Math.max(row.top - y, y - row.bottom, 0);
  const row = rows.reduce((best, next) => distance(next) < distance(best) ? next : best);
  return row.items.find(item => x < (item.rect.left + item.rect.right) / 2)?.index ?? row.items.at(-1).index + 1;
}

function finishPromptTagDrag(app, commit = false) {
  const drag = promptTagDrags.get(app);
  if (!drag) return;
  promptTagDrags.delete(app);
  cancelAnimationFrame(drag.frame);
  drag.listeners.forEach(([target, type, fn, options]) => target.removeEventListener(type, fn, options));
  drag.preview?.remove(); drag.placeholder?.remove();
  drag.source.style.display = drag.display;
  document.body.classList.remove('pw-tag-sorting');
  try { drag.list.releasePointerCapture(drag.pointerId); } catch { /* Capture may already be released. */ }
  if (commit && drag.active && drag.to !== drag.from && app.promptWorkbenchActiveId === drag.activeId && app.promptWorkbenchActive?.text === drag.text) {
    const tags = drag.tags.slice(), [tag] = tags.splice(drag.from, 1);
    tags.splice(drag.to, 0, tag);
    app.setPromptWorkbenchTags(tags);
  }
}

function paintPromptTagDrag(app, time, finishing = false) {
  const drag = promptTagDrags.get(app);
  if (!drag?.active) return;
  if (!app.promptWorkbenchOpen || !drag.list.isConnected) { finishPromptTagDrag(app); return; }
  const bounds = drag.list.getBoundingClientRect();
  if (!finishing) {
    const elapsed = Math.min(32, Math.max(0, time - (drag.time ?? time - 16)));
    drag.time = time;
    const edge = Math.min(24, bounds.height / 8);
    const speed = drag.y < bounds.top + edge ? -Math.min(1, (bounds.top + edge - drag.y) / edge)
      : drag.y > bounds.bottom - edge ? Math.min(1, (drag.y - bounds.bottom + edge) / edge) : 0;
    if (speed) drag.list.scrollTop = Math.max(0, Math.min(drag.list.scrollHeight - drag.list.clientHeight, drag.list.scrollTop + speed * elapsed * .5));
  }
  const x = drag.x - drag.offsetX + drag.width / 2, y = drag.y - drag.offsetY + drag.height / 2;
  const slot = drag.placeholder.getBoundingClientRect();
  if ((drag.lastX !== drag.x || drag.lastY !== drag.y || drag.lastScroll !== drag.list.scrollTop)
      && !(x >= slot.left - 3 && x <= slot.right + 3 && y >= slot.top - 3 && y <= slot.bottom + 3)) {
    const entries = [...drag.list.querySelectorAll(':scope > [data-pw-tag-index]')].filter(node => node !== drag.source)
      .map(node => ({node, rect:node.getBoundingClientRect()}));
    const to = promptTagInsertion(entries, x, y);
    if (to !== drag.to) { drag.to = to; drag.list.insertBefore(drag.placeholder, entries[to]?.node || null); }
  }
  drag.lastX = drag.x; drag.lastY = drag.y; drag.lastScroll = drag.list.scrollTop;
  drag.preview.style.transform = `translate3d(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px, 0)`;
  if (!finishing) drag.frame = requestAnimationFrame(next => paintPromptTagDrag(app, next));
}

window.trainingPromptTagToolsMixin = {
  promptWorkbenchTagInput: '',
  promptWorkbenchShowTagChips: false,
  promptWorkbenchTagSuggestions: [],
  promptWorkbenchTagSuggestIndex: -1,
  promptWorkbenchTagSuggestLoading: false,
  promptWorkbenchTagSuggestMore: false,
  promptWorkbenchTagSuggestCoords: null,
  _promptWorkbenchTagSuggestSeq: 0,
  _promptWorkbenchTagSuggestTimer: null,
  _promptWorkbenchTagSuggestLimit: 20,
  _promptWorkbenchTagQuery: '',
  _promptWorkbenchTagInputEl: null,
  get promptWorkbenchUseTagChips() { return this.promptWorkbenchShowTagChips && !this.promptWorkbenchStructured; },
  get promptWorkbenchPromptTags() { return promptWorkbenchParseTags(this.promptWorkbenchActive?.text); },
  promptWorkbenchTagCount(tag) {
    return promptTagStat(this, tag)?.count ?? null;
  },
  initPromptWorkbenchTagTools() {
    this.closePromptWorkbenchTagTools();
    try { this.promptWorkbenchShowTagChips = localStorage.getItem('anima-preview-tag-chips') === '1'; } catch { /* Use the current layout. */ }
  },
  setPromptWorkbenchTagChips(value) {
    finishPromptTagDrag(this);
    this.closePromptWorkbenchTagSuggestions();
    this.promptWorkbenchShowTagChips = value;
    if (value) this.tagDictionaryLookupTags?.(this.promptWorkbenchPromptTags);
    try { localStorage.setItem('anima-preview-tag-chips', value ? '1' : '0'); } catch { /* Keep in-memory preference. */ }
  },
  closePromptWorkbenchTagTools() {
    finishPromptTagDrag(this);
    this.closePromptWorkbenchTagSuggestions();
    this.promptWorkbenchTagInput = '';
  },
  releasePromptWorkbenchTagTools() {
    this.closePromptWorkbenchTagTools();
    promptTagFrequencyCache.delete(this);
  },
  setPromptWorkbenchTags(tags) {
    const item = this.promptWorkbenchActive;
    if (!item || this.promptWorkbenchStructured) return;
    const text = tags.join(', ');
    if (text === item.text) return;
    this.invalidatePromptWorkbenchOrganization?.();
    item.text = text;
    this._promptWorkbenchTagAnchor = '';
    this.closePromptWorkbenchTagSuggestions();
  },
  organizePromptWorkbenchTags() {
    if (!this.promptWorkbenchData || this.promptWorkbenchLoading || this.promptWorkbenchStructured) return;
    const tags = this.promptWorkbenchPromptTags.map((tag, index) => ({tag, index, stat:promptTagStat(this, tag), trigger:!!this.promptWorkbenchIsTrigger?.(tag)}));
    tags.sort((a, b) => Number(b.trigger) - Number(a.trigger) || Number(!!b.stat) - Number(!!a.stat) || (b.stat?.count ?? 0) - (a.stat?.count ?? 0)
      || (a.stat?.order ?? 0) - (b.stat?.order ?? 0) || a.index - b.index);
    this.setPromptWorkbenchTags(tags.map(item => item.tag));
    this.rememberPromptWorkbenchOrganization?.();
  },
  addPromptWorkbenchTags(suggestion = null) {
    const item = this.promptWorkbenchActive;
    if (!item || this.promptWorkbenchStructured) return;
    let text = this.promptWorkbenchTagInput;
    if (suggestion) text = _teReplaceToken(text, this._promptWorkbenchTagInputEl?.selectionStart ?? text.length, suggestion.insert).text;
    const seen = new Set(this.promptWorkbenchPromptTags.map(tag => window.TagDictionary.normalizeKey(tag)));
    const added = promptWorkbenchParseTags(text).filter(tag => {
      const key = window.TagDictionary.normalizeKey(tag);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    if (added.length) {
      this.invalidatePromptWorkbenchOrganization?.();
      const current = item.text.trimEnd();
      item.text = current + (current ? (current.endsWith(',') ? ' ' : ', ') : '') + added.join(', ');
      this._promptWorkbenchTagAnchor = '';
      this.tagDictionaryLookupTags?.(added);
    }
    this.promptWorkbenchTagInput = '';
    this.closePromptWorkbenchTagSuggestions();
    this.$nextTick(() => document.getElementById('promptWorkbenchTagAdd')?.focus({preventScroll:true}));
  },
  removePromptWorkbenchTagAt(index) {
    const tags = this.promptWorkbenchPromptTags;
    if (index < 0 || index >= tags.length) return;
    tags.splice(index, 1); this.setPromptWorkbenchTags(tags);
    this.focusPromptWorkbenchTagAt(index);
  },
  focusPromptWorkbenchTagAt(index, activeId = this.promptWorkbenchActiveId) {
    this.$nextTick(() => {
      if (!this.promptWorkbenchOpen || activeId !== this.promptWorkbenchActiveId || !this.promptWorkbenchUseTagChips) return;
      const count = this.promptWorkbenchPromptTags.length;
      const chip = count ? document.querySelector(`#promptWorkbenchTagChips [data-pw-tag-index="${Math.max(0, Math.min(index, count - 1))}"]`) : null;
      (chip || document.getElementById('promptWorkbenchTagAdd'))?.focus({preventScroll:true});
      chip?.scrollIntoView?.({block:'nearest', inline:'nearest'});
    });
  },
  closePromptWorkbenchTagSuggestions() {
    if (this._promptWorkbenchTagSuggestTimer) clearTimeout(this._promptWorkbenchTagSuggestTimer);
    this._promptWorkbenchTagSuggestTimer = null;
    ++this._promptWorkbenchTagSuggestSeq;
    this.promptWorkbenchTagSuggestions = [];
    this.promptWorkbenchTagSuggestIndex = -1;
    this.promptWorkbenchTagSuggestCoords = null;
    this.promptWorkbenchTagSuggestLoading = this.promptWorkbenchTagSuggestMore = false;
    this._promptWorkbenchTagQuery = '';
    this._promptWorkbenchTagInputEl = null;
  },
  suggestPromptWorkbenchTags(input) {
    this.closePromptWorkbenchTagSuggestions();
    if (!this.promptWorkbenchActive || this.promptWorkbenchStructured || !input) return;
    const query = _teGetCurrentToken(input.value, input.selectionStart ?? input.value.length);
    if (!query) return;
    this._promptWorkbenchTagQuery = query;
    this._promptWorkbenchTagInputEl = input;
    this._promptWorkbenchTagSuggestLimit = 20;
    const seq = this._promptWorkbenchTagSuggestSeq;
    this._promptWorkbenchTagSuggestTimer = setTimeout(() => {
      this._promptWorkbenchTagSuggestTimer = null;
      this.fetchPromptWorkbenchTagSuggestions(seq);
    }, 100);
  },
  async fetchPromptWorkbenchTagSuggestions(seq) {
    const query = this._promptWorkbenchTagQuery;
    if (!query || !this.promptWorkbenchOpen) return;
    const selected = new Set(this.promptWorkbenchPromptTags.map(tag => window.TagDictionary.normalizeKey(tag)));
    const source = this.promptWorkbenchScopeTags.map(item => item.tag).filter(tag => !selected.has(window.TagDictionary.normalizeKey(tag)));
    const key = window.TagDictionary.normalizeKey(query), limit = this._promptWorkbenchTagSuggestLimit;
    const local = source.filter(tag => window.TagDictionary.normalizeKey(tag).includes(key)
      || String(this.tagDictionaryTranslationFor?.(tag) || '').toLowerCase().includes(query.toLowerCase()));
    const set = (locals, results) => {
      const active = this.promptWorkbenchTagSuggestions[this.promptWorkbenchTagSuggestIndex]?.insert;
      // Dictionary completions default to Anima syntax; other profiles do not add its artist prefix.
      const dictionary = this.promptWorkbenchProfile === 'anima-lora' ? results : results.map(result => result.category === 1
        ? {...result, animaTag:result.animaTag.replace(/^@+/, '')} : result);
      const items = _teSuggestMerge(locals, dictionary, limit + selected.size + 1, tag => this.tagDictionaryMetaFor?.(tag))
        .filter(item => !selected.has(window.TagDictionary.normalizeKey(item.insert)));
      this.promptWorkbenchTagSuggestMore = items.length > limit;
      this.promptWorkbenchTagSuggestions = items.slice(0, limit);
      this.promptWorkbenchTagSuggestIndex = active ? this.promptWorkbenchTagSuggestions.findIndex(item => item.insert === active) : -1;
      this.positionPromptWorkbenchTagSuggestions();
    };
    if (!this.promptWorkbenchTagSuggestions.length) set(local, []);
    this.promptWorkbenchTagSuggestLoading = true;
    let reply = null;
    try { reply = await this.tagDictionaryComplete?.(query, {sourceTags:source, existingOnly:false, limit:limit + Math.min(100, selected.size) + 1}); }
    catch { /* Local tags remain available without the dictionary. */ }
    if (seq !== this._promptWorkbenchTagSuggestSeq || !this.promptWorkbenchOpen) return;
    this.promptWorkbenchTagSuggestLoading = false;
    set(reply?.localTags || local, reply?.results || []);
  },
  morePromptWorkbenchTagSuggestions() {
    if (!this.promptWorkbenchTagSuggestMore || this.promptWorkbenchTagSuggestLoading) return;
    this._promptWorkbenchTagSuggestLimit += 20;
    return this.fetchPromptWorkbenchTagSuggestions(++this._promptWorkbenchTagSuggestSeq);
  },
  positionPromptWorkbenchTagSuggestions(event) {
    if (event?.target?.closest?.('.pw-tag-suggest')) return;
    const input = this._promptWorkbenchTagInputEl;
    this.promptWorkbenchTagSuggestCoords = input?.isConnected && this.promptWorkbenchTagSuggestions.length ? _teGetSuggestCoords(input) : null;
  },
  promptWorkbenchTagKey(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closePromptWorkbenchTagSuggestions(); return; }
    if (['ArrowDown','ArrowUp'].includes(event.key) && this.promptWorkbenchTagSuggestions.length) {
      event.preventDefault(); event.stopPropagation();
      this.promptWorkbenchTagSuggestIndex = Math.max(-1, Math.min(this.promptWorkbenchTagSuggestions.length - 1,
        this.promptWorkbenchTagSuggestIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      this.$nextTick(() => document.getElementById('pw-tag-suggestion-' + this.promptWorkbenchTagSuggestIndex)?.scrollIntoView({block:'nearest'}));
    } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey && this.promptWorkbenchTagSuggestIndex >= 0)) {
      event.preventDefault(); event.stopPropagation();
      this.addPromptWorkbenchTags(this.promptWorkbenchTagSuggestions[this.promptWorkbenchTagSuggestIndex]);
    }
  },
  promptWorkbenchTagSortKey(event, index) {
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); this.removePromptWorkbenchTagAt(index); return; }
    if (!event.altKey || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const tags = this.promptWorkbenchPromptTags, to = index + (['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1);
    if (to < 0 || to >= tags.length) return;
    const [tag] = tags.splice(index, 1); tags.splice(to, 0, tag); this.setPromptWorkbenchTags(tags);
    this.focusPromptWorkbenchTagAt(to);
  },
  startPromptWorkbenchTagDrag(event, index) {
    if (event.button !== 0 || event.isPrimary === false || event.target.closest('button') || this.promptWorkbenchPromptTags.length < 2) return;
    this.invalidatePromptWorkbenchOrganization?.();
    finishPromptTagDrag(this); this.closePromptWorkbenchTagSuggestions();
    const source = event.currentTarget, list = source.closest('.pw-prompt-chips'), rect = source.getBoundingClientRect();
    event.preventDefault();
    const drag = {source, list, from:index, to:index, tags:this.promptWorkbenchPromptTags, text:this.promptWorkbenchActive.text, activeId:this.promptWorkbenchActiveId,
      pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, x:event.clientX, y:event.clientY, offsetX:event.clientX - rect.left, offsetY:event.clientY - rect.top,
      width:rect.width, height:rect.height, display:source.style.display, active:false, frame:0, listeners:[]};
    promptTagDrags.set(this, drag);
    const listen = (target, type, fn, options = false) => { target.addEventListener(type, fn, options); drag.listeners.push([target, type, fn, options]); };
    listen(window, 'pointermove', move => {
      if (move.pointerId !== drag.pointerId) return;
      if (move.pointerType === 'mouse' && move.buttons === 0) { finishPromptTagDrag(this); return; }
      drag.x = move.clientX; drag.y = move.clientY;
      if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
      move.preventDefault();
      if (!drag.active) {
        const preview = source.cloneNode(true);
        preview.setAttribute('x-ignore',''); preview.setAttribute('aria-hidden','true'); preview.removeAttribute('data-pw-tag-index'); preview.inert = true;
        preview.classList.add('pw-tag-drag-preview');
        Object.assign(preview.style, {width:`${rect.width}px`, height:`${rect.height}px`, transform:`translate3d(${rect.left}px, ${rect.top}px, 0)`});
        list.closest('dialog').append(preview);
        const placeholder = document.createElement('span'); placeholder.className = 'pw-tag-placeholder'; placeholder.setAttribute('x-ignore',''); placeholder.setAttribute('aria-hidden','true');
        Object.assign(placeholder.style, {width:`${rect.width}px`, height:`${rect.height}px`}); list.insertBefore(placeholder, source);
        drag.preview = preview; drag.placeholder = placeholder; drag.active = true; source.style.display = 'none';
        document.body.classList.add('pw-tag-sorting');
        drag.frame = requestAnimationFrame(time => paintPromptTagDrag(this, time));
      }
    }, {capture:true, passive:false});
    listen(window, 'pointerup', up => {
      if (up.pointerId !== drag.pointerId) return;
      if (drag.active) { drag.x = up.clientX; drag.y = up.clientY; cancelAnimationFrame(drag.frame); paintPromptTagDrag(this, performance.now(), true); }
      finishPromptTagDrag(this, true);
    }, true);
    listen(window, 'pointercancel', cancel => { if (cancel.pointerId === drag.pointerId) finishPromptTagDrag(this); }, true);
    listen(list, 'lostpointercapture', () => finishPromptTagDrag(this));
    listen(window, 'blur', () => finishPromptTagDrag(this)); listen(window, 'resize', () => finishPromptTagDrag(this));
    listen(window, 'keydown', key => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finishPromptTagDrag(this); } }, true);
    list.focus({preventScroll:true});
    try { list.setPointerCapture(event.pointerId); } catch { /* Window events still track this pointer. */ }
  },
};
