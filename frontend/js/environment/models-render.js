// 模型分组 → 槽位 / 标题 / 无文件时回退仓库（与后端 MODEL_FILES 的 group 字段对应）
const ENV_MODEL_GROUPS = {
  'Anima': { slot: 'animaModel', titleKey: 'animaModel.animaTitle', titleFallback: 'Anima Models', fallbackRepo: 'circlestone-labs/Anima' },
  'Krea 2': {
    slot: 'krea2', titleKey: 'animaModel.krea2Title', titleFallback: 'Krea 2 Models', fallbackRepo: 'Comfy-Org/Krea-2',
    trainingModels: ['krea2_raw_bf16.safetensors', 'krea2_raw_int8_convrot.safetensors'],
    noteKey: 'animaModel.kreaNote', noteDetails: ['animaModel.kreaQuantizationNote', 'animaModel.kreaPreviewNote'],
  },
  'MOSS-Image': { slot: 'moss', titleKey: 'animaModel.mossTitle', titleFallback: 'MOSS-Image Models', fallbackRepo: 'Comfy-Org/MOSS-Image', noteKey: 'animaModel.mossNote', noteDetails: ['animaModel.mossTrainingNote', 'animaModel.mossTokenizerNote'] },
  'Train Use': { slot: 'trainUse', titleKey: 'animaModel.trainUseTitle', titleFallback: 'Additional Models', fallbackRepo: 'ame-la/train_use_models', requiredComponents: ['model'] },
};
const ENV_MODEL_COMPONENT_KEYS = { model: 'componentModel', lora: 'componentLora', encoder: 'componentEncoder', vae: 'componentVae', other: 'componentOther' };

