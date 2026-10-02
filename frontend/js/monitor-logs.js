/* Normalized log records, pagination and rendering. Loaded before monitor core/render. */
window.monitorLogCoreMixin = {
  // ── Log helpers ────────────────────────────────────────
  async copyLogs() {
    const lines = this.logFullLines || [];
    try { await navigator.clipboard.writeText(lines.join('\n')); this.toast(this.t('common.copied')); }
    catch (_) { this.toast(this.t('common.failed'), 'error'); }
  },
  // 内存缓冲上限 / 分页大小（取自 constants.js LOG）
  _logCap() { return (window.UI_CONSTANTS && window.UI_CONSTANTS.LOG && window.UI_CONSTANTS.LOG.MAX_LINES) || 5000; },
  _logPageSize() { return (window.UI_CONSTANTS && window.UI_CONSTANTS.LOG && window.UI_CONSTANTS.LOG.FULL_PAGE_SIZE) || 1000; },

  _applyMonitorLogSnapshot(lines = [], total = 0, preserveFull = false) {
    const tail = lines.slice(-this._logCap());
    preserveFull = preserveFull && total >= this.logTotal
      && !((this.logAutoScroll || this._logAtBottom) && this.logFullOffset + this.logFullLines.length >= this.logTotal);
    this.logTotal = total;
    this._logObservationVersion = (this._logObservationVersion || 0) + 1;
    this.logLines = tail;
    this._logTailOffset = Math.max(0, total - tail.length);
    this._logContentVersion++;
    if (!preserveFull) {
      this.logFullLines = tail.slice(-this._logPageSize());
      this.logFullOffset = Math.max(0, total - this.logFullLines.length);
      this._logFullLoaded = true;
      this._logFullNeedsResync = false;
      this._logFullSlide = false;
      this._forceLogRebuild = true;
    }
  },

  // HTTP 尾页与 WS 重放可能交叠；按绝对行号替换/追加，文本相同的真实新行也保留。
  _mergeRealtimeLogPage(target, offset, data, cap) {
    const lines = Array.isArray(data.lines) ? data.lines : [];
    const incomingOffset = data.offset;
    const end = offset + target.length;
    const gap = incomingOffset > end;
    const reset = data.reset || gap || data.log_total < end;
    const skip = reset ? 0 : Math.max(0, offset - incomingOffset);
    const index = reset ? 0 : Math.max(0, incomingOffset - offset);
    const incoming = lines.slice(skip);
    if (!reset && incomingOffset + lines.length <= offset) return { offset, trimmed: 0, changed: false, replaced: false };
    const replaced = reset || incoming.some((line, i) => index + i < target.length && target[index + i] !== line);
    const changed = replaced || index + incoming.length !== target.length;
    if (changed) target.splice(index, target.length - index, ...incoming);
    const trimmed = Math.max(0, target.length - cap);
    if (trimmed) target.splice(0, trimmed);
    return { offset: (reset ? incomingOffset : offset) + trimmed, trimmed, changed, replaced, gap };
  },

  _needsLogTailFetch() {
    return !this.logFullLoading && (!this._logFullLoaded || (this._logFullNeedsResync && (this.logAutoScroll || this._logAtBottom)));
  },

  // ── 完整日志模式（后端分页）──────────────────────────────
  /** 当前完整日志模式定位日志的 run_dir（历史）或 task_id（实时） */
  _logSliceRunDir() { return this.selectedRunDir || (!this.liveTaskId && this.currentOutputRunDir) || null; },
  _logSliceTaskId() {
    if (this.selectedRunDir) return null;
    if (this.monitorData && this.monitorData.active_task) return this.monitorData.active_task.id || null;
    if (this.runningTask) return this.runningTask.id || null;
    return this.taskId || null;
  },
  _currentLogSourceKey() {
    const runDir = this._logSliceRunDir();
    if (runDir) return 'run:' + runDir;
    const taskId = this._logSliceTaskId();
    return taskId ? 'task:' + taskId : '';
  },
  /** 是否存在可拉取的实时/历史日志源（无训练且非历史模式时为 false） */
  _hasLogSource() { return !!this._currentLogSourceKey(); },

  /** 回到完整日志末尾并恢复跟随（实时增量刷新）。浏览历史页后用它回到 live 末尾。 */
  followFullTail(opts) {
    opts = opts || {};
    if (!this._hasLogSource()) {
      if (!opts.silent) this.toast(this.t('monitor.logSliceNoSource'), 'error');
      return;
    }
    this.logAutoScroll = true;
    this._logAtBottom = true;
    this._logFullNeedsResync = true;    // 触发 resync：重拉末页（补回浏览期间的新行）
    if (opts.fetchNow) {
      this._logFullNeedsResync = false;
      this._logFullLoaded = true;
      this.fetchLogSlice({ tail: true, silent: !!opts.silent });
      return;
    }
    this.renderDashboard();
  },

  /** 拉取完整日志分页：offset/tail/q 三选一驱动。
   *  opts.silent=true 时若无可拉取日志源则静默返回（不弹错误提示），
   *  用于进入日志标签时的自动末页拉取。用户主动点击工具栏按钮
   *  不传 silent，仍会在无源时给出 toast 反馈。 */
  async fetchLogSlice(opts) {
    opts = opts || {};
    const limit = this._logPageSize();
    const runDir = this._logSliceRunDir();
    const taskId = this._logSliceTaskId();
    if (!runDir && !taskId) {
      this.logFullLoading = false;
      if (!opts.silent) this.toast(this.t('monitor.logSliceNoSource'), 'error');
      return;
    }
    const requestSeq = ++this._logSliceRequestSeq;
    const eventVersion = this._logObservationVersion || 0;
    const sourceKey = runDir ? ('run:' + runDir) : ('task:' + taskId);
    const q = (opts.q !== undefined) ? opts.q : this.logFullQuery;
    let offset = this.logFullOffset;
    if (opts.offset !== undefined) offset = opts.offset;
    else if (opts.matchIdx !== undefined && this.logFullMatches.length && q === this.logFullQuery) {
      // 跳到指定匹配行所在页
      const m = this.logFullMatches[opts.matchIdx];
      offset = Math.floor(m / limit) * limit;
      this.logFullMatchIdx = opts.matchIdx;
    } else if (opts.tail) {
      offset = 0; // tail 由后端计算
    }
    this.logFullLoading = true;
    this.renderDashboard();
    const params = new URLSearchParams();
    if (runDir) params.set('run_dir', runDir);
    else params.set('task_id', taskId);
    params.set('offset', String(offset));
    params.set('limit', String(limit));
    params.set('q', q);
    if (opts.tail) params.set('tail', 'true');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch('/api/monitor/log-slice?' + params.toString(), { signal: controller.signal });
      const j = await r.json();
      const currentRunDir = this._logSliceRunDir();
      const currentTaskId = this._logSliceTaskId();
      const currentSourceKey = currentRunDir ? ('run:' + currentRunDir) : (currentTaskId ? ('task:' + currentTaskId) : '');
      if (requestSeq !== this._logSliceRequestSeq || sourceKey !== currentSourceKey) return;
      if (j.status === 'success' && j.data) {
        const d = j.data;
        const nextLines = d.lines || [];
        const nextMatches = d.match_indices || [];
        if (opts.matchIdx !== undefined && nextMatches.length && !opts._matchJumpResolved) {
          const idx = Math.max(0, Math.min(opts.matchIdx, nextMatches.length - 1));
          const target = nextMatches[idx];
          const pageEnd = d.offset + nextLines.length;
          if (target < d.offset || target >= pageEnd) {
            this.logFullMatches = nextMatches;
            this.logFullMatchIdx = idx;
            await this.fetchLogSlice({
              offset: Math.floor(target / limit) * limit,
              q,
              _matchIdx: idx,
              _matchJumpResolved: true,
            });
            return;
          }
        }
        this.logFullOffset = d.offset;
        // 请求期间可能收到更晚的推送；分页响应不能把徽标总数倒退。
        const updatedDuringRequest = eventVersion !== (this._logObservationVersion || 0);
        this.logTotal = updatedDuringRequest && !this.selectedRunDir ? Math.max(this.logTotal, d.total) : d.total;
        this.logFullLines = nextLines;
        this.logFullMatches = nextMatches;
        this.logFullMatchesTruncated = !!d.matches_truncated;
        this.logFullQuery = q;
        this._logFullSourceKey = sourceKey;
        if (opts._matchIdx !== undefined) {
          this.logFullMatchIdx = opts._matchIdx;
        } else if (opts.matchIdx === undefined) {
          // 非「跳匹配」操作：若当前 offset 落在某匹配所在页，定位到该页首个匹配
          const cur = this.logFullMatches.findIndex(mi => mi >= d.offset && mi < d.offset + this.logFullLines.length);
          this.logFullMatchIdx = cur;
        } else {
          this.logFullMatchIdx = Math.max(0, Math.min(opts.matchIdx, this.logFullMatches.length - 1));
        }
        this._logScrollTarget = (opts.matchIdx !== undefined || opts._matchIdx !== undefined)
          ? this.logFullMatches[this.logFullMatchIdx] : null;
        this._forceLogRebuild = true;
        this._logFullSlide = false;
        if (opts.tail && updatedDuringRequest) this._logFullNeedsResync = true;
        this._logObservationVersion = (this._logObservationVersion || 0) + 1;
      } else {
        this.toast(j.message || this.t('monitor.logSliceError'), 'error');
      }
    } catch (e) {
      if (requestSeq !== this._logSliceRequestSeq) return;
      this.toast(this.t('monitor.logSliceError'), 'error');
    } finally {
      clearTimeout(timeout);
      if (requestSeq === this._logSliceRequestSeq) {
        this.logFullLoading = false;
        this.renderDashboard();
      }
    }
  },

  /** 完整日志搜索（全文件） */
  searchFullLog(q) {
    const query = (q !== undefined ? String(q) : '').trim();
    this.logAutoScroll = false;
    this._logAtBottom = false;
    if (!query) {
      this.logFullQuery = '';
      this.logFullMatches = [];
      this.logFullMatchIdx = -1;
      this.fetchLogSlice({ q: '' });
      return;
    }
    this.fetchLogSlice({ q: query, matchIdx: 0 });
  },

  /** 完整日志翻页 */
  async logFullFirstPage() {
    if (this.logFullLoading || this.logTotal <= 0) return;
    this.logAutoScroll = false;
    this._logAtBottom = false;
    if (this.logFullOffset > 0) await this.fetchLogSlice({ offset: 0 });
    requestAnimationFrame(() => this._scrollLogsToTop());
  },
  logFullLastPage() { this.followFullTail({ fetchNow: true }); },
  logFullPrevPage() { if (this.logFullOffset > 0) { this.logAutoScroll = false; this._logAtBottom = false; this.fetchLogSlice({ offset: Math.max(0, this.logFullOffset - this._logPageSize()) }); } },
  logFullNextPage() { if (this.logFullOffset + this.logFullLines.length < this.logTotal) { this.logAutoScroll = false; this._logAtBottom = false; this.fetchLogSlice({ offset: this.logFullOffset + this._logPageSize() }); } },
  /** 上一/下一匹配行 */
  logFullPrevMatch() {
    if (!this.logFullMatches.length) return;
    let idx = this.logFullMatchIdx;
    // 在当前页之前的最近匹配
    if (idx < 0) idx = this.logFullMatches.length;
    idx = idx - 1;
    if (idx < 0) idx = this.logFullMatches.length - 1;
    this.logAutoScroll = false; this._logAtBottom = false;
    this.fetchLogSlice({ matchIdx: idx });
  },
  logFullNextMatch() {
    if (!this.logFullMatches.length) return;
    let idx = this.logFullMatchIdx + 1;
    if (idx >= this.logFullMatches.length) idx = 0;
    this.logAutoScroll = false; this._logAtBottom = false;
    this.fetchLogSlice({ matchIdx: idx });
  },
  refreshFullLog() {
    const container = document.getElementById('monitorDashboardLogs');
    this._logRestoreScroll = container ? container.scrollTop : 0;
    this.fetchLogSlice({});
  },


};

