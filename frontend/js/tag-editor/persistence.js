/* Saving captions, timeline operations and local draft recovery. */
window.tagEditorPersistence = {
  tagEditorSaving: false,
  tagEditorTimeline: [],
  tagEditorSnapshots: [],
  tagEditorSnapshotLoading: false,
  tagEditorSnapshotBusy: false,
  tagEditorSnapshotError: false,
  _teAutoSaveInterval: null,
  _teDraftRemainder: [],
  _teDraftRestoreBusy: false,
  _teDraftSavedAt: '',
  _teIsSaving: false,
  _teSaveProgress: 0,
  _teTimelineAbort: null,
  _teSaveEpoch: 0,
  _teCaptionRevisions: null,

  // ===== Save =====
  async tagEditorSaveAll() {
    if (this._teIsSaving || this._teDraftRestoreBusy || this.tagEditorSnapshotBusy) return;
    this._teFlushAllPendingTextEdits();
    var modified = this._teGetModified();
    if (modified.length === 0) { this.toast(this.t('tagEditor.batchNoChanges')); return; }
    var self2 = this;
    var epoch = this._teLoadEpoch;
    var saveDir = this.tagEditorLoadedDir || this.tagEditorDir;
    // C4: 小批量（≤5 张）跳过确认，减少打断；大批量仍确认
    if (modified.length > 5) {
      this._teConfirmBatch(this.t('tagEditor.batchConfirmAll').replace('{n}', modified.length), function() {
        if (epoch !== self2._teLoadEpoch || saveDir !== (self2.tagEditorLoadedDir || self2.tagEditorDir)) return;
        return self2._doSaveAll(modified);
      });
    } else {
      return this._doSaveAll(modified);
    }
  },

  async _doSaveAll(modified) {
    if (this._teIsSaving || this._teDraftRestoreBusy || this.tagEditorSnapshotBusy) return;
    this._teFlushAllPendingTextEdits();
    // Persist the pre-save baseline even when the first save precedes autosave.
    this._teSaveDraft();
    this.tagEditorSaving = true;
    this._teIsSaving = true;
    this._teSaveProgress = 0;
    var self = this;
    var saveEpoch = ++this._teSaveEpoch;
    var loadEpoch = this._teLoadEpoch;
    var saveDir = this.tagEditorLoadedDir || this.tagEditorDir;
    var processedCount = 0;
    var writtenCount = 0;
    var failedItems = [];
    var saveErrorMessage = '';
    var timelineWarning = '';
    var rollbackFailed = [];
    var payload = modified.map(function(img) {
      return {
        path: img.path,
        tags: img.tags,
        edit_version: (self._teEditVersions && self._teEditVersions[img.path]) || 0,
        expected_revision: self._teCaptionRevisions ? self._teCaptionRevisions[img.path] : undefined
      };
    });

    try {
      var r = await fetch('/api/tageditor/save-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: saveDir, images: payload })
      });
      var j = await r.json();
      if (saveEpoch !== self._teSaveEpoch || loadEpoch !== self._teLoadEpoch || saveDir !== (self.tagEditorLoadedDir || self.tagEditorDir)) return;
      if (j.status !== 'success') {
        saveErrorMessage = j.message || self.t('common.error');
        failedItems = modified.map(function(img) { return { path: img.path, reason: saveErrorMessage }; });
      } else {
        var data = j.data || {};
        timelineWarning = data.timeline_warning || '';
        rollbackFailed = data.rollback_failed || [];
        if (timelineWarning) {
          payload.forEach(function(item) {
            if ((data.saved_paths || []).includes(item.path)) self._teDraftRemainder.push({
              path: item.path, tags: item.tags, original: self.tagEditorOriginal[item.path],
              revision: data.revisions?.[item.path]
            });
          });
        }
        var successfulPaths = (data.saved_paths || []).concat(data.skipped_paths || []);
        var successfulLookup = {};
        successfulPaths.forEach(function(path) { successfulLookup[path] = true; });
        // Input can continue while the request is in flight. Record it against
        // the old baseline before advancing that baseline to the saved payload.
        this._teFlushAllPendingTextEdits();
        this.tagEditorHistory.forEach(function(entry) {
          Object.entries(entry.changes || {}).forEach(function([path, change]) {
            if (!successfulLookup[path]) return;
            if (change.before == null) change.before = self.tagEditorOriginal[path] || '';
            if (change.after == null) change.after = self.tagEditorOriginal[path] || '';
          });
        });
        var payloadByPath = {};
        payload.forEach(function(item) { payloadByPath[item.path] = item; });
        modified.forEach(function(img) {
          var savedPayload = payloadByPath[img.path];
          if (successfulLookup[img.path] && savedPayload) {
            self.tagEditorNoTagCount += Number(!savedPayload.tags.trim()) - Number(!(self.tagEditorOriginal[img.path] || '').trim());
            self.tagEditorOriginal[img.path] = savedPayload.tags;
          }
        });
        if (data.revisions && self._teCaptionRevisions) {
          Object.keys(data.revisions).forEach(function(path) { self._teCaptionRevisions[path] = data.revisions[path]; });
        }
        if (Array.isArray(data.conflicts)) failedItems = failedItems.concat(data.conflicts);
        if (Array.isArray(data.failed)) failedItems = failedItems.concat(data.failed);
        processedCount = successfulPaths.length;
        writtenCount = Number(data.saved || 0);
        self._teSaveProgress = 100;
      }
    } catch (e) {
      saveErrorMessage = this.t('common.networkError');
      failedItems = modified.map(function(img) { return { path: img.path, reason: saveErrorMessage }; });
    } finally {
      if (saveEpoch === this._teSaveEpoch && loadEpoch === this._teLoadEpoch) {
        this.tagEditorSaving = false;
        this._teIsSaving = false;
        this._teSaveProgress = 0;
      }
    }

    if (saveEpoch !== this._teSaveEpoch || loadEpoch !== this._teLoadEpoch) return;
    var hadHistory = this.tagEditorHistory.length > 0;
    this._teRecountModified();
    this._teInvalidateCaptionQuery();
    this.tagEditorModified = this._teModifiedCount > 0;
    this._teInvalidateFilter();
    if (!timelineWarning && !rollbackFailed.length && this._teModifiedCount === 0) {
      this.tagEditorHistory = [];
      this.tagEditorHistoryIdx = -1;
      this.tagEditorHistoryDetailIdx = -1;
    }
    this._teInvalidateDiff();
    if (this._teModifiedCount === 0) {
      this._teHistoryState = {};
    } else if (processedCount > 0) {
      var remainingState = {};
      var remainingModified = this._teGetModified();
      for (var rm = 0; rm < remainingModified.length; rm++) {
        remainingState[remainingModified[rm].path] = remainingModified[rm].tags;
      }
      this._teHistoryState = remainingState;
    }
    if (timelineWarning || rollbackFailed.length) {
      var warning = timelineWarning ? this.t('tagEditor.timelineSaveFailed').replace('{error}', timelineWarning) : '';
      if (rollbackFailed.length) warning += (warning ? '\n' : '') + this.t('tagEditor.rollbackFailed').replace('{paths}', rollbackFailed.join(', '));
      this.toast(warning, 'warning');
      this._teSaveDraft(true);
    } else if (failedItems.length > 0 || this._teModifiedCount > 0) {
      if (processedCount === 0 && saveErrorMessage) {
        this.toast(saveErrorMessage, 'error');
      } else {
        this.toast(this.t('tagEditor.partialSaveFailed')
          .replace('{saved}', processedCount)
          .replace('{failed}', Math.max(failedItems.length, this._teModifiedCount)), 'warning');
      }
      this._teSaveDraft();
    } else {
      this.toast(hadHistory ? this.t('tagEditor.savedArchived') : this.t('common.saved'));
      this._teDraftSavedAt = '';
      this._teRemoveDraft();
    }
    if (writtenCount > 0) {
      self.tagEditorLoadSnapshots(loadEpoch);
      if (this._teModifiedCount === 0) await this.tagEditorReloadSessionPage(this.tagEditorPage);
    }
  },

  tagEditorLoadSnapshots(epoch) {
    var self = this;
    var requestEpoch = epoch == null ? this._teLoadEpoch : epoch;
    if (this._teTimelineAbort) this._teTimelineAbort.abort();
    var controller = new AbortController();
    this._teTimelineAbort = controller;
    this.tagEditorSnapshotLoading = true;
    this.tagEditorSnapshotError = false;
    fetch('/api/tageditor/timeline?dataset_dir=' + encodeURIComponent(this.tagEditorLoadedDir || this.tagEditorDir), { signal: controller.signal })
      .then(function(r) { return r.json(); }).then(function(j) {
        if (requestEpoch !== self._teLoadEpoch || controller.signal.aborted) return;
        if (j.status === 'success') {
          self.tagEditorTimeline = j.data || [];
          self.tagEditorSnapshots = self.tagEditorTimeline;
        } else self.tagEditorSnapshotError = true;
        self.tagEditorSnapshotLoading = false;
        self._teTimelineAbort = null;
      }).catch(function(err) {
        if (requestEpoch !== self._teLoadEpoch || controller.signal.aborted) return;
        self.tagEditorSnapshotError = true;
        self.tagEditorSnapshotLoading = false;
        self._teTimelineAbort = null;
      });
  },

  _teCanRestoreCaptions() {
    this._teFlushAllPendingTextEdits();
    if (this.tagEditorModified || this._teIsSaving || this._teDraftRestoreBusy) {
      this.toast(this.t('tagEditor.timelineUnsaved'), 'warning');
      return false;
    }
    return true;
  },

  tagEditorRestoreSnapshot(sid) {
    if (!this._teCanRestoreCaptions()) return;
    this._teTimelineAction(sid, 'restore', 'snapshotRestoreConfirmTitle', 'snapshotRestoreConfirm', 'snapshotRestored');
  },

  tagEditorDeleteSnapshot(sid) {
    this._teTimelineAction(sid, 'delete', 'snapshotDelete', 'snapshotDeleteConfirm', 'snapshotDeleted');
  },

  // C5: 清理全部快照
  tagEditorClearAllSnapshots() {
    this._teTimelineAction(null, 'delete', 'snapshotClearConfirmTitle', 'snapshotClearAllConfirm', 'snapshotCleared');
  },

  _teTimelineAction(sid, action, title, message, success) {
    if (this.tagEditorSnapshotBusy) return;
    var self = this;
    var epoch = this._teLoadEpoch;
    var dir = this.tagEditorLoadedDir || this.tagEditorDir;
    var restoring = action === 'restore' || action === 'backup';
    var snapshot = this.tagEditorSnapshots.find(function(item) { return item.id === sid; });
    var description = this.t('tagEditor.' + message);
    if (snapshot) description = this._teFormatSnapshotTime(snapshot.timestamp) + ' · ' + this.t('tagEditor.historyStepImages').replace('{n}', snapshot.file_count) + '\n\n' + description;
    this.openConfirm(this.t('tagEditor.' + title), description, function() {
      if (epoch !== self._teLoadEpoch || self.tagEditorSnapshotBusy) return;
      if (restoring && !self._teCanRestoreCaptions()) return;
      self.tagEditorSnapshotBusy = true;
      var path = '/api/tageditor/timeline' + (sid ? '/' + encodeURIComponent(sid) : '') + (action === 'restore' ? '/restore' : '');
      var url = path + '?dataset_dir=' + encodeURIComponent(dir);
      var options = { method: action === 'restore' ? 'POST' : 'DELETE' };
      if (action === 'backup') {
        url = '/api/tageditor/restore-backup';
        options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: dir }) };
      }
      return fetch(url, options)
        .then(function(r) { return r.json(); }).then(function(j) {
          if (epoch !== self._teLoadEpoch) return;
          if (j.status !== 'success') throw new Error(j.message || self.t('common.error'));
          self.toast(self.t('tagEditor.' + success));
          if (restoring) return self.tagEditorLoad(dir);
          else self.tagEditorLoadSnapshots(epoch);
        }).catch(function(err) {
          if (epoch === self._teLoadEpoch) self.toast(err.message || self.t('common.error'), 'error');
        }).finally(function() { if (epoch === self._teLoadEpoch) self.tagEditorSnapshotBusy = false; });
    }, this.t('common.confirm'));
  },

  _teTimelineLabel(event) {
    var key = { save: 'timelineSave', restore: 'timelineRestore', legacy_backup_restore: 'timelineBackup' }[event.event_type];
    return key ? this.t('tagEditor.' + key) : event.label || event.event_type;
  },

  _teFormatSnapshotTime(ts) {
    var numeric = Number(ts);
    var d = new Date(numeric > 1000000000000 ? numeric : numeric * 1000);
    return d.toLocaleString(this.locale || undefined);
  },

  // ===== Auto-save Draft =====
  _teStartAutoSave() {
    this._teStopAutoSave();
    var self = this;
    this._teAutoSaveInterval = setInterval(function() {
      self._teSaveDraft();
    }, 30000);
  },

  _teStopAutoSave() {
    if (this._teAutoSaveInterval) { clearInterval(this._teAutoSaveInterval); this._teAutoSaveInterval = null; }
  },

  _teSaveDraft(forcePending = false) {
    if (this._teIsSaving || this._teDraftRestoreBusy || (!this.tagEditorModified && !(forcePending && this._teDraftRemainder.length))) return;
    try {
      var key = 'tagEditor_draft_' + (this.tagEditorLoadedDir || this.tagEditorDir);
      var orig = this.tagEditorOriginal;
      var revisions = this._teCaptionRevisions || {};
      var data = this._teGetModified()
        .map(function(img) {
          return { path: img.path, tags: img.tags, original: orig[img.path], revision: revisions[img.path] };
        });
      localStorage.setItem(key, JSON.stringify({ version: 2, items: data, pending: this._teDraftRemainder }));
      this._teDraftSavedAt = new Date().toLocaleTimeString(this.locale || undefined, { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      this.toast(this.t('tagEditor.draftSaveFailed'), 'warning');
    }
  },

  _teCheckDraft() {
    if (this._teDraftRestoreBusy || this._teIsSaving) return;
    try {
      var dir = this.tagEditorLoadedDir || this.tagEditorDir;
      var epoch = this._teLoadEpoch;
      var key = 'tagEditor_draft_' + dir;
      var raw = localStorage.getItem(key);
      if (raw) {
        var stored = JSON.parse(raw);
        var data = Array.isArray(stored) ? stored : stored.version === 2 ? (stored.items || []).concat(stored.pending || []) : [];
        data = data.filter(function(item) { return item && typeof item.path === 'string' && typeof item.tags === 'string'; });
        if (data && data.length > 0) {
          var self = this;
          this._teDraftRemainder = data;
          this._teConfirmUnsaved(this.t('tagEditor.draftFound'), async function() {
            var isCurrent = () => epoch === self._teLoadEpoch && dir === (self.tagEditorLoadedDir || self.tagEditorDir) && self.currentRoute === 'tagEditor';
            if (!isCurrent() || self._teIsSaving || self._teDraftRestoreBusy) return;
            self._teFlushAllPendingTextEdits();
            self._teDraftRestoreBusy = true;
            try {
              if (data.some(item => !self._teFindByPath(item.path))) await self._teEnsureAllImagesLoaded();
              if (!isCurrent()) return;
              var remaining = [], changes = {}, seen = new Set();
              data.forEach(function(item) {
                var identity = JSON.stringify([item.path, item.tags, item.original, item.revision]);
                if (seen.has(identity)) return;
                seen.add(identity);
                var img = self._teFindByPath(item.path);
                // Never replace an in-session edit or an externally changed baseline.
                if (!img || img.tags !== self.tagEditorOriginal[item.path]) {
                  if (!img || img.tags !== item.tags) remaining.push(item);
                  return;
                }
                var alreadySaved = img.tags === item.tags;
                var matches = item.revision != null ? item.revision === self._teCaptionRevisions?.[item.path]
                  : typeof item.original === 'string' && item.original === img.tags;
                if (!alreadySaved && !matches) { remaining.push(item); return; }
                var before = alreadySaved && typeof item.original === 'string' ? item.original : img.tags;
                if (before !== item.tags) changes[item.path] = { before: before, after: item.tags };
                if (!alreadySaved) self._teUpdateImageTags(img, item.tags);
              });
              self._teDraftRemainder = remaining;
              self._teRecountModified();
              self.tagEditorModified = self._teModifiedCount > 0;
              if (Object.keys(changes).length) {
                self.tagEditorHistory = self.tagEditorHistory.slice(0, self.tagEditorHistoryIdx + 1);
                self.tagEditorHistory.push({
                  meta: { type: 'restoreDraft', contentMode: 'text', desc: self.t('tagEditor.autoSaveRestored'), affected: Object.keys(changes).length },
                  changes: changes, _ts: Date.now()
                });
                if (self.tagEditorHistory.length > 200) self.tagEditorHistory.shift();
                self.tagEditorHistoryIdx = self.tagEditorHistory.length - 1;
              }
              var restoredState = {};
              var restoredModified = self._teGetModified();
              for (var i = 0; i < restoredModified.length; i++) restoredState[restoredModified[i].path] = restoredModified[i].tags;
              self._teHistoryState = restoredState;
              self._teInvalidateFilter();
              self._teInvalidateDiff();
              self._updateEditorPanel();
              self._teDraftRestoreBusy = false;
              if (self.tagEditorModified || remaining.length) self._teSaveDraft(true);
              else self._teRemoveDraft();
              self.toast(remaining.length ? self.t('tagEditor.draftUnresolved').replace('{n}', remaining.length) : self.t('tagEditor.autoSaveRestored'), remaining.length ? 'warning' : undefined);
            } catch (error) {
              if (isCurrent()) self.toast(self.t('tagEditor.draftRestoreFailed'), 'warning');
            } finally {
              if (isCurrent()) self._teDraftRestoreBusy = false;
            }
          });
        }
      }
    } catch (e) { /* ignore */ }
  },

  _teRemoveDraft() {
    try {
      var key = 'tagEditor_draft_' + (this.tagEditorLoadedDir || this.tagEditorDir);
      if (this._teDraftRemainder.length) localStorage.setItem(key, JSON.stringify({ version: 2, items: [], pending: this._teDraftRemainder }));
      else localStorage.removeItem(key);
      this._teDraftSavedAt = '';
    } catch (e) { /* ignore */ }
  },
};
