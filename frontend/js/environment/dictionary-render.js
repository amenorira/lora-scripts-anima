/* 词典数据下载与进度视图；由 environment-render.js 装配。 */
window.environmentDictionaryRenderMixin = {
  _renderDictionaryRow(T) {
    const server = this.tagDictionaryServer;
    const dataState = this.tagDictionaryDataState();
    const open = this._envCardOpen('dictionary');

    const badgeState = dataState === 'installed' && this.tagDictionaryCheckingUpdate ? 'checking'
      : dataState === 'installed' && server?.update?.state === 'available' ? 'checking'
      : dataState === 'installed' && server?.update?.state === 'error' ? 'error'
      : dataState === 'installed' && server?.update?.state === 'unknown' ? 'absent' : dataState;
    const badgeClass = {
      installing: 'env-badge-loading', installed: 'env-badge-ok', checking: 'env-badge-loading',
      failed: 'env-badge-err', error: 'env-badge-err', absent: '',
    }[badgeState] || '';
    const updateKey = { available: 'dictUpdateAvailable', current: 'dictUpToDate',
      unknown: 'dictUpdateUnknown', error: 'dictCheckFailed' }[server?.update?.state];
    const badgeText = (this.tagDictionaryStatusError || !server) && ['failed', 'error'].includes(dataState) ? T('loadFailed')
      : dataState === 'installing' ? this.tagDictionaryInstallText()
      : server?.status === 'failed' ? T(server.installed ? 'dictUpdateFailed' : 'dictDownloadFailed')
      : this.tagDictionaryCheckingUpdate ? T('dictCheckingUpdate')
      : dataState === 'installed' && updateKey ? T(updateKey) : this.tagDictionaryDataLabel();
    const badge = `<span class="env-badge ${badgeClass}">${this.esc(badgeText)}</span>`;

    const parts = [];
    if (server?.installed) {
      parts.push(this.tagDictionaryVersionText(), this.tagDictionaryTagCountText(), this.tagDictionarySizeText());
    }
    const version = parts.filter(Boolean).length
      ? `<span class="env-mgroup-count">${parts.filter(Boolean).map(item => this.esc(item)).join(this.tagDictionaryIsChinese() ? '，' : ', ')}</span>`
      : '';

    let action = this.tagDictionaryDataActionVisible()
      ? `<button class="btn btn-sm btn-secondary" data-env-action="dictionary"${dataState === 'installing' || this.tagDictionaryCheckingUpdate ? ' disabled' : ''}>`
        + `${this.esc(this.tagDictionaryDataActionLabel())}</button>`
      : '';

    if (server?.installed && dataState === 'installed') {
      action += `<button class="btn btn-sm btn-ghost" data-env-action="dictionary-redownload"${this.tagDictionaryCheckingUpdate ? ' disabled' : ''}>${this.esc(T('dictRedownload'))}</button>`;
    }

    const head = this._renderRowHead('dictionary', open, {
      name: T('dictRowName', 'Danbooru Chinese dictionary'),
      desc: T('dictRowDesc', 'Tag translations, colors and notes for the Tag Editor'),
      version, badge, action,
      detailKey: 'dictionary', detailLabel: T('details', 'Details'),
    });

    return this._renderRow('dictionary', dataState === 'installing' ? 'loading'
      : ['failed', 'error'].includes(badgeState) ? 'err' : (dataState === 'installed' ? 'ok' : 'muted'), open, head,
      this._renderDictionaryBody(T, dataState));
  },

  _renderDictionaryBody(T, dataState) {
    const server = this.tagDictionaryServer || {};
    let body = '';
    const category = String(server.current_file || '').replace(/\.csv$/, '');
    const categoryNames = { general: 'dictGeneral', artist: 'dictArtist', copyright: 'dictCopyright',
      character: 'dictCharacter', meta: 'dictMeta' };
    const current = categoryNames[category] ? T(categoryNames[category]) : server.current_file || '';
    if (dataState === 'installing') {
      if (server.status !== 'building' && current && !server.files?.length) {
        const source = server.download_source ? ` (${this.esc(server.download_source)})` : '';
        body += `<div class="env-text-dim">${this.esc(current)} (${Number(server.file_index || 0) + 1}/${Number(server.file_total || 5)})${source}</div>`;
      }
      body += server.status === 'building'
        ? this._renderProgressPanel({ stage: 'installing', stageLabel: this.t('tagEditor.dictBuilding') })
        : this._renderProgressPanel({
            stage: server.phase === 'connecting' ? 'connecting' : 'downloading',
            fileIndex: Math.min(Number(server.file_index || 0) + 1, server.file_total || 5), fileTotal: server.file_total || 5,
            pct: server.percent ?? (server.total_bytes > 0 ? Math.min(100, Math.floor(100 * server.downloaded_bytes / server.total_bytes)) : 0),
            speedMB: server.speed_mb || 0,
            downloadedBytes: server.downloaded_bytes || 0,
            totalBytes: server.total_bytes || 0,
          });
      if (server.status !== 'building') {
        for (const file of server.files || []) {
          const name = String(file.filename || '').replace(/\.csv$/, '');
          const label = categoryNames[name] ? T(categoryNames[name]) : file.filename;
          const progress = file.done ? T('dictFileDone') : file.phase === 'queued' ? T('dictFileQueued')
            : file.total > 0 ? `${Math.min(100, Math.floor(100 * (file.downloaded || 0) / file.total))}%` : T('dictFileConnecting');
          body += this._renderDetailGroup(this.esc(label), this.esc(progress));
        }
      }
    }
    if (dataState === 'failed' || dataState === 'error') {
      const reason = this.tagDictionaryStatusError || !this.tagDictionaryServer ? this.t('tagEditor.dictStatusUnavailable') : T(server.error_kind === 'source' ? 'dictErrorSource'
        : server.error_kind === 'integrity' ? 'dictErrorIntegrity'
        : server.error_kind === 'build' ? 'dictErrorBuild' : 'dictErrorDownload');
      body += `<div class="env-msg env-msg-err">${current ? this.esc(current) + '：' : ''}${this.esc(reason)}</div>`;
    }
    if (server.categories?.length) {
      const number = value => Number(value || 0).toLocaleString();
      body += '<div class="env-dict-table"><table><thead><tr>'
        + ['dictCategory', 'dictTags'].map(key => `<th>${this.esc(T(key))}</th>`).join('')
        + '</tr></thead><tbody>';
      for (const item of server.categories) {
        body += `<tr><th>${this.esc(T(categoryNames[item.name] || 'dictCategory'))}</th>`
          + `<td>${number(item.tag_count)}</td></tr>`;
      }
      body += `<tr><th>${this.esc(T('dictTotal'))}</th><td>${number(server.tag_count)}</td></tr></tbody></table></div>`;
    }
    body += this._renderDetailGroup(T('dictSource'), '<a href="https://huggingface.co/datasets/ame-la/danbooru-tags-data-zh" target="_blank" rel="noopener" class="env-link">ame-la/danbooru-tags-data-zh ↗</a>');
    if (dataState === 'installed' && server.update?.state === 'error') {
      const reason = T(server.update.error_kind === 'source' ? 'dictErrorSource' : 'dictCheckFailed');
      body += `<div class="env-msg env-msg-err">${this.esc(reason)}</div>`;
      if (server.update.message) {
        body += `<details><summary class="env-text-dim">${this.esc(T('dictErrorDetails'))}</summary>${this._renderLog(server.update.message)}</details>`;
      }
    }
    const log = this.tagDictionaryLogText() || this.tagDictionaryInstallError || server.message;
    if (log && (dataState === 'failed' || dataState === 'error')) {
      body += `<details><summary class="env-text-dim">${this.esc(T('dictErrorDetails'))}</summary>${this._renderLog(log)}</details>`;
    }
    return body;
  },
};