window.monitorLogRenderMixin = {
  // ═══════════════════════════════════════════════════════════
  //  日志标签（增量追加 + 保留滚动位置）
  // ═══════════════════════════════════════════════════════════
  _logsTabShellHtml(t) {
    let html = '<div class="m-section m-logs-section">';
    const titleKey = 'logFullTitle';
    html += '<div class="m-view-header"><div class="m-view-heading"><span class="m-view-title">' + this.esc(t(titleKey,'Logs')) + '</span><span class="m-logs-count" data-field="log-count">' + this._logDisplayCount() + '</span><span class="m-log-mode-indicator"><i></i>' + this.esc(this.selectedRunDir ? t('historyMode') : t('live')) + '</span></div>';
    html += '<div class="m-view-actions m-logs-tools">';
    html += this._logFullToolbarHtml(t);
    html += '</div></div>';
    html += '<div id="monitorDashboardLogs" class="monitor-logs-container log-lines"></div></div>';
    return html;
  },

  // 完整日志工具栏：一层操作，按「翻页 → 全文件查找 → 当前页/整文件操作」从左到右排列。
  // 翻页组按位置顺序 顶部 → 上一页 → 范围 → 下一页 → 底部，与分页控件的常规排列一致。
  _logFullToolbarHtml(t) {
    let html = '';
    const tailLabel = this.selectedRunDir ? t('logBottom') : t('logLiveTail');
    // 顶部：在有日志且非加载中时始终可用——offset 已为 0 时它仍负责把当前页滚回开头。
    html += '<div class="m-log-toolgroup"><button type="button" class="btn btn-sm btn-secondary" @click="logFullFirstPage()" :disabled="logTotal<=0 || logFullLoading">' + this.esc(t('firstPage')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullPrevPage()" :disabled="logFullOffset<=0">' + this.esc(t('prevPage')) + '</button>';
    html += '<span class="m-logs-range" x-text="logFullRangeText()"></span>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullNextPage()" :disabled="logFullOffset+logFullLines.length>=logTotal">' + this.esc(t('nextPage')) + '</button>';
    html += '<button type="button" class="btn btn-sm log-follow-btn" :class="logAutoScroll ? \'btn-primary\' : \'btn-secondary\'" @click="logFullLastPage()" x-text="selectedRunDir ? t(\'monitor.logBottom\') : (logAutoScroll ? t(\'monitor.logLiveTail\') : t(\'monitor.followPaused\'))">' + this.esc(tailLabel) + '</button></div>';
    html += '<div class="m-log-toolgroup m-log-searchgroup"><input type="text" class="m-logs-search m-logs-search-full" x-model="logFullQuery" placeholder="' + this.esc(t('searchFullLog')) + '" @keydown.enter="searchFullLog(logFullQuery)">';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="searchFullLog(logFullQuery)">' + this.esc(t('search')) + '</button>';
    html += '<span class="m-logs-match-nav" x-show="logFullQuery && !logFullLoading">';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullPrevMatch()">‹</button>';
    html += '<span class="m-logs-match" x-text="logFullMatches.length ? logFullMatchText() : t(\'monitor.noResults\')"></span>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullNextMatch()">›</button>';
    html += '</span></div><div class="m-log-toolgroup m-log-toolgroup-actions">';
    // 当前页操作（复制、刷新）在前，整文件下载收尾：范围由小到大，下载保持最右的位置不变。
    html += '<button type="button" class="btn btn-sm btn-secondary" :disabled="logTotal<=0 || logFullLoading" @click="copyLogs()">' + this.esc(t('copyPage')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" :disabled="logFullLoading" @click="refreshFullLog()">' + this.esc(t('refresh')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="downloadLogs()">' + this.esc(t('downloadFullLog')) + '</button></div>';
    return html;
  },

  _renderLogs(contentEl, d, t, tabChanged) {
    const shellInDom = !!contentEl.querySelector('#monitorDashboardLogs');
    if (tabChanged || !shellInDom || this._builtLogLocale !== this._shellLocale) {
      this._builtLogLocale = this._shellLocale;
      contentEl.innerHTML = this._logsTabShellHtml(t);
      this._forceLogRebuild = true;
      this._bindLogScroll(contentEl);
    }
    if (this._needsLogTailFetch()) {
      this._logFullNeedsResync = false;
      if (this._hasLogSource()) {
        this._logFullLoaded = true;
        this.fetchLogSlice({ tail: true, silent: true });
      }
    }
    if (this._forceLogRebuild || this._logFullSlide) {
      this._populateFullLogs(contentEl, !this._forceLogRebuild);
      this._forceLogRebuild = false;
      this._logFullSlide = false;
    }
    this._updateLogCount(contentEl);
  },

  // Display original row numbers, independent of collapsed DOM rows.
  _buildLogLineDom(line, search, extraClass, lineNo, count = 1) {
    const div = document.createElement('div');
    div.className = 'log-line' + (extraClass ? ' ' + extraClass : '');
    if (lineNo != null) div.dataset.lineNo = String(lineNo);
    const span = document.createElement('span');
    span.className = 'log-line-text';
    const richSource = this._splitRichLogSource(line);
    if (richSource) {
      span.className += ' log-line-text-split';
      const main = document.createElement('span');
      main.className = 'log-line-main';
      const source = document.createElement('span');
      source.className = 'log-line-source';
      this._highlightLogLine(main, richSource.main, search);
      this._highlightLogLine(source, richSource.source, search);
      span.append(main, source);
    } else {
      // Strip terminal right-padding only; keep continuation indentation intact.
      this._highlightLogLine(span, String(line).trimEnd(), search);
    }
    div.appendChild(span);
    this._setLogRepeatCount(div, count);
    return div;
  },

  _setLogRepeatCount(div, count) {
    if (div.dataset.repeatCount === String(count)) return;
    div.dataset.repeatCount = String(count);
    div.dataset.endLineNo = String(Number(div.dataset.lineNo) + count - 1);
    let badge = div.querySelector('.log-repeat-count');
    if (count > 1) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'log-repeat-count';
        const main = div.querySelector('.log-line-main') || div.querySelector('.log-line-text');
        main.appendChild(badge);
      }
      badge.textContent = '×' + count;
    } else if (badge) badge.remove();
  },

  _parseLogRecord(line) {
    const text = String(line || '').trimEnd();
    const match = text.match(/^(?:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d+)?|\[\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\])\s+|\s*)(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\s+(.*)$/);
    if (!match) return null;
    const source = match[3].match(/^(.*\S)[ \t]+([\w.-]+\.py:\d+)$/);
    const message = source ? source[1].trimEnd() : match[3];
    const location = source ? source[2] : '';
    return { timestamp: match[1] || '', level: match[2], message, source: location,
      main: location ? text.slice(0, -location.length).trimEnd() : text,
      key: [match[2], message, location].join('\u0000') };
  },

  _splitRichLogSource(line) {
    const record = this._parseLogRecord(line);
    return record && record.source ? record : null;
  },

  _coalesceRichLogLines(lines, baseOffset, search = '', activeLine = null) {
    const entries = [];
    const needle = search.toLowerCase();
    (lines || []).forEach((line, index) => {
      const text = String(line || '');
      const record = this._parseLogRecord(text);
      const key = record ? record.key : null;
      const lineNo = (baseOffset || 0) + index + 1;
      const last = entries[entries.length - 1];
      if (key && last && key === last.key) {
        last.count++;
        last.lastTime = record.timestamp;
        if (lineNo - 1 === activeLine || (activeLine == null && needle && text.toLowerCase().includes(needle))) last.text = text;
      } else entries.push({ text, key, count: 1, lineNo,
        firstTime: record?.timestamp || '', lastTime: record?.timestamp || '' });
    });
    return entries;
  },

  // ── full：完整日志分页渲染（≤ 一页，静态，绝对行号）──
  _populateFullLogs(contentEl, reuse = false) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    const existing = new Map();
    container.querySelectorAll('.log-line, .log-empty').forEach(n => {
      if (reuse && n.dataset.lineNo) existing.set(Number(n.dataset.lineNo), n);
      else n.remove();
    });
    const offset = this.logFullOffset || 0;
    const lines = this.logFullLines || [];
    const search = this.logFullQuery || '';
    const activeLine = search ? this.logFullMatches[this.logFullMatchIdx] : null;
    const entries = this._coalesceRichLogLines(lines, offset, search, activeLine);
    if (this.logFullLoading || !entries.length) {
      existing.forEach(n => n.remove());
      const empty = document.createElement('div');
      empty.className = 'log-empty dashboard-empty';
      const msg = this._logEmptyMessage(!!this.logFullLoading);
      empty.innerHTML = '<p>' + this.esc(msg) + '</p>';
      container.appendChild(empty);
      return;
    }
    const matchSet = search ? new Set(this.logFullMatches) : null;
    const wanted = new Set(entries.map(item => item.lineNo));
    existing.forEach((node, number) => {
      if (!wanted.has(number)) { node.remove(); existing.delete(number); }
    });
    let cursor = container.firstElementChild;
    let activeNode = null;
    for (const item of entries) {
      const matched = matchSet && lines.slice(item.lineNo - offset - 1, item.lineNo - offset - 1 + item.count)
        .some((_, i) => matchSet.has(item.lineNo - 1 + i));
      const active = activeLine != null && activeLine >= item.lineNo - 1 && activeLine < item.lineNo - 1 + item.count;
      const cls = (matched ? 'log-line-match' : '') + (active ? ' log-line-current-match' : '');
      let node = existing.get(item.lineNo);
      if (node && node._logText === item.text && node._logSearch === search) {
        this._setLogRepeatCount(node, item.count);
        node.className = 'log-line' + (cls ? ' ' + cls : '');
        existing.delete(item.lineNo);
      } else {
        if (node) {
          if (node === cursor) cursor = node.nextElementSibling;
          node.remove();
          existing.delete(item.lineNo);
        }
        node = this._buildLogLineDom(item.text, search, cls, item.lineNo, item.count);
        node._logText = item.text;
        node._logSearch = search;
      }
      const badge = node.querySelector('.log-repeat-count');
      if (badge) {
        const range = `${item.lineNo}–${item.lineNo + item.count - 1}`;
        const times = item.firstTime ? ` · ${item.firstTime} → ${item.lastTime}` : '';
        const boundary = (offset > 0 && item.lineNo === offset + 1)
          || (offset + lines.length < this.logTotal && item.lineNo + item.count - 1 === offset + lines.length);
        badge.textContent = boundary ? this.t('monitor.logRepeatPageCount').replace('{count}', item.count) : '×' + item.count;
        badge.title = this.t('monitor.logRepeatPage') + `: ${item.count} (${range})${times}`;
      }
      if (active) activeNode = node;
      // Leave unchanged nodes in place: append/update/remove only affected rows.
      if (node !== cursor) container.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
    }
    existing.forEach(n => n.remove());
    if (this._logScrollTarget != null && activeNode) {
      container.scrollTop += activeNode.getBoundingClientRect().top - container.getBoundingClientRect().top
        - (container.clientHeight - activeNode.offsetHeight) / 2;
    } else if (this.logAutoScroll || this._logAtBottom) container.scrollTop = container.scrollHeight;
    else if (!reuse) container.scrollTop = this._logRestoreScroll || 0;
    this._logScrollTarget = null;
    this._logRestoreScroll = null;
  },

  _updateLogCount(contentEl) {
    const countEl = contentEl.querySelector('[data-field="log-count"]');
    if (countEl) countEl.textContent = this._logDisplayCount();
  },
  _logDisplayCount() {
    return this.logTotal || 0;
  },
  /** 日志空态文案：按场景区分（实时无训练 / 实时训练中等待输出 / 历史无日志 / 加载中） */
  _logEmptyMessage(isLoading) {
    if (isLoading) return this.t('monitor.loading');
    if (this.selectedRunDir) {
      return this.t('monitor.noLogsHistoryHint');
    }
    const state = (this.monitorData && this.monitorData.state) || 'IDLE';
    if (state === 'RUNNING') {
      return this.t('monitor.noLogsRunningHint');
    }
    return this.t('monitor.noLogsIdleHint');
  },
  // 完整日志工具栏文本（reactive：x-text 调用）
  logFullRangeText() {
    const total = this.logTotal || 0;
    if (!total) return '0 / 0';
    const off = this.logFullOffset || 0;
    const end = Math.min(off + (this.logFullLines ? this.logFullLines.length : 0), total);
    return (off + 1) + '–' + end + ' / ' + total;
  },
  logFullMatchText() {
    const n = this.logFullMatches ? this.logFullMatches.length : 0;
    return (this.logFullMatchIdx >= 0 ? (this.logFullMatchIdx + 1) : 0) + '/' + n + (this.logFullMatchesTruncated ? '+' : '');
  },

  _bindLogScroll(contentEl) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    container.onscroll = () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
      // Search navigation can scroll to the bottom programmatically; it must
      // remain paused until the user explicitly follows the live tail again.
      this._logAtBottom = atBottom && (!this.logFullQuery || this.logAutoScroll);
      if (this.logAutoScroll && !atBottom) this.logAutoScroll = false;
      else if (!this.logAutoScroll && this._logAtBottom) this.logAutoScroll = true;
    };
  },

  _scrollLogsToTop() {
    const container = document.querySelector('#monitorDashboardLogs');
    if (container) { container.scrollTop = 0; this._logAtBottom = false; this.logAutoScroll = false; }
  },

  // ═══════════════════════════════════════════════════════════
  //  VSCode-style log tokenizer — single regex, one pass per line
  //  Groups: 1=str 2=url 3=domain 4=hex 5=ts 6=lvl 7=path 8=mod 9=exc
  //         10=const 11=num 12=unit 13=kw 14=empty 15=stack
  // ═══════════════════════════════════════════════════════════
  _LOG_TOKEN_RE: (() => {
    // ts 用非捕获括号：(外层 wrapper 已是捕获组 g5，若 ts 再用捕获括号会吞掉 g6，
    // 把 lvl 挤到 g7 → 级别被误染为 log-path 绿色、g===6 重映射失效。)
    const ts   = '(?:\\d{4}[-/]\\d{2}[-/]\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?|\\b\\d{2}[/-]\\d{2}[/-]\\d{4}\\b|\\b\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\b)';
    const lvl  = '(?:ALERT|CRITICAL|EMERGENCY|FATAL|ERROR|FAILURE|FAIL|Fatal|HINT|INFORMATION|NOTICE|Info|WARNING|Warn|DEBUG|Debug|TRACE|Trace|INFO|WARN)\\b';
    // Fix5：dir 段允许点（后接分隔符，无歧义）；文件名 stem 拆为「无点段+.」序列，
    //   消除与 \\.(ext) 边界的互相回溯；重复次数有界，杜绝病态 O(n²)。
    const path = '(?:[\\w.@()-]+[\\/\\\\]){0,10}(?:[\\w@()-]+\\.){0,12}[\\w@()-]+\\.(?:py|toml|json|yaml|yml|txt|log|safetensors|pt|pth|ckpt|bin|csv|tsv|pb|h5|onnx|java|kt|js|ts|jsx|tsx|go|rs|cpp|c|h|hpp|cs|rb|php|swift)(?::\\d+)?';
    const mod  = '\\b[a-zA-Z_]\\w*(?:\\.\\w+){1,20}\\b';
    const exc  = '\\b[A-Z]\\w*(?:Error|Exception|Warning|Fault)\\b';
    const cnst = '\\b(?:true|false|null|undefined|none|NaN|Inf(?:inity)?|N\\/A)\\b';
    const num  = '(?<![\\w.])(?:[+-]?\\d+\\.?\\d*(?:[eE][+-]?\\d+)?)';
    const unit = '(?<=\\d)(?:it\\/s|s\\/it|[sm]s|us|ns|GiB|MiB|KiB|GB|MB|KB|TB|B|%)';
    const kw   = '\\b(?:Traceback|raise|assert|failed|failure|abort|killed|OOM|CUDA out of memory|memory)\\b';
    return new RegExp(
      '(`[^`]*`|"[^"]*"|\'(?:\\\\.|[^\'\\\\])*\')' +  // group 1: quoted strings
      '|(https?:\\/\\/[^\\s,;)\\]}>]+)' +               // group 2: URLs
      // Fix5：domain 段有界重复 + TLD 后置 (?![\\w]) 边界，固化匹配
      '|(\\b(?:[\\w-]+\\.){1,10}(?:com|org|net|io|dev|co|ai|app|gg|xyz|me|info|biz|tv|cc)(?![\\w])(?:\\/[^\\s,;)\\]}>]*)?)' + // group 3: domains
      '|(\\b[0-9a-f]{40}\\b|\\b[0-9a-f]{10}\\b|\\b[0-9a-f]{7}\\b|\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b|\\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b|\\b0x[0-9a-f]+\\b)' + // group 4: hex
      '|(' + ts + ')' +                                  // group 5: timestamp
      '|(' + lvl + ')' +                                 // group 6: log level
      '|(' + path + ')' +                                // group 7: file path
      '|(' + mod + ')' +                                 // group 8: module path
      '|(' + exc + ')' +                                 // group 9: exception
      '|(' + cnst + ')' +                                // group 10: constant
      '|(' + num + ')' +                                 // group 11: number
      '|(' + unit + ')' +                                // group 12: unit
      '|(' + kw + ')' +                                  // group 13: keyword
      '|(\\{\\s*\\}|\\[\\s*\\])' +                       // group 14: empty object/array
      '|(^\\s*at\\s+)',                                  // group 15: stack trace
      'gi'
    );
  })(),

  _highlightLogLine(rootEl, lineText, search) {
    // Highlight the full source first; matches can cross syntax-token boundaries.
    if (search) { this._appendHighlighted(rootEl, lineText, search, search.toLowerCase()); return; }
    const classes = [
      null,           // 0: (unused)
      'log-str',      // 1: quoted string
      'log-url',      // 2: URL
      'log-url',      // 3: domain
      'log-hex',      // 4: hex/UUID/MAC
      'log-ts',       // 5: timestamp
      'log-lvl-fix',  // 6: log level (class set below from match)
      'log-path',     // 7: file path
      'log-module',   // 8: module path
      'log-exc',      // 9: exception
      'log-const',    // 10: constant
      'log-num',      // 11: number
      'log-unit',     // 12: unit
      'log-kw',       // 13: keyword
      'log-punct',    // 14: empty obj/arr
      'log-exc',      // 15: stack trace "at "
    ];
    const re = this._LOG_TOKEN_RE;
    const lower = search ? search.toLowerCase() : '';
    // Fix4：把 search 高亮并入分词 pass —— 对任意文本段（纯文本或 token 内）按
    //   search 切分并包 <mark>，省掉原先每行一次 TreeWalker 二次遍历。
    const appendText = (parent, text) => {
      if (!lower) { parent.appendChild(document.createTextNode(text)); return; }
      this._appendHighlighted(parent, text, search, lower);
    };
    let lastIdx = 0;
    let m;
    const frag = document.createDocumentFragment();
    while ((m = re.exec(lineText)) !== null) {
      if (m.index > lastIdx) appendText(frag, lineText.slice(lastIdx, m.index));
      // Find which group matched
      let cls = '';
      for (let g = 1; g < m.length; g++) {
        if (m[g] !== undefined) {
          cls = classes[g];
          if (g === 6) { // log level — map to specific VSCode class
            const lv = m[g].toUpperCase();
            if (/^(ERROR|CRITICAL|FATAL|ALERT|EMERGENCY|FAILURE|FAIL)$/.test(lv)) cls = 'log-lvl log-lvl-ERROR';
            else if (/^(WARNING|WARN)$/.test(lv)) cls = 'log-lvl log-lvl-WARN';
            else if (/^(INFO|INFORMATION|NOTICE|HINT)$/.test(lv)) cls = 'log-lvl log-lvl-INFO';
            else if (/^(DEBUG|TRACE)$/.test(lv)) cls = 'log-lvl log-lvl-DEBUG';
          }
          break;
        }
      }
      if (cls) {
        const span = document.createElement('span');
        span.className = cls;
        appendText(span, m[0]);   // token 内命中 search 也高亮（mark 仅加背景，保留 token 颜色）
        frag.appendChild(span);
      } else {
        appendText(frag, m[0]);
      }
      lastIdx = re.lastIndex;
    }
    if (lastIdx < lineText.length) appendText(frag, lineText.slice(lastIdx));
    rootEl.appendChild(frag);
  },

  // 把 text 追加到 parent，其中命中 search 的片段包 <mark>（一次线性扫描）
  _appendHighlighted(parent, text, search, lower) {
    if (!lower) { parent.appendChild(document.createTextNode(text)); return; }
    const lowerText = text.toLowerCase();
    let from = 0, idx = lowerText.indexOf(lower, from);
    if (idx === -1) { parent.appendChild(document.createTextNode(text)); return; }
    while (idx !== -1) {
      if (idx > from) parent.appendChild(document.createTextNode(text.slice(from, idx)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + search.length);
      parent.appendChild(mark);
      from = idx + search.length;
      idx = lowerText.indexOf(lower, from);
    }
    if (from < text.length) parent.appendChild(document.createTextNode(text.slice(from)));
  },

  downloadLogs() {
    const runDir = this._logSliceRunDir();
    const taskId = this._logSliceTaskId();
    if (!runDir && !taskId) {
      this.toast(this.t('monitor.logSliceNoSource'), 'error');
      return;
    }
    const params = new URLSearchParams();
    if (runDir) params.set('run_dir', runDir);
    else params.set('task_id', taskId);
    this._triggerDownload('/api/monitor/log-download?' + params.toString());
    this.toast(this.t('monitor.logDownloadStarted'));
  },


};
