/* MOSS directory workflow, using the shared Tagger task/source lifecycle. */
window.captionFieldDefaults = {
  options: {mode:'generate',overwrite:false,recursive:true,reference_extension:'',caption_extension:'.txt',sidecar_suffix:'_caption.json',separator:'---===---',
    candidates:['original','long','medium','short'],knowledge:'',knowledge_file:'',dir_knowledge_name:'_knowledge.txt',knowledge_suffix:'_knowledge.txt',prompt_source:'default',prompt_text:'',prompt_file:'',verbose:false},
  api: {baseUrl:'',apiKey:'',model:'',protocol:'chat-completions',max_workers:1,max_image_size:1536,jpeg_quality:'',max_tokens:16384,temperature:1,top_p:.95,timeout:600,max_retries:3,extra_body:'{}'},
};
window.captionOptionsMixin = {
  _captionOptionsLoaded: false,
  captionDefaultPrompt: '',
  captionOptions: JSON.parse(JSON.stringify(window.captionFieldDefaults.options)),
  taggerApiSettings: {...window.captionFieldDefaults.api},
  taggerApiModelSuggestions: [],
  taggerApiShowKey: false,
  taggerApiTesting: false,
  taggerApiTestInfo: {state: '', text: ''},
  _taggerApiConnectionFingerprint: '',
  _taggerApiTestRequest: 0,
  _taggerApiTestAbort: null,

  loadCaptionOptions() {
    if (this._captionOptionsLoaded) return;
    this._captionOptionsLoaded = true;
    try {
      const saved = JSON.parse(localStorage.getItem('anima-moss-workflow') || 'null');
      if (saved) {
        for (const key of Object.keys(this.captionOptions)) if (key in (saved.options || {})) this.captionOptions[key] = saved.options[key];
        for (const key of Object.keys(this.taggerApiSettings)) if (key in (saved.api || {})) this.taggerApiSettings[key] = saved.api[key];
      } else {
        // Import useful connection/file settings, without restoring removed AI modes or presets.
        const api = JSON.parse(localStorage.getItem('anima-tagger-api-settings') || '{}');
        const options = JSON.parse(localStorage.getItem('anima-ai-caption-options') || '{}');
        for (const key of ['baseUrl','apiKey','model','protocol']) if (key in api) this.taggerApiSettings[key] = api[key];
        for (const key of ['reference_extension','caption_extension','sidecar_suffix','separator','knowledge','knowledge_file','dir_knowledge_name','knowledge_suffix','candidates']) if (key in options) this.captionOptions[key] = options[key];
        if (options.prompt_file) Object.assign(this.captionOptions, {prompt_source:'file', prompt_file:options.prompt_file});
        if (!api.modelSelectionVersion && ['deepseek-v4-flash-vision-exp','gpt-4o-mini','claude-sonnet-4-5','Qwen/Qwen2.5-VL-72B-Instruct','qwen-vl-max'].includes(api.model)) this.taggerApiSettings.model = '';
      }
    } catch (_) {}
    if (!Array.isArray(this.captionOptions.candidates)) this.captionOptions.candidates = [...window.captionFieldDefaults.options.candidates];
    this.captionOptions.candidates = ['original','long','medium','short'].filter(name => this.captionOptions.candidates.includes(name));
    this._captionInitialFields = JSON.parse(JSON.stringify({options:this.captionOptions,api:this.taggerApiSettings}));
    this.captionOptionsChanged?.({initialize:true});
  },

  captionFieldChanged(scope, key) {
    const values = scope === 'api' ? this.taggerApiSettings : this.captionOptions;
    const value = values[key], original = window.captionFieldDefaults[scope]?.[key];
    return Array.isArray(value) ? JSON.stringify(value) !== JSON.stringify(original) : String(value) !== String(original);
  },

  restoreCaptionField(scope, key, undo = false) {
    const defaults = window.captionFieldDefaults[scope];
    if (!defaults || !Object.hasOwn(defaults,key)) return;
    const value = undo ? this._captionInitialFields?.[scope]?.[key] ?? defaults[key] : defaults[key];
    (scope === 'api' ? this.taggerApiSettings : this.captionOptions)[key] = JSON.parse(JSON.stringify(value));
    if (scope === 'options' && key === 'recursive') this.scheduleTaggerSourceScan();
    this.saveCaptionOptions();
  },

  captionFieldMenu(scope, key) {
    if (!window.captionFieldDefaults[scope] || !Object.hasOwn(window.captionFieldDefaults[scope],key)) return '';
    return `<div class="field-menu-wrap" x-data="actionMenu" x-id="['field-menu']" @keydown="key($event)" @click.outside="close(false)" @pointerenter="hoverEnter($event)" @pointerleave="hoverLeave()" @focusout="focusOut($event)">
      <button type="button" class="btn-menu" x-ref="trigger" :aria-label="t('common.fieldActions')" aria-haspopup="menu" :aria-expanded="open" :aria-controls="$id('field-menu')" @click="toggle()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
      <div class="field-menu-popup" x-ref="menu" x-show="open" :class="{'is-positioned':positioned}" :inert="!open" :id="$id('field-menu')" role="menu" :aria-label="t('common.fieldActions')" x-cloak>
        <button type="button" role="menuitem" tabindex="-1" @click="restoreCaptionField('${scope}','${key}',true);close()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span x-text="t('common.undoField')"></span></button>
        <button type="button" role="menuitem" tabindex="-1" @click="restoreCaptionField('${scope}','${key}');close()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span x-text="t('common.resetField')"></span></button>
      </div></div>`;
  },

  saveCaptionOptions() {
    this.syncTaggerApiConnection();
    localStorage.setItem('anima-moss-workflow', JSON.stringify({options:this.captionOptions, api:this.taggerApiSettings}));
    if (this.taggerSourceMode === 'api-folder') localStorage.setItem('anima-ai-source-path', this.taggerSourcePath);
    this.captionOptionsChanged?.();
  },

  async loadCaptionTemplate() {
    if (this.captionDefaultPrompt) return;
    try {
      const body = await (await fetch('/api/tagger/api/caption-template')).json();
      if (body.status === 'success') this.captionDefaultPrompt = body.data?.prompt || '';
    } catch (_) {}
  },

  captionOffline() { return this.captionOptions.mode === 'export'; },

  captionOverwriteLabel() {
    return this.t('caption.overwrite_' + this.captionOptions.mode);
  },

  captionReferenceExtension(settings = this.captionOptions) {
    return String(settings.reference_extension || '').trim() || '.txt';
  },

  captionSelectedCandidates() {
    return [...this.captionOptions.candidates];
  },

  setCaptionTaskMode(mode) {
    if (mode === this.captionOptions.mode) return;
    this.captionOptions.mode = mode;
    this.captionOptions.overwrite = false;
    this.saveCaptionOptions();
  },

  captionTaskConfig() {
    return {options:['generate','export'].map(v => ({v,l:this.t('caption.task_' + v),d:this.t('caption.task_' + v + 'Help')}))};
  },

  captionImageFormatConfig() {
    return {options:['png','jpeg'].map(v => ({v,l:v.toUpperCase(),d:this.t('caption.imageFormat_' + v)}))};
  },

  captionStartHint() {
    if (!this.taggerSource) return this.captionSourceError ? '' : this.t('caption.selectDirectory');
    if (!this.taggerSource.total) return this.t('caption.noImages');
    if (!this.captionSelectedCandidates().length) return this.t('caption.chooseCandidate');
    if (!this.captionOffline() && !this.captionPromptReady()) return this.t('caption.completePrompt');
    if (!this.captionOffline() && (!this.taggerApiSettings.baseUrl.trim() || !this.taggerApiSettings.model.trim())) return this.t('caption.completeConnection');
    return '';
  },

  captionOutputExample() {
    const extension = String(this.captionOptions.caption_extension || '').trim().replace(/^\.+/, '');
    return this.t(this.captionOffline() ? 'caption.outputExampleExport' : 'caption.outputExampleGenerate')
      .replace('{caption}', 'image.' + extension)
      .replace('{json}', 'image' + this.captionOptions.sidecar_suffix);
  },

  captionErrorMessage(error) {
    const text = String(error?.message || error || this.t('common.failed'));
    const match = text.match(/^HTTP (\d+):\s*(\{[\s\S]*\})$/);
    if (match) {
      try {
        const body = JSON.parse(match[2]), detail = body.error?.message || body.message || body.error;
        if (typeof detail === 'string' && detail.trim()) return this.t('caption.serviceError').replace('{status}',match[1]).replace('{message}',() => detail);
      } catch (_) {}
    }
    const separator = text.indexOf(' / ');
    if (this.locale === 'zh-CN' && !text.startsWith('HTTP ') && separator >= 0 && /[\u3400-\u9fff]/.test(text.slice(separator + 3))) {
      return text.slice(separator + 3);
    }
    return text;
  },

  captionPromptConfig() {
    return {options:['default','text','file'].map(v => ({v,l:this.t('caption.prompt_' + v),d:this.t('caption.prompt_' + v + 'Help')}))};
  },

  setCaptionPromptSource(source) {
    this.captionOptions.prompt_source = source;
    if (source === 'text' && !this.captionOptions.prompt_text) this.captionOptions.prompt_text = this.captionDefaultPrompt;
    this.saveCaptionOptions();
  },

  captionPromptReady() {
    const o = this.captionOptions;
    return o.prompt_source === 'default' || (o.prompt_source === 'text' ? !!o.prompt_text.trim() : !!o.prompt_file.trim());
  },

  captionCanCheck() {
    return !!(this.taggerSourceMode !== 'api-single' && this.taggerSource?.total && (this.captionOffline() || this.captionPromptReady()) && this.captionSelectedCandidates().length
      && !this.captionPlanError && !this.captionPlanLoading && !this._taggerSourceScanTimer && !this.captionPreviewBusy && !this.taggerHasActiveTask() && !this.taggerStarting && !this.taggerScanning);
  },

  taggerApiCanStart() {
    const s = this.taggerApiSettings;
    return !!(this.taggerSource?.total && this.captionSelectedCandidates().length
      && (this.captionOffline() || (s.baseUrl.trim() && s.model.trim() && this.captionPromptReady()))
      && this.taggerSourceMode !== 'api-single' && !this.trainingActive && !this.regularizationActive
      && !this.captionPlanError && !this.captionPlanLoading && !this._taggerSourceScanTimer && !this.captionPreviewBusy && !this.taggerHasActiveTask() && !this.taggerStarting && !this.taggerScanning);
  },

  captionProtocolConfig() {
    return {options:[['chat-completions','Chat'],['responses','Responses'],['anthropic','Anthropic']].map(([v,key]) => ({v,l:this.t('tagger.apiProtocol'+key),d:this.t('tagger.apiProtocol'+key+'Desc')}))};
  },

  taggerApiModelConfig() { return {options:this.taggerApiModelSuggestions.map(v => ({v,l:v}))}; },

  taggerApiConnectionFingerprint() {
    const s = this.taggerApiSettings;
    return JSON.stringify([s.baseUrl, s.apiKey, s.protocol]);
  },

  syncTaggerApiConnection() {
    const fingerprint = this.taggerApiConnectionFingerprint();
    if (fingerprint === this._taggerApiConnectionFingerprint) return;
    this._taggerApiConnectionFingerprint = fingerprint;
    this.resetTaggerApiTest();
  },

  resetTaggerApiTest() {
    ++this._taggerApiTestRequest;
    this._taggerApiTestAbort?.abort();
    this._taggerApiTestAbort = null;
    this.taggerApiTesting = false;
    this.taggerApiTestInfo = {state:'',text:''};
    this.taggerApiModelSuggestions = [];
  },

  async testTaggerApiConnection() {
    this.syncTaggerApiConnection();
    if (this.taggerApiTesting || !this.taggerApiSettings.baseUrl.trim()) return;
    this.resetTaggerApiTest();
    const request = this._taggerApiTestRequest;
    const fingerprint = this.taggerApiConnectionFingerprint(), route = this.currentRoute;
    const controller = new AbortController();
    this._taggerApiTestAbort = controller;
    const stillCurrent = () => request === this._taggerApiTestRequest
      && fingerprint === this.taggerApiConnectionFingerprint() && route === this.currentRoute;
    this.taggerApiTesting = true;
    try {
      const s = this.taggerApiSettings;
      const body = await (await fetch('/api/tagger/api/test', {method:'POST', headers:{'Content-Type':'application/json'}, signal:controller.signal, body:JSON.stringify({base_url:s.baseUrl,api_key:s.apiKey,protocol:s.protocol})})).json();
      if (!stillCurrent()) return;
      if (body.status !== 'success') throw new Error(body.message);
      this.taggerApiModelSuggestions = body.data?.models || [];
      this.taggerApiTestInfo = {state:'ok',text:this.t('tagger.apiTestOk').replace('{count}',String(body.data?.count || 0))};
    } catch (error) {
      if (stillCurrent()) this.taggerApiTestInfo = {state:'fail',text:this.captionErrorMessage(error)};
    } finally {
      if (request === this._taggerApiTestRequest) {
        this.taggerApiTesting = false;
        this._taggerApiTestAbort = null;
      }
    }
  },

  async startApiTagger(dryRun = false, approval = '') {
    if (dryRun ? !this.captionCanCheck() : !this.taggerApiCanStart()) return;
    const route = this.currentRoute, mode = this.taggerSourceMode;
    const source = this.taggerSource, token = source.source_token;
    const options = {...this.captionOptions,candidates:[...this.captionOptions.candidates]};
    const api = this.captionApiPayload(), candidates = this.captionSelectedCandidates();
    const settings = JSON.stringify([options,api]);
    const stillCurrent = () => this.currentRoute === route && this.taggerSourceMode === mode
      && this.taggerSource?.source_token === token
      && JSON.stringify([this.captionOptions,this.captionApiPayload()]) === settings;
    this.taggerStarting = true;
    this.saveCaptionOptions();
    try {
      clearTimeout(this._captionRefreshTimer);
      const data = await this.refreshCaptionPlan({source,options});
      // Navigation can replace the shared Tagger source while planning is in flight.
      if (!stillCurrent()) return;
      if (!data) throw new Error(this.captionPlanError || this.t('common.failed'));
      const plan = data.plan;
      const signature = JSON.stringify([token,options,plan]);
      if (!dryRun && plan && (plan.overwrite_captions || plan.overwrite_json || plan.overwrite_references) && signature !== approval) {
        const message = this.t(this.captionOffline() ? 'caption.exportOverwriteConfirm' : 'caption.overwriteConfirm').replace('{captions}',plan.overwrite_captions).replace('{json}',plan.overwrite_json).replace('{references}',plan.overwrite_references);
        this.openConfirm(this.t('caption.confirmOverwriteFiles'),message,() => {
          if (stillCurrent()) return this.startApiTagger(false,signature);
        },this.t('caption.continueOverwrite'),{danger:true});
        return;
      }
      this._clearTaggerResultState(true);
      const payload = {engine:'api',source_token:token,
        api,options:{captioning:{...options,candidates,dry_run:dryRun}}};
      const body = await (await fetch('/api/tagger/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).json();
      if (body.status !== 'success') throw new Error(body.message);
      this.attachTaggerTask(body.data.task_id, mode);
    } catch (error) { this.toast(error.message, 'error'); }
    finally { this.taggerStarting = false; }
  },

  captionImageFormat() { return this.taggerApiSettings.jpeg_quality === '' ? 'png' : 'jpeg'; },
  setCaptionImageFormat(format) {
    this.taggerApiSettings.jpeg_quality = format === 'png' ? '' : (Number(this.taggerApiSettings.jpeg_quality) || 90);
    this.saveCaptionOptions();
  },
  adjustCaptionNumber(key, direction, step, min, max) {
    this.taggerApiSettings[key] = Number(Math.min(max,Math.max(min,Number(this.taggerApiSettings[key]) + direction * step)).toFixed(4));
    this.saveCaptionOptions();
  },
  async pickCaptionPath(key) {
    try {
      const body = await (await fetch(this.nativePickerUrl('text-file'))).json();
      if (body.status === 'success' && body.data?.path) { this.captionOptions[key] = body.data.path; this.saveCaptionOptions(); }
    } catch (_) { this.toast(this.t('common.localPickerNA')); }
  },
};
