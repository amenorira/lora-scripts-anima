/* Navigation, read-only overview and synchronous MOSS preview. Sources/media remain in tagger.js. */
window.captionWorkspaceMixin = {
  captionTab: 'batch',
  captionPreviewStatus: 'idle',
  get captionPreviewBusy() { return this.captionPreviewStatus !== 'idle'; },
  get captionPreviewCancelling() { return this.captionPreviewStatus === 'cancelling'; },
  captionPreviewRequestId: '',
  captionPreviewError: '',
  captionSingleResult: null,
  captionExternalTaggerBusy: false,
  captionOverviewItems: [],
  captionOverviewCounts: {},
  captionOverviewPlan: null,
  captionPlanError: '',
  captionPlanLoading: false,
  _captionPlanSourcePath: '',
  captionOverviewSettings: null,
  captionOverviewTotal: 0,
  captionOverviewOffset: 0,
  captionOverviewFilter: 'all',
  captionOverviewQuery: '',
  captionOverviewLoading: false,
  captionOverviewError: '',
  captionSourceError: '',
  captionOverviewDetail: null,
  captionDetailLoading: false,
  captionDetailError: '',
  captionGridDensity: 'comfortable',
  captionLastReviewedPath: '',
  captionDetailView: 'caption',
  captionReviewImageOnly: false,
  captionPromptOpen: false,
  captionCheckPrompt: '',
  captionCheckPromptPath: '',
  _captionOverviewRequest: 0,
  _captionOverviewInFlight: false,
  _captionDetailRequest: 0,
  _captionOptionsFingerprint: '',
  _captionPlanRequest: 0,
  _captionPromptRequest: 0,
  _captionDetailFocus: null,

  captionBatchState() {
    const state = this.taggerSourceMode === 'api-folder'
      ? {source:this.taggerSource,sourcePath:this.taggerSourcePath,taskId:this.taggerTaskId}
      : this._taggerModeStates['api-folder'] || {};
    return {...state,task:this.taggerTaskById(state.taskId)};
  },
  captionBatchRunning() {
    return this.taggerTaskActive(this.captionBatchState().taskId);
  },
  async initCaptionWorkspace(isCurrent = () => this.currentRoute === 'ai-captioning') {
    await this.syncCaptionPreviewState(isCurrent);
    if (!isCurrent()) return;
    const tab = ['batch','single','overview'].includes(this.captionTab) ? this.captionTab : 'batch';
    await this.selectCaptionTab(tab, false);
    if (!isCurrent()) return;
    if (this.taggerSourceMode === 'api-folder' && !this.taggerSourcePath) {
      this.taggerSourcePath = localStorage.getItem('anima-ai-source-path') || '';
      if (this.taggerSourcePath) await this.scanTaggerSource({quiet:true});
    }
    if (isCurrent() && this.captionBatchState().source) void this.refreshCaptionPlan();
  },
  stopCaptionWorkspace() {
    clearTimeout(this._captionRefreshTimer);
    clearTimeout(this._captionBusyTimer);
    ++this._captionOverviewRequest;
    ++this._captionPlanRequest;
    ++this._captionPromptRequest;
    this._captionOverviewInFlight = false;
    this.captionOverviewLoading = false;
    this.captionPlanLoading = false;
    ++this._captionDetailRequest;
    this.closeCaptionDetail();
    this.captionPromptOpen = false;
    if (this.captionPreviewBusy && !this.captionPreviewCancelling) void this.cancelCaptionPreview();
  },
  async selectCaptionTab(tab, focus = true) {
    if (!['batch','single','overview'].includes(tab) || this.captionPreviewBusy || this.taggerStarting || this.taggerScanning) return;
    const changed = tab !== this.captionTab;
    if (changed) ++this._captionPromptRequest;
    const mode = tab === 'single' ? 'api-single' : 'api-folder';
    await this.selectTaggerSourceMode(mode, {allowActive:true});
    this.captionTab = tab;
    localStorage.setItem('anima-ai-tab', tab);
    if (changed || focus) this.closeCaptionDetail();
    if (tab === 'overview') void this.refreshCaptionOverview();
    if (tab === 'single') void this.syncCaptionPreviewState();
    if (focus) this.$nextTick?.(() => document.getElementById('caption-tab-' + tab)?.focus());
  },
  captionTabKey(event) {
    const tabs = ['batch','single','overview'];
    let i = tabs.indexOf(this.captionTab);
    if (event.key === 'ArrowRight') i = (i + 1) % 3;
    else if (event.key === 'ArrowLeft') i = (i + 2) % 3;
    else if (event.key === 'Home') i = 0;
    else if (event.key === 'End') i = 2;
    else return;
    event.preventDefault();
    void this.selectCaptionTab(tabs[i]);
  },
  captionSourceChanged(mode) {
    if (mode === 'api-single') { this.captionSingleResult = null; this.captionPreviewError = ''; }
    if (mode !== 'api-folder') return;
    this.captionSourceError = '';
    ++this._captionPlanRequest;
    this.captionPlanLoading = false;
    ++this._captionPromptRequest;
    this.captionOverviewOffset = 0;
    this.captionCheckPrompt = '';
    this.captionPromptOpen = false;
    this.captionOverviewItems = [];
    this.captionOverviewTotal = 0;
    this.captionLastReviewedPath = '';
    const batch = this.captionBatchState();
    if (!batch.source || batch.source.path !== this._captionPlanSourcePath) {
      this.captionOverviewCounts = batch.source || {};
      this.captionOverviewPlan = null;
    }
    this.captionPlanError = '';
    this.captionOverviewSettings = null;
    this.captionOverviewError = '';
    if (this.captionOverviewFilter === 'failed' && !batch.taskId) this.captionOverviewFilter = 'all';
    this.closeCaptionDetail();
    if (mode === this.taggerSourceMode) localStorage.setItem('anima-ai-source-path', batch.sourcePath || '');
    if (batch.source) void this.refreshCaptionPlan();
  },
  captionOptionsChanged({initialize = false} = {}) {
    const o = this.captionOptions;
    const outputFingerprint = JSON.stringify([o.caption_extension,o.reference_extension,o.sidecar_suffix,o.separator]);
    const fingerprint = JSON.stringify([outputFingerprint,o.mode,o.overwrite,o.knowledge_file,
      o.prompt_source === 'file' ? o.prompt_file : '',o.dir_knowledge_name,o.knowledge_suffix]);
    const promptFingerprint = JSON.stringify([o.knowledge,o.knowledge_file,o.dir_knowledge_name,o.knowledge_suffix,
      o.prompt_source,o.prompt_text,o.prompt_file,o.reference_extension]);
    const planChanged = fingerprint !== this._captionOptionsFingerprint;
    const outputChanged = outputFingerprint !== this._captionOutputFingerprint;
    const promptChanged = promptFingerprint !== this._captionPromptFingerprint;
    this._captionOptionsFingerprint = fingerprint;
    this._captionOutputFingerprint = outputFingerprint;
    this._captionPromptFingerprint = promptFingerprint;
    if (initialize) return;
    if (promptChanged || planChanged) {
      ++this._captionPromptRequest;
      this.captionCheckPrompt = '';
      this.captionPromptOpen = false;
    }
    if (!planChanged && !outputChanged) return;
    ++this._captionPlanRequest;
    this.captionPlanError = '';
    if (outputChanged) {
      ++this._captionOverviewRequest;
      this.captionOverviewLoading = false;
      this._captionOverviewInFlight = false;
      this.closeCaptionDetail();
    }
    if (!this.taggerStarting && !this.taggerScanning && !this._taggerSourceScanTimer && this.captionBatchState().source) {
      this.captionPlanLoading = true;
      clearTimeout(this._captionRefreshTimer);
      this._captionRefreshTimer = setTimeout(() => {
        void this.refreshCaptionPlan();
        if (outputChanged && this.captionTab === 'overview') void this.refreshCaptionOverview();
      }, 250);
    }
  },
  captionCandidateRows(single = false) {
    return ['original','long','medium','short']
      .filter(n => n !== 'original' || !single);
  },
  toggleCaptionCandidate(name, enabled) {
    const names = this.captionOptions.candidates.filter(n => n !== name);
    if (enabled) names.push(name);
    this.captionOptions.candidates = ['original','long','medium','short'].filter(n => names.includes(n));
    this.saveCaptionOptions();
  },
  captionPrecheckStale() {
    const saved = this.captionBatchState().task?.caption_options;
    const hasDescription = options => options.candidates?.some(name => name !== 'original');
    return !!(saved?.dry_run && (hasDescription(saved) !== hasDescription(this.captionOptions) || Object.keys(this.captionOptions).some(key => !['dry_run','verbose','candidates'].includes(key) && (key === 'reference_extension'
      ? this.captionReferenceExtension() !== this.captionReferenceExtension(saved)
      : JSON.stringify(this.captionOptions[key]) !== JSON.stringify(saved[key])))));
  },
  captionApiPayload() {
    const {baseUrl,apiKey,...settings} = this.taggerApiSettings;
    return {...settings,base_url:baseUrl,api_key:apiKey};
  },
  captionPreviewCanStart() {
    return !!(this.taggerSourceMode === 'api-single' && this.taggerSource?.total === 1 && this.captionPromptReady()
      && this.captionOptions.candidates.some(n => n !== 'original') && this.taggerApiSettings.baseUrl.trim() && this.taggerApiSettings.model.trim()
      && !this.captionPreviewBusy && !this.taggerHasActiveTask() && !this.captionExternalTaggerBusy && !this.taggerScanning);
  },
  captionPreviewStartHint() {
    if (!this.captionOptions.candidates.some(name => name !== 'original')) return this.t('caption.chooseDescription');
    if (!this.captionPromptReady()) return this.t('caption.completePrompt');
    if (!this.taggerApiSettings.baseUrl.trim() || !this.taggerApiSettings.model.trim()) return this.t('caption.completeConnection');
    return '';
  },
  async syncCaptionPreviewState(isCurrent = () => true) {
    try {
      const body = await (await fetch('/api/tagger/caption/preview-state')).json();
      if (!isCurrent() || body.status !== 'success') return;
      this.captionExternalTaggerBusy = !!body.data.tagger_busy;
      clearTimeout(this._captionBusyTimer);
      if (body.data.tagger_busy && !body.data.active && this.currentRoute === 'ai-captioning' && this.captionTab === 'single') {
        this._captionBusyTimer = setTimeout(() => void this.syncCaptionPreviewState(),1000);
      }
      if (body.data.active && !this.captionPreviewBusy) {
        this.captionPreviewStatus = body.data.phase;
        this.captionPreviewRequestId = body.data.request_id;
        void this.waitCaptionPreviewSettled();
      }
    } catch (_) {}
  },
  async waitCaptionPreviewSettled() {
    const id = this.captionPreviewRequestId;
    // A lost network connection cannot prove the server released its gate.
    while (id === this.captionPreviewRequestId && this.captionPreviewBusy) {
      try {
        const body = await (await fetch('/api/tagger/caption/preview-state')).json();
        if (body.status === 'success' && (!body.data.active || body.data.request_id !== id)) {
          this.captionPreviewStatus = 'idle';
          this.captionExternalTaggerBusy = !!body.data.tagger_busy;
          break;
        }
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  },
  async startCaptionPreview() {
    if (this.currentRoute !== 'ai-captioning' || this.taggerSourceMode !== 'api-single' || !this.taggerSource) return;
    const source = this.taggerSource.source_token, version = this._taggerFormVersion;
    const options = {...this.captionOptions,candidates:[...this.captionOptions.candidates]};
    const api = this.captionApiPayload(), settings = JSON.stringify([options,api]);
    const isCurrent = () => this.currentRoute === 'ai-captioning' && version === this._taggerFormVersion
      && this.taggerSourceMode === 'api-single' && this.taggerSource?.source_token === source
      && JSON.stringify([this.captionOptions,this.captionApiPayload()]) === settings;
    await this.syncCaptionPreviewState(isCurrent);
    if (!isCurrent() || !this.captionPreviewCanStart()) return;
    const id = 'caption-' + crypto.randomUUID();
    this.captionPreviewRequestId = id;
    this.captionPreviewStatus = 'preparing';
    this.captionSingleResult = null;
    this.captionPreviewError = '';
    this.saveCaptionOptions();
    try {
      const body = await (await fetch('/api/tagger/caption/preview', {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_token:source,index:0,request_id:id,api,captioning:options})})).json();
      if (isCurrent() && !this.captionPreviewCancelling) {
        if (body.status !== 'success') throw new Error(body.message);
        this.captionSingleResult = body.data;
      }
    } catch (error) {
      if (isCurrent() && !this.captionPreviewCancelling) this.captionPreviewError = this.captionErrorMessage(error);
    } finally {
      // A failed HTTP response cannot establish whether the worker released its gate.
      await this.waitCaptionPreviewSettled();
    }
  },
  async cancelCaptionPreview() {
    if (!this.captionPreviewBusy || this.captionPreviewCancelling) return;
    const id = this.captionPreviewRequestId;
    this.captionPreviewStatus = 'cancelling';
    // The cancel HTTP request can reach the server before the preview POST.
    // Retry until acknowledged or the original request has actually settled.
    while (id === this.captionPreviewRequestId && this.captionPreviewBusy) {
      try {
        const body = await (await fetch('/api/tagger/caption/preview-cancel', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:id})})).json();
        if (body.data?.cancelling) return;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  },
  captionOutputParams(settings = this.captionOptions) {
    return new URLSearchParams(Object.fromEntries(['caption_extension','reference_extension','sidecar_suffix','separator'].map(key => [key,settings[key]])));
  },
  captionAnnotationParams({refresh=false} = {}) {
    const params = this.captionOutputParams();
    for (const [key,value] of Object.entries({offset:this.captionOverviewOffset,limit:60,status:this.captionOverviewFilter,q:this.captionOverviewQuery,
      refresh,task_id:this.captionBatchState().taskId || ''})) params.set(key,String(value));
    return params;
  },
  async refreshCaptionPlan({source = this.captionBatchState().source, options = this.captionOptions} = {}) {
    if (!source?.source_token) return null;
    const token = source.source_token, request = ++this._captionPlanRequest;
    this.captionPlanLoading = true;
    this.captionPlanError = '';
    try {
      const body = await (await fetch(`/api/tagger/source/${encodeURIComponent(token)}/caption-plan`, {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(options)})).json();
      if (request !== this._captionPlanRequest || token !== this.captionBatchState().source?.source_token) return null;
      if (body.status !== 'success') throw new Error(body.message);
      if (JSON.stringify(this.captionOverviewPlan) !== JSON.stringify(body.data.plan)) this.captionOverviewPlan = body.data.plan;
      this._captionPlanSourcePath = source.path;
      this.captionOverviewCounts = body.data.counts;
      source.total = body.data.counts.total;
      return body.data;
    } catch (error) {
      if (request === this._captionPlanRequest && token === this.captionBatchState().source?.source_token) {
        this.captionOverviewPlan = null;
        this.captionPlanError = error.message || String(error);
      }
      return null;
    } finally {
      if (request === this._captionPlanRequest) this.captionPlanLoading = false;
    }
  },
  async refreshCaptionOverview(options = {}) {
    const source = this.captionBatchState().source;
    if (!source?.source_token) return null;
    const token = source.source_token, request = ++this._captionOverviewRequest;
    this._captionOverviewInFlight = true;
    if (!options.silent) this.captionOverviewLoading = true;
    this.captionOverviewError = '';
    try {
      const body = await (await fetch(`/api/tagger/source/${encodeURIComponent(token)}/annotations?${this.captionAnnotationParams(options)}`)).json();
      if (request !== this._captionOverviewRequest || token !== this.captionBatchState().source?.source_token) return null;
      if (body.status !== 'success') throw new Error(body.message);
      const data = body.data;
      this.captionOverviewCounts = data.counts;
      source.total = data.counts.total;
      this.captionOverviewSettings = data.settings;
      this.captionOverviewItems = data.items || [];
      this.captionOverviewTotal = data.total;
      this.captionOverviewOffset = data.offset;
      return data;
    } catch (error) {
      if (request === this._captionOverviewRequest) this.captionOverviewError = error.message || String(error);
      return null;
    } finally {
      if (request === this._captionOverviewRequest) {
        this.captionOverviewLoading = false;
        this._captionOverviewInFlight = false;
      }
    }
  },
  async rescanCaptionOverview() {
    if (this.currentRoute !== 'ai-captioning' || this.taggerSourceMode !== 'api-folder' || this.captionOverviewLoading) return;
    this.closeCaptionDetail();
    const batch = this.captionBatchState(), version = this._taggerFormVersion, tab = this.captionTab;
    const isCurrent = () => this.currentRoute === 'ai-captioning' && version === this._taggerFormVersion
      && this.taggerSourceMode === 'api-folder' && this.captionTab === tab;
    const sameSource = () => this.captionBatchState().source?.source_token === batch.source?.source_token
      && this.captionBatchState().sourcePath === batch.sourcePath;
    if (batch.source) {
      const pending = this.refreshCaptionOverview({refresh:true}), request = this._captionOverviewRequest;
      const result = await pending;
      // A discarded response is not a reason to recover an expired source.
      if (!isCurrent() || !sameSource() || request !== this._captionOverviewRequest) return;
      if (result) { void this.refreshCaptionPlan(); return; }
    }
    if (isCurrent() && sameSource() && !this.captionBatchRunning() && batch.sourcePath) {
      await this.scanTaggerSource();
      if (isCurrent()) await this.refreshCaptionOverview();
    }
  },
  setCaptionOverviewFilter(filter) {
    this.captionOverviewFilter = filter;
    this.captionOverviewOffset = 0;
    this.closeCaptionDetail();
    void this.refreshCaptionOverview();
  },
  resetCaptionOverviewFilters() {
    this.captionOverviewQuery = '';
    this.setCaptionOverviewFilter('all');
  },
  captionEditorAvailable() {
    const source = this.captionBatchState().source;
    const settings = this.captionOverviewSettings || this.captionOptions;
    return source?.kind === 'folder' && String(settings.caption_extension || '').trim().replace(/^\.+/,'').toLowerCase() === 'txt';
  },
  openCaptionEditor(item = null) {
    if (!this.captionEditorAvailable() || this.captionBatchRunning()) return;
    this.tagEditorDetailView = 'text';
    this.tagEditorOpenPath = item?.path || '';
    this.tagEditorSearchQuery = item ? item.relative || item.name : '';
    this.tagEditorUseRegex = false;
    this.tagEditorQuickFilter = 'all';
    this.tagEditorTagSearch = '';
    this.tagEditorTagSelection = [];
    this.tagEditorExcludedTags = [];
    this.closeCaptionDetail();
    this.openTaggerDatasetInEditor();
  },
  captionSourceName() {
    return (this.captionBatchState().source?.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  },
  captionFilterCount(filter) {
    if (filter === 'all') return this.captionBatchState().source?.total || 0;
    if (filter === 'failed') return this.captionBatchState().task?.failed || 0;
    return this.captionOverviewCounts[{missing:'missing_outputs',missing_json:'missing_json',invalid_json:'invalid_json',ordinary:'ordinary_outputs'}[filter]] || 0;
  },
  captionOverviewSummary() {
    if (this.captionOverviewTotal > 60) return this.t('caption.pageRange')
      .replace('{start}',this.captionOverviewOffset + 1).replace('{end}',Math.min(this.captionOverviewTotal,this.captionOverviewOffset + 60)).replace('{total}',this.captionOverviewTotal);
    if (this.captionOverviewQuery || this.captionOverviewFilter !== 'all') return this.t('caption.filteredCount')
      .replace('{count}',this.captionOverviewTotal).replace('{total}',this.captionBatchState().source?.total || 0);
    return this.t('caption.imageCount').replace('{count}',this.captionOverviewTotal);
  },
  captionItemTone(item) {
    if (item.read_error || item.sidecar_error || item.caption_kind === 'unreadable' || item.task?.status === 'failed') return 'danger';
    if (item.caption_kind === 'missing') return 'warning';
    return 'running';
  },
  captionItemStatus(item) {
    if (item.read_error || item.caption_kind === 'unreadable') return this.t('caption.kind_unreadable');
    if (item.sidecar_error) return this.t('caption.invalidRecord');
    if (item.task?.status === 'failed' || item.task?.status === 'running') return this.t('caption.state_' + item.task.status);
    if (item.caption_kind === 'missing') return this.t('caption.kind_missing');
    return '';
  },
  captionGridKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const items = [...event.currentTarget.querySelectorAll('.caption-overview-item')];
    const index = items.indexOf(event.target.closest('.caption-overview-item'));
    if (index < 0 || this.captionOverviewLoading) return;
    const columns = Math.max(1,getComputedStyle(event.currentTarget).gridTemplateColumns.split(' ').length);
    const delta = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-columns,ArrowDown:columns}[event.key];
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : delta ? Math.max(0,Math.min(items.length - 1,index + delta)) : -1;
    if (target >= 0) { event.preventDefault(); items[target]?.focus({preventScroll:true}); items[target]?.scrollIntoView({block:'nearest'}); }
  },
  captionOverviewSearch() {
    this.captionOverviewOffset = 0;
    this.closeCaptionDetail();
    void this.refreshCaptionOverview();
  },
  captionOverviewPage(delta) {
    this.captionOverviewOffset = Math.max(0,this.captionOverviewOffset + delta * 60);
    this.closeCaptionDetail();
    void this.refreshCaptionOverview();
    document.querySelector('.caption-overview-grid')?.scrollTo({top:0});
  },
  captionTaskUpdated(data, previous, terminal) {
    if (this.currentRoute !== 'ai-captioning') return;
    if (terminal && previous?.status !== data.status) {
      this.captionCheckPrompt = '';
      void this.refreshCaptionPlan();
      if (this.captionTab === 'overview') void this.refreshCaptionOverview({silent:true});
    } else if (this.captionTab === 'overview' && !this._captionOverviewInFlight && Date.now() - (this._captionLiveRefresh || 0) > 1200) {
      this._captionLiveRefresh = Date.now();
      void this.refreshCaptionOverview({silent:true});
    }
  },
  captionDetailPosition() {
    const index = this.captionOverviewItems.findIndex(item => item.path === this.captionOverviewDetail?.path);
    return index < 0 ? '' : `${this.captionOverviewOffset + index + 1} / ${this.captionOverviewTotal}`;
  },
  captionDetailNeighbors() {
    const index = this.captionOverviewItems.findIndex(item => item.path === this.captionOverviewDetail?.path);
    const start = Math.max(0,Math.min(index - 3,this.captionOverviewItems.length - 7));
    return this.captionOverviewItems.slice(start,start + 7);
  },
  captionCanNavigateDetail(delta) {
    const index = this.captionOverviewItems.findIndex(item => item.path === this.captionOverviewDetail?.path);
    return !!this.captionOverviewDetail && !this.captionDetailLoading && !this.captionOverviewLoading
      && index >= 0 && this.captionOverviewOffset + index + delta >= 0
      && this.captionOverviewOffset + index + delta < this.captionOverviewTotal;
  },
  async navigateCaptionDetail(delta) {
    if (!this.captionCanNavigateDetail(delta)) return;
    const index = this.captionOverviewItems.findIndex(item => item.path === this.captionOverviewDetail.path);
    let target = index + delta;
    if (target < 0 || target >= this.captionOverviewItems.length) {
      const request = this._captionDetailRequest, offset = this.captionOverviewOffset;
      this.captionOverviewOffset = Math.max(0, offset + delta * 60);
      const result = await this.refreshCaptionOverview();
      if (request !== this._captionDetailRequest || !this.captionOverviewDetail) return;
      if (!result) { this.captionOverviewOffset = offset; return; }
      target = delta > 0 ? 0 : this.captionOverviewItems.length - 1;
    }
    const item = this.captionOverviewItems[target];
    if (item) await this.openCaptionDetail(item, null);
  },
  async openCaptionDetail(item, element) {
    const source = this.captionBatchState().source, request = ++this._captionDetailRequest;
    if (!source) return;
    if (element) this._captionDetailFocus = element;
    if (!this.captionOverviewDetail) { this.captionDetailView = 'caption'; this.captionReviewImageOnly = false; }
    this.captionLastReviewedPath = item.path;
    this.captionOverviewDetail = {index:item.index,name:item.name,path:item.path,image_version:item.image_version};
    this.captionDetailLoading = true;
    this.captionDetailError = '';
    try {
      const body = await (await fetch(`/api/tagger/source/${encodeURIComponent(source.source_token)}/annotations/${item.index}?${this.captionOutputParams(this.captionOverviewSettings || this.captionOptions)}`)).json();
      if (request !== this._captionDetailRequest) return;
      if (body.status !== 'success') throw new Error(body.message);
      this.captionOverviewDetail = body.data;
    } catch (error) { if (request === this._captionDetailRequest) this.captionDetailError = error.message || String(error); }
    finally { if (request === this._captionDetailRequest) this.captionDetailLoading = false; }
  },
  closeCaptionDetail() {
    ++this._captionDetailRequest;
    const path = this.captionOverviewDetail?.path;
    const wasOpen = !!this.captionOverviewDetail;
    this.captionOverviewDetail = null;
    this.captionDetailLoading = false;
    if (wasOpen && this._captionDetailFocus?.isConnected !== false) this._captionDetailFocus?.focus?.({preventScroll:true});
    else if (wasOpen) this.$nextTick?.(() => {
      const index = this.captionOverviewItems.findIndex(item => item.path === path);
      const target = document.querySelectorAll?.('.caption-overview-item')?.[index];
      target?.focus({preventScroll:true});
      target?.scrollIntoView?.({block:'nearest'});
    });
    this._captionDetailFocus = null;
  },
  captionDetailKey(event) {
    if (['ArrowLeft','ArrowRight'].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey
      && !event.target?.closest?.('input,textarea,select,[contenteditable="true"],.caption-candidate-tabs,.caption-review-sections')) {
      const delta = event.key === 'ArrowLeft' ? -1 : 1;
      if (this.captionCanNavigateDetail(delta)) { event.preventDefault(); void this.navigateCaptionDetail(delta); }
      return;
    }
  },
  captionReviewTabKey(event) {
    const views = ['caption','context','record'];
    let index = views.indexOf(this.captionDetailView);
    if (event.key === 'ArrowRight') index = (index + 1) % views.length;
    else if (event.key === 'ArrowLeft') index = (index + views.length - 1) % views.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = views.length - 1;
    else return;
    event.preventDefault();
    this.captionDetailView = views[index];
    this.$nextTick?.(() => document.getElementById('caption-review-tab-' + this.captionDetailView)?.focus({preventScroll:true}));
  },
  captionOverviewImage(index, variant = 'thumb') {
    const source = this.captionBatchState().source;
    if (!source) return '';
    const item = this.captionOverviewItems.find(item => item.index === index) || this.captionOverviewDetail;
    return '/api/image-preview?' + new URLSearchParams({scope:'tagger',source_token:source.source_token,index:String(index),variant,
      identity:item?.path || '',version:item?.image_version || ''});
  },
  async showCaptionCheckPrompt() {
    const batch = this.captionBatchState();
    if (this.currentRoute !== 'ai-captioning' || !batch.taskId) return;
    const request = ++this._captionPromptRequest, version = this._taggerFormVersion;
    const mode = this.taggerSourceMode, tab = this.captionTab, token = batch.source?.source_token;
    const isCurrent = () => {
      const current = this.captionBatchState();
      return request === this._captionPromptRequest && version === this._taggerFormVersion
        && this.currentRoute === 'ai-captioning' && this.taggerSourceMode === mode && this.captionTab === tab
        && current.taskId === batch.taskId && current.source?.source_token === token && current.sourcePath === batch.sourcePath;
    };
    try {
      const body = await (await fetch(`/api/tagger/tasks/${encodeURIComponent(batch.taskId)}/check-prompt`)).json();
      if (!isCurrent()) return;
      if (body.status !== 'success') throw new Error(body.message);
      this.captionCheckPrompt = body.data.prompt;
      this.captionCheckPromptPath = body.data.path;
      this.captionPromptOpen = true;
    } catch (error) { if (isCurrent()) this.toast(error.message,'error'); }
  },
  showCaptionDefaultPrompt() {
    this.captionCheckPromptPath = '';
    this.captionCheckPrompt = this.captionDefaultPrompt;
    this.captionPromptOpen = true;
  },
};