/* 模型文件分组、下载状态与事件；由 environment-render.js 装配。 */
window.environmentModelsRenderMixin = {
  // ═══════════════════════════════════════════════════════
  //  模型组（Anima / Krea 2）：组头统计 + 文件行 + 日志子折叠
  // ═══════════════════════════════════════════════════════
  _envModelFileComponent(file) {
    if (Object.hasOwn(ENV_MODEL_COMPONENT_KEYS, file.component_type)) return file.component_type;
    // 兼容尚未重启的后端：使用目录用途，不猜测文件名或翻译后的说明。
    const folders = (file.source_url || '').split('/');
    if (folders.includes('diffusion_models') || file.group === 'Train Use') return 'model';
    if (folders.includes('loras')) return 'lora';
    if (folders.includes('text_encoders')) return 'encoder';
    if (folders.includes('vae')) return 'vae';
    return 'other';
  },

  _envModelMissingComponents(files, modelGroup) {
    const view = ENV_MODEL_GROUPS[modelGroup] || {};
    return (view.requiredComponents || ['model', 'encoder', 'vae']).filter(kind =>
      !files.some(file => file.exists && this._envModelFileComponent(file) === kind
        && (kind !== 'model' || !view.trainingModels || view.trainingModels.includes(file.filename))));
  },

  _renderModelGroup(T, modelGroup) {
    const files = (this.animaModelStatus || []).filter(file => file.group === modelGroup);
    const progress = this.animaModelProgress;
    const aggregate = this.animaModelAggregate;
    const busy = this.animaModelBusy;
    const error = this.animaModelError;
    const destDir = this.animaModelDestDir || 'models/';
    const p = progress || {};
    const curFile = p.filename || '';
    const batch = Array.isArray(p.batch) ? p.batch : (curFile ? [curFile] : []);
    const phase = p.phase || '';
    const groupTask = !this.animaModelStatus || !p.group || p.group === 'all' || p.group === modelGroup;
    const groupBusy = busy && groupTask;
    const groupError = error && groupTask ? error : null;
    const view = ENV_MODEL_GROUPS[modelGroup] || { slot: 'animaModel', titleKey: 'animaModel.animaTitle', titleFallback: 'Anima Models', fallbackRepo: 'circlestone-labs/Anima' };
    const slotId = view.slot;
    const open = this._envCardOpen(slotId);
    const title = T(view.titleKey, view.titleFallback);

    const missing = this._envModelMissingComponents(files, modelGroup);
    const componentsReady = files.length > 0 && missing.length === 0;
    const state = groupError ? 'err' : !files.length || groupBusy ? 'loading' : componentsReady ? 'ok' : 'muted';
    const badge = groupError
      ? `<span class="env-badge env-badge-err">${T('operationFailed','Operation failed')}</span>`
      : !files.length
        ? `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>`
        : groupBusy
          ? `<span class="env-badge env-badge-loading">${T('animaModel.downloading','Downloading')}</span>`
          : componentsReady
            ? `<span class="env-badge env-badge-ok">${modelGroup === 'Train Use' ? T('animaModel.downloaded','Downloaded') : T('animaModel.componentsReady','Components available')}</span>`
            : '';

    // 按必需组件判断齐备；同类下载多个变体不会抵消缺少的另一类。
    const doneFiles = files.filter(f => f.exists);
    const totalBytes = doneFiles.reduce((sum, f) => sum + (f.size_bytes ?? (f.size_gb || 0) * 1073741824), 0);
    const missingNames = missing.map(kind => T('animaModel.' + (kind === 'model' && view.trainingModels ? 'componentTrainingModel' : ENV_MODEL_COMPONENT_KEYS[kind])));
    const countText = !doneFiles.length
      ? T('animaModel.notDownloaded', 'Not downloaded')
      : missing.length
        ? T('animaModel.missingComponents', 'Missing: {components}').replace('{components}', missingNames.join(' / '))
        : T('animaModel.localSize', 'Local files · {size}').replace('{size}', this._humanBytes(totalBytes));
    const countHtml = files.length
      ? `<span class="env-mgroup-count">${countText}</span>`
      : '';

    // 下载入口仅放在具体文件旁，组头只负责展开列表。
    const head = this._renderRowHead(slotId, open, {
      name: title, version: countHtml, badge,
      detailKey: slotId, detailLabel: T('animaModel.filesLabel','Files'),
    });

    let body = '';
    if (groupError) body += this._renderErrorBar(T, groupError, 'animaModelLog');
    if (view.noteKey) {
      body += `<aside class="env-download-note">
        <h3>${this.esc(T('animaModel.downloadGuide','Download guide'))}</h3>
        <p class="env-download-note-lead">${this.esc(T(view.noteKey))}</p>
        ${(view.noteDetails || []).map(key => `<p>${this.esc(T(key))}</p>`).join('')}
      </aside>`;
    }

    // 整体批量进度（下载中显示）
    if (groupBusy && aggregate && aggregate.fileTotal > 1) {
      const fileOf = T('animaModel.fileOf','File {i}/{n}').replace('{i}', aggregate.fileIndex).replace('{n}', aggregate.fileTotal);
      body += `<div class="env-model-aggregate">
        <div class="env-progress-bar"><div style="width:${aggregate.pct}%"></div></div>
        <div class="env-progress-meta">
          <span class="env-progress-pct">${aggregate.pct}%</span>
          <span class="env-progress-meta-r">${this.esc(fileOf)}${aggregate.label?' · '+this.esc(aggregate.label):''}</span>
        </div>
      </div>`;
    }

    // 按组件用途归组；仅给分类标题着色，文件与下载状态仍沿用原有样式。
    const groupedFiles = Object.keys(ENV_MODEL_COMPONENT_KEYS).map(kind => ({
      kind, files: files.filter(file => this._envModelFileComponent(file) === kind),
    })).filter(group => group.files.length);
    body += `<div class="env-file-list">`;
    for (const component of groupedFiles) {
      body += `<section class="env-file-section" data-env-component="${component.kind}">
        <div class="env-file-section-head">
          <h4 class="env-component-label env-component-${component.kind}">${this.esc(T('animaModel.' + ENV_MODEL_COMPONENT_KEYS[component.kind]))}</h4>
        </div>`;
      for (const f of component.files) {
      const inBatch = batch.includes(f.filename);
      const isCurrent = groupBusy && curFile === f.filename;
      const isQueued = groupBusy && inBatch && !isCurrent;
      let statusHtml = '', actionHtml = '', rowCls = 'env-file', progressHtml = '';

      if (isCurrent && p.total > 0) {
        const pct = Math.max(0, Math.min(100, Math.round(p.downloaded * 100 / p.total)));
        rowCls += ' env-file-active';
        progressHtml = `<div class="env-file-progress">
            <div class="env-progress-bar"><div style="width:${pct}%"></div></div>
            <div class="env-progress-meta">
              <span class="env-progress-pct">${pct}%</span>
              <span class="env-progress-meta-r">${(p.speed||0).toFixed(1)} MB/s &middot; ${this._humanBytes(p.downloaded||0)}/${this._humanBytes(p.total||0)}</span>
            </div>
          </div>`;
      } else if (isCurrent) {
        rowCls += ' env-file-active';
        const idx = p.file_index != null ? (p.file_index + 1) : '?';
        const tt = p.file_total || '?';
        progressHtml = `<div class="env-file-progress">
            <div class="env-progress-bar env-progress-indeterminate"><div></div></div>
            <div class="env-progress-meta">
              <span class="env-progress-stage">${T('animaModel.connecting','Connecting')}${p.file_total > 1 ? ` ${idx}/${tt}` : ''}</span>
            </div>
          </div>`;
      } else if (isQueued) {
        rowCls += ' env-file-queued';
        statusHtml = `<span class="env-badge env-badge-loading">${T('animaModel.pending','Pending')}</span>`;
      } else if (f.exists) {
        statusHtml = `<span class="env-badge env-badge-ok">${T('animaModel.downloaded','Downloaded')}</span>`;
      } else if (!busy && groupTask && phase === 'error' && curFile === f.filename) {
        rowCls += ' env-file-failed';
        statusHtml = `<span class="env-badge env-badge-err">${T('animaModel.failed','Failed')}</span>`;
      } else if (!busy && groupTask && inBatch && phase === 'done') {
        rowCls += ' env-file-failed';
        statusHtml = `<span class="env-badge env-badge-err">${T('animaModel.failed','Failed')}</span>`;
      } else {
        // 未下载是中性状态：灰徽标，不用警告色
        statusHtml = `<span class="env-badge env-badge-muted">${T('animaModel.notDownloaded','Not downloaded')}</span>`;
      }

      if (isCurrent || isQueued) {
        actionHtml = `<button class="btn btn-sm btn-ghost env-model-dl" disabled>${T('animaModel.downloading','Downloading')}</button>`;
      } else if (f.exists) {
        actionHtml = `<button class="btn btn-sm btn-ghost env-model-dl" data-group="${this.escapeAttr(modelGroup)}" data-file="${this.escapeAttr(f.filename)}" ${busy?'disabled':''} title="${T('animaModel.redownload','Redownload')}">${T('animaModel.redownload','Redownload')}</button>`;
      } else {
        actionHtml = `<button class="btn btn-sm btn-secondary env-model-dl" data-group="${this.escapeAttr(modelGroup)}" data-file="${this.escapeAttr(f.filename)}" ${busy?'disabled':''}>${T('animaModel.download','Download')}</button>`;
      }

      const sizeBytes = f.exists ? (f.size_bytes ?? (f.size_gb || 0) * 1073741824) : f.download_size_bytes;
      const sizeHtml = `<span class="env-file-size">${Number.isFinite(sizeBytes) && sizeBytes >= 0 ? this._humanBytes(sizeBytes) : '—'}</span>`;
      const destPath = f.dest_path || (destDir + f.filename);
      const description = f.desc_key ? this.t(f.desc_key, f.desc) : f.desc || '';
      const originHtml = f.source_page
        ? ` <a href="${this.escapeAttr(f.source_page)}" target="_blank" rel="noopener" class="env-link" title="${T('animaModel.openOriginalPage','Open the original model page')}">${T('animaModel.originalPage','Original page')} &#8599;</a>`
        : '';
      body += `<div class="${rowCls}">
        <div class="env-file-main">
          <a href="${this.escapeAttr(f.source_url || '#')}" target="_blank" rel="noopener" class="env-link env-file-name"><code title="${this.escapeAttr(f.filename)}">${this.esc(f.filename)}</code></a>
          ${sizeHtml}
          <span class="env-file-status">${statusHtml}</span>
          <span class="env-file-action">${actionHtml}</span>
        </div>
        <div class="env-file-sub">${this.esc(description)}${originHtml}<span class="env-file-dest">${this.esc(destPath)}</span></div>
        ${progressHtml}
      </div>`;
      }
      body += '</section>';
    }

    if (!files.length) {
      body += `<div class="env-file"><span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span></div>`;
    }
    body += `</div>`; // .env-file-list

    // 下载日志（子折叠，覆盖持久化）
    if (this.animaModelLog && groupTask) {
      body += this._renderSubCollapse('animaModelLog', T('animaModel.progressLog','Progress Log'), this._envCardOpen('animaModelLog'), this._renderLog(this.animaModelLog));
    }

    return `<div class="env-mgroup env-row-${state}${open ? ' env-open' : ''}" data-env-row="${slotId}">`
      + head
      + `<div class="env-row-body" data-env-body="${slotId}"${open ? '' : ' inert'}><div class="env-row-body-inner">${body}</div></div>`
      + `</div>`;
  },

  _bindModelGroupEvents(host) {
    const a = window.__anima || this;
    host.querySelectorAll('.env-model-refresh').forEach(btn => {
      btn.addEventListener('click', () => a.animaModelRefresh());
    });
    host.querySelectorAll('.env-model-dl[data-file]').forEach(btn => {
      btn.addEventListener('click', () => a.animaModelDownload(btn.dataset.file, btn.dataset.group));
    });
  },
};
