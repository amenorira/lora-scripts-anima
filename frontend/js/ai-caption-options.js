/* MOSS directory workflow, using the shared Tagger task/source lifecycle. */
window.captionOptionsMixin = {
  _captionOptionsLoaded: false,
  captionDefaultPrompt: '',
  captionOptions: {
    mode: 'generate', overwrite: false, recursive: true,
    reference_extension: '.tags', caption_extension: '.txt', sidecar_suffix: '_caption.json', separator: '---===---',
    candidates: ['original', 'long', 'medium', 'short'], knowledge: '', knowledge_file: '',
    dir_knowledge_name: '_knowledge.txt', knowledge_suffix: '_knowledge.txt',
    prompt_source: 'default', prompt_text: '', prompt_file: '', verbose: false,
  },
  taggerApiSettings: {
    baseUrl: '', apiKey: '', model: '', protocol: 'chat-completions',
    max_workers: 1, max_image_size: 1536, jpeg_quality: '', max_tokens: 16384,
    temperature: 1, top_p: .95, timeout: 600, max_retries: 3, extra_body: '{}',
  },
  taggerApiModelSuggestions: [],
  taggerApiShowKey: false,
  taggerApiTesting: false,
  taggerApiTestInfo: {state: '', text: ''},

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
        if (!this.captionOptions.reference_extension) this.captionOptions.reference_extension = '.tags';
        if (options.prompt_file) Object.assign(this.captionOptions, {prompt_source:'file', prompt_file:options.prompt_file});
        if (!api.modelSelectionVersion && ['deepseek-v4-flash-vision-exp','gpt-4o-mini','claude-sonnet-4-5','Qwen/Qwen2.5-VL-72B-Instruct','qwen-vl-max'].includes(api.model)) this.taggerApiSettings.model = '';
      }
    } catch (_) {}
  },

  saveCaptionOptions() {
    localStorage.setItem('anima-moss-workflow', JSON.stringify({options:this.captionOptions, api:this.taggerApiSettings}));
    if (this.taggerSourceMode === 'api-folder') localStorage.setItem('anima-ai-source-path', this.taggerSourcePath);
  },

  async loadCaptionTemplate() {
    if (this.captionDefaultPrompt) return;
    try {
      const body = await (await fetch('/api/tagger/api/caption-template')).json();
      if (body.status === 'success') this.captionDefaultPrompt = body.data?.prompt || '';
    } catch (_) {}
  },

  captionOffline() { return this.captionOptions.mode === 'export'; },

  captionSelectedCandidates() {
    return this.captionOptions.candidates.filter(name => name !== 'original' || this.captionOffline() || !!this.captionOptions.reference_extension.trim());
  },

  setCaptionTaskMode(mode) {
    if (mode === this.captionOptions.mode) return;
    this.captionOptions.mode = mode;
    this.captionOptions.overwrite = false;
    this.saveCaptionOptions();
  },

  captionStartHint() {
    if (!this.taggerSource?.total) return this.t('caption.selectDirectory');
    if (!this.captionSelectedCandidates().length) return this.t('caption.chooseCandidate');
    if (this.captionReferenceConflict()) return this.t('caption.referenceConflict');
    if (!this.captionOffline() && !this.captionPromptReady()) return this.t('caption.completePrompt');
    if (!this.captionOffline() && (!this.taggerApiSettings.baseUrl.trim() || !this.taggerApiSettings.model.trim())) return this.t('caption.completeConnection');
    return '';
  },

  captionModeConfig() {
    return {options:['generate','export'].map(v => ({v, l:this.t('caption.task_' + v), d:this.t('caption.task_' + v + 'Help')}))};
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

  captionReferenceConflict() {
    const o = this.captionOptions;
    return !this.captionOffline() && !o.overwrite && !!o.reference_extension.trim()
      && o.reference_extension.replace(/^\.+/, '').toLowerCase() === o.caption_extension.replace(/^\.+/, '').toLowerCase();
  },

  captionCanCheck() {
    return !!(this.taggerSource?.total && !this.captionOffline() && this.captionPromptReady() && this.captionSelectedCandidates().length
      && !this.captionReferenceConflict() && !this.taggerRunning && !this.taggerStarting && !this.taggerScanning);
  },

  taggerApiCanStart() {
    const s = this.taggerApiSettings;
    return !!(this.taggerSource?.total && this.captionSelectedCandidates().length && !this.captionReferenceConflict()
      && (this.captionOffline() || (s.baseUrl.trim() && s.model.trim() && this.captionPromptReady()))
      && !this.regularizationActive && !this.taggerRunning && !this.taggerStarting && !this.taggerScanning);
  },

  taggerApiModelConfig() { return {options:this.taggerApiModelSuggestions.map(v => ({v,l:v}))}; },

  captionProtocolConfig() {
    return {options:[['chat-completions','Chat'],['responses','Responses'],['anthropic','Anthropic']].map(([v,key]) => ({v,l:this.t('tagger.apiProtocol'+key),d:this.t('tagger.apiProtocol'+key+'Desc')}))};
  },

  async testTaggerApiConnection() {
    if (this.taggerApiTesting || !this.taggerApiSettings.baseUrl.trim()) return;
    this.taggerApiTesting = true;
    try {
      const s = this.taggerApiSettings;
      const body = await (await fetch('/api/tagger/api/test', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({base_url:s.baseUrl,api_key:s.apiKey,protocol:s.protocol})})).json();
      if (body.status !== 'success') throw new Error(body.message);
      this.taggerApiModelSuggestions = body.data?.models || [];
      this.taggerApiTestInfo = {state:'ok',text:this.t('tagger.apiTestOk').replace('{count}',String(body.data?.count || 0))};
    } catch (error) { this.taggerApiTestInfo = {state:'fail',text:String(error.message || error)}; }
    finally { this.taggerApiTesting = false; }
  },

  async startApiTagger(dryRun = false) {
    if (dryRun ? !this.captionCanCheck() : !this.taggerApiCanStart()) return;
    this._clearTaggerResultState(true);
    this.taggerStarting = true;
    this.saveCaptionOptions();
    try {
      const s = this.taggerApiSettings;
      const payload = {engine:'api',source_token:this.taggerSource.source_token,
        api:{...s,base_url:s.baseUrl,api_key:s.apiKey},options:{captioning:{...this.captionOptions,candidates:this.captionSelectedCandidates(),dry_run:dryRun}}};
      delete payload.api.baseUrl; delete payload.api.apiKey;
      const body = await (await fetch('/api/tagger/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).json();
      if (body.status !== 'success') throw new Error(body.message);
      this.attachTaggerTask(body.data.task_id);
    } catch (error) { this.toast(error.message, 'error'); }
    finally { this.taggerStarting = false; }
  },

  captionImageFormat() { return this.taggerApiSettings.jpeg_quality === '' ? 'png' : 'jpeg'; },
  captionImageFormatConfig() { return {options:[{v:'png',l:'PNG',d:this.t('caption.imageFormat_png')},{v:'jpeg',l:'JPEG',d:this.t('caption.imageFormat_jpeg')}]}; },
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
      const body = await (await fetch('/api/pick_file?picker_type=text-file')).json();
      if (body.status === 'success' && body.data?.path) { this.captionOptions[key] = body.data.path; this.saveCaptionOptions(); }
    } catch (_) { this.toast(this.t('common.localPickerNA')); }
  },
  captionOutputExample() {
    const o = this.captionOptions;
    return this.captionOffline()
      ? 'image' + o.sidecar_suffix + ' → image' + o.caption_extension
      : 'image.png → image' + o.sidecar_suffix + ' + image' + o.caption_extension;
  },
};