// Candidate selection and clipboard handling are shared by preview and detail.
window.captionCandidateViewer = read => ({
  candidate: '',
  _captionRevealFrame: null,
  destroy() { window.cancelAnimationFrame(this._captionRevealFrame); },
  captionViewerNames() { return ['original','long','medium','short'].filter(name => Object.hasOwn(read()?.candidates || {},name)); },
  captionViewerText() {
    const data = read();
    const names = this.captionViewerNames();
    return data?.candidates?.[names.includes(this.candidate) ? this.candidate : names[0]] || data?.text || '';
  },
  captionViewerReveal(element) {
    element.scrollTop = 0;
    window.cancelAnimationFrame(this._captionRevealFrame);
    // Alpine defers x-show visibility until the next frame. Reset after that
    // layout too, so the newly visible long section cannot restore its old offset.
    this._captionRevealFrame = window.requestAnimationFrame(() => {
      this._captionRevealFrame = null;
      if (!element.isConnected) return;
      element.scrollTop = 0;
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        element.getAnimations().forEach(animation => animation.cancel());
        element.animate([{opacity:.35},{opacity:1}],{duration:120,easing:'ease-out'});
      }
    });
  },
  async captionViewerCopy() {
    try { await navigator.clipboard.writeText(this.captionViewerText()); this.toast(this.t('tagger.copied')); }
    catch (_) { this.toast(this.t('common.failed'),'error'); }
  },
});
