/* Shared output and file options for the existing AI annotation workflow. */
window.captionOptionsMixin = {
  _captionOptionsLoaded: false,
  captionOptions: {
    mode: 'fill', export_overwrite: true, save_json: true,
    reference_extension: '', caption_extension: '.txt', candidates: ['original', 'long', 'medium', 'short'],
    knowledge: '', knowledge_file: '', dir_knowledge_name: '_knowledge.txt', knowledge_suffix: '_knowledge.txt',
    prompt_file: '', sidecar_suffix: '_caption.json', separator: '---===---',
    max_image_size: 1536, jpeg_quality: '', max_tokens: 1024, temperature: .2, top_p: .95,
    timeout: 600, max_retries: 3, extra_body: '{}',
  },

  loadCaptionOptions() {
    if (this._captionOptionsLoaded) return;
    this._captionOptionsLoaded = true;
    try {
      const saved = JSON.parse(localStorage.getItem('anima-ai-caption-options') || 'null');
      if (saved) this.captionOptions = Object.assign({}, this.captionOptions, saved);
    } catch (_) {}
  },

  saveCaptionOptions() {
    localStorage.setItem('anima-ai-caption-options', JSON.stringify(this.captionOptions));
    if (this.taggerSourceMode === 'api-folder') localStorage.setItem('anima-ai-source-path', this.taggerSourcePath);
  },

  async loadCaptionTemplate() {
    if (this.TAGGER_API_BUILTIN_PROMPT_TEXTS.multi) return;
    try {
      const body = await (await fetch('/api/tagger/api/caption-template')).json();
      if (body.status !== 'success' || !body.data?.prompt) return;
      this.TAGGER_API_BUILTIN_PROMPT_TEXTS.multi = body.data.prompt;
      if (this.taggerApiSettings.promptPresetId === 'multi' && !this.taggerApiSettings.promptText) {
        this.taggerApiSettings.promptText = body.data.prompt;
        this.saveTaggerApiSettings();
      }
    } catch (_) {}
  },

  captionOffline() {
    return this.taggerSourceMode === 'api-folder' && this.captionOptions.mode === 'export';
  },

  applyCaptionFormat(format) {
    this.taggerApiSettings.parseMode = format;
    if (!this.taggerApiPresetIsUser()) {
      this.selectTaggerApiPromptPreset({tags: 'booru', caption: 'caption', 'multi-caption': 'multi'}[format]);
    }
    this.applyCaptionDefaults(format);
    this.saveTaggerApiSettings();
    this.saveCaptionOptions();
  },

  applyCaptionDefaults(format) {
    if (format !== 'multi-caption') return;
    if (Number(this.captionOptions.max_tokens) === 1024) this.captionOptions.max_tokens = 16384;
    if (Number(this.captionOptions.temperature) === .2) this.captionOptions.temperature = 1;
  },

  captionModeConfig() {
    return {options: ['fill', 'regenerate', 'export'].map(v => ({v, l: this.t('moss.mode_' + v), d: this.t('moss.mode_' + v + '_help')}))};
  },

  captionImageFormat() {
    return this.captionOptions.jpeg_quality === '' || this.captionOptions.jpeg_quality == null ? 'png' : 'jpeg';
  },

  captionImageFormatConfig() {
    return {options: ['png', 'jpeg'].map(v => ({v, l: v.toUpperCase(), d: this.t('caption.imageFormat_' + v)}))};
  },

  setCaptionImageFormat(format) {
    this.captionOptions.jpeg_quality = format === 'png' ? '' : (Number(this.captionOptions.jpeg_quality) || 90);
    this.saveCaptionOptions();
  },

  captionCanCheck() {
    return !!(this.taggerSource?.total && this.taggerSourceMode === 'api-folder' && !this.captionOffline()
      && !this.taggerRunning && !this.taggerStarting && !this.taggerApiSingleRunning);
  },

  captionPayload(dryRun = false) {
    return {...this.captionOptions, dry_run: dryRun, mode: this.taggerSourceMode === 'api-single' ? 'regenerate' : this.captionOptions.mode};
  },

  adjustCaptionNumber(key, direction, step, min, max, fallback = min) {
    const raw = this.captionOptions[key];
    const value = raw === '' || raw == null ? fallback : Math.min(max, Math.max(min, Number(raw) + direction * step));
    this.captionOptions[key] = Number(value.toFixed(4));
    this.saveCaptionOptions();
  },

  async pickCaptionPath(key) {
    try {
      const body = await (await fetch('/api/pick_file?picker_type=text-file')).json();
      if (body.status === 'success' && body.data?.path) {
        this.captionOptions[key] = body.data.path;
        this.saveCaptionOptions();
      }
    } catch (_) { this.toast(this.t('common.localPickerNA')); }
  },

  captionOutputExample() {
    const o = this.captionOptions;
    return 'image.png → image.' + String(o.caption_extension).replace(/^\.+/, '') + (!this.captionOffline() && o.save_json ? ' + image' + o.sidecar_suffix : '');
  },
};
