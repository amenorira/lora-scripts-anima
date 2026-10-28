/* Conditional field visibility, layout motion and read-only state.
 * Composed into trainingCoreMixin with property descriptors intact.
 */
window.trainingConditions = {
  _conditionalMotionQueue: null,
  _conditionalMotionTimer: null,
  _conditionalMotionEpoch: 0,
  _allShowIfKeys() {
    const keys = new Set();
    this._allSections().forEach(s => s.fields.forEach(f => {
      if (f.showIf) {
        if (Array.isArray(f.showIf)) {
          f.showIf.forEach(c => keys.add(c.key));
        } else {
          keys.add(f.showIf.key);
        }
      }
      if (f.showIfAny) {
        // OR-of-ANDs: list[list[dict]] — 收集每个内层 AND 组里的所有 key
        f.showIfAny.forEach(group => group.forEach(c => keys.add(c.key)));
      }
    }));
    return [...keys];
  },

  // Evaluate a single show_if condition dict (used by both single and multi-condition)
  _evalShowIfCond(c) {
    const pv = this.form[c.key];
    if (c.eq !== undefined) {
      if (String(pv) === String(c.eq)) return true;
      if (c.or && Array.isArray(c.or)) return c.or.some(function(v) { return String(pv) === String(v); });
      return false;
    }
    if (c.neq !== undefined) {
      return String(pv) !== String(c.neq) && pv !== null && pv !== undefined && pv !== '';
    }
    return true;
  },
  // 初始化与字段变化共用条件解析，避免两条路径的显示规则漂移。
  _visitConditionalRows(parentKey, visit) {
    const containers = [document.getElementById('trainFormContent'), document.getElementById('lycorisConfigContent')].filter(Boolean);
    containers.flatMap(container => Array.from(container.querySelectorAll('[data-show-if-all],[data-show-if-any],[data-show-if-key]'))).forEach(row => {
      let match;
      try {
        let groups;
        const allAttr = row.getAttribute('data-show-if-all');
        const anyAttr = row.getAttribute('data-show-if-any');
        if (allAttr !== null) {
          groups = [JSON.parse(allAttr)];
        } else if (anyAttr !== null) {
          groups = JSON.parse(anyAttr);
        } else {
          const condition = { key: row.getAttribute('data-show-if-key') };
          const eqVal = row.getAttribute('data-show-if-eq');
          const neqVal = row.getAttribute('data-show-if-neq');
          if (eqVal !== null) {
            condition.eq = eqVal;
            condition.or = (row.getAttribute('data-show-if-or') || '').split(',').filter(Boolean);
          } else if (neqVal !== null) {
            condition.neq = neqVal;
          }
          groups = [[condition]];
        }
        if (parentKey !== null && !groups.some(group => group.some(c => c.key === parentKey))) return;
        match = groups.some(group => group.every(c => this._evalShowIfCond(c)));
      } catch (e) {
        if (parentKey !== null) return;
        // 无效条件保留渲染阶段的状态。
        match = !row.classList.contains('field-hidden');
      }
      visit(row, match);
    });
  },

  // 初始化只同步状态；动画与 TOML 生成由调用方控制。
  _syncAllConditionalFields() {
    this._visitConditionalRows(null, (row, match) => {
      row._conditionalTargetVisible = match;
      this._setConditionalState(row, match);
    });
  },

  showConditionalFields(parentKey) {
    const toAnimate = [];
    this._visitConditionalRows(parentKey, (row, match) => {
      this._toggleFieldRow(row, match, toAnimate);
    });
    if (toAnimate.length) this._queueConditionalMotion(toAnimate);
    this.updateToml();
  },

  // 只记录最终目标；同一轮 Alpine watcher 产生的多项变化会合并为一次布局切换。
  _toggleFieldRow(row, match, toAnimate) {
    const targetVisible = row._conditionalTargetVisible;
    const currentlyVisible = !row.classList.contains('field-hidden') && !row.classList.contains('field-motion-exit');
    if (targetVisible === match) return;
    if (targetVisible === undefined && currentlyVisible === match) return;
    row._conditionalTargetVisible = match;
    toAnimate.push({ row, match });
  },

  _queueConditionalMotion(items) {
    if (!(this._conditionalMotionQueue instanceof Map)) this._conditionalMotionQueue = new Map();
    items.forEach(item => this._conditionalMotionQueue.set(item.row, item.match));
    if (this._conditionalMotionTimer) return;

    const epoch = this._conditionalMotionEpoch;
    this._conditionalMotionTimer = setTimeout(() => {
      this._conditionalMotionTimer = null;
      if (epoch !== this._conditionalMotionEpoch) return;
      const queue = this._conditionalMotionQueue;
      this._conditionalMotionQueue = null;
      if (!queue) return;
      const changes = [];
      queue.forEach((match, row) => {
        if (row && row.isConnected) changes.push({ row, match });
      });
      this._runConditionalMotion(changes, epoch);
    }, 0);
  },

  _runConditionalMotion(changes, epoch) {
    if (!changes.length || epoch !== this._conditionalMotionEpoch) return;
    const container = document.getElementById('trainFormContent');
    if (!container) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canAnimate = !reduceMotion && typeof Element !== 'undefined'
      && Element.prototype && typeof Element.prototype.animate === 'function';
    if (!canAnimate) {
      changes.forEach(item => this._setConditionalState(item.row, item.match));
      return;
    }

    const changedRows = new Set(changes.map(item => item.row));
    const primary = [];
    const deferredByPrimary = new Map();

    changes.forEach(item => {
      const row = item.row;
      const exitingAncestor = row.parentElement && row.parentElement.closest('.field-motion-exit');
      if (exitingAncestor && !changedRows.has(exitingAncestor)) {
        this._deferConditionalChange(exitingAncestor, row, item.match);
        return;
      }

      const hiddenAncestor = row.parentElement
        && row.parentElement.closest('.field-hidden, .card-collapsed');
      if (hiddenAncestor && !changedRows.has(hiddenAncestor)) {
        this._setConditionalState(row, item.match);
        return;
      }

      let owner = null;
      let parent = row.parentElement;
      while (parent && parent !== container) {
        if (changedRows.has(parent)) owner = parent;
        parent = parent.parentElement;
      }
      if (owner) {
        if (!deferredByPrimary.has(owner)) deferredByPrimary.set(owner, []);
        deferredByPrimary.get(owner).push(item);
      } else {
        primary.push(item);
      }
    });

    deferredByPrimary.forEach((items, owner) => {
      items.forEach(item => this._deferConditionalChange(owner, item.row, item.match));
    });
    if (!primary.length) return;

    const layoutParents = new Set();
    primary.forEach(item => {
      if (item.row.parentElement) layoutParents.add(item.row.parentElement);
      const card = item.row.closest('.card');
      if (card && card.parentElement) layoutParents.add(card.parentElement);
      this._cancelConditionalVisibilityAnimation(item.row);
    });

    const before = this._captureConditionalLayout(layoutParents, true);
    const entering = new Set();
    const exiting = new Set();

    primary.forEach(item => {
      const row = item.row;
      if (item.match) {
        this._restoreConditionalExit(row);
        row.classList.remove('field-hidden');
        row.setAttribute('aria-hidden', 'false');
        this._applyConditionalDeferredChanges(row);
        entering.add(row);
        return;
      }

      if (row.classList.contains('field-hidden')) {
        this._setConditionalState(row, false);
        this._applyConditionalDeferredChanges(row);
        return;
      }
      const rect = before.get(row) || row.getBoundingClientRect();
      this._prepareConditionalExit(row, rect);
      exiting.add(row);
    });

    const after = this._captureConditionalLayout(layoutParents, false);
    this._playConditionalFlip(before, after, entering);
    this._animateConditionalEntries(entering);
    this._animateConditionalExits(exiting, epoch);
  },

  _captureConditionalLayout(parents, cancelExisting) {
    const layout = new Map();
    parents.forEach(parent => {
      if (!parent || !parent.isConnected) return;
      Array.from(parent.children).forEach(element => {
        if (cancelExisting && element._conditionalLayoutAnimation) {
          clearTimeout(element._conditionalLayoutTimer);
          element._conditionalLayoutTimer = null;
          element._conditionalLayoutAnimation.cancel();
          element._conditionalLayoutAnimation = null;
          element.classList.remove('field-motion-moving');
        }
        if (element.classList.contains('field-hidden') || element.classList.contains('field-motion-exit')) return;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') return;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        layout.set(element, {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
        });
      });
    });
    return layout;
  },

  _playConditionalFlip(before, after, entering) {
    const scroller = document.getElementById('mainContent');
    const viewport = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    let animationCount = 0;
    after.forEach((nextRect, element) => {
      const prevRect = before.get(element);
      if (!prevRect || entering.has(element) || animationCount >= 36) return;
      const dx = prevRect.left - nextRect.left;
      const dy = prevRect.top - nextRect.top;
      if (Math.abs(dx) < 0.75 && Math.abs(dy) < 0.75) return;
      const inView = nextRect.bottom >= viewport.top - 140 && nextRect.top <= viewport.bottom + 140;
      const wasInView = prevRect.bottom >= viewport.top - 140 && prevRect.top <= viewport.bottom + 140;
      if (!inView && !wasInView) return;
      if (getComputedStyle(element).transform !== 'none') return;

      if (element._conditionalLayoutAnimation) element._conditionalLayoutAnimation.cancel();
      element.classList.add('field-motion-moving');
      const animation = element.animate([
        { transform: `translate3d(${dx}px, ${dy}px, 0)` },
        { transform: 'translate3d(0, 0, 0)' },
      ], {
        duration: 190,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
      element._conditionalLayoutAnimation = animation;
      animationCount += 1;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(element._conditionalLayoutTimer);
        element._conditionalLayoutTimer = null;
        if (element._conditionalLayoutAnimation === animation) {
          element._conditionalLayoutAnimation = null;
          animation.cancel();
          element.classList.remove('field-motion-moving');
        }
      };
      element._conditionalLayoutTimer = setTimeout(finish, 260);
      animation.finished.then(finish).catch(() => {});
    });
  },

  _animateConditionalEntries(rows) {
    rows.forEach(row => {
      if (!row.isConnected || row._conditionalTargetVisible !== true) return;
      row.classList.add('field-motion-entering');
      const animation = row.animate([
        { opacity: 0, transform: 'translate3d(0, -6px, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ], {
        duration: 180,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
      row._conditionalVisibilityAnimation = animation;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(row._conditionalVisibilityTimer);
        row._conditionalVisibilityTimer = null;
        if (row._conditionalVisibilityAnimation === animation) {
          row._conditionalVisibilityAnimation = null;
          animation.cancel();
          row.classList.remove('field-motion-entering');
        }
      };
      row._conditionalVisibilityTimer = setTimeout(finish, 240);
      animation.finished.then(finish).catch(() => {});
    });
  },

  _animateConditionalExits(rows, epoch) {
    rows.forEach(row => {
      if (!row.isConnected || row._conditionalTargetVisible !== false) return;
      const animation = row.animate([
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        { opacity: 0, transform: 'translate3d(0, -4px, 0)' },
      ], {
        duration: 125,
        easing: 'cubic-bezier(0.4, 0, 1, 1)',
        fill: 'forwards',
      });
      row._conditionalVisibilityAnimation = animation;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(row._conditionalVisibilityTimer);
        row._conditionalVisibilityTimer = null;
        if (row._conditionalVisibilityAnimation !== animation) return;
        row._conditionalVisibilityAnimation = null;
        if (epoch !== this._conditionalMotionEpoch || !row.isConnected) {
          animation.cancel();
          this._restoreConditionalExit(row);
          return;
        }
        if (row._conditionalTargetVisible === false) {
          row.classList.add('field-hidden');
          row.setAttribute('aria-hidden', 'true');
          animation.cancel();
          this._applyConditionalDeferredChanges(row);
          this._restoreConditionalExit(row);
        } else {
          animation.cancel();
          this._restoreConditionalExit(row);
          row.classList.remove('field-hidden');
          row.setAttribute('aria-hidden', 'false');
          this._applyConditionalDeferredChanges(row);
        }
      };
      row._conditionalVisibilityTimer = setTimeout(finish, 190);
      animation.finished.then(finish).catch(() => {});
    });
  },

  _prepareConditionalExit(row, rect) {
    this._restoreConditionalExit(row);
    const properties = [
      'position', 'top', 'left', 'width', 'height', 'minHeight', 'maxHeight',
      'margin', 'overflow', 'opacity', 'transform', 'transformOrigin', 'transition',
      'visibility', 'pointerEvents', 'zIndex', 'boxSizing', 'backgroundColor',
      'contain', 'willChange',
    ];
    const inline = {};
    properties.forEach(property => { inline[property] = row.style[property]; });
    row._conditionalExitInline = inline;
    row.classList.remove('field-hidden', 'field-motion-entering');
    row.classList.add('field-motion-exit');
    row.setAttribute('aria-hidden', 'true');
    row.style.position = 'fixed';
    row.style.top = `${rect.top}px`;
    row.style.left = `${rect.left}px`;
    row.style.width = `${Math.max(0, rect.right - rect.left)}px`;
    row.style.height = `${Math.max(0, rect.bottom - rect.top)}px`;
    row.style.minHeight = '0';
    row.style.maxHeight = `${Math.max(0, rect.bottom - rect.top)}px`;
    row.style.margin = '0';
    row.style.overflow = 'hidden';
    row.style.opacity = '1';
    row.style.transform = 'translate3d(0, 0, 0)';
    row.style.transformOrigin = 'top left';
    row.style.transition = 'none';
    row.style.visibility = 'visible';
    row.style.pointerEvents = 'none';
    row.style.zIndex = '60';
    row.style.boxSizing = 'border-box';
    row.style.backgroundColor = 'var(--bg-surface)';
    row.style.contain = 'paint';
    row.style.willChange = 'transform, opacity';
  },

  _restoreConditionalExit(row) {
    const inline = row._conditionalExitInline;
    if (inline) {
      Object.keys(inline).forEach(property => { row.style[property] = inline[property]; });
      delete row._conditionalExitInline;
    }
    row.classList.remove('field-motion-exit');
  },

  _cancelConditionalVisibilityAnimation(row) {
    clearTimeout(row._conditionalVisibilityTimer);
    row._conditionalVisibilityTimer = null;
    if (row._conditionalVisibilityAnimation) {
      row._conditionalVisibilityAnimation.cancel();
      row._conditionalVisibilityAnimation = null;
    }
    row.classList.remove('field-motion-entering');
  },

  _setConditionalState(row, visible) {
    if (!row || !row.isConnected) return;
    this._cancelConditionalVisibilityAnimation(row);
    if (visible) {
      this._restoreConditionalExit(row);
      row.classList.remove('field-hidden');
      row.setAttribute('aria-hidden', 'false');
    } else {
      row.classList.add('field-hidden');
      row.setAttribute('aria-hidden', 'true');
      this._restoreConditionalExit(row);
    }
    row.classList.remove('field-motion-entering');
  },

  _deferConditionalChange(owner, row, match) {
    if (!(owner._conditionalDeferredChanges instanceof Map)) owner._conditionalDeferredChanges = new Map();
    owner._conditionalDeferredChanges.set(row, match);
  },

  _applyConditionalDeferredChanges(owner) {
    const deferred = owner._conditionalDeferredChanges;
    if (!(deferred instanceof Map)) return;
    delete owner._conditionalDeferredChanges;
    deferred.forEach((match, row) => {
      const target = typeof row._conditionalTargetVisible === 'boolean'
        ? row._conditionalTargetVisible
        : match;
      this._setConditionalState(row, target);
    });
  },

  _readonlyReason(field) {
    if (!field) return '';
    if (field.readonlyIf && this._evalShowIfCond(field.readonlyIf)) return field.readonlyIf.reasonKey || '';
    if (this._readonlyIfAnyMet(field.readonlyIfAny)) return field.readonlyReasonKey || '';
    return '';
  },

  // ── Show If Watchers: listen for parent field changes to show/hide children ──
  setupShowIfWatchers() {
    const self = this;
    // Clean up previous watchers（防御：过滤非函数元素，避免 w is not a function 崩溃）
    if (this._showIfWatchers) { this._showIfWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    this._showIfWatchers = [];
    this._allShowIfKeys().forEach(k => {
      // Use a named function for clarity; Alpine re-evaluates on change
      self._showIfWatchers.push(self.$watch('form.' + k, () => self.showConditionalFields(k)));
    });
  },

  // ── Readonly If: disable fields based on conditions ──
  _allReadonlyIfKeys() {
    const keys = new Set();
    const collect = clause => {
      if (Array.isArray(clause)) {
        clause.forEach(collect);
      } else if (clause && clause.key) {
        keys.add(clause.key);
      }
    };
    this._allSections().forEach(s => s.fields.forEach(f => {
      if (f.readonlyIf) keys.add(f.readonlyIf.key);
      if (f.readonlyIfAny && Array.isArray(f.readonlyIfAny)) {
        f.readonlyIfAny.forEach(collect);
      }
    }));
    return [...keys];
  },

  setupReadonlyWatchers() {
    const self = this;
    // Clean up previous watchers（防御：过滤非函数元素，避免 w is not a function 崩溃）
    if (this._readonlyWatchers) { this._readonlyWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    this._readonlyWatchers = [];
    this._allReadonlyIfKeys().forEach(k => {
      self._readonlyWatchers.push(self.$watch('form.' + k, () => self.updateReadonlyStates()));
    });
    // Also watch model_train_type for multi-condition auto_value
    self._readonlyWatchers.push(self.$watch('form.model_train_type', () => self.updateReadonlyStates()));
    // Initial apply
    self.updateReadonlyStates();
  },

  updateReadonlyStates() {
    this._enforceDataLoaderUiConstraints();
    this._enforceImageAugmentationUiConstraints();
    this._enforceMossTextEncoderFreeze();
    this._enforceSharedTrainingUiConstraints();
    const self = this;
    // 公用 apply 函数：根据 met 决定启用/解除 readonly 态（含告警文本注入）。
    // 由 [data-readonly-if-key]（单 key eq/neq）与 [data-readonly-if-any]（多 key，任一成立即锁定）复用。
    const apply = (row, met, reasonKey) => {
      // Always apply full state (idempotent) to handle re-renders correctly
      if (met) {
        row.setAttribute('data-readonly-if-active', '1');
        row.classList.add('field-readonly');
        row.querySelectorAll('input, textarea, select').forEach(el => { el.disabled = true; });
        row.querySelectorAll('.btn-menu, .anima-select-trigger').forEach(el => { el.disabled = true; });
        row.querySelectorAll('.stepper button').forEach(el => { el.disabled = true; });
        row.querySelectorAll('.field-actions .btn-icon').forEach(el => { el.disabled = true; el.style.pointerEvents = 'none'; });
        row.querySelectorAll('.anima-select').forEach(sel => { sel.style.pointerEvents = 'none'; sel.style.opacity = '0.55'; });
        // Ensure warning text exists (deduplicate: remove any stale ones first)
        const text = reasonKey ? self.t(reasonKey) : '';
        // Remove ALL existing warnings in this row to avoid duplication
        row.querySelectorAll('.field-readonly-warn').forEach(el => el.remove());
        if (text) {
          const warnEl = document.createElement('div');
          warnEl.className = 'field-readonly-warn';
          warnEl.textContent = text;
          // Insert after .field-row, or at end of row
          const anchor = row.querySelector('.field-row') || row;
          anchor.parentNode === row ? row.appendChild(warnEl) : anchor.parentNode.insertBefore(warnEl, anchor.nextSibling);
        }
      } else {
        row.removeAttribute('data-readonly-if-active');
        row.classList.remove('field-readonly');
        row.querySelectorAll('input, textarea, select').forEach(el => { el.disabled = false; });
        row.querySelectorAll('.btn-menu, .anima-select-trigger').forEach(el => { el.disabled = false; });
        row.querySelectorAll('.stepper button').forEach(el => { el.disabled = false; });
        row.querySelectorAll('.field-actions .btn-icon').forEach(el => { el.disabled = false; el.style.pointerEvents = ''; });
        row.querySelectorAll('.anima-select').forEach(sel => { sel.style.pointerEvents = ''; sel.style.opacity = ''; });
        const warnEl = row.querySelector('.field-readonly-warn');
        if (warnEl) warnEl.remove();
      }
    };

    // 单 key readonly_if：eq/neq/or
    document.querySelectorAll('[data-readonly-if-key]').forEach(row => {
      const key = row.getAttribute('data-readonly-if-key');
      const eqVal = row.getAttribute('data-readonly-if-eq');
      const orVals = (row.getAttribute('data-readonly-if-or') || '').split(',').filter(Boolean);
      const neqVal = row.getAttribute('data-readonly-if-neq');
      const parentVal = self.form[key];

      let met = false;
      if (eqVal !== null) {
        met = String(parentVal) === eqVal;
        if (!met && orVals.length > 0) met = orVals.indexOf(String(parentVal)) !== -1;
      } else if (neqVal !== null) {
        met = String(parentVal) !== neqVal && String(parentVal) !== 'null' && String(parentVal) !== 'undefined' && String(parentVal) !== '';
      }
      apply(row, met, row.getAttribute('data-readonly-if-reason'));
    });

    // readonlyIfAny is OR across clauses; nested arrays are AND groups.
    document.querySelectorAll('[data-readonly-if-any]').forEach(row => {
      let conds = [];
      try { conds = JSON.parse(row.getAttribute('data-readonly-if-any') || '[]'); } catch (e) { /* 防御损坏 */ }
      const met = self._readonlyIfAnyMet(conds);
      apply(row, met, row.getAttribute('data-readonly-if-reason'));
    });
  },

  _readonlyIfAnyMet(clauses) {
    return Array.isArray(clauses) && clauses.some(clause => (
      Array.isArray(clause)
        ? clause.every(condition => this._evalShowIfCond(condition))
        : this._evalShowIfCond(clause)
    ));
  },
};
