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
        html += '<div class="card history-card' + (artifactOffline ? ' history-artifact-offline' : '') + '">';
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
        html += '</div>';
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
      if (j.status !== 'success' || !j.data) throw new Error(j.message || t('configLoadError'));
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

  showSnapshotModal(snapshot) {
    const content = document.getElementById('configSnapshotContent');
    if (!content) return;
    const t = (k, fb) => this.tMonitor(k, fb);

    let html = '';
    html += '<p class="snapshot-run-path">' + this.esc(snapshot.run_dir || '') + '</p>';
    if (snapshot.config_warning || snapshot.reuse_error) html += '<p class="hist-warning">' + this.esc(snapshot.reuse_error || snapshot.config_warning) + '</p>';
    if (snapshot.params) {
      const p = snapshot.params;
      // 关键参数高亮卡（与概览页同款）：模型取 basename，9 个核心字段
      const keyDefs = [
        { key: 'pretrained_model_name_or_path', labelKey: 'field.pretrained_model_name_or_path', short: 'historyModel', basename: true },
        { key: 'learning_rate', labelKey: 'field.learning_rate', short: 'historyLR' },
        { key: 'network_dim', labelKey: 'field.network_dim', short: 'historyDim' },
        { key: 'network_alpha', labelKey: 'field.network_alpha', short: 'historyAlpha' },
        { key: 'max_train_epochs', labelKey: 'field.max_train_epochs', short: 'historyEpochs' },
        { key: 'optimizer_type', labelKey: 'field.optimizer_type', short: 'historyOptimizer', className: true },
        { key: 'train_batch_size', labelKey: 'field.train_batch_size', short: 'historyBatch' },
        { key: 'resolution', labelKey: 'field.resolution', short: 'historyResolution' },
        { key: 'seed', labelKey: 'field.seed', short: 'historySeed' },
      ];
      const keyItems = [];
      keyDefs.forEach(kd => {
        const raw = p[kd.key];
        if (raw == null || raw === '') return;
        let val = String(raw);
        if (kd.basename) {
          const parts = val.replace(/\\/g, '/').split('/');
          val = parts[parts.length - 1] || val;
        }
        if (kd.className) val = val.split('.').pop();
        if (kd.key === 'learning_rate') val = this._formatLearningRate(raw, val);
        // 高亮卡 label 用 short key（简短），title 用 field.* 完整描述句
        keyItems.push({ label: t(kd.short, kd.key), title: String(raw), value: val });
      });
      if (keyItems.length) {
        html += '<div class="param-keygrid" style="margin-bottom:16px">';
        keyItems.forEach(it => {
          const titleAttr = it.title && it.title !== it.label ? ' title="' + this.esc(it.title) + '"' : '';
          html += '<div class="param-key-item"' + titleAttr + '><span class="param-key-label">' + this.esc(it.label) + '</span><span class="param-key-value">' + this.esc(it.value) + '</span></div>';
        });
        html += '</div>';
      }
    }
    if (snapshot.content) {
      html += '<details open><summary class="m-details-summary">' + this.esc(t('rawConfig')) + ' <span class="hist-tag">' + this.esc((snapshot.config_format || 'toml').toUpperCase()) + '</span></summary>';
      html += '<pre class="m-config-pre">' + this.esc(snapshot.content) + '</pre></details>';
    }

    content.innerHTML = html;
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
    if (this._previewReturnFocus) this.closePreviewLightbox();
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
    try {
      this.startProgress();
      const j = snapshot ? { status: 'success', data: snapshot } : await this._fetchConfigSnapshot(runDir, this._reuseAbort.signal);
      if (seq !== this._reuseRequestSeq) return;
      if (j.status !== 'success' || !j.data?.reuse_params) throw new Error(j.data?.reuse_error || j.message || t('configLoadError'));
      const undo = JSON.parse(JSON.stringify({
        form: this.form, drafts: this._profileFormDrafts, sources: this._profileFieldSources,
        fieldSources: this._fieldSources, documentId: this._trainingDocumentId,
        formHistory: this.formHistory, formHistoryIdx: this.formHistoryIdx, formDefaults: this.formDefaults,
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
      if (seq === this._reuseRequestSeq && e.name !== 'AbortError') this.toast(e.message || t('configLoadError'), 'error');
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
      this._persistProfileDrafts?.();
      this._persistProfileFieldSources?.();
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
