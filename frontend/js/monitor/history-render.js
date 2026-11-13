/* 历史记录与配置快照、复用交互；由 monitor-render.js 装配。 */
window.monitorHistoryRenderMixin = {
  // ═══════════════════════════════════════════════════════════
  //  历史记录页（搜索 / 筛选 / 删除 / 下载）
  // ═══════════════════════════════════════════════════════════
  renderHistory() {
    const el = document.getElementById('historyList');
    if (!el) return;
    try {
    const t = (k, fb) => this.tMonitor(k, fb);
    const hasRunning = this.runningTask && this._isActiveState(this.runningTask.status);
    const items = this.filteredHistoryItems;
    const hasHistory = items && items.length;

    let html = '';

    if (hasRunning) {
      const r = this.runningTask;
      html += '<div class="card history-card history-running">';
      html += '<div class="card-header">' + this.esc(t('running')) + ' <span class="m-badge m-badge-ok badge-running"><i aria-hidden="true"></i>' + this.esc(t(r.status === 'CREATED' ? 'created' : 'training')) + '</span>';
      if (r.artifact_available === false) html += '<span class="m-badge m-badge-danger"><i aria-hidden="true"></i>' + this.esc(t('artifactOffline')) + '</span>';
      html += '</div>';
      html += '<div class="hist-name"><b>' + this.esc(r.name || r.id || '') + '</b></div>';
      html += '<div class="hist-meta">' + this.esc(t('historyModel')) + ': ' + this.esc((r.model || '').split(/[\\\/]/).pop() || this.t('common.unknown')) + '</div>';
      html += '<div class="hist-meta">' + this.esc(t('historyLR')) + ': ' + this.esc(this._formatLearningRate(r.lr, r.lr ?? '?')) + ' | ' + this.esc(t('historyDim')) + ': ' + this.esc(r.dim || '?') + (r.alpha ? ' / α ' + this.esc(r.alpha) : '') + ' | ' + this.esc(t('historyEpochs')) + ': ' + this.esc(r.epochs || '?') + '</div>';
      if (r.run_dir) html += '<div class="hist-rundir">' + this.esc(t('runDir')) + ': ' + this.esc(r.run_dir) + '</div>';
      if (r.artifact_available === false && r.artifact_dir) html += '<div class="hist-artifact is-offline">' + this.esc(r.artifact_dir) + '</div>';
      html += '<div class="hist-actions"><button class="hist-action hist-action-primary" @click="navigate(\'monitor-dashboard\')">' + this.esc(t('viewDashboard')) + '</button></div>';
      html += '</div>';
    }

    if (!hasHistory) {
      const filtered = this.historySearch.trim() || this.historyFilter !== 'all';
      html += '<div class="dashboard-empty hist-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></svg><p>' + this.esc(t(filtered ? 'historyNoMatches' : 'historyNoRecords')) + '</p><p class="m-empty-sub">' + this.esc(t(filtered ? 'historyChangeFilters' : 'historyWillAppear')) + '</p>';
      if (filtered) html += '<button class="btn btn-sm btn-secondary" @click="clearHistoryFilters()">' + this.esc(t('clearHistoryFilters')) + '</button>';
      html += '</div>';
    } else {
      if (hasRunning) html += '<div class="hist-section-label">' + this.esc(t('pastRuns')) + '</div>';
      html += '<div class="history-grid">';
      items.forEach(h => {
        const runDirJs = this.esc(this.escapeJsString(h.run_dir || ''));
        const controlId = this.esc('history-' + encodeURIComponent(h.run_dir || ''));
        const artifactOffline = h.artifact_available === false;
        const unavailable = h.deletion_pending ? ' disabled' : '';
        const configAvailable = !!h.run_dir && !h.deletion_pending;
        html += '<div class="card history-card' + (artifactOffline ? ' history-artifact-offline' : '') + '">';
        html += '<div class="hist-card-content' + (configAvailable ? ' is-clickable' : '') + '"';
        if (configAvailable) {
          html += ' id="' + controlId + '-card" role="button" tabindex="0" aria-label="' + this.esc(t('viewConfig') + ': ' + (h.name || h.run_dir)) + '"';
          html += ' @click="_viewHistoryCardSnapshot(\'' + runDirJs + '\', $event)" @keydown.enter.prevent="$el.click()" @keydown.space.prevent="$el.click()"';
        }
        html += '>';
        html += '<div class="hist-card-head">';
        html += '<h2 class="hist-name" title="' + this.esc(h.name || '') + '">' + this.esc(h.name || '') + '</h2>';
        const statusColors = { completed: 'ok', failed: 'danger', terminated: 'muted' };
        const statusLabels = { completed: t('statusCompleted'), failed: t('statusFailed'), terminated: t('statusTerminated') };
        html += '<span class="m-badge m-badge-' + (statusColors[h.status] || 'muted') + '"><i aria-hidden="true"></i>' + this.esc(statusLabels[h.status] || t('statusUnknown')) + '</span>';
        if (artifactOffline) html += '<span class="m-badge m-badge-danger"><i aria-hidden="true"></i>' + this.esc(t('artifactOffline')) + '</span>';
        html += '</div>';
        html += '<div class="hist-card-body">';
        html += '<div class="hist-timing"><time class="hist-time">' + this.esc(h.time) + '</time>';
        if (h.duration) html += '<span class="hist-duration">' + this.esc(t('totalDuration')) + ' ' + this.esc(this._formatMonitorDuration(h.duration)) + '</span>';
        html += '</div><div class="hist-tags">';
        [h.profile_label, h.network, h.optimizer].filter(Boolean).forEach((label, i) => {
          html += '<span class="hist-tag' + (i === 0 ? ' hist-tag-profile' : '') + '" title="' + this.esc(label) + '">' + this.esc(label) + '</span>';
        });
        html += '</div><div class="hist-meta hist-truncate" title="' + this.esc(h.model || '') + '">' + this.esc(t('historyModel')) + ' · ' + this.esc(h.model || '') + '</div>';
        html += '<dl class="hist-stats">';
        [[t('historyLR'), this._formatLearningRate(h.lr, h.lr ?? '—')], [t('historyDim') + ' / α', String(h.dim ?? '—') + ' / ' + (h.alpha === '' ? '—' : h.alpha ?? '—')], [t('historyEpochs'), h.epochs]].forEach(([label, value]) => {
          html += '<div><dt>' + this.esc(label) + '</dt><dd>' + this.esc(value ?? '—') + '</dd></div>';
        });
        html += '</dl>';
        if (h.dataset) html += '<div class="hist-dataset hist-truncate" title="' + this.esc(h.dataset) + '">' + this.esc(t('dataset')) + ' · ' + this.esc(h.dataset) + '</div>';
        if (artifactOffline && h.artifact_dir) html += '<div class="hist-artifact is-offline">' + this.esc(h.artifact_dir) + '</div>';
        if (h.deletion_pending || h.warning) html += '<p class="hist-warning">' + this.esc(t(h.deletion_pending ? 'historyCleanupPending' : 'historyResultUnreadable')) + '</p>';
        html += '</div></div>';
        if (h.run_dir) {
          html += '<div class="hist-actions">';
          html += '<button class="hist-action hist-action-primary" @click.stop="viewRunDetail(\'' + runDirJs + '\')"' + unavailable + '>' + this.esc(t('viewDetails')) + '</button>';
          html += '<button id="' + controlId + '-config" class="hist-action hist-action-secondary" @click.stop="viewSnapshot(\'' + runDirJs + '\')"' + unavailable + '>' + this.esc(t('viewConfig')) + '</button>';
          html += '<button id="' + controlId + '-reuse" class="hist-action hist-action-secondary" :disabled="!!historyReuseBusy || ' + !!h.deletion_pending + '" @click.stop="reuseConfig(\'' + runDirJs + '\')" x-text="t(historyReuseBusy === \'' + runDirJs + '\' ? \'monitor.copyingConfig\' : \'monitor.reuseConfig\')">' + this.esc(t('reuseConfig')) + '</button>';
          html += '<div class="hist-icon-actions">';
          const downloadTitle = artifactOffline ? t('artifactOfflineHint') : t('downloadAll');
          html += '<button class="hist-action hist-action-icon hist-download" @click.stop="downloadRunOutputs(\'' + runDirJs + '\')" title="' + this.esc(downloadTitle) + '" aria-label="' + this.esc(downloadTitle) + '"' + (artifactOffline ? ' disabled' : '') + '><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
          const deleteLabel = t(h.deletion_pending ? 'retryCleanup' : 'deleteHistoryOnly');
          html += '<button id="' + controlId + '-delete" class="hist-action hist-action-icon hist-delete" :disabled="!!historyDeleting" @click.stop="deleteHistoryRun(\'' + runDirJs + '\')" title="' + this.esc(deleteLabel) + '" aria-label="' + this.esc(deleteLabel) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>';
          html += '</div></div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }

    const activeId = el.contains?.(document.activeElement) ? document.activeElement.id : '';
    el.innerHTML = html;
    if (activeId) document.getElementById(activeId)?.focus({ preventScroll: true });
    } catch (e) {
      el.innerHTML = '<div class="dashboard-empty" style="padding:48px"><p>⚠ ' + (this.t ? this.t('monitor.historyRenderError') : 'Error displaying history. Check browser console (F12).') + '</p></div>';
    }
  },

  _viewHistoryCardSnapshot(runDir, event) {
    if (event.detail && window.getSelection?.()?.isCollapsed === false) return;
    this.viewSnapshot(runDir);
  },

  async downloadRunOutputs(runDir) {
    if (!runDir) return;
    this._triggerDownload('/api/monitor/outputs/download?run_dir=' + encodeURIComponent(runDir));
  },

  async _fetchConfigSnapshot(runDir, signal) {
    const response = await fetch('/api/monitor/config-from-run?run_dir=' + encodeURIComponent(runDir), { signal });
    if (response.ok === false) throw new Error(this.t('monitor.configLoadError'));
    return response.json();
  },

  async viewSnapshot(runDir) {
    if (!runDir) return;
    const t = (k, fb) => this.tMonitor(k, fb);
    this._snapshotAbort?.abort();
    this._snapshotAbort = new AbortController();
    const seq = ++this._snapshotRequestSeq;
    this.configSnapshotRunDir = runDir;
    this._currentSnapshot = null;
    this.configSnapshotError = '';
    this.configSnapshotLoading = true;
    this.configSnapshotOpen = true;
    const body = document.getElementById('configSnapshotBody');
    if (body) body.scrollTop = 0;
    try {
      const j = await this._fetchConfigSnapshot(runDir, this._snapshotAbort.signal);
      if (seq !== this._snapshotRequestSeq) return;
      if (j.status !== 'success' || !j.data) {
        this.configSnapshotError = this.localizeApiError(j, 'monitor.configLoadError');
        return;
      }
      this.showSnapshotModal(j.data);
    } catch (e) {
      if (seq === this._snapshotRequestSeq && e.name !== 'AbortError') this.configSnapshotError = t('configLoadError');
    } finally {
      if (seq === this._snapshotRequestSeq) {
        this.configSnapshotLoading = false;
        this._snapshotAbort = null;
      }
    }
  },

  _readSnapshotYamlQuoted(line, start, quote, continuation = false) {
    let i = start + (continuation ? 0 : 1);
    while (i < line.length) {
      if (quote === '"' && line[i] === '\\') {
        if (i + 1 === line.length) return { end: line.length, closed: false, escapedBreak: true };
        i += 2; continue;
      }
      if (line[i] === quote) {
        if (quote === "'" && line[i + 1] === "'") { i += 2; continue; }
        return { end: i + 1, closed: true, escapedBreak: false };
      }
      i++;
    }
    return { end: line.length, closed: false, escapedBreak: false };
  },

  // Highlight the snapshot without parsing or rewriting its contents. Every
  // token is escaped before it is inserted into the modal's HTML.
  _highlightSnapshotYaml(source) {
    const span = (type, text) => '<span class="yaml-' + type + '">' + this.esc(text) + '</span>';
    const findKey = (line, start, inFlow) => {
      if (start >= line.length || line[start] === '[' || line[start] === '{') return null;
      let end = start;
      const quotedKey = line[start] === '"' || line[start] === "'";
      if (quotedKey) {
        const quoted = this._readSnapshotYamlQuoted(line, start, line[start]);
        if (!quoted.closed) return null;
        end = quoted.end;
      } else {
        while (end < line.length) {
          const char = line[end];
          if (char === '#' && (end === start || /\s/.test(line[end - 1]))) return null;
          if (inFlow && /[\[\]{},]/.test(char)) return null;
          if (char === ':' && (end + 1 === line.length || /\s/.test(line[end + 1]) || (inFlow && /[\[\]{},]/.test(line[end + 1])))) break;
          end++;
        }
        while (end > start && /[ \t]/.test(line[end - 1])) end--;
      }
      let colon = end;
      while (/[ \t]/.test(line[colon] || '')) colon++;
      if (end === start || line[colon] !== ':' || (colon + 1 < line.length && !/\s/.test(line[colon + 1]) && !(inFlow && (quotedKey || /[\[\]{},]/.test(line[colon + 1]))))) return null;
      return { end, colon };
    };

    const parts = String(source).split(/(\r\n|\r|\n)/);
    const html = [];
    const flow = [];
    let quote = null;
    let blockIndent = null;
    let plainIndent = null;
    for (let part = 0; part < parts.length; part += 2) {
      const line = parts[part];
      const indent = (line.match(/^[ \t]*/) || [''])[0].length;
      if (plainIndent !== null) {
        if (/^[ \t]*$/.test(line)) {
          html.push(this.esc(line));
          if (part + 1 < parts.length) html.push(parts[part + 1]);
          continue;
        }
        if (indent > plainIndent && line[indent] !== '#') {
          const content = line.slice(indent);
          const comment = content.match(/(^|[ \t])#/);
          const commentAt = comment ? comment.index + comment[1].length : content.length;
          html.push(this.esc(line.slice(0, indent)), span('string', content.slice(0, commentAt)));
          if (comment) { html.push(span('comment', content.slice(commentAt))); plainIndent = null; }
          if (part + 1 < parts.length) html.push(parts[part + 1]);
          continue;
        }
        plainIndent = null;
      }
      if (blockIndent !== null && (/^[ \t]*$/.test(line) || indent > blockIndent)) {
        html.push(span('string', line));
      } else {
        blockIndent = null;
        let i = 0;
        if (!quote && !flow.length) {
          const prefix = (line.match(/^[ \t]*(?:[-?](?:[ \t]+|$))?/) || [''])[0];
          html.push(this.esc(prefix));
          i = prefix.length;
          const key = findKey(line, i, false);
          if (key) {
            html.push(span('key', line.slice(i, key.end)), this.esc(line.slice(key.end, key.colon + 1)));
            i = key.colon + 1;
          }
          const sequenceItem = !key && /-[ \t]+$/.test(prefix);
          if (key || sequenceItem) {
            const value = line.slice(i).trimStart();
            if (value && !/^[\[\]{}"'|>!&*#%@`]/.test(value) && !/(?:^|[ \t])#/.test(value)) {
              plainIndent = key ? prefix.length : indent;
            }
          }
        }
        while (i < line.length) {
          if (quote) {
            const quoted = this._readSnapshotYamlQuoted(line, i, quote, true);
            html.push(span('string', line.slice(i, quoted.end)));
            i = quoted.end;
            if (quoted.closed) quote = null;
            continue;
          }
          const char = line[i];
          if (/[ \t]/.test(char)) { html.push(this.esc(char)); i++; continue; }
          if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
            html.push(span('comment', line.slice(i)));
            break;
          }
          if (flow.length && flow[flow.length - 1].map && flow[flow.length - 1].expectKey) {
            const key = findKey(line, i, true);
            if (key) {
              html.push(span('key', line.slice(i, key.end)), this.esc(line.slice(key.end, key.colon + 1)));
              i = key.colon + 1;
              flow[flow.length - 1].expectKey = false;
              continue;
            }
          }
          if (char === '"' || char === "'") {
            const quoted = this._readSnapshotYamlQuoted(line, i, char);
            html.push(span('string', line.slice(i, quoted.end)));
            i = quoted.end;
            if (!quoted.closed) quote = char;
            continue;
          }
          if (char === '[' || char === '{') {
            flow.push({ map: char === '{', expectKey: char === '{' });
            html.push(this.esc(char)); i++; continue;
          }
          if (flow.length && (char === ']' || char === '}')) {
            flow.pop(); html.push(this.esc(char)); i++; continue;
          }
          if (flow.length && char === ',') {
            if (flow[flow.length - 1].map) flow[flow.length - 1].expectKey = true;
            html.push(this.esc(char)); i++; continue;
          }
          if (/[!&*]/.test(char)) {
            const meta = line.slice(i).match(/^[!&*][^\s\[\]{},]+/);
            if (meta) { html.push(span('meta', meta[0])); i += meta[0].length; continue; }
          }
          let end = i;
          while (end < line.length) {
            if (line[end] === '#' && (end === 0 || /\s/.test(line[end - 1]))) break;
            if (flow.length && /[\[\]{},]/.test(line[end])) break;
            end++;
          }
          // A malformed flow delimiter must still make progress.
          if (end === i) { html.push(this.esc(line[i++])); continue; }
          const text = line.slice(i, end);
          const value = text.replace(/[ \t]+$/, '');
          let type = 'string';
          if (/^(?:true|false|null|~)$/i.test(value)) type = 'constant';
          else if (/^[+-]?(?:(?:0x[\da-f_]+|0o[0-7_]+|0b[01_]+)|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?\d+)?|\.inf|\.nan)$/i.test(value)) type = 'number';
          else if (/^(?:---|\.\.\.)$/.test(value)) type = 'meta';
          else if (/^[|>](?:[+-]?[1-9]?|[1-9][+-]?)$/.test(value) && !flow.length) { type = 'meta'; blockIndent = indent; }
          html.push(span(type, value), this.esc(text.slice(value.length)));
          i = end;
        }
      }
      if (part + 1 < parts.length) html.push(parts[part + 1]);
    }
    return html.join('');
  },

  // A YAML plain/quoted scalar folds ordinary continuation lines into spaces.
  // Reflow only prompt values here; block scalars and real blank lines retain
  // their original boundaries. The DOM still contains the original text.
  _renderSnapshotLines(source, highlightedHtml, format) {
    const parts = String(source).split(/(\r\n|\r|\n)/);
    const rendered = highlightedHtml.split(/(\r\n|\r|\n)/);
    const html = [];
    const promptScalar = line => {
      const match = line.match(/^([ ]*)((?:-[ ]+)?)(?:positive_prompts|negative_prompts|krea_sample_prompts):[ \t]+(\S.*)$/);
      if (!match) return null;
      const value = match[3];
      const keyIndent = match[1].length + match[2].length;
      if (value[0] === '"' || value[0] === "'") {
        const state = this._readSnapshotYamlQuoted(value, 0, value[0]);
        return state.closed || state.escapedBreak ? null : { indent: keyIndent, quote: value[0] };
      }
      if (/^[|>!&*\[\]{},%@`]/.test(value) || /(?:^|[ \t])#|:(?=[ \t]|$)|[ \t]$/.test(value)) return null;
      return { indent: keyIndent, quote: null };
    };
    const removeLeadingIndent = (lineHtml, indent) => {
      const stringTag = '<span class="yaml-string">';
      if (lineHtml.startsWith(stringTag + indent)) return stringTag + lineHtml.slice(stringTag.length + indent.length);
      return lineHtml.startsWith(indent) ? lineHtml.slice(indent.length) : null;
    };

    for (let i = 0; i < parts.length; i += 2) {
      const line = parts[i];
      let lineHtml = rendered[i];
      const promptKey = /^[ \t]*(?:-[ \t]+)?<span class="yaml-key">(?:positive_prompts|negative_prompts|krea_sample_prompts)<\/span>/.test(lineHtml);
      const scalar = (format === 'yaml' || format === 'yml') && promptKey ? promptScalar(line) : null;
      if (scalar) {
        while (i + 2 < parts.length) {
          const next = parts[i + 2];
          const match = next.match(/^([ ]+)(\S.*)$/);
          if (!match || match[1].length <= scalar.indent) break;
          const value = match[2];
          if (!scalar.quote && /(?:^|[ \t])#|:(?=[ \t]|$)|[ \t]$/.test(value)) break;
          const rest = removeLeadingIndent(rendered[i + 2], match[1]);
          if (rest === null) break;
          const state = scalar.quote ? this._readSnapshotYamlQuoted(value, 0, scalar.quote, true) : null;
          // A backslash at the end of a double-quoted line removes the break,
          // so leave it untouched rather than displaying it as a space.
          if (state?.escapedBreak) break;
          lineHtml += '<span class="m-config-fold">' + parts[i + 1] + match[1] + '</span>' + rest;
          i += 2;
          if (state?.closed) break;
        }
      }
      if (line) {
        let indent = 0;
        for (const char of line) {
          if (char === ' ') indent++;
          else if (char === '\t') indent += 8 - indent % 8;
          else break;
        }
        html.push('<span class="m-config-line" style="--config-indent:' + indent + '">' + lineHtml + '</span>');
      }
      if (i + 1 < parts.length) html.push('<br><span class="m-config-newline">' + parts[i + 1] + '</span>');
    }
    return html.join('');
  },

  _copySnapshotSelection(event, pre) {
    const selection = window.getSelection?.();
    if (event.defaultPrevented || !event.clipboardData || !selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    if (!pre.contains(range.commonAncestorContainer)) return;
    event.clipboardData.setData('text/plain', range.cloneContents().textContent);
    event.preventDefault();
  },

  snapshotTitle() {
    const runDir = this.configSnapshotRunDir || '';
    return this._currentSnapshot?.name
      || this.historyItems?.find(item => item.run_dir === runDir)?.name
      || String(runDir).replace(/\\/g, '/').split('/').pop()
      || '';
  },

  _initSnapshotPathScroll(content) {
    const path = content.querySelector?.('.snapshot-dataset-path');
    const label = path?.querySelector?.('.snapshot-path-text');
    if (!path || !label) return null;
    const update = () => {
      const distance = Math.max(0, label.scrollWidth - path.clientWidth);
      path.classList.toggle('is-overflowing', distance > 1);
      if (distance > 1) {
        path.style.setProperty('--snapshot-scroll-distance', `${distance}px`);
        path.style.setProperty('--snapshot-scroll-duration', `${Math.max(6, distance / 35 * 2 + 2).toFixed(2)}s`);
      }
    };
    path.addEventListener('mouseenter', update);
    path.addEventListener('focus', update);
    window.addEventListener?.('resize', update);
    const observer = window.ResizeObserver ? new window.ResizeObserver(update) : null;
    observer?.observe(path);
    update();
    return () => {
      observer?.disconnect();
      path.removeEventListener('mouseenter', update);
      path.removeEventListener('focus', update);
      window.removeEventListener?.('resize', update);
    };
  },

  _initSnapshotDisclosure(content) {
    const details = content.querySelector?.('.snapshot-raw details');
    const summary = details?.querySelector?.('summary');
    const panel = details?.querySelector?.('.snapshot-raw-panel');
    if (!details || !summary || !panel) return null;
    let expanded = details.open;
    let animation = null;
    const stopAnimation = () => {
      if (!animation) return;
      animation.onfinish = null;
      animation.cancel();
      animation = null;
    };
    const resetPanel = () => { panel.style.height = ''; panel.style.overflow = ''; };
    const toggle = event => {
      event.preventDefault();
      const fromHeight = details.open ? panel.getBoundingClientRect().height : 0;
      stopAnimation();
      expanded = !expanded;
      summary.setAttribute('aria-expanded', String(expanded));
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      if (reduced || typeof panel.animate !== 'function') {
        details.open = expanded;
        resetPanel();
        return;
      }
      if (expanded) details.open = true;
      // Restore the natural size before measuring, even if the previous motion
      // was interrupted. No intermediate size is painted before the new effect.
      resetPanel();
      const bodyHeight = document.getElementById('configSnapshotBody')?.clientHeight || panel.scrollHeight;
      // A long YAML file can be much taller than the scrollable modal. Animate
      // only the visible height so its disclosure doesn't finish in a flash.
      const visibleHeight = Math.min(panel.scrollHeight, Math.max(200, bodyHeight));
      const from = Math.min(fromHeight, visibleHeight);
      const to = expanded ? visibleHeight : 0;
      if (Math.abs(from - to) < 1) {
        details.open = expanded;
        resetPanel();
        return;
      }
      panel.style.height = `${to}px`;
      panel.style.overflow = 'hidden';
      const current = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: expanded ? 220 : 180,
        easing: 'cubic-bezier(.1, .78, .21, 1)',
      });
      animation = current;
      current.onfinish = () => {
        if (animation !== current) return;
        animation = null;
        details.open = expanded;
        resetPanel();
      };
    };
    summary.addEventListener('click', toggle);
    return () => { stopAnimation(); resetPanel(); summary.removeEventListener('click', toggle); };
  },

  showSnapshotModal(snapshot) {
    const content = document.getElementById('configSnapshotContent');
    if (!content) return;
    const t = (k, fb) => this.tMonitor(k, fb);

    let html = '';
    if (snapshot.config_warning || snapshot.reuse_error) html += '<p class="hist-warning">' + this.esc(snapshot.reuse_error || snapshot.config_warning) + '</p>';
    if (snapshot.params) {
      const p = snapshot.params;
      const present = value => value != null && String(value).trim() !== '';
      const basename = value => {
        const path = String(value);
        return path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || path;
      };
      const profileId = p.model_train_type || snapshot.reuse_params?.model_train_type;
      const model = profileId === 'krea2-lora' ? (p.dit || p.pretrained_model_name_or_path) : (p.pretrained_model_name_or_path || p.dit);
      const sources = [
        [t('historyModel'), model],
        [t(p.train_data_dir ? 'dataset' : 'snapshotDatasetConfig'), p.train_data_dir || p.dataset_config, true],
        [t('field.network_weights'), p.network_weights],
      ].filter(([, value]) => present(value));

      const items = [];
      const add = (label, value, title = value) => {
        if (present(value)) items.push({ label, value: String(value), title: String(title) });
      };
      const profileNames = { 'anima-lora': 'Anima', 'sdxl-lora': 'SDXL', 'krea2-lora': 'Krea 2', 'moss-image-lora': 'MOSS-Image' };
      if (present(profileId)) add(t('field.model_train_type'), Object.hasOwn(profileNames, profileId) ? profileNames[profileId] : profileId, profileId);
      const module = String(p.network_module || '');
      const networkNames = { lora: 'LoRA', lora_anima: 'LoRA', lora_generic: 'LoRA', lora_krea2: 'LoRA', loha: 'LoHa', lokr: 'LoKr' };
      const moduleName = module.split('.').pop();
      let network = Object.hasOwn(networkNames, moduleName) ? networkNames[moduleName] : module;
      if (module === 'lycoris.kohya') {
        const arg = Array.isArray(p.network_args) && p.network_args.find(value => /^algo\s*=/.test(String(value)));
        const algo = String(p.lycoris_algo || (arg && String(arg).split('=').slice(1).join('=')) || '').trim().toLowerCase();
        const algorithmNames = { lora: 'LoCon', loha: 'LoHa', lokr: 'LoKr' };
        network = Object.hasOwn(algorithmNames, algo) ? algorithmNames[algo] : (algo || 'LyCORIS');
      }
      add(t('snapshotNetwork'), network, module);
      const dimFromWeights = String(p.dim_from_weights).toLowerCase() === 'true';
      if (dimFromWeights) {
        add(t('snapshotRankAlpha'), t('snapshotRankFromWeights'));
      } else if (present(p.network_dim) && present(p.network_alpha)) {
        add(t('snapshotRankAlpha'), String(p.network_dim) + ' / ' + String(p.network_alpha));
      } else {
        add(t('historyDim'), p.network_dim);
        add(t('historyAlpha'), p.network_alpha);
      }
      if (present(p.learning_rate)) add(t('snapshotBaseLearningRate'), this._formatLearningRate(p.learning_rate, String(p.learning_rate)));
      if (present(p.optimizer_type)) add(t('historyOptimizer'), String(p.optimizer_type).split('.').pop(), p.optimizer_type);
      const stepsMode = p.krea_training_duration_mode === 'steps' || (!present(p.max_train_epochs) && present(p.max_train_steps));
      add(t(stepsMode ? 'snapshotSteps' : 'historyEpochs'), stepsMode ? p.max_train_steps : p.max_train_epochs);
      add(t('historyBatch'), p.train_batch_size);
      if (present(p.gradient_accumulation_steps) && Number(p.gradient_accumulation_steps) > 1) add(t('field.gradient_accumulation_steps'), p.gradient_accumulation_steps);
      if (present(p.resolution)) {
        const resolution = String(p.resolution);
        add(t('historyResolution'), resolution.replace(/^\s*(\d+)\s*,\s*(\d+)\s*$/, '$1 × $2'), resolution);
      }

      if (sources.length || items.length) {
        html += '<div class="snapshot-overview">';
        if (sources.length) {
          html += '<dl class="snapshot-sources">';
          sources.forEach(([label, value, isDataset]) => {
            html += '<div><dt>' + this.esc(label) + '</dt>';
            if (isDataset) {
              html += '<dd class="snapshot-dataset-path" tabindex="0" title="' + this.esc(value) + '"><span class="snapshot-path-text">' + this.esc(value) + '</span></dd>';
            } else {
              html += '<dd title="' + this.esc(value) + '">' + this.esc(basename(value)) + '</dd>';
            }
            html += '</div>';
          });
          html += '</dl>';
        }
        if (items.length) {
          html += '<dl class="snapshot-params">';
          items.forEach(it => {
            html += '<div><dt>' + this.esc(it.label) + '</dt><dd title="' + this.esc(it.title) + '">' + this.esc(it.value) + '</dd></div>';
          });
          html += '</dl>';
        }
        html += '</div>';
      }
    }
    if (snapshot.content) {
      html += '<div class="snapshot-raw"><details open><summary class="m-details-summary" aria-expanded="true"><svg class="snapshot-raw-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>' + this.esc(t('rawConfig')) + ' <span class="snapshot-format">' + this.esc((snapshot.config_format || 'toml').toUpperCase()) + '</span></summary>';
      const format = String(snapshot.config_format || 'toml').toLowerCase();
      const configHtml = format === 'yaml' || format === 'yml' ? this._highlightSnapshotYaml(snapshot.content) : this.esc(snapshot.content);
      html += '<div class="snapshot-raw-panel"><pre class="m-config-pre">' + this._renderSnapshotLines(snapshot.content, configHtml, format) + '</pre></div></details>';
      html += '<button type="button" class="btn btn-sm btn-ghost snapshot-raw-copy">' + this.esc(t('snapshotCopyRaw')) + '</button></div>';
    }

    this._snapshotCopyCleanup?.();
    this._snapshotCopyCleanup = null;
    this._snapshotPathCleanup?.();
    this._snapshotDisclosureCleanup?.();
    content.innerHTML = html;
    this._snapshotPathCleanup = this._initSnapshotPathScroll(content);
    this._snapshotDisclosureCleanup = this._initSnapshotDisclosure(content);
    content.querySelector?.('.snapshot-raw-copy')?.addEventListener?.('click', () => this.copyConfigContent());
    const pre = content.querySelector?.('.m-config-pre');
    if (pre && document.addEventListener) {
      const copyDocument = document;
      const onCopy = event => this._copySnapshotSelection(event, pre);
      copyDocument.addEventListener('copy', onCopy);
      this._snapshotCopyCleanup = () => copyDocument.removeEventListener('copy', onCopy);
    }
    const body = document.getElementById('configSnapshotBody');
    if (body) body.scrollTop = 0;
    content.scrollTop = 0;
    this._currentSnapshot = snapshot;
    this.configSnapshotRunDir = snapshot.run_dir || this.configSnapshotRunDir;
    this.configSnapshotLoading = false;
    this.configSnapshotError = '';
    this.configSnapshotOpen = true;
  },

  closeSnapshotModal() {
    this._snapshotCopyCleanup?.();
    this._snapshotCopyCleanup = null;
    this._snapshotPathCleanup?.();
    this._snapshotPathCleanup = null;
    this._snapshotDisclosureCleanup?.();
    this._snapshotDisclosureCleanup = null;
    ++this._snapshotRequestSeq;
    this._snapshotAbort?.abort();
    this._snapshotAbort = null;
    this.configSnapshotOpen = false;
    this.configSnapshotLoading = false;
  },

  cancelHistoryInteractions() {
    this.closeSnapshotModal();
    // A fetched configuration can be cancelled. Once applying starts, let the
    // form update finish atomically, but do not navigate away from the user's new page.
    if (!this._historyReuseApplying) {
      ++this._reuseRequestSeq;
      this._reuseAbort?.abort();
      this._reuseAbort = null;
      this.historyReuseBusy = '';
    }
    if (this.previewLightboxOpen) this.closePreviewLightbox();
  },

  copyConfigContent() {
    if (this._currentSnapshot && this._currentSnapshot.content) {
      navigator.clipboard.writeText(this._currentSnapshot.content).then(() => this.toast(this.t('common.copied'))).catch(() => this.toast(this.t('common.requestFailed'), 'error'));
    }
  },

  async reuseConfig(runDir, snapshot = null) {
    if (this.historyReuseBusy || !runDir) return;
    const t = (k, fb) => this.tMonitor(k, fb);
    const seq = ++this._reuseRequestSeq;
    const routeSeq = this._routeTransitionSeq;
    this.historyReuseBusy = runDir;
    this._reuseAbort = new AbortController();
    let errorDetails = '';
    try {
      this.startProgress();
      const j = snapshot ? { status: 'success', data: snapshot } : await this._fetchConfigSnapshot(runDir, this._reuseAbort.signal);
      if (seq !== this._reuseRequestSeq) return;
      if (j.status !== 'success' || !j.data?.reuse_params) {
        errorDetails = this.apiErrorDetails(j);
        throw new Error(j.data?.reuse_error || this.localizeApiError(j, 'monitor.configLoadError'));
      }
      this._ensureTrainingSession?.('train-basic');
      // When startup restore is disabled, some saved profiles are intentionally
      // absent from the in-memory undo snapshot. Keep their original storage
      // values too, so undo can recover a profile replaced by this import.
      const preserveUnloaded = this._preserveUnloadedTrainingDrafts ||
        (this.autoLoadHistory === false && !this._trainingSessionRoute);
      let storedDrafts = null;
      if (preserveUnloaded && typeof localStorage !== 'undefined') {
        try {
          storedDrafts = Object.fromEntries([
            'anima-form-train-basic', 'anima-form-profiles-train-basic',
            'anima-form-profile-sources-v1-train-basic',
          ].map(key => [key, localStorage.getItem(key)]));
        } catch (e) { /* Storage may be unavailable. */ }
      }
      const undo = JSON.parse(JSON.stringify({
        form: this.form, drafts: this._profileFormDrafts, sources: this._profileFieldSources,
        fieldSources: this._fieldSources, documentId: this._trainingDocumentId,
        formHistory: this.formHistory, formHistoryIdx: this.formHistoryIdx, formDefaults: this.formDefaults,
        storedDrafts, preserveUnloaded, editedProfiles: Array.from(this._sessionEditedProfiles || []),
      }));
      this._historyReuseApplying = true;
      await this._applyConfigToTraining(j.data.reuse_params);
      this._trainingDocumentId = null;
      this._historyReuseUndo = undo;
      this.historyReuseSource = j.data.name || runDir;
      const ignored = this._lastConfigImportIgnoredFields || [];
      this.historyReuseWarning = [j.data.config_warning, ignored.length ? this.t('common.importedWithIgnoredFields').replace('{fields}', ignored.join(', ')) : ''].filter(Boolean).join('\n');
      if (this.historyReuseWarning) this.toast(this.historyReuseWarning, 'warning');
      else this.toast(t('configLoaded'), 'success');
      if (routeSeq === this._routeTransitionSeq) this.navigate('train-basic');
    } catch (e) {
      if (seq === this._reuseRequestSeq && e.name !== 'AbortError') this.toast(e.message || t('configLoadError'), 'error', { details: errorDetails });
    } finally {
      if (seq === this._reuseRequestSeq) {
        this.historyReuseBusy = '';
        this._historyReuseApplying = false;
        this._reuseAbort = null;
        this.finishProgress();
      }
    }
  },

  reuseConfigFromSnapshot(runDir) {
    const snapshot = this._currentSnapshot;
    if (!snapshot?.reuse_params || this.historyReuseBusy) return;
    this.closeSnapshotModal();
    if (runDir) this.reuseConfig(runDir, snapshot);
  },

  dismissHistoryReuse() {
    this.historyReuseSource = '';
    this.historyReuseWarning = '';
    this._historyReuseUndo = null;
  },

  async undoHistoryReuse() {
    const undo = this._historyReuseUndo;
    if (!undo || this.historyReuseBusy) return;
    this.historyReuseBusy = 'undo';
    this._historyReuseApplying = true;
    try {
      await this._applyConfigToTraining(undo.form);
      this._profileFormDrafts = undo.drafts || {};
      this._profileFieldSources = undo.sources || {};
      this._fieldSources = undo.fieldSources || {};
      this._trainingDocumentId = undo.documentId || null;
      if (undo.formDefaults) this.formDefaults = undo.formDefaults;
      this.formHistory = undo.formHistory || [this.formDefaults];
      this.formHistoryIdx = undo.formHistoryIdx ?? 0;
      if (undo.preserveUnloaded) this._sessionEditedProfiles = new Set(undo.editedProfiles || []);
      if (undo.storedDrafts && typeof localStorage !== 'undefined') {
        Object.entries(undo.storedDrafts).forEach(([key, value]) => {
          if (value === null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        });
      } else {
        this._persistProfileDrafts?.();
        this._persistProfileFieldSources?.();
      }
      this.rebuildForm?.();
      this.dismissHistoryReuse();
      this.toast(this.t('monitor.historyReuseUndone'), 'success');
    } catch (e) {
      this.toast(this.t('monitor.restoreConfigError'), 'error');
    } finally {
      this.historyReuseBusy = '';
      this._historyReuseApplying = false;
    }
  },

  async _applyConfigToTraining(params) {
    if (!params || !this.form) return;
    if (typeof this._applyImportedFlatConfig === 'function') {
      await this._applyImportedFlatConfig(params);
      return;
    }
    for (const key of Object.keys(params)) {
      if (key === 'sample_prompts' || key.startsWith('_')) continue;
      if (params[key] !== undefined && params[key] !== null && this.form.hasOwnProperty(key)) {
        this.form[key] = String(params[key]);
      }
    }
    if (this.updateToml) this.updateToml();
  },
};
