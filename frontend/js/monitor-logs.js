/* Normalized log records, pagination and rendering. Loaded before monitor core/render. */
window.monitorLogCoreMixin = {
  // ── Log helpers ────────────────────────────────────────
  async copyLogs() {
    const lines = this.logMode === 'full' ? (this.logFullLines || []) : (this.logLines || []);
    try { await navigator.clipboard.writeText(lines.join('\n')); this.toast(this.t('common.copied')); }
    catch (_) { this.toast(this.t('common.failed'), 'error'); }
  },
  requestClearLogs() {
    this.openConfirm(this.t('monitor.confirmClearLogsTitle'), this.t('monitor.confirmClearLogs'), () => this.clearLogs(), this.t('common.confirm'), { danger: true });
  },
  clearLogs() {
    this.logLines = []; this._logContentVersion = 0;
    this._renderedLogCount = 0; this._renderedLogFilterKey = '';
    this._logDirty = true; this._logTrimK = 0; this._forceLogRebuild = true;
    this.renderDashboard();
  },

  // 内存缓冲上限 / 分页大小（取自 constants.js LOG）
  _logCap() { return (window.UI_CONSTANTS && window.UI_CONSTANTS.LOG && window.UI_CONSTANTS.LOG.MAX_LINES) || 5000; },
  _logPageSize() { return (window.UI_CONSTANTS && window.UI_CONSTANTS.LOG && window.UI_CONSTANTS.LOG.FULL_PAGE_SIZE) || 1000; },

  _tqdmProgressSignature(line) {
    const match = String(line || '').match(/^\s*steps:\s+\d+%\|.*\|\s*(\d+)\s*\/\s*(\d+)(?=\s*\[)/i);
    return match ? match[1] + '/' + match[2] : '';
  },

  _mergeRealtimeLogLines(target, incoming) {
    const lines = Array.isArray(incoming) ? incoming : [];
    let overlap = 0;
    const maxOverlap = Math.min(target.length, lines.length);
    for (let size = maxOverlap; size > 0; size--) {
      let matches = true;
      for (let index = 0; index < size; index++) {
        if (target[target.length - size + index] !== lines[index]) { matches = false; break; }
      }
      if (matches) { overlap = size; break; }
    }

    let appended = 0;
    let replaced = 0;
    for (const line of lines.slice(overlap)) {
      const signature = this._tqdmProgressSignature(line);
      const lastIndex = target.length - 1;
      if (signature && lastIndex >= 0 && signature === this._tqdmProgressSignature(target[lastIndex])) {
        if (target[lastIndex] !== line) {
          target[lastIndex] = line;
          replaced++;
        }
        continue;
      }
      target.push(line);
      appended++;
    }
    return { appended, replaced, overlap, changed: appended > 0 || replaced > 0 };
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

  /** 切换 tail/full 模式 */
  async setLogMode(mode) {
    if (mode === this.logMode) return;
    this.logMode = mode;
    this._renderedLogCount = 0;
    this._renderedLogFilterKey = '';
    this._forceLogRebuild = true;
    this._logFullSlide = false;
    this._logFullEvictK = 0;
    if (mode === 'full') {
      // 进入完整日志：末页 + 跟随（实时训练随 WebSocket 增量滚动；历史停在末尾）
      this.logAutoScroll = true;
      this._logAtBottom = true;
      this._logFullLoaded = true;       // setLogMode 自行拉取，标记已加载避免首屏重复拉
      this._logFullNeedsResync = false;
      this.logFullLoading = true;
      this.logFullLines = [];
      this.renderDashboard();           // 先渲染外壳 + Loading
      await this.fetchLogSlice({ tail: true });
      return;
    }
    // 切回 tail：恢复实时尾部缓冲视图
    this.logAutoScroll = true;
    this._logAtBottom = true;
    this._logDirty = true;
    this.renderDashboard();
  },

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
    const eventVersion = this._logEventVersion || 0;
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
        this.logFullTotal = d.total;
        this.logFullLines = nextLines;
        this.logFullMatches = nextMatches;
        this.logFullMatchesTruncated = !!d.matches_truncated;
        this.logFullQuery = q;
        this._logFullSourceKey = sourceKey;
        // 更新 logTotal（live 模式首次探得）
        if (!this.selectedRunDir) this.logTotal = d.total;
        if (opts._matchIdx !== undefined) {
          this.logFullMatchIdx = opts._matchIdx;
        } else if (opts.matchIdx === undefined) {
          // 非「跳匹配」操作：若当前 offset 落在某匹配所在页，定位到该页首个匹配
          const cur = this.logFullMatches.findIndex(mi => mi >= d.offset && mi < d.offset + this.logFullLines.length);
          this.logFullMatchIdx = cur;
        } else {
          this.logFullMatchIdx = Math.max(0, Math.min(opts.matchIdx, this.logFullMatches.length - 1));
        }
        this._forceLogRebuild = true;
        this._logFullSlide = false;
        this._logFullEvictK = 0;
        if (opts.tail && eventVersion !== (this._logEventVersion || 0)) this._logFullNeedsResync = true;
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
    if (this.logFullLoading || this.logFullTotal <= 0) return;
    this.logAutoScroll = false;
    this._logAtBottom = false;
    if (this.logFullOffset > 0) await this.fetchLogSlice({ offset: 0 });
    requestAnimationFrame(() => this._scrollLogsToTop());
  },
  logFullLastPage() { this.followFullTail({ fetchNow: true }); },
  logFullPrevPage() { if (this.logFullOffset > 0) { this.logAutoScroll = false; this._logAtBottom = false; this.fetchLogSlice({ offset: Math.max(0, this.logFullOffset - this._logPageSize()) }); } },
  logFullNextPage() { if (this.logFullOffset + this.logFullLines.length < this.logFullTotal) { this.logAutoScroll = false; this._logAtBottom = false; this.fetchLogSlice({ offset: this.logFullOffset + this._logPageSize() }); } },
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
    const titleKey = this.logMode === 'full' ? 'logFullTitle' : 'logTitle';
    html += '<div class="m-view-header"><div class="m-view-heading"><span class="m-view-title">' + this.esc(t(titleKey,'Logs')) + '</span><span class="m-logs-count" data-field="log-count">' + this._logDisplayCount() + '</span><span class="m-log-mode-indicator"><i></i>' + this.esc(this.selectedRunDir ? t('historyMode') : t('live')) + '</span></div>';
    html += '<div class="m-view-actions m-logs-tools">';
    if (this.logMode === 'full') {
      html += this._logFullToolbarHtml(t);
    } else {
      html += '<div class="m-log-toolgroup"><button type="button" class="btn btn-sm btn-secondary" @click="setLogMode(\'full\')">' + this.esc(t('logFullMode')) + '</button><button type="button" class="btn btn-sm" :class="logAutoScroll?\'btn-primary\':\'btn-secondary\'" @click="logAutoScroll=!logAutoScroll"><span x-text="logAutoScroll?\'' + this.esc(t('logAutoScroll')) + ': ON\':\'' + this.esc(t('logAutoScroll')) + ': OFF\'"></span></button></div>';
      html += '<div class="m-log-toolgroup m-log-searchgroup"><input type="text" class="m-logs-search" x-model="logSearch" placeholder="' + this.esc(t('logSearch')) + '" @input.debounce.300ms="renderDashboard()">';
      const levels = ['all','info','warn','error'];
      const levelLabels = {all:t('logLevelAll'),info:t('logLevelInfo'),warn:t('logLevelWarn'),error:t('logLevelError')};
      levels.forEach(l => {
        html += '<button type="button" class="log-level-btn" :class="{active:logLevel===\'' + l + '\'}" @click="logLevel=\'' + l + '\';renderDashboard()">' + this.esc(levelLabels[l]) + '</button>';
      });
      html += '</div><div class="m-log-toolgroup m-log-toolgroup-actions"><button type="button" class="btn btn-sm btn-secondary" @click="copyLogs()">' + this.esc(t('logCopy')) + '</button>';
      html += '<button type="button" class="btn btn-sm btn-secondary" @click="requestClearLogs()">' + this.esc(t('logClear')) + '</button>';
      html += '<button type="button" class="btn btn-sm btn-secondary log-nav-btn-top" @click="_scrollLogsToTop()">' + this.esc(t('scrollToTop')) + '</button>';
      html += '<button type="button" class="btn btn-sm btn-secondary log-nav-btn-bottom" @click="logAutoScroll=true;_scrollLogsToBottom()">' + this.esc(t('scrollToBottom')) + '</button>';
      html += '<button type="button" class="btn btn-sm btn-secondary" @click="downloadLogs()">' + this.esc(t('logDownload')) + '</button></div>';
    }
    html += '</div></div>';
    html += '<div id="monitorDashboardLogs" class="monitor-logs-container log-lines"></div></div>';
    return html;
  },

  // 完整日志工具栏：一层操作，直接覆盖浏览、搜索、复制和下载。
  _logFullToolbarHtml(t) {
    let html = '';
    const tailLabel = this.selectedRunDir ? t('logBottom') : t('logLiveTail');
    html += '<div class="m-log-toolgroup"><button type="button" class="btn btn-sm log-follow-btn" :class="logAutoScroll ? \'btn-primary\' : \'btn-secondary\'" @click="logFullLastPage()" x-text="selectedRunDir ? t(\'monitor.logBottom\') : (logAutoScroll ? t(\'monitor.logLiveTail\') : t(\'monitor.followPaused\'))">' + this.esc(tailLabel) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullPrevPage()" :disabled="logFullOffset<=0">' + this.esc(t('prevPage')) + '</button>';
    html += '<span class="m-logs-range" x-text="logFullRangeText()"></span>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullNextPage()" :disabled="logFullOffset+logFullLines.length>=logFullTotal">' + this.esc(t('nextPage')) + '</button></div>';
    html += '<div class="m-log-toolgroup m-log-searchgroup"><input type="text" class="m-logs-search m-logs-search-full" x-model="logFullQuery" placeholder="' + this.esc(t('searchFullLog')) + '" @keydown.enter="searchFullLog(logFullQuery)">';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="searchFullLog(logFullQuery)">' + this.esc(t('search')) + '</button>';
    html += '<span class="m-logs-match-nav" x-show="logFullQuery && !logFullLoading">';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullPrevMatch()">‹</button>';
    html += '<span class="m-logs-match" x-text="logFullMatches.length ? logFullMatchText() : t(\'monitor.noResults\')"></span>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="logFullNextMatch()">›</button>';
    html += '</span></div><div class="m-log-toolgroup m-log-toolgroup-actions"><button type="button" class="btn btn-sm btn-secondary" @click="downloadLogs()">' + this.esc(t('downloadFullLog')) + '</button>';
    html += '<details class="m-monitor-more"><summary class="btn btn-sm btn-secondary">' + this.esc(t('moreActions')) + '</summary><div>';
    [['logFullFirstPage()', 'firstPage'], ['copyLogs()', 'copyPage'], ['refreshFullLog()', 'refresh']].forEach(([action, label]) => {
      const disabled = label === 'refresh' ? 'logFullLoading' : 'logFullTotal<=0 || logFullLoading';
      html += '<button type="button" class="btn btn-sm" :disabled="' + disabled + '" @click="' + action + ';$el.closest(\'details\').open=false">' + this.esc(t(label)) + '</button>';
    });
    html += '</div></details></div>';
    return html;
  },

  _logLineMatches(line, search, level) {
    const lower = line.toLowerCase();
    if (search && lower.indexOf(search) === -1) return false;
    if (level === 'error') {
      return lower.indexOf('error') !== -1 || lower.indexOf('traceback') !== -1 || lower.indexOf('exception') !== -1 || /\bcuda\b.*\berror\b/i.test(line) || /\bfail\b/i.test(line);
    } else if (level === 'warn') {
      return lower.indexOf('warning') !== -1 || lower.indexOf('warn') !== -1 || /\bdeprecated\b/i.test(line);
    } else if (level === 'info') {
      return !(lower.indexOf('error') !== -1 || lower.indexOf('traceback') !== -1 || lower.indexOf('exception') !== -1 || lower.indexOf('warning') !== -1 || lower.indexOf('warn') !== -1);
    }
    return true;
  },

  _renderLogs(contentEl, d, t, tabChanged) {
    const shellInDom = !!contentEl.querySelector('#monitorDashboardLogs');
    const shellStale = this._builtLogMode !== this.logMode || this._builtLogLocale !== this._shellLocale;

    // ── 首次 / 标签切换 / 模式切换：重建外壳 + 全量填充 ──
    if (tabChanged || !shellInDom || shellStale) {
      this._builtLogMode = this.logMode;
      this._builtLogLocale = this._shellLocale;
      contentEl.innerHTML = this._logsTabShellHtml(t);
      this._renderedLogFilterKey = '';
      this._renderedLogCount = 0;
      this._logTrimK = 0;
      this._forceLogRebuild = false;
      this._logChunking = false;
      this._populateLogs(contentEl, true);
      // full 模式首屏/重连：自动拉取末页（async，先渲染 Loading 态，拉完再 renderDashboard）
      if (this.logMode === 'full' && !this.logFullLoading && (!this._logFullLoaded || this._logFullNeedsResync)) {
        // 无日志源（无训练且非历史模式）→ 不触发拉取，避免 toast 误报；保持空态文案。
        // 不标记 _logFullLoaded，以便后续训练启动/实时重连时自动重新拉取。
        if (!this._hasLogSource()) {
          this._logFullNeedsResync = false;
        } else {
          this._logFullNeedsResync = false;
          this._logFullLoaded = true;
          this.fetchLogSlice({ tail: true, silent: true });
        }
      }
      this._bindLogScroll(contentEl);
      // tail 全量是分帧的，末帧自会滚底；此处仅在非分帧（full/空）时按需滚动
      this._afterLogsRender(contentEl, this.logMode === 'tail' && !this._logChunking);
      return;
    }

    // ── full 模式：末页 WebSocket 增量 + 翻页静态；首屏/重连自动拉取末页 ──
    if (this.logMode === 'full') {
      // 首屏未加载或实时重连后需 resync → 自动拉取末页（async，先返回 loading 态，拉完再 renderDashboard）
      if ((!this._logFullLoaded || this._logFullNeedsResync) && !this.logFullLoading) {
        if (!this._hasLogSource()) {
          this._logFullNeedsResync = false;  // 留待有源时再拉
        } else {
          this._logFullNeedsResync = false;
          this._logFullLoaded = true;
          this.fetchLogSlice({ tail: true, silent: true });
        }
      }
      if (this._logFullSlide) {
        this._logFullSlide = false;
        this._populateFullSlide(contentEl);
      } else if (this._forceLogRebuild) {
        this._forceLogRebuild = false;
        this._populateLogs(contentEl, true);
      }
      this._updateLogCount(contentEl);
      return;
    }

    // ── tail 模式 ──
    const search = (this.logSearch || '').toLowerCase();
    const level = this.logLevel || 'all';
    const filterKey = search + '|' + level;
    const filterChanged = this._renderedLogFilterKey !== filterKey;
    const trimmed = this.logLines.length < this._renderedLogCount;
    const wasDirty = this._logDirty;

    // Fix3：非脏且无过滤/裁剪/强制重建 → 跳过日志重排（progress/hardware/loss 不再触碰日志 DOM）
    if (!wasDirty && !filterChanged && !trimmed && !this._forceLogRebuild) {
      this._updateLogCount(contentEl);
      return;
    }

    if (filterChanged || trimmed || this._logTrimK > 0 || this._forceLogRebuild) {
      this._renderedLogFilterKey = filterKey;
      this._renderedLogCount = 0;
      this._logTrimK = 0;
      this._forceLogRebuild = false;
      this._populateLogs(contentEl, true);          // 分帧全量重建
      this._logDirty = false;
      this._updateLogCount(contentEl);
      this._afterLogsRender(contentEl, !this._logChunking); // 末帧自滚底
      return;
    }

    // Fix1：分帧进行中 → 跳过增量（循环实时读 logLines 会吸收新行；裁剪已取消分帧并置 forceRebuild）
    if (this._logChunking) {
      this._logDirty = false;
      this._updateLogCount(contentEl);
      return;
    }

    // 增量 / 滑窗（Fix2）
    if (wasDirty && (this.logLines.length > this._renderedLogCount || this._logTrimK > 0)) {
      this._populateLogs(contentEl, false);
    }
    this._logDirty = false;
    this._updateLogCount(contentEl);
    this._afterLogsRender(contentEl, wasDirty);
  },

  _populateLogs(contentEl, isFullRebuild) {
    if (this.logMode === 'full') { this._populateFullLogs(contentEl); return; }
    const search = (this.logSearch || '').toLowerCase();
    const level = this.logLevel || 'all';
    if (isFullRebuild) this._populateTailFull(contentEl, search, level);
    else this._populateTailIncremental(contentEl, search, level);
  },

  // 行号由 CSS counter（.log-line::before）按 DOM 位置自动生成；full 模式由
  // counter-reset=offset 给出绝对行号。故此处不再创建 num span。
  _buildLogLineDom(line, search, extraClass, lineNo) {
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
      span.appendChild(main);
      span.appendChild(source);
    } else {
      this._highlightLogLine(span, line, search);
    }
    div.appendChild(span);
    return div;
  },

  _splitRichLogSource(lineText) {
    const text = String(lineText || '');
    const pathTail = '((?:[A-Za-z]:[\\\\/])?(?:[\\w.@()-]+[\\\\/\\\\]){0,10}(?:[\\w@()-]+\\.){0,12}[\\w@()-]+\\.(?:py|toml|json|yaml|yml|txt|log|js|ts|jsx|tsx|go|rs|cpp|c|h|hpp)(?::\\d+)?)';
    let m;
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (normalized.indexOf('\n') >= 0) {
      m = normalized.match(new RegExp('^(.*)\\n[ \\t]*' + pathTail + '\\s*$', 's'));
    } else {
      // Rich console pads the source column with a long run of spaces. In narrow
      // containers that padding wraps visually; split it into a real right column.
      m = normalized.match(new RegExp('^(.*?)[ \\t]{3,}' + pathTail + '\\s*$'));
    }
    if (!m) return null;
    const main = m[1].replace(/\n[ \t]*$/g, '').trimEnd();
    const source = m[2].trim();
    if (!main || !source) return null;
    return { main, source };
  },

  _coalesceRichLogLines(lines, baseOffset) {
    // Keep disk rows and DOM rows one-to-one in both full and incremental views.
    return (lines || []).map((text, index) => ({ text: String(text || ''), lineNo: (baseOffset || 0) + index + 1 }));
  },

  // ── tail：分帧全量重建（Fix1 _logChunking 防竞态；末帧自滚底）──
  _populateTailFull(contentEl, search, level) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    container.querySelectorAll('.log-line, .log-empty').forEach(n => n.remove());
    container.style.counterReset = 'logline 0';   // tail：缓冲内相对行号 1..n
    const lines = this.logLines.slice();
    const version = this._logContentVersion;
    const entries = this._coalesceRichLogLines(lines, 0);
    const CHUNK = 400;
    const self = this;
    this._logChunking = true;
    const generation = this._logRenderGeneration = (this._logRenderGeneration || 0) + 1;
    let i = 0;
    let firstChunk = true;

    function renderChunk() {
      if (!self._logChunking || generation !== self._logRenderGeneration) return;
      const frag = document.createDocumentFragment();
      let count = 0;
      while (i < entries.length && count < CHUNK) {
        const item = entries[i];
        if (self._logLineMatches(item.text, search, level)) {
          frag.appendChild(self._buildLogLineDom(item.text, search, '', item.lineNo));
        }
        i++; count++;
      }
      if (firstChunk) {
        if (entries.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'log-empty dashboard-empty';
          empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>' + self.esc(self._logEmptyMessage(false)) + '</p>';
          container.appendChild(empty);
          self._renderedLogCount = lines.length;
          self._logChunking = false;
          self._afterLogsRender(contentEl, false);
          return;
        }
        firstChunk = false;
      }
      container.appendChild(frag);
      self._renderedLogCount = Math.min(i, entries.length);
      if (i < entries.length) {
        requestAnimationFrame(renderChunk);
      } else {
        self._logChunking = false;
        if (!container.querySelector('.log-line') && entries.length > 0) {
          const empty = document.createElement('div');
          empty.className = 'log-empty dashboard-empty';
          empty.innerHTML = '<p>' + self.esc(self.t('monitor.noResults')) + '</p>';
          container.appendChild(empty);
        }
        self._renderedLogCount = lines.length;
        self._afterLogsRender(contentEl, true);   // 末帧：按需滚底
        if (self._logContentVersion !== version) { self._logDirty = true; self._forceLogRebuild = true; self.scheduleRender(); }
      }
    }
    requestAnimationFrame(renderChunk);
  },

  // ── tail：增量 + 滑窗（Fix2 删顶补底，O(新增) 而非 O(缓冲)）──
  _populateTailIncremental(contentEl, search, level) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    const lines = this.logLines;

    // 滑窗删顶：环形缓冲裁掉头部 K 行 → 同步删除 DOM 前 K 个 .log-line。
    // CSS counter 自动重编 surviving 行号，无需 JS 重编。仅在 DOM 已同步时执行。
    if (this._logTrimK > 0) {
      const k = Math.min(this._logTrimK, this._renderedLogCount);
      let remove = k;
      while (remove-- > 0) {
        const first = container.querySelector('.log-line');
        if (!first) break;
        first.remove();
      }
      this._renderedLogCount = Math.max(0, this._renderedLogCount - k);
      this._logTrimK = 0;
      const emp = container.querySelector('.log-empty');
      if (emp) emp.remove();
    }

    // 补底：追加新行
    const start = this._renderedLogCount;
    if (start < lines.length) {
      const frag = document.createDocumentFragment();
      let appended = 0;
      for (let i = start; i < lines.length; i++) {
        if (!this._logLineMatches(lines[i], search, level)) continue;
        frag.appendChild(this._buildLogLineDom(lines[i], search, '', i + 1));
        appended++;
      }
      container.appendChild(frag);
      const emp = container.querySelector('.log-empty');
      if (emp && appended > 0) emp.remove();
      this._renderedLogCount = lines.length;
    }
  },

  // ── full：完整日志分页渲染（≤ 一页，静态，绝对行号）──
  _populateFullLogs(contentEl) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    container.querySelectorAll('.log-line, .log-empty').forEach(n => n.remove());
    const offset = this.logFullOffset || 0;
    container.style.counterReset = 'logline ' + offset;  // 首行显示 offset+1
    const lines = this.logFullLines || [];
    const entries = this._coalesceRichLogLines(lines, offset);
    if (this.logFullLoading || !entries.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty dashboard-empty';
      const msg = this._logEmptyMessage(!!this.logFullLoading);
      empty.innerHTML = '<p>' + this.esc(msg) + '</p>';
      container.appendChild(empty);
      this._renderedLogCount = 0;
      return;
    }
    const search = this.logFullQuery || '';
    const matchSet = search ? new Set(this.logFullMatches) : null;
    const frag = document.createDocumentFragment();
    for (const item of entries) {
      const cls = (matchSet && matchSet.has(item.lineNo - 1)) ? 'log-line-match' : '';
      frag.appendChild(this._buildLogLineDom(item.text, search, cls, item.lineNo));
    }
    container.appendChild(frag);
    this._renderedLogCount = lines.length;
    // 跟随（实时末页 / 历史停在末尾）滚底；浏览历史页时停在顶部
    container.scrollTop = (this.logAutoScroll || this._logAtBottom) ? container.scrollHeight : (this._logRestoreScroll || 0);
    this._logRestoreScroll = null;
  },

  // ── full：实时增量 slide（O(新行) 删除顶部 evicted + 追加底部新行，零 HTTP）──
  _populateFullSlide(contentEl) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    const lines = this.logFullLines;

    // 删顶：实时日志处理已 splice + bump offset；同步删除 DOM 前 K 个 .log-line
    if (this._logFullEvictK > 0) {
      const k = Math.min(this._logFullEvictK, this._renderedLogCount);
      let remove = k;
      while (remove-- > 0) {
        const first = container.querySelector('.log-line');
        if (!first) break;
        first.remove();
      }
      this._renderedLogCount = Math.max(0, this._renderedLogCount - k);
      this._logFullEvictK = 0;
      const emp = container.querySelector('.log-empty');
      if (emp) emp.remove();
    }
    // 更新 counter-reset 使 surviving 节点绝对行号与新的 logFullOffset 一致
    container.style.counterReset = 'logline ' + (this.logFullOffset || 0);

    // 补底：追加新行（词内搜索高亮，不加行级 match 背景——match_indices 来自后端快照不覆盖增量行）
    const start = this._renderedLogCount;
    if (start < lines.length) {
      const search = this.logFullQuery || '';
      const frag = document.createDocumentFragment();
      let appended = 0;
      for (let i = start; i < lines.length; i++) {
        frag.appendChild(this._buildLogLineDom(lines[i], search, '', (this.logFullOffset || 0) + i + 1));
        appended++;
      }
      container.appendChild(frag);
      const emp = container.querySelector('.log-empty');
      if (emp && appended > 0) emp.remove();
      this._renderedLogCount = lines.length;
    }
    // 跟随则滚底
    if (this.logAutoScroll || this._logAtBottom) {
      container.scrollTop = container.scrollHeight;
    }
  },

  _updateLogCount(contentEl) {
    const countEl = contentEl.querySelector('[data-field="log-count"]');
    if (countEl) countEl.textContent = this._logDisplayCount();
  },
  _logDisplayCount() {
    return this.logMode === 'full' ? (this.logFullTotal || 0) : this.logLines.length;
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
    const total = this.logFullTotal || 0;
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
    if (!this.selectedRunDir) this._logAtBottom = true;
    container.onscroll = () => {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
      this._logAtBottom = atBottom;
      if (this.logAutoScroll && !atBottom) this.logAutoScroll = false;
      else if (!this.logAutoScroll && atBottom) this.logAutoScroll = true;
      this._updateLogNavButtons(contentEl);
    };
  },

  _scrollLogsToTop() {
    const container = document.querySelector('#monitorDashboardLogs');
    if (container) { container.scrollTop = 0; this._logAtBottom = false; this.logAutoScroll = false; }
    this._updateLogNavButtons(document.getElementById('monitorTabContent'));
  },

  _scrollLogsToBottom() {
    const container = document.querySelector('#monitorDashboardLogs');
    if (container) { container.scrollTop = container.scrollHeight; this._logAtBottom = true; }
    this._updateLogNavButtons(document.getElementById('monitorTabContent'));
  },

  _updateLogNavButtons(contentEl) {
    if (!contentEl) return;
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    const atTop = container.scrollTop < 30;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 30;
    const topBtn = contentEl.querySelector('.log-nav-btn-top');
    const bottomBtn = contentEl.querySelector('.log-nav-btn-bottom');
    if (topBtn) topBtn.style.display = atTop ? 'none' : '';
    if (bottomBtn) bottomBtn.style.display = atBottom ? 'none' : '';
  },

  _afterLogsRender(contentEl, doScroll) {
    const container = contentEl.querySelector('#monitorDashboardLogs');
    if (!container) return;
    // Fix3：仅在有新日志（doScroll）时才设 scrollTop，避免大 DOM 上每帧强制 reflow
    if (doScroll && (this.logAutoScroll || this._logAtBottom)) {
      container.scrollTop = container.scrollHeight;
      this._logAtBottom = true;
    }
    this._updateLogNavButtons(contentEl);
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
    if (this.logMode === 'full') {
      const runDir = this._logSliceRunDir ? this._logSliceRunDir() : null;
      const taskId = this._logSliceTaskId ? this._logSliceTaskId() : null;
      if (runDir || taskId) {
        const params = new URLSearchParams();
        if (runDir) params.set('run_dir', runDir);
        else params.set('task_id', taskId);
        this._triggerDownload('/api/monitor/log-download?' + params.toString());
        this.toast(this.t('monitor.logDownloadStarted'));
        return;
      }
    }

    const lines = this.logMode === 'full' ? (this.logFullLines || []) : (this.logLines || []);
    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'training-logs-' + new Date().toISOString().slice(0,19).replace(/[T:]/g,'-') + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.toast(this.t('common.downloaded'));
  },


};
