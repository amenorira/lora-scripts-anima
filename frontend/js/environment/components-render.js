/* 训练核心及加速组件的状态与详情；由 environment-render.js 装配。 */
window.environmentComponentsRenderMixin = {
  // ═══════════════════════════════════════════════════════
  //  FlashAttention
  _renderFaRow(T) {
    const status = this.faStatus;
    const open = this._envCardOpen('fa');
    const error = this.faError;
    const state = this.faBusy ? 'loading' : error ? 'err' : !status ? 'loading' : status.installed ? 'ok' : 'muted';
    const key = this.faBusy ? 'installing' : error ? 'operationFailed' : !status ? 'loadingShort'
      : status.installed ? 'installed' : 'optionalNotInstalled';
    const disabled = this.faBusy || !status?.can_install;
    const head = this._renderRowHead('fa', open, {
      name: 'FlashAttention 2', desc: T('fa.hint'),
      version: status?.version ? `<span class="env-row-version" title="${this.escapeAttr(status.version)}">v${this.esc(status.version.split('+')[0])}</span>` : '',
      badge: `<span class="env-badge env-badge-${state}">${this.esc(T(key))}</span>`,
      action: status?.installed ? '' : `<button type="button" class="btn btn-sm btn-secondary env-head-btn" data-env-action="fa-install" ${disabled ? 'disabled' : ''}>${this.esc(T('install'))}</button>`,
      detailKey: 'fa', detailLabel: T('details'),
    });
    let body = `<div class="env-msg env-msg-info">${this.esc(T('fa.usage'))}</div>`;
    if (status) {
      const env = status.env || {};
      body += this._renderDetailGroup(T('envLabel'), this.esc(`Python ${env.python || '—'} · PyTorch ${env.torch || '—'} · CUDA ${env.cuda || '—'}`));
      if (!status.can_install) body += `<div class="env-msg">${this.esc(T(status.has_wheel ? 'fa.unsupported' : 'fa.noWheel'))}</div>`;
    }
    if (error) body += this._renderErrorBar(T, error, 'faInstallLog');
    if (this.faBusy) {
      const p = this.faProgress || {};
      body += this._renderProgressPanel({
        stage: p.stage === 'downloading' ? 'downloading' : 'working',
        stageLabel: T(p.stage === 'downloading' ? 'downloading' : 'fa.stage.' + (p.stage || 'resolving')),
        pct: p.total ? Math.min(100, Math.floor((p.downloaded || 0) * 100 / p.total)) : 0,
        downloadedBytes: p.downloaded, totalBytes: p.total, speedMB: (p.speed || 0) / 1048576,
        elapsed: this.faInstallElapsed,
      });
    }
    body += `<div class="env-actions">`
      + (status?.installed ? `<button type="button" class="btn btn-sm btn-ghost" data-env-action="fa-install" ${disabled ? 'disabled' : ''}>${this.esc(T('reinstall'))}</button>` : '')
      + this._renderRefreshBtn('fa', this.faBusy, true) + '</div>';
    if (this.faInstallLog) body += this._renderLog(this.faInstallLog);
    return this._renderRow('fa', state, open, head, body);
  },

  //  xformers 行
  // ═══════════════════════════════════════════════════════
  _renderXfRow(T) {
    const xs = this.xfStatus; const xfEnv = xs?.env || {}; const xfInstalled = xs?.installed;
    const open = this._envCardOpen('xf');

    if (this.xfBusy) {
      const head = this._renderRowHead('xf', open, {
        name: 'xformers',
        desc: T('xfHint'),
        version: '', badge: `<span class="env-badge env-badge-loading">${T('installing')}</span>`,
        detailKey: 'xf', detailLabel: T('details'),
      });
      const body = this._renderProgressPanel({ stage: 'working', elapsed: this.xfInstallElapsed, stageLabel: T('xfInstallingHint') })
        + this._renderLog(this.xfInstallLog);
      return this._renderRow('xf', 'loading', open, head, body);
    }

    const state = this.xfError ? 'err' : !xs ? 'loading' : xfInstalled ? 'ok' : 'muted';
    const badge = this.xfError ? `<span class="env-badge env-badge-err">${T('operationFailed')}</span>`
      : !xs ? `<span class="env-badge env-badge-loading">${T('loadingShort')}</span>`
      : xfInstalled ? `<span class="env-badge env-badge-ok">${T('installed')}</span>`
      : `<span class="env-badge env-badge-muted">${T('optionalNotInstalled')}</span>`;
    const version = xfInstalled && xs.version ? `<span class="env-row-version">v${this.esc(xs.version)}</span>` : '';
    const headBtn = xs && !xfInstalled
      ? `<button type="button" class="btn btn-sm btn-secondary env-head-btn" data-env-action="xf">${this.esc(T('install'))}</button>`
      : '';
    const head = this._renderRowHead('xf', open, {
      name: 'xformers',
      desc: T('xfHint'),
      version, badge, action: headBtn,
      detailKey: 'xf', detailLabel: T('details'),
    });

    let body = '';
    if (this.xfError) body += this._renderErrorBar(T, this.xfError, 'xfInstallLog');

    if (xs) {
      const envItems = [];
      if (xfInstalled) envItems.push(`<span class="env-env-item">xformers <em>v${xs.version||'?'}</em></span>`);
      if (xfEnv.python_tag) envItems.push(`<span class="env-env-item"><em>${xfEnv.python_tag}</em></span>`);
      if (xfEnv.torch_ver) envItems.push(`<span class="env-env-item">PyTorch <em>${xfEnv.torch_ver}</em></span>`);
      if (xfEnv.cuda_ver) envItems.push(`<span class="env-env-item">CUDA <em>cu${xfEnv.cuda_ver.replace('.','')}</em></span>`);
      body += this._renderDetailGroup(T('envLabel'), envItems.join(' &middot; ') || `<span class="env-text-dim">${T('notDetected')}</span>`);

      if (!xfInstalled) body += `<div class="env-msg env-msg-info">${T('xfInstallInfo')}</div>`;

    }
    body += `<div class="env-actions">`
      + (xfInstalled ? `<button type="button" class="btn btn-sm btn-ghost" data-env-action="xf">${this.esc(T('reinstall'))}</button>` : '')
      + this._renderRefreshBtn('xf', this.xfBusy, true) + '</div>';

    return this._renderRow('xf', state, open, head, body);
  },

  // ═══════════════════════════════════════════════════════
  //  训练核心行（sd-scripts / LyCORIS / musubi-tuner）
  // ═══════════════════════════════════════════════════════
  // 行头右侧：版本号（mono，链 GitHub）+ 状态徽标。
  _coreVersionInfo(meta) {
    if (!meta) return { label: '', url: '' };
    const commit = String(meta.local_commit || '');
    const release = meta.describe || meta.tag || meta.version;
    const branch = meta.local_branch && meta.local_branch !== 'HEAD' ? meta.local_branch : '';
    const label = release || (commit ? [branch, commit.slice(0, 7)].filter(Boolean).join(' ') : branch);
    const repoUrl = `https://github.com/${meta.repo}`;
    const url = commit ? `${repoUrl}/commit/${encodeURIComponent(commit)}`
      : meta.tag ? `${repoUrl}/releases/tag/${encodeURIComponent(meta.tag)}`
      : branch ? `${repoUrl}/tree/${encodeURIComponent(branch)}` : repoUrl;
    return { label, url };
  },

  _renderCoreHeadParts(T, meta, available = true, error = null, loaded = !!meta) {
    if (error) return { version: '', badge: `<span class="env-badge env-badge-err">${T('loadFailed')}</span>` };
    if (!loaded) return { version: '', badge: `<span class="env-badge env-badge-loading">${T('loadingShort')}</span>` };
    if (!available) return { version: '', badge: `<span class="env-badge env-badge-muted">${T('coreNotReady')}</span>` };
    const info = this._coreVersionInfo(meta);
    const version = info.label
      ? `<a href="${this.escapeAttr(info.url)}" target="_blank" rel="noopener" class="env-row-version env-link"><code>${this.esc(info.label)}</code></a>` : '';
    return { version, badge: `<span class="env-badge env-badge-ok">${T('coreReady')}</span>` };
  },

  _renderCoreRepositoryDetails(T, meta, fallbackRepo) {
    const repo = meta?.repo || fallbackRepo;
    const repoUrl = `https://github.com/${repo}`;
    const info = this._coreVersionInfo({ ...meta, repo });
    const item = (key, html) => `<div><dt>${this.esc(T(key))}</dt><dd>${html}</dd></div>`;
    const verItems = [
      item('repositoryLabel', `<a href="${repoUrl}" target="_blank" rel="noopener" class="env-link">${this.esc(repo)} &#8599;</a>`),
      meta?.local_branch ? item('branchLabel', this.esc(meta.local_branch)) : '',
      meta?.describe || meta?.tag || meta?.version ? item('columnVersion', `<a href="${this.escapeAttr(info.url)}" target="_blank" rel="noopener" class="env-link"><code>${this.esc(info.label)}</code></a>`) : '',
      meta?.local_commit ? item('commitLabel', `<a href="${repoUrl}/commit/${this.escapeAttr(meta.local_commit)}" target="_blank" rel="noopener" class="env-link"><code>${this.esc(meta.local_commit.slice(0,7))}</code></a>`) : '',
      meta?.sync_date ? item('syncLabel', this.esc(meta.sync_date)) : '',
    ];
    return `<dl class="env-repo-details">${verItems.join('')}</dl>`;
  },

  _renderSdRow(T) {
    const sd = this.sdStatus; const sdLocal = sd?.local || null;
    const open = this._envCardOpen('sd');
    const error = this.sdError || this.trainingCoresError;
    const engine = this.trainingCores?.engines?.find(item => item.id === 'sd_scripts');
    const available = engine ? !!engine.available : !!sdLocal;
    const state = error ? 'err' : !sd ? 'loading' : available ? 'ok' : 'muted';
    const parts = this._renderCoreHeadParts(T, sdLocal, available, error, !!sd);
    const head = this._renderRowHead('sd', open, {
      name: T('sdScriptsTitle'),
      desc: T('sdScriptsDesc'),
      version: parts.version, badge: parts.badge,
      detailKey: 'sd', detailLabel: T('details'),
    });
    const body = (error ? this._renderErrorBar(T, error, null) : '') + (sd ? this._renderCoreRepositoryDetails(T, sdLocal, 'kohya-ss/sd-scripts') : '');
    return this._renderRow('sd', state, open, head, body);
  },

  _renderLycorisRow(T) {
    const registry = this.trainingCores;
    const error = this.trainingCoresError;
    const adapter = registry?.adapters?.find(item => item.id === 'lycoris');
    const available = !!adapter?.available;
    const state = error ? 'err' : !registry ? 'loading' : available ? 'ok' : 'muted';
    const open = this._envCardOpen('lycoris');
    const parts = this._renderCoreHeadParts(T, adapter?.version || null, available, error, !!registry);
    const head = this._renderRowHead('lycoris', open, {
      name: 'LyCORIS',
      desc: T('lycorisDesc'),
      version: parts.version, badge: parts.badge,
      detailKey: 'lycoris', detailLabel: T('details'),
    });
    let body = '';
    if (error) body += this._renderErrorBar(T, error, null);
    if (adapter) body += this._renderCoreRepositoryDetails(T, adapter.version, 'KohakuBlueleaf/LyCORIS');
    return this._renderRow('lycoris', state, open, head, body);
  },

  _renderMusubiRow(T) {
    const registry = this.trainingCores;
    const error = this.trainingCoresError;
    const engine = registry?.engines?.find(item => item.id === 'musubi_tuner');
    const available = !!engine?.available;
    const state = error ? 'err' : !registry ? 'loading' : available ? 'ok' : 'muted';
    const open = this._envCardOpen('musubi');
    const parts = this._renderCoreHeadParts(T, engine?.version || null, available, error, !!registry);
    const head = this._renderRowHead('musubi', open, {
      name: 'musubi-tuner',
      desc: T('musubiDesc'),
      version: parts.version, badge: parts.badge,
      detailKey: 'musubi', detailLabel: T('details'),
    });
    let body = '';
    if (error) body += this._renderErrorBar(T, error, null);
    if (engine) {
      body += this._renderCoreRepositoryDetails(T, engine.version, 'kohya-ss/musubi-tuner');
      const runtimeErrors = Array.isArray(engine.runtime_errors) ? engine.runtime_errors : [];
      if (runtimeErrors.length) body += `<div class="env-msg env-msg-err"><pre>${this.esc(runtimeErrors.join('\n'))}</pre></div>`;
    }
    return this._renderRow('musubi', state, open, head, body);
  },

  _renderMossAccelRow(T) {
    const status = this.mossAccelStatus;
    const busy = this.mossAccelBusy;
    const error = this.mossAccelError;
    const open = this._envCardOpen('mossAccel');
    const state = error ? 'err' : busy || !status ? 'loading' : status.enabled ? 'ok' : 'muted';
    const label = error ? T('operationFailed') : busy ? T('mossAccelWorking') : !status ? T('loadingShort')
      : status.enabled ? T('mossAccelEnabled') : status.reason ? T('mossAccelUnavailable')
        : status.available ? T('mossAccelDisabled') : T('optionalNotInstalled');
    let action = '';
    if (!busy && status) {
      const command = status.enabled ? 'disable' : status.available ? 'enable' : status.can_install ? 'install' : null;
      if (command) action = `<button type="button" class="btn btn-sm btn-secondary env-head-btn" data-env-action="moss-accel-${command}">${T(command === 'install' ? 'mossAccelInstall' : command === 'enable' ? 'mossAccelEnable' : 'mossAccelDisable')}</button>`;
    }
    const flaVer = status?.versions?.['flash-linear-attention'] || '0.5.2';
    const convVer = status?.versions?.['causal-conv1d'] || '1.7.0';
    const versionText = `FLA ${flaVer} · Conv1D ${convVer}`;
    const head = this._renderRowHead('mossAccel', open, {
      name: T('mossAccelTitle'), desc: T('mossAccelDesc'), action,
      version: status?.installed ? `<span class="env-row-version">${this.esc(versionText)}</span>` : '',
      badge: `<span class="env-badge env-badge-${state === 'loading' ? 'loading' : state === 'err' ? 'err' : state === 'ok' ? 'ok' : 'muted'}">${this.esc(label)}</span>`,
      detailKey: 'mossAccel', detailLabel: T('details'),
    });
    let body = (!status?.installed
      ? this._renderDetailGroup(this.esc(T('mossAccelTargetVersion')), `<span class="env-row-version">${this.esc(versionText)}</span>`)
      : '')
      + this._renderDetailGroup('FLA', this.esc(T('mossAccelFlaInfo')))
      + this._renderDetailGroup('Conv', this.esc(T('mossAccelConvInfo')))
      + `<div class="env-msg env-msg-info">${this.esc(T('mossAccelInfo'))}</div>`;
    if (error) body += this._renderErrorBar(T, error, 'mossAccelInstallLog');
    if (busy) body += this._renderProgressPanel({ stage: 'working', elapsed: this.mossAccelInstallElapsed,
      stageLabel: T('mossAccelVerifying') }) + this._renderLog(this.mossAccelInstallLog);
    if (status?.reason) body += `<div class="env-msg env-msg-info">${this.esc(T('mossAccelReason_' + status.reason))}</div>`;
    if (status?.verification?.gpu) body += this._renderDetailGroup('GPU', this.esc(status.verification.gpu));
    if (!busy) {
      body += '<div class="env-actions">';
      if (status?.available && status.can_install) body += `<button type="button" class="btn btn-sm btn-ghost" data-env-action="moss-accel-install">${this.esc(T('mossAccelReinstall'))}</button>`;
      body += `${this._renderRefreshBtn('mossAccel', false, true)}</div>`;
    }
    return this._renderRow('mossAccel', state, open, head, body);
  },

  // ═══════════════════════════════════════════════════════
  //  Triton 行
  // ═══════════════════════════════════════════════════════
  _renderTritonRow(T) {
    const tr = this.tritonStatus;
    const open = this._envCardOpen('triton');

    // Busy: installing
    if (this.tritonBusy) {
      const head = this._renderRowHead('triton', open, {
        name: 'Triton',
        desc: T('tritonDesc'),
        version: '', badge: `<span class="env-badge env-badge-loading">${T('installing')}</span>`,
        detailKey: 'triton', detailLabel: T('details'),
      });
      const body = this._renderProgressPanel({ stage: 'working', elapsed: this.tritonInstallElapsed, stageLabel: T('tritonInstallingHint') })
        + this._renderLog(this.tritonInstallLog);
      return this._renderRow('triton', 'loading', open, head, body);
    }

    const state = this.tritonError ? 'err' : !tr ? 'loading' : tr.installed ? 'ok' : 'muted';
    const badge = this.tritonError
      ? `<span class="env-badge env-badge-err">${T('operationFailed')}</span>`
      : !tr
        ? `<span class="env-badge env-badge-loading">${T('loadingShort')}</span>`
        : tr.installed
          ? `<span class="env-badge env-badge-ok">${T('tritonInstalled')}</span>`
          : `<span class="env-badge env-badge-muted">${T('notInstalled')}</span>`;
    const version = tr && tr.installed && tr.version
      ? `<span class="env-row-version">v${this.esc(tr.version)}${tr.package ? ' · ' + this.esc(tr.package) : ''}</span>` : '';
    const headBtn = tr && !tr.installed
      ? `<button type="button" class="btn btn-sm btn-secondary env-head-btn" data-env-action="triton">${this.esc(T('install'))}</button>`
      : '';
    const head = this._renderRowHead('triton', open, {
      name: 'Triton',
      desc: T('tritonDesc'),
      version, badge, action: headBtn,
      detailKey: 'triton', detailLabel: T('details'),
    });

    let body = '';
    if (this.tritonError) body += this._renderErrorBar(T, this.tritonError, 'tritonInstallLog');

    if (tr) {
      if (tr.installed) {
        body += this._renderDetailGroup(T('verLabel'), `<span class="env-env-item">${this.esc(tr.package||'triton')} <em>v${this.esc(tr.version||'?')}</em></span>`);
      } else {
        body += `<div class="env-msg env-msg-info">${T('tritonInstallInfo')}</div>`;
      }
    }
    body += `<div class="env-actions">`
      + (tr?.installed ? `<button type="button" class="btn btn-sm btn-ghost" data-env-action="triton">${this.esc(T('reinstall'))}</button>` : '')
      + this._renderRefreshBtn('triton', this.tritonBusy, true) + '</div>';
    return this._renderRow('triton', state, open, head, body);
  },

};
