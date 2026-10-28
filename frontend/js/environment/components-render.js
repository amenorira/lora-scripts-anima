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
    const sources = { options: ['auto', 'direct', 'mirror'].map(v => ({ v, l: T('fa.source_' + v) })) };
    body += `<div class="env-actions"><div class="env-download-source"><span>${this.esc(T('fa.source'))}</span>
      <div class="anima-select" x-data="animaSelect('${this.escJson(sources)}', '${this.escapeAttr(this.faSource)}')" @click.outside="close()" @anima-select-change="faSource = $event.detail.value">
        <button type="button" class="anima-select-trigger" :class="{ focused: open }" @click="toggle()" aria-label="${this.escapeAttr(T('fa.source'))}" ${this.faBusy ? 'disabled' : ''}>
          <span class="anima-select-trigger-text" x-text="selectedLabel">${this.esc(T('fa.source_' + this.faSource))}</span>
          <svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <template x-if="open"><div class="anima-select-menu" :class="{ 'anima-select-menu-positioned': positioned }"><div class="anima-select-menu-scroll">
          <template x-for="opt in flatOptions" :key="opt.v"><div class="anima-select-option" :class="{ active: opt.v === value }" @click="select(opt.v)"><span class="anima-select-option-label" x-text="opt.l"></span><svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></div></template>
        </div></div></template>
      </div></div>`
      + (status?.installed ? `<button type="button" class="btn btn-sm btn-ghost" data-env-action="fa-install" ${disabled ? 'disabled' : ''}>${this.esc(T('reinstall'))}</button>` : '')
      + `<button type="button" class="btn btn-sm btn-ghost" data-env-action="fa-refresh" ${this.faBusy ? 'disabled' : ''}>${this.esc(T('refresh'))}</button></div>`;
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
        desc: T('xfHint','Memory-efficient attention'),
        version: '', badge: `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`,
        detailKey: 'xf', detailLabel: T('details','Details'),
      });
      const body = this._renderProgressPanel({ stage: 'working', elapsed: this.xfInstallElapsed, stageLabel: T('xfInstallingHint','Downloading...') })
        + this._renderLog(this.xfInstallLog);
      return this._renderRow('xf', 'loading', open, head, body);
    }

    const state = this.xfError ? 'err' : !xs ? 'loading' : xfInstalled ? 'ok' : 'muted';
    const badge = this.xfError ? `<span class="env-badge env-badge-err">${T('operationFailed','Operation failed')}</span>`
      : !xs ? `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>`
      : xfInstalled ? `<span class="env-badge env-badge-ok">${T('installed','Installed')}</span>`
      : `<span class="env-badge env-badge-muted">${T('optionalNotInstalled','Optional · Not installed')}</span>`;
    const version = xfInstalled && xs.version ? `<span class="env-row-version">v${this.esc(xs.version)}</span>` : '';
    const headBtn = xs ? `<button type="button" class="btn btn-sm ${xfInstalled ? 'btn-ghost' : 'btn-secondary'} env-head-btn" data-env-action="xf">${xfInstalled ? T('reinstall','Reinstall') : T('install','Install')}</button>` : '';
    const head = this._renderRowHead('xf', open, {
      name: 'xformers',
      desc: T('xfHint','Memory-efficient attention'),
      version, badge, action: headBtn,
      detailKey: 'xf', detailLabel: T('details','Details'),
    });

    let body = '';
    if (this.xfError) body += this._renderErrorBar(T, this.xfError, 'xfInstallLog');

    if (xs) {
      const envItems = [];
      if (xfInstalled) envItems.push(`<span class="env-env-item">xformers <em>v${xs.version||'?'}</em></span>`);
      if (xfEnv.python_tag) envItems.push(`<span class="env-env-item"><em>${xfEnv.python_tag}</em></span>`);
      if (xfEnv.torch_ver) envItems.push(`<span class="env-env-item">PyTorch <em>${xfEnv.torch_ver}</em></span>`);
      if (xfEnv.cuda_ver) envItems.push(`<span class="env-env-item">CUDA <em>cu${xfEnv.cuda_ver.replace('.','')}</em></span>`);
      body += this._renderDetailGroup(T('envLabel','Env'), envItems.join(' &middot; ') || `<span class="env-text-dim">${T('notDetected','N/A')}</span>`);

      if (!xfInstalled) body += `<div class="env-msg env-msg-info">${T('xfInstallInfo','Installs latest compatible version from PyPI.')}</div>`;

    }
    body += `<div class="env-actions">${this._renderRefreshBtn('xf-refresh-btn', this.xfBusy)}</div>`;

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
    if (error) return { version: '', badge: `<span class="env-badge env-badge-err">${T('loadFailed', 'Load failed')}</span>` };
    if (!loaded) return { version: '', badge: `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>` };
    if (!available) return { version: '', badge: `<span class="env-badge env-badge-muted">${T('coreNotReady', 'Not configured')}</span>` };
    const info = this._coreVersionInfo(meta);
    const version = info.label
      ? `<a href="${this.escapeAttr(info.url)}" target="_blank" rel="noopener" class="env-row-version env-link"><code>${this.esc(info.label)}</code></a>` : '';
    return { version, badge: `<span class="env-badge env-badge-ok">${T('coreReady','Ready')}</span>` };
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
      name: T('sdScriptsTitle','sd-scripts'),
      desc: T('sdScriptsDesc','kohya-ss/sd-scripts'),
      version: parts.version, badge: parts.badge,
      detailKey: 'sd', detailLabel: T('details','Details'),
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
      desc: T('lycorisDesc', 'LoRA adapter core'),
      version: parts.version, badge: parts.badge,
      detailKey: 'lycoris', detailLabel: T('details','Details'),
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
      desc: T('musubiDesc', 'Krea 2 training core'),
      version: parts.version, badge: parts.badge,
      detailKey: 'musubi', detailLabel: T('details','Details'),
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
    const head = this._renderRowHead('mossAccel', open, {
      name: T('mossAccelTitle'), action,
      version: '<span class="env-row-version">FLA 0.5.2 · Conv1D 1.7.0</span>',
      badge: `<span class="env-badge env-badge-${state === 'loading' ? 'loading' : state === 'err' ? 'err' : state === 'ok' ? 'ok' : 'muted'}">${this.esc(label)}</span>`,
      detailKey: 'mossAccel', detailLabel: T('details'),
    });
    let body = `<div class="env-msg env-msg-info">${this.esc(T('mossAccelDesc'))}</div>`
      + this._renderDetailGroup('FLA', this.esc(T('mossAccelFlaInfo')))
      + this._renderDetailGroup('Conv', this.esc(T('mossAccelConvInfo')))
      + `<div class="env-msg">${this.esc(T('mossAccelBenefit'))}</div>`
      + `<div class="env-msg env-msg-info">${this.esc(T('mossAccelInfo'))}</div>`;
    if (error) body += this._renderErrorBar(T, error, 'mossAccelInstallLog');
    if (busy) body += this._renderProgressPanel({ stage: 'working', elapsed: this.mossAccelInstallElapsed,
      stageLabel: T('mossAccelVerifying') }) + this._renderLog(this.mossAccelInstallLog);
    if (status?.reason) body += `<div class="env-msg env-msg-info">${this.esc(T('mossAccelReason_' + status.reason))}</div>`;
    if (status?.verification?.gpu) body += this._renderDetailGroup('GPU', this.esc(status.verification.gpu));
    if (!busy) {
      body += `<div class="env-actions"><button type="button" class="btn btn-sm btn-ghost" data-env-action="moss-accel-refresh">${T('refresh')}</button>`;
      if (status?.installed && status.can_install) body += `<button type="button" class="btn btn-sm btn-ghost" data-env-action="moss-accel-install">${T('mossAccelReinstall')}</button>`;
      body += '</div>';
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
        desc: T('tritonDesc','GPU compile backend for torch.compile'),
        version: '', badge: `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`,
        detailKey: 'triton', detailLabel: T('details','Details'),
      });
      const body = this._renderProgressPanel({ stage: 'working', elapsed: this.tritonInstallElapsed, stageLabel: T('tritonInstallingHint','Downloading...') })
        + this._renderLog(this.tritonInstallLog);
      return this._renderRow('triton', 'loading', open, head, body);
    }

    const state = this.tritonError ? 'err' : !tr ? 'loading' : tr.installed ? 'ok' : 'muted';
    const badge = this.tritonError
      ? `<span class="env-badge env-badge-err">${T('operationFailed','Operation failed')}</span>`
      : !tr
        ? `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>`
        : tr.installed
          ? `<span class="env-badge env-badge-ok">${T('tritonInstalled','Installed')}</span>`
          : `<span class="env-badge env-badge-muted">${T('notInstalled','Not installed')}</span>`;
    const version = tr && tr.installed && tr.version
      ? `<span class="env-row-version">v${this.esc(tr.version)}${tr.package ? ' · ' + this.esc(tr.package) : ''}</span>` : '';
    const headBtn = tr ? `<button type="button" class="btn btn-sm ${tr?.installed ? 'btn-ghost' : 'btn-secondary'} env-head-btn" data-env-action="triton">${tr?.installed ? T('reinstall','Reinstall') : T('install','Install')}</button>` : '';
    const head = this._renderRowHead('triton', open, {
      name: 'Triton',
      desc: T('tritonDesc','GPU compile backend for torch.compile'),
      version, badge, action: headBtn,
      detailKey: 'triton', detailLabel: T('details','Details'),
    });

    let body = '';
    if (this.tritonError) body += this._renderErrorBar(T, this.tritonError, 'tritonInstallLog');

    if (tr) {
      if (tr.installed) {
        body += this._renderDetailGroup(T('verLabel','Ver'), `<span class="env-env-item">${this.esc(tr.package||'triton')} <em>v${this.esc(tr.version||'?')}</em></span>`);
      } else {
        body += `<div class="env-msg env-msg-info">${T('tritonInstallInfo','Enables DiT per-block compilation. Windows installs a triton-windows version matched to PyTorch; Linux installs triton.')}</div>`;
      }
    }
    body += `<div class="env-actions">${this._renderRefreshBtn('triton-refresh-btn', this.tritonBusy)}</div>`;
    return this._renderRow('triton', state, open, head, body);
  },

  _bindXfEvents(el) {
    const a = window.__anima || this;
    el.querySelector('#xf-refresh-btn')?.addEventListener('click', () => a.xfRefresh());
  },

  _bindTritonEvents(el) {
    const a = window.__anima || this;
    el.querySelector('#triton-refresh-btn')?.addEventListener('click', () => a.tritonRefresh());
  },
};
