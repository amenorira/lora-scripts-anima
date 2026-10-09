/* Anima regularization workspace: persistent jobs and shared scrolling galleries. */
window.regularizationMixin = {
  regDefaults: null, regSectionCollapsed: { models: true, deviceOptions: true, bucketSettings: true }, _regUndo: {}, _regFields: {}, _regControlsLocale: '',
  regSettings: {}, regMetadata: null, _regResultRequest: 0, _regSourceRequest: 0, _regScanTimer: null, _regScanVersion: 0,
  regTab: 'settings', regPlan: null, regSources: [], regEdits: {}, regPlanDirty: false, regPreviewDirty: false, regPlanConsumed: false,
  regBusy: false, regError: '', regNewRound: false, regTask: null, regRunKey: '', regRuns: [],
  regItems: [], regItemsTotal: 0, regFilter: 'all', regLogs: [], regLogsOpen: false, _regLogRequest: 0,
  regGalleryLoading: '', regMoreError: '', _regMoreRequest: 0, _regResultRefresh: 0,
  regSelected: null, regTrainRoute: 'train-anima', regPendingTrainingPath: '', _regTopic: null, _regTimer: null, _regLoaded: false, _regRefreshing: false,
  get regRunning() { return ['created', 'running', 'stopping'].includes(this.regTask?.status); },
  get regTaskMatchesPlan() { return this.regRunning || !!this.regPlan && this.regTask?.output_path === this.regPlan.output_path; },
  get regProgress() {
    if (!this.regTask?.total) return 0;
    const partial = this.regRunning && this.regTask.steps ? Math.min(1, (this.regTask.step || 0) / this.regTask.steps) : 0;
    return Math.min(100, 100 * ((this.regTask.completed || 0) + (this.regTask.excluded || 0) + partial) / this.regTask.total);
  },
  regT(key) { return this.t('regularization.' + key); },
  get regGalleryCount() { return this.regTab === 'plan' ? this.regSources.length : this.regItems.length; },
  get regGalleryTotal() { return this.regTab === 'plan' ? this.regPlan?.source_count || 0 : this.regItemsTotal; },
  get regHasMore() { return this.regGalleryCount < this.regGalleryTotal; },
  get regCards() {
    const plan = this.regTab === 'plan';
    return (plan ? this.regSources : this.regItems).map((item, index) => ({
      key: plan ? 'source:' + item.relative : 'result:' + item.index,
      item, source: plan ? item : null,
      filename: plan ? item.relative.split('/').pop() : item.filename,
      label: plan ? this.regPreviewDirty ? this.regT('awaitValidation') : item.reason ? this.regT('invalid') : this.regT('imageCount') + ' ' + (item.count || 0) : this.regT(item.status),
      caption: item.caption || '—', dimensions: (item.width || '—') + ' × ' + (item.height || '—'),
      error: plan ? item.reason : item.error,
      image: plan ? this.regSourceImage(index) : ['completed', 'excluded'].includes(item.status) ? this.regImage(item) : '',
    }));
  },
  regGallery() {
    let observer, detailVersion = 0, detailReady = false;
    return {
      detail: null, pinned: false, detailStyle: '',
      init() {
        for (const key of ['currentRoute', 'regTab', 'regPlan']) this.$watch(key, () => this.closeDetail());
        this.$watch('regSources', () => { if (this.detail && !this.regSources.includes(this.detail)) this.closeDetail(); });
        this.$watch('regTab', () => { this.regMoreError = ''; });
        for (const key of ['currentRoute', 'regTab', 'regBusy', 'regPreviewDirty', 'regSources', 'regItems', 'regItemsTotal', 'regGalleryLoading', '_regResultRefresh']) this.$watch(key, () => this.$nextTick(() => this.checkMore()));
        this.$nextTick(() => {
          observer = new IntersectionObserver(() => this.checkMore(), {rootMargin: '400px'});
          observer.observe(this.$refs.galleryEnd);
          this.checkMore();
        });
      },
      destroy() { observer?.disconnect(); },
      checkMore() {
        if (this.currentRoute !== 'regularization' || this.regTab === 'settings' || this.regMoreError) return;
        const end = this.$refs.galleryEnd;
        if (!end?.getClientRects().length) return;
        const rect = end.getBoundingClientRect();
        if (rect.top <= window.innerHeight + 400 && rect.bottom >= 0) void this.regLoadMore();
      },
      closeDetail() { ++detailVersion; detailReady = false; this.detail = null; this.pinned = false; },
      showDetail(source, event, pin = false) {
        if (this.pinned && !pin) return;
        // Focus fires before click: keep the existing hover position when pinning.
        if (this.detail === source) { if (pin) this.pinned = true; return; }
        this.detail = source; this.pinned = pin;
        detailReady = false;
        const version = ++detailVersion;
        const anchor = {clientX: event.clientX, clientY: event.clientY, currentTarget: event.currentTarget};
        this.detailStyle = 'visibility:hidden;left:12px;top:12px';
        this.$nextTick(() => {
          if (version !== detailVersion || !this.detail) return;
          const popup = this.$refs.sourceDetail;
          if (!popup) return;
          const body = popup.querySelector('.te-dict-hover-body');
          const maxWidth = Math.max(1, window.innerWidth - 24);
          const maxHeight = Math.max(1, window.innerHeight - 24);
          // Widen long captions until they fit vertically, using the viewport as the limit.
          let width = Math.min(420, maxWidth);
          popup.style.maxHeight = `${maxHeight}px`;
          popup.style.width = `${width}px`;
          while (body.scrollHeight > body.clientHeight + 1 && width < maxWidth) {
            width = Math.min(maxWidth, width + 80);
            popup.style.width = `${width}px`;
          }
          body.scrollTop = 0;
          this.detailStyle = `width:${width}px;max-height:${maxHeight}px;visibility:hidden`;
          detailReady = true;
          this.moveDetail(anchor);
        });
      },
      moveDetail(event) {
        if (!this.detail || !detailReady) return;
        const box = event.currentTarget.getBoundingClientRect();
        const x = event.clientX || box.right, y = event.clientY || box.top;
        const popup = this.$refs.sourceDetail;
        const width = popup?.offsetWidth || 400, height = popup?.offsetHeight || 300;
        const left = Math.max(12, Math.min(x + 16 + width > window.innerWidth ? x - width - 16 : x + 16, window.innerWidth - width - 12));
        const top = Math.max(12, Math.min(y + 16, window.innerHeight - height - 12));
        this.detailStyle = `width:${width}px;max-height:${Math.max(1, window.innerHeight - 24)}px;left:${left}px;top:${top}px`;
      },
    };
  },
  regSourceSummary() {
    if (!this.regPlan || this.regPreviewDirty) return this.regT('awaitPreview');
    return this.regT('usableSources').replace('{valid}', this.regPlan.valid_sources).replace('{total}', this.regPlan.source_count);
  },
  regPromptSizing() {
    let observer;
    return {
      init() {
        this.$nextTick(() => {
          const inputs = [...this.$el.querySelectorAll('textarea')];
          observer = new ResizeObserver(entries => {
            const bounds = inputs.map(input => input.getBoundingClientRect());
            if (bounds.some(rect => !rect.height) || Math.abs(bounds[0].top - bounds[1].top) > 2) return;
            const height = entries[0].target.getBoundingClientRect().height;
            inputs.forEach((input, index) => {
              if (Math.abs(bounds[index].height - height) > .5) input.style.height = height + 'px';
            });
          });
          inputs.forEach(input => observer.observe(input));
        });
      },
      destroy() { observer?.disconnect(); },
    };
  },
  regRunSelectConfig() { return { options: this.regRuns.map(run => ({v: run.run_key, l: run.run_key + ' · ' + run.completed + '/' + run.total})) }; },
  regFilterSelectConfig() { return { options: ['all','completed','failed','excluded','pending'].map(key => ({v:key,l:this.regT(key)})) }; },
  async regRequest(path, body) {
    const response = await fetch('/api/regularization' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (result.status === 'changed') {
      this.regPlan = result.data; this.regPlanDirty = false; this.regPreviewDirty = false; this.regPlanConsumed = false; this.regSources = [];
      await this.regLoadSources();
      throw new Error(this.regT('changed'));
    }
    if (result.status !== 'success') throw new Error(result.message || 'Request failed');
    return result.data;
  },
  async regAction(callback) {
    if (this.regBusy) return;
    this.regBusy = true; this.regError = '';
    try { await callback(); } catch (error) { this.regReportError(error.message); }
    finally { this.regBusy = false; }
  },
  regReportError(message) {
    if (message !== this.regError) this.toast(message, 'error');
    this.regError = message;
  },
  regInitSettings() {
    const prompts = {
      extra_positive: 'masterpiece, best quality, score_7',
      negative: 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration',
    };
    this.regDefaults = { ...this.regMetadata.defaults, ...prompts };
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('anima-reg-settings') || '{}'); } catch (_) {}
    Object.assign(this.regSettings, this.regDefaults, saved, { ...this.regSettings });
    // Migrate the old empty defaults once; subsequent deliberate clearing stays empty.
    if (!localStorage.getItem('anima-reg-prompt-defaults-v1')) {
      for (const [key, value] of Object.entries(prompts)) {
        if (!this.regSettings[key]?.trim()) this.regSettings[key] = value;
      }
      localStorage.setItem('anima-reg-settings', JSON.stringify(this.regSettings));
      localStorage.setItem('anima-reg-prompt-defaults-v1', '1');
    }
  },
  async buildRegularizationForm() {
    if (!this._regLoaded) {
      try {
        this.regMetadata = await this.regRequest('/metadata');
      } catch (error) { this.regReportError(error.message); return; }
      this.regInitSettings();
      this._regLoaded = true;
    }
    const host = document.getElementById('regularizationWorkspaceHost');
    if (host && !host.dataset.mounted) {
      const response = await fetch('/anima-ui/regularization-workspace.html?v=20261009-reg-sdxl');
      host.innerHTML = await response.text(); host.dataset.mounted = '1';
      Alpine.initTree(host);
    }
    this.regRenderControls();
    if (this.currentRoute !== 'regularization') return;
    this.realtimeSubscribe('hardware'); this.renderRegularizationResourceBar();
    await this.regRefreshRuns();
    const active = this.regRuns.find(run => ['created', 'running', 'stopping'].includes(run.status));
    const stored = localStorage.getItem('anima-reg-run');
    const restored = active || this.regRuns.find(run => run.run_key === stored);
    if (stored && !restored) localStorage.removeItem('anima-reg-run');
    if (restored) {
      this.regRunKey = restored.run_key; this.regApplyTask(restored);
      localStorage.setItem('anima-reg-run', restored.run_key);
      if (this.regRunning) {
        const page = await this.regRequest('/runs/' + encodeURIComponent(this.regRunKey) + '/items?limit=1');
        Object.assign(this.regSettings, this.regDefaults, page.settings, { seed: String(page.settings.seed) });
        this.regRenderControls(true);
      }
      if (this.regTab === 'inspect') await this.regLoadResults();
      await this.regLoadLogs();
    }
    this.regSyncTimer();
    if ((!this.regPlan || this.regPreviewDirty) && !this.regRunning) this.regScheduleScan();
  },
  regSyncTimer() {
    if (this.regRunning && this.currentRoute === 'regularization') {
      if (!this._regTimer) this._regTimer = setInterval(() => void this.regRefreshTask(), 2500);
    } else if (this._regTimer) { clearInterval(this._regTimer); this._regTimer = null; }
  },
  stopRegularizationWorkspace() {
    this._regScanVersion++;
    clearTimeout(this._regScanTimer); this._regScanTimer = null;
    if (this._regTimer) { clearInterval(this._regTimer); this._regTimer = null; }
    if (this._regTopic) this.realtimeUnsubscribe(this._regTopic);
    this._regTopic = null;
    // Other route builders subscribe after this route has released hardware.
    if (this.currentRoute !== 'tagger' && !this.currentRoute.startsWith('monitor-')) this.realtimeUnsubscribe('hardware');
  },
  renderRegularizationResourceBar() {
    this._renderResourceBar('regularizationResbar', this.gpuInfo, this.sysInfo, (key, fallback) => this.t('monitor.' + key, fallback), this.locale);
  },
  regChanged(key) {
    // Every edit invalidates the executable token, but only dataset-dependent
    // fields invalidate the source preview. Validate the full config on Generate.
    this.regPlanDirty = true;
    const scanFields = ['source_dir', 'ignore_first', 'exclude_tags', 'size_mode', 'per_image', 'expand_repeats'];
    const sizeFields = this.regSettings.size_mode === 'fixed' ? ['width', 'height'] : this.regSettings.size_mode === 'bucket'
      ? ['resolution', 'enable_bucket', ...(this.regSettings.enable_bucket ? ['bucket_no_upscale', 'min_bucket_reso', 'max_bucket_reso', 'bucket_reso_steps'] : [])] : [];
    if (!key || !this.regPlan || scanFields.includes(key) || sizeFields.includes(key)) this.regPreviewDirty = true;
    this._regScanVersion++;
    localStorage.setItem('anima-reg-settings', JSON.stringify(this.regSettings));
    if (this.regPreviewDirty) this.regScheduleScan();
  },
  regSetField(key, value) {
    if (this.regRunning || this.regBusy) return;
    if (typeof this.regDefaults[key] === 'number') value = value === '' ? '' : Number(value);
    const field = this._regFields[key];
    if (value !== '' && field?.type === 'number' && Number.isFinite(value)) value = Math.max(field.min, Math.min(field.max, value));
    if (Object.is(this.regSettings[key], value)) return;
    this._regUndo[key] = this.regSettings[key];
    this.regSettings[key] = value;
    if (key === 'model_type' || key === 'sampler') this.regNormalizeModelSettings();
    if (key === 'source_dir') { this.regEdits = {}; this.regPlan = null; this.regSources = []; this.regPlanConsumed = false; }
    if (key === 'extra_positive') for (const source of this.regSources) {
      source.prompt = this.regActualPrompt(source.caption);
    }
    this.regChanged(key);
    if (this._regLoaded && (key === 'model_type' || key === 'sampler')) this.regRenderControls(true);
  },
  regNormalizeModelSettings() {
    if (this.regSettings.model_type !== 'sdxl') return;
    if (this.regSettings.sampler === 'er_sde') this.regSettings.sampler = 'euler_a';
    if (!['normal', 'karras', 'exponential'].includes(this.regSettings.scheduler) || this.regSettings.sampler === 'euler_a') this.regSettings.scheduler = 'normal';
    this.regSettings.blocks_to_swap = 0;
  },
  regScheduleScan() {
    clearTimeout(this._regScanTimer); this._regScanTimer = null;
    if (this.currentRoute !== 'regularization' || this.regRunning || !this.regSettings.source_dir?.trim()) return;
    this._regScanTimer = setTimeout(() => {
      this._regScanTimer = null;
      if (this.currentRoute === 'regularization' && !this.regBusy && !this.regRunning) void this.regScan({ quiet: true });
    }, 500);
  },
  regFormControls() {
    const root = this;
    return {
      form: root.regSettings, formDefaults: root.regDefaults, formErrors: {},
      regImportTraining() { root.regImportTraining(); },
      setField(key, value) { root.regSetField(key, value); },
      findFieldDef(key) { return root._regFields[key]; },
      _numberConstraints(field) { return field || {}; },
      stepField(key, delta) { root.stepField.call(this, key, delta); },
      resetField(key) { root.regSetField(key, root.regDefaults[key]); },
      undoField(key) { if (key in root._regUndo) root.regSetField(key, root._regUndo[key]); },
      localFilePicker(key, role) { return root.localFilePicker('reg__' + key, role); },
      builtinFilePicker(key, role) { return root.builtinFilePicker('reg__' + key, role); },
    };
  },
  regToggleSection(key, header) {
    const collapsed = !this.regSectionCollapsed[key];
    this.regSectionCollapsed[key] = collapsed;
    this._animateCollapse(header.nextElementSibling, collapsed);
  },
  regRenderControls(force = false) {
    const host = document.getElementById('regTrainingControls');
    if (!host || !force && host.dataset.locale === this.locale) return;
    if (host.dataset.locale) Alpine.destroyTree(host);
    // Reuse the training page's renderer and its actual controls. This scope
    // supplies generator values without changing the user's training form.
    const scope = Object.create(this);
    Object.defineProperties(scope, {
      form: { value: { ...this.regSettings, model_train_type: 'anima-lora' } },
      formDefaults: { value: this.regDefaults },
      _getEnvHint: { value: () => '' }, _getOutputPathHint: { value: () => '' },
    });
    const helpFields = new Set(['source_dir', 'ignore_first', 'exclude_tags', 'sampler', 'scheduler', 'steps', 'cfg', 'seed', 'per_image', 'expand_repeats', 'size_mode', 'flow_shift', 'precision', 'blocks_to_swap', 'text_encoder_cpu', 'gpu_index', 'bucket_no_upscale', 'min_bucket_reso', 'max_bucket_reso', 'bucket_reso_steps']);
    const field = (key, type = 'text', extra = {}) => ({ key, type, descKey: 'regularization.' + key, helpKey: helpFields.has(key) ? 'regularization.help.' + key : undefined, default: this.regDefaults[key], nested: false, labelOnly: true, ...extra });
    const num = (key, step = 1) => {
      const schema = this.regMetadata.fields[key];
      return field(key, 'number', { min: schema.minimum, max: schema.maximum, step: schema.multipleOf ?? step });
    };
    const labels = { euler_a: 'euler_ancestral', bf16: 'BF16', fp16: 'FP16', auto: this.regT('autoSize'), manual: this.regT('manualMemory'), bucket: this.regT('bucket'), fixed: this.regT('fixed') };
    const select = key => field(key, 'select', { options: this.regMetadata.fields[key].enum.filter(v =>
      this.regSettings.model_type !== 'sdxl' || (key !== 'sampler' || v !== 'er_sde') &&
      (key !== 'scheduler' || (this.regSettings.sampler === 'euler_a' ? ['normal'] : ['normal', 'karras', 'exponential']).includes(v))
    ).map(v => ({v, l: v === 'sdxl' ? 'SDXL' : v === 'anima' ? 'Anima' : labels[v] || v, ...(key === 'model_type' ? {} : {dKey: `regularization.options.${key}.${v}`})})) });
    const action = (label, click, icon, disabled = 'false') => `<button type="button" class="btn btn-secondary reg-control-action" @click="${click}" :disabled="${disabled}" :title="regT('${label}')" :aria-label="regT('${label}')"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></button>`;
    const seedActions = action('randomSeed', "setField('seed', '-1')", '<path d="m3 7 3 0 12 10h3m-4-14 4 0v4M3 17h3l3-3m6-4 3-3h3m-4 10h4v-4"/>')
      + action('reuseSeed', "setField('seed', regTask.master_seed)", '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>', 'regTask?.master_seed == null');
    const widthField = num('width');
    widthField.controlActions = '<span class="reg-control-spacer" aria-hidden="true"></span>';
    const heightField = num('height');
    heightField.controlActions = action('swapSize', 'regSwapSize()', '<path d="M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4"/>');
    const groups = [
      ['dataset', [field('source_dir', 'text', { role: 'file-folder', required: true,
        controlActions: `<button type="button" class="btn btn-secondary btn-sm" :disabled="regBusy || regRunning" :title="regT('importHelp')" @click="regImportTraining()" x-text="regT('import')"></button>` })]],
      ['models', [select('model_type'), ...['dit', 'text_encoder', 'vae', 'checkpoint', 'sdxl_vae'].map(key => field(key, 'text', { role: 'file-model', required: key !== 'sdxl_vae' }))]],
      ['prompts', [num('ignore_first'), field('exclude_tags')]],
      ['quantity', [select('sampler'), select('scheduler'), num('flow_shift', .1), num('steps'), num('cfg', .1),
        field('seed', 'text', { controlActions: seedActions })]],
      ['size', [select('size_mode'), widthField, heightField, field('resolution'), field('enable_bucket', 'toggle'), num('per_image'), field('expand_repeats', 'toggle')]],
      ['deviceOptions', [select('memory_mode'), select('precision'), num('blocks_to_swap'), field('text_encoder_cpu', 'toggle'), num('gpu_index')]],
    ];
    const sectionHeader = key => `<div class="card-header" role="button" tabindex="0" :aria-expanded="!regSectionCollapsed['${key}']" @click="regToggleSection('${key}', $el)" @keydown.enter.prevent="$el.click()" @keydown.space.prevent="$el.click()"><svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg><span>${this.esc(this.regT(key))}</span></div>`;
    const bucketFields = [field('bucket_no_upscale', 'toggle'), num('min_bucket_reso', 16), num('max_bucket_reso', 16), num('bucket_reso_steps')];
    this._regFields = Object.fromEntries(groups.flatMap(([,fields]) => fields.map(field => [field.key, field])));
    for (const definition of bucketFields) this._regFields[definition.key] = definition;
    let html = '<div x-data="regFormControls()">';
    for (const [title, fields] of groups) {
      const section = {dataset:'model', models:'model', prompts:'caption', quantity:'training', size:'regularization', deviceOptions:'performance'}[title];
      html += '<div class="card" data-section="' + section + '" :class="{\'card-collapsed\': regSectionCollapsed[\'' + title + '\']}">' + sectionHeader(title);
      html += '<div class="card-body" :inert="!!regSectionCollapsed[\'' + title + '\']">';
      if (title === 'prompts') html += document.getElementById('regPromptFields').innerHTML;
      for (const definition of fields) {
        let rendered = this.renderField.call(scope, definition);
        let show = '';
        if (['width', 'height'].includes(definition.key)) show = "form.size_mode === 'fixed'";
        if (['resolution', 'enable_bucket'].includes(definition.key)) show = "form.size_mode === 'bucket'";
        if (definition.key === 'flow_shift') show = "form.model_type !== 'sdxl' && form.scheduler !== 'flux2'";
        if (['precision', 'blocks_to_swap', 'text_encoder_cpu'].includes(definition.key)) show = "form.memory_mode === 'manual'";
        if (definition.key === 'blocks_to_swap') show += " && form.model_type !== 'sdxl'";
        if (['dit', 'text_encoder', 'vae'].includes(definition.key)) show = "form.model_type !== 'sdxl'";
        if (['checkpoint', 'sdxl_vae'].includes(definition.key)) show = "form.model_type === 'sdxl'";
        html += show ? '<div x-show="' + show + '" x-cloak>' + rendered + '</div>' : rendered;
      }
      if (title === 'size') html += '<div class="card reg-extra-options" :class="{\'card-collapsed\': regSectionCollapsed.bucketSettings}" x-show="form.size_mode === \'bucket\' && form.enable_bucket">' + sectionHeader('bucketSettings') + '<div class="card-body" :inert="!!regSectionCollapsed.bucketSettings">' + bucketFields.map(definition => this.renderField.call(scope, definition)).join('') + '</div></div>';
      html += '</div></div>';
    }
    host.innerHTML = html + '</div>'; host.dataset.locale = this.locale;
    Alpine.initTree(host);
    if (!this._regControlsLocale) {
      this._regControlsLocale = 'registered';
      window.addEventListener('locale-changed', () => this.regRenderControls());
    }
  },
  async regShowPlan() {
    this.regTab = 'plan';
    if (this.regBusy) return;
    if (this.regRunning && (!this.regPlan || this.regPlan.output_path !== this.regTask.output_path)) {
      await this.regAction(async () => {
        this.regPlan = await this.regRequest('/runs/' + encodeURIComponent(this.regRunKey) + '/plan');
        this.regEdits = this.regPlan.overrides; this.regPlanConsumed = true; this.regPlanDirty = false; this.regPreviewDirty = false; this.regSources = [];
        await this.regLoadSources();
      });
    } else if (!this.regRunning && (!this.regPlan || this.regPreviewDirty)) await this.regScan();
  },
  regSwapSize() {
    const {width, height} = this.regSettings;
    this.regSetField('width', height); this.regSetField('height', width);
  },
  regPhaseLabel() { return this.regT(!this.regTaskMatchesPlan ? 'idle' : this.regRunning ? this.regTask?.phase || 'created' : this.regTask?.status || 'idle'); },
  regStatusClass() { return this.regTask?.failed && !this.regRunning ? 'error' : {finished:'done',failed:'error',terminated:'cancelled'}[this.regTask?.status] || this.regTask?.status || 'idle'; },
  regVisibleLogs() {
    if (!this.regTaskMatchesPlan) return [];
    const lines = this.taggerVisibleLogs.call({taggerTask:{logs:this.regLogs}, taggerLogsOpen:true});
    const occurrences = new Map();
    return lines.map((line, index) => {
      const raw = this.regLogs[index];
      const occurrence = occurrences.get(raw) || 0;
      occurrences.set(raw, occurrence + 1);
      const record = this._parseLogRecord(line.message);
      const message = record?.message || line.message;
      const level = record?.level || '';
      return {time: (record?.timestamp || line.time)?.match(/\d{2}:\d{2}:\d{2}/)?.[0] || '',
        key: JSON.stringify([raw, occurrence]), message, level: /ERROR|CRITICAL/.test(level) || /Traceback|Error:/.test(message) ? 'error' : /WARN/.test(level) ? 'warning' : /Completed|已完成/.test(message) ? 'success' : line.level};
    });
  },
  async regCopyLogs() {
    try { await navigator.clipboard.writeText(this.regLogs.join('\n')); this.toast(this.t('common.copied')); }
    catch (_) { this.toast(this.t('common.failed'), 'error'); }
  },
  async regGenerate() {
    if (this.regBusy || this.regRunning || this.trainingActive) return;
    this.regError = '';
    // Files may have been added outside the app since the last preview.
    await this.regScan();
    if (this.regError || !this.regPlan) return;
    if (!this.regPlan.total) { this.regReportError(this.regT('noUsableSources')); return; }
    if (this.regPlanConsumed || this.regPlan.total && !this.regPlan.pending) await this.regAgain();
    else await this.regStart();
  },
  async regScan({ quiet = false } = {}) {
    clearTimeout(this._regScanTimer); this._regScanTimer = null;
    if (this.regRunning || this.regBusy) return;
    const version = ++this._regScanVersion;
    const scan = async () => {
      // Send seeds as strings: JS integers cannot exactly represent int64.
      const plan = await this.regRequest('/plans', { settings: { ...this.regSettings }, overrides: { ...this.regEdits }, new_round: this.regNewRound,
        previous_token: this.regPlanConsumed ? undefined : this.regPlan?.token });
      if (version !== this._regScanVersion) return;
      const page = await this.regFetchItems('/plans/' + plan.token + '/items', Math.max(24, this.regSources.length));
      if (version !== this._regScanVersion) return;
      this.regPlan = plan; this.regError = '';
      this.regPlanDirty = false; this.regPreviewDirty = false; this.regPlanConsumed = false;
      ++this._regSourceRequest;
      this.regSources = this.regMapSources(page.items);
      this.regMoreError = '';
      localStorage.setItem('anima-reg-settings', JSON.stringify(this.regSettings));
    };
    // Background previews must not disable the form while the user adjusts it.
    if (quiet) {
      try { await scan(); } catch (error) { if (version === this._regScanVersion) this.regError = error.message; }
    } else await this.regAction(scan);
  },
  async regFetchItems(path, count = 24, offset = 0) {
    const items = [];
    let page;
    do {
      page = await this.regRequest(path + (path.includes('?') ? '&' : '?') + 'offset=' + (offset + items.length) + '&limit=' + Math.min(100, count - items.length));
      items.push(...page.items);
    } while (page.items.length && items.length < count && offset + items.length < page.total);
    return {...page, items};
  },
  async regLoadMore(tab = this.regTab) {
    if (this.regBusy || this.regGalleryLoading === tab || tab !== this.regTab || !this.regHasMore || tab === 'settings' || tab === 'plan' && this.regPreviewDirty || tab === 'inspect' && this._regResultRefresh) return;
    const request = ++this._regMoreRequest;
    this.regGalleryLoading = tab; this.regMoreError = '';
    try {
      if (tab === 'plan') await this.regLoadSources({append: true});
      else await this.regLoadResults({append: true});
    } catch (error) { if (tab === this.regTab && request === this._regMoreRequest) this.regMoreError = error.message; }
    finally { if (request === this._regMoreRequest) this.regGalleryLoading = ''; }
  },
  regMapSources(items) {
    return items.map(source => {
      const caption = this.regEdits[source.relative] ?? source.caption;
      return {...source, caption, prompt: this.regActualPrompt(caption)};
    });
  },
  regActualPrompt(caption) {
    return [this.regSettings.extra_positive, caption].map(part => part.trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');
  },
  async regLoadSources({append = false} = {}) {
    if (!this.regPlan) return;
    const token = this.regPlan.token, version = this._regScanVersion, request = ++this._regSourceRequest;
    const offset = append ? this.regSources.length : 0;
    let page;
    try { page = await this.regFetchItems('/plans/' + token + '/items', append ? 24 : Math.max(24, this.regSources.length), offset); }
    catch (error) {
      if (token !== this.regPlan?.token || version !== this._regScanVersion || request !== this._regSourceRequest) return false;
      throw error;
    }
    if (token !== this.regPlan?.token || version !== this._regScanVersion || request !== this._regSourceRequest) return false;
    this.regSources = append ? [...this.regSources, ...this.regMapSources(page.items)] : this.regMapSources(page.items);
    return true;
  },
  async regStart() {
    if (!this.regPlan || this.regPlanDirty || this.regPlanConsumed || this.regRunning || this.trainingActive) return;
    await this.regAction(async () => {
      const task = await this.regRequest('/tasks', { token: this.regPlan.token });
      this.regRunKey = task.run_key; this.regLogs = []; localStorage.setItem('anima-reg-run', task.run_key);
      this.regApplyTask(await this.regRequest('/tasks/' + task.task_id));
      this.regPlanConsumed = true;
      this.regNewRound = false;
      await this.regRefreshRuns();
    });
  },
  async regAgain() {
    if (!this.regPlan || this.regPlanDirty || this.regRunning || this.regBusy || this.trainingActive) return;
    const fingerprint = this.regPlan.fingerprint;
    await this.regAction(async () => {
      this.regNewRound = true;
      this.regPlan = await this.regRequest('/plans', {settings: this.regSettings, overrides: this.regEdits, new_round: true});
      this.regPlanConsumed = false;
      await this.regLoadSources();
      if (this.regPlan.fingerprint !== fingerprint) this.toast(this.regT('changed'));
    });
    if (!this.regError && this.regPlan?.fingerprint === fingerprint) await this.regStart();
  },
  async regStop() { await this.regAction(async () => { await this.regRequest('/tasks/' + this.regTask.task_id + '/cancel', {}); this.regTask.status = 'stopping'; }); },
  regApplyTask(task, refreshResults = true) {
    // Registration publishes a CREATED event with empty data before the first
    // summary. Keep the known task so polling and cancellation remain active.
    if (!task?.task_id || !task.status) return;
    if (task.run_key && task.run_key !== this.regRunKey) return;
    if (task.task_id === this.regTask?.task_id && task.updated_at < this.regTask.updated_at) return;
    const wasRunning = this.regRunning;
    const countsChanged = task.completed !== this.regTask?.completed || task.failed !== this.regTask?.failed;
    this.regTask = task;
    if (this.regPlan && this.regPlan.output_path === task.output_path) {
      this.regPlan.completed = task.completed; this.regPlan.pending = task.pending;
    }
    const topic = this.regRunning && task.task_id ? 'task:' + task.task_id : null;
    if (topic !== this._regTopic) {
      if (this._regTopic) this.realtimeUnsubscribe(this._regTopic);
      this._regTopic = topic;
      if (topic && this.currentRoute === 'regularization') this.realtimeSubscribe(topic);
    }
    this.regSyncTimer();
    if (refreshResults && this.regTab === 'inspect' && (countsChanged || wasRunning && !this.regRunning)) {
      void this.regLoadResults().catch(error => { this.regReportError(error.message); });
    }
    if (wasRunning && !this.regRunning) {
      void this.regRefreshRuns();
      if (refreshResults && this.regTab !== 'inspect') void this.regLoadLogs();
    }
  },
  handleRealtimeRegularizationEvent(event) {
    if (this.currentRoute !== 'regularization' || event?.topic !== this._regTopic) return;
    if (['task.status', 'task.progress', 'task.result'].includes(event.type) && event.payload?.data) this.regApplyTask(event.payload.data);
  },
  applyRealtimeRegularizationSnapshot(snapshot) {
    const tracked = snapshot?.tasks?.tracked?.find(task => task.task_id === this.regTask?.task_id);
    if (tracked && this.currentRoute === 'regularization') this.regApplyTask(tracked.data);
  },
  async regRefreshTask() {
    if (!this.regRunning) { this.regSyncTimer(); return; }
    if (!this.regTask?.task_id || this._regRefreshing || this.currentRoute !== 'regularization') return;
    const taskId = this.regTask.task_id, key = this.regRunKey;
    this._regRefreshing = true;
    try {
      if (!this.realtimeReady || this.realtimeState !== 'online') {
        const task = await this.regRequest('/tasks/' + taskId);
        if (key !== this.regRunKey || taskId !== this.regTask?.task_id) return;
        this.regApplyTask(task);
        if (!this.regRunning) return;
      }
      await this.regLoadLogs();
    } catch (error) { if (key === this.regRunKey && taskId === this.regTask?.task_id) this.regReportError(error.message); }
    finally { this._regRefreshing = false; }
  },
  regClearRun() {
    const outputPath = this.regTask?.output_path;
    ++this._regResultRequest;
    this._regResultRefresh = 0;
    this.regRunKey = ''; this.regTask = null; this.regItems = []; this.regItemsTotal = 0;
    this.regSelected = null; this.regLogs = []; this.regError = ''; this.regMoreError = '';
    if (this._regTopic) this.realtimeUnsubscribe(this._regTopic);
    this._regTopic = null; this.regSyncTimer();
    localStorage.removeItem('anima-reg-run');
    if (outputPath && this.regPlan?.output_path === outputPath) {
      ++this._regScanVersion;
      this.regPlan = null; this.regSources = []; this.regPlanConsumed = false; this.regPlanDirty = true;
    }
  },
  async regRefreshRuns() {
    const key = this.regRunKey;
    this.regRuns = await this.regRequest('/runs');
    if (key && key === this.regRunKey && !this.regRunning && !this.regRuns.some(run => run.run_key === key)) this.regClearRun();
  },
  async regResume(failedOnly = false) {
    if (this.trainingActive || this.regRunning) return;
    if (this.regTab !== 'inspect' && this.regPlanDirty) { this.regReportError(this.regT('resumeDirty')); return; }
    await this.regAction(async () => {
      const task = await this.regRequest('/runs/' + encodeURIComponent(this.regRunKey) + '/resume', { failed_only: failedOnly });
      this.regApplyTask(await this.regRequest('/tasks/' + task.task_id));
      await this.regLoadResults();
    });
  },
  async regSelectRun() {
    if (!this.regRunKey) { this.regClearRun(); return; }
    ++this._regResultRequest;
    this.regSelected = null; this.regLogs = []; this.regTask = null; this.regItems = []; this.regItemsTotal = 0; this.regMoreError = '';
    this.regSyncTimer();
    localStorage.setItem('anima-reg-run', this.regRunKey);
    await this.regAction(() => this.regLoadResults());
  },
  async regInspect() {
    this.regTab = 'inspect';
    await this.regAction(async () => { await this.regRefreshRuns(); if (this.regRunKey) await this.regLoadResults(); });
  },
  async regSelectFilter() {
    ++this._regResultRequest;
    this.regItems = []; this.regItemsTotal = 0; this.regSelected = null; this.regMoreError = '';
    await this.regAction(() => this.regLoadResults());
  },
  async regLoadResults({append = false} = {}) {
    if (!this.regRunKey) { this.regClearRun(); return; }
    if (append && this._regResultRefresh) return false;
    const key = this.regRunKey, filter = this.regFilter, request = ++this._regResultRequest;
    const offset = append ? this.regItems.length : 0;
    if (!append) this._regResultRefresh = request;
    try {
      let page;
      try {
        page = await this.regFetchItems('/runs/' + encodeURIComponent(key) + '/items?status=' + filter, append ? 24 : Math.max(24, this.regItems.length), offset);
      } catch (error) {
        if (key !== this.regRunKey || filter !== this.regFilter || request !== this._regResultRequest) return false;
        // The directory may have been removed after the result list was fetched.
        await this.regRefreshRuns();
        if (key !== this.regRunKey) return false;
        throw error;
      }
      if (key !== this.regRunKey || filter !== this.regFilter || request !== this._regResultRequest) return false;
      this.regItems = append ? [...this.regItems, ...page.items] : page.items;
      this.regItemsTotal = page.total; this.regApplyTask(page.summary, false); this.regMoreError = '';
      if (this.regRunning) {
        const model = this.regSettings.model_type;
        Object.assign(this.regSettings, this.regDefaults, page.settings);
        if (this._regLoaded && model !== this.regSettings.model_type) this.regRenderControls(true);
      }
      if (!append) await this.regLoadLogs();
      return true;
    } finally {
      if (!append && this._regResultRefresh === request) this._regResultRefresh = 0;
    }
  },
  async regReadRunSettings() {
    if (this.regRunning || this.regBusy || !this.regRunKey) return;
    await this.regAction(async () => {
      const key = this.regRunKey;
      const saved = await this.regRequest('/runs/' + encodeURIComponent(key) + '/settings');
      if (key !== this.regRunKey) return;
      Object.assign(this.regSettings, this.regDefaults, saved.settings);
      if (this._regLoaded) this.regRenderControls(true);
      this.regEdits = saved.overrides; this.regSources = []; this.regPlan = null; this.regPlanConsumed = false;
      this.regChanged(); this.regPlanDirty = false; this.regPreviewDirty = false; this.regTab = 'settings'; this.toast(this.regT('settingsLoaded'));
    });
  },
  regImage(item, variant = 'thumb') { return '/api/regularization/runs/' + encodeURIComponent(this.regRunKey) + '/preview/' + item.index + '?variant=' + variant; },
  async regCopyOutputPath() {
    if (!this.regTask?.output_path) return;
    try { await navigator.clipboard.writeText(this.regTask.output_path); this.toast(this.t('common.copied')); }
    catch (_) { this.toast(this.t('common.failed'), 'error'); }
  },
  regCanNavigateImage(direction) {
    if (!this.regSelected) return false;
    const position = this.regItems.findIndex(item => item.index === this.regSelected.index);
    const candidates = direction > 0 ? this.regItems.slice(position + 1) : this.regItems.slice(0, position);
    return candidates.some(item => ['completed', 'excluded'].includes(item.status)) ||
      (direction > 0 && this.regItems.length < this.regItemsTotal);
  },
  async regNavigateImage(direction) {
    if (this.regBusy || !this.regCanNavigateImage(direction)) return;
    const key = this.regRunKey, selected = this.regSelected;
    await this.regAction(async () => {
      let position = this.regItems.findIndex(item => item.index === selected.index);
      while (key === this.regRunKey && this.regSelected === selected) {
        const candidates = direction > 0 ? this.regItems.slice(position + 1) : this.regItems.slice(0, position).reverse();
        const next = candidates.find(item => ['completed', 'excluded'].includes(item.status));
        if (next) { this.regSelected = next; return; }
        if (direction < 0 || this.regItems.length >= this.regItemsTotal) return;
        const previousCount = this.regItems.length;
        await this.regLoadResults({append: true});
        if (previousCount === this.regItems.length) return;
        position = previousCount - 1;
      }
    });
  },
  regSourceImage(index) { return '/api/regularization/plans/' + this.regPlan?.token + '/preview/' + index + '?variant=thumb'; },
  async regMutate(item, action) {
    if (this.trainingActive || this.regRunning) return;
    if (action === 'regenerate' && !window.confirm(this.regT('replaceHelp'))) return;
    await this.regAction(async () => {
      const result = await this.regRequest('/runs/' + encodeURIComponent(this.regRunKey) + '/items/' + item.index + '/' + action, {});
      if (action === 'regenerate') this.regApplyTask(await this.regRequest('/tasks/' + result.task_id));
      await this.regLoadResults(); this.regSelected = null; this.regPlanDirty = true;
    });
  },
  async regLoadLogs() {
    const request = ++this._regLogRequest;
    const key = this.regRunKey;
    if (!key) { this.regLogs = []; return; }
    const lines = await this.regRequest('/runs/' + encodeURIComponent(key) + '/logs');
    if (key === this.regRunKey && request === this._regLogRequest &&
        (lines.length !== this.regLogs.length || lines.some((line, index) => line !== this.regLogs[index]))) this.regLogs = lines;
  },
  regImportTraining() {
    if (this.regRunning || this.regBusy) return;
    if (!this._regLoaded) {
      try { Object.assign(this.regSettings, JSON.parse(localStorage.getItem('anima-reg-settings') || '{}'), {...this.regSettings}); } catch (_) {}
    }
    let form = this.form;
    if (!form?.model_train_type) {
      try { form = JSON.parse(localStorage.getItem('anima-form-' + this.regTrainRoute) || '{}'); } catch (_) {}
      if (!form?.model_train_type) form = this._buildFormDefaults('anima-lora');
    }
    if (!['anima-lora', 'sdxl-lora'].includes(form.model_train_type)) { this.regReportError(this.regT('onlyAnima')); return; }
    const sdxl = form.model_train_type === 'sdxl-lora';
    Object.assign(this.regSettings, sdxl
      ? {model_type: 'sdxl', source_dir: form.train_data_dir, checkpoint: form.pretrained_model_name_or_path, sdxl_vae: form.vae || ''}
      : {model_type: 'anima', source_dir: form.train_data_dir, dit: form.pretrained_model_name_or_path, text_encoder: form.qwen3, vae: form.vae});
    this.regNormalizeModelSettings();
    if (this._regLoaded) this.regRenderControls(true);
    for (const key of ['resolution', 'enable_bucket', 'bucket_no_upscale', 'min_bucket_reso', 'max_bucket_reso', 'bucket_reso_steps']) {
      if (form[key] !== undefined) this.regSettings[key] = key === 'resolution' ? String(form[key]) : form[key];
    }
    this.regEdits = {}; this.regChanged(); this.toast(this.regT('imported')); this.regError = '';
  },
  openRegularizationFromTraining() {
    this.regTrainRoute = this.currentRoute; this.regImportTraining(); this.regTab = 'settings'; this.navigate('regularization');
  },
  regUseForTraining() {
    if (!this.regTask?.completed || !this.regTask.output_path || this.regRunning) return;
    this.regPendingTrainingPath = this.regTask.output_path;
    this.navigate(this.regTrainRoute);
  },
  regOpenTagEditor() {
    if (this.regRunning || this.trainingActive || !this.regTask?.completed) return;
    this.tagEditorDir = this.regTask.output_path.replace(/[\\/]$/, '') + '/1_reg';
    this.navigate('tagEditor');
  },
  regApplyPendingTrainingPath() {
    if (!this.regPendingTrainingPath) return;
    const path = this.regPendingTrainingPath;
    this.regPendingTrainingPath = '';
    if (!['anima-lora', 'sdxl-lora'].includes(this.form.model_train_type)) { this.regReportError(this.regT('onlyAnima')); return; }
    this.setField('reg_data_dir', path); this.setField('enable_reg_data', true);
    this.scheduleStepEstimate(); this.updateToml();
    if (typeof this.toast === 'function') this.toast(this.regT('applied'), 'success');
  },
};
