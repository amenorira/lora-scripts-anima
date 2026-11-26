/* Commands always belong to the task visible when the dialog was opened. */
window.trainingControlMixin = {
  trainingStopping: '',
  controlTask: '',
  controlState: null,
  controlDialog: '',
  controlDialogTask: '',
  controlSubmitting: false,
  controlLoading: false,
  controlSaveWeights: false,
  controlSaveState: false,
  controlChoices: [],
  controlDefaults: {},
  controlExternalEncoder: false,
  controlIndex: '',
  controlPrompt: '',
  controlSeed: '',
  controlSteps: '',
  controlWidth: '',
  controlHeight: '',
  controlScale: '',
  controlReceipt: '',
  controlRequest: 0,

  applyTrainingControl(id, state) {
    if (this.controlTask !== id) {
      this.controlState = null;
      this.controlReceipt = '';
      if (this.controlDialogTask !== id) this.controlDialog = '';
    }
    const previous = this.controlState;
    if (previous?.updated_at && state?.updated_at < previous.updated_at) return;
    // A state poll can finish after the POST that queued the next command.
    const last = previous?.command, next = state?.command;
    if (state && last && (!next || next.id < last.id || (next.id === last.id && last.status !== 'pending' && next.status === 'pending'))) {
      state = {...state, command: last};
    }
    const refreshed = previous?.updated_at !== state?.updated_at;
    this.controlTask = id;
    this.controlState = state;
    if (!this.selectedRunDir && this.currentRoute === 'monitor-dashboard'
        && (previous?.state !== state?.state || previous?.allowed?.join() !== state?.allowed?.join()
          || last?.id !== state?.command?.id || last?.status !== state?.command?.status
          || last?.phase !== state?.command?.phase)) this.scheduleRender();
    if (refreshed && !this.selectedRunDir && this.liveTaskId === id && state?.progress && this.monitorData) {
      this.handleRealtimeTaskProgress({data: state.progress});
    }
    const cmd = state?.command;
    if (cmd && cmd.status !== 'pending' && this.controlReceipt !== cmd.id) {
      this.controlReceipt = cmd.id;
      const result = cmd.result || {};
      const paths = [result.path, result.checkpoint, result.state, ...(result.files || [])].filter(Boolean);
      const success = {save:'weightsSaved', save_state:'stateSaved', sample:'sampleDone', pause:'paused', resume:'resumed', stop:'stopped'};
      let message;
      if (cmd.status === 'ok') {
        if (cmd.action === 'pause' && result.warning) {
          message = this.t('control.replica');
        } else {
          message = this.t('control.' + (success[cmd.action] || 'done'));
          if (result.warning) paths.unshift(result.warning);
        }
      } else {
        message = ['expired', 'encodingFailed'].includes(cmd.error) ? this.t('control.' + cmd.error) : cmd.error || this.t('control.expired');
      }
      this.toast(message, cmd.status === 'ok' ? 'success' : 'error', {key:'training-control', details:paths.join('\n')});
    }
  },

  stopTraining() { return this.openTrainingControl('stop'); },

  get controlHasNativeControl() {
    return !!this.controlState?.state;
  },

  get controlCanStopAtStep() {
    return this.controlState?.allowed?.includes('stop') && this.controlState.command?.status !== 'pending';
  },

  get controlPromptIsPreset() {
    return this.controlIndex !== '' && this.controlIndex !== 'new' && !!this.controlChoices[Number(this.controlIndex)];
  },

  get controlPromptModified() {
    if (!this.controlPromptIsPreset) return false;
    const preset = this.controlChoices[Number(this.controlIndex)];
    return this.controlPrompt.trim() !== String(preset?.prompt || '').trim();
  },

  get controlUsesText() {
    return this.controlIndex === 'new' || this.controlPromptModified;
  },

  get controlCanEditPrompt() {
    return !!this.controlState?.new_prompt;
  },

  get controlPromptSelectConfig() {
    const options = this.controlChoices.map((item, i) => {
      const text = String(item.prompt || '').replace(/\s+/g, ' ').trim();
      const snippet = text.length > 64 ? text.slice(0, 64) + '…' : text;
      return {
        v: String(i),
        l: this.t('control.configItem').replace('{n}', i + 1),
        d: snippet,
      };
    });
    if (this.controlState?.new_prompt || !options.length) {
      options.push({ v: 'new', l: this.t('control.newPrompt'), d: this.t('control.newPromptDesc') });
    }
    return { options };
  },

  get controlActiveTemplate() {
    if (this.controlPromptIsPreset) {
      return this.controlChoices[Number(this.controlIndex)];
    }
    return this.controlUsesText ? this.controlDefaults : {};
  },

  get controlNegativeSummary() {
    const neg = this.controlActiveTemplate.negative_prompt;
    return typeof neg === 'string' ? neg.trim() : '';
  },

  get controlHasQualityPrompts() {
    const param = (this.trainParams || []).find(p => p.key === 'quality_prompts');
    return !!(param && String(param.value ?? '').trim());
  },

  get controlWidthPlaceholder() {
    const width = this.controlActiveTemplate.width;
    return width ? this.t('control.keepValue').replace('{value}', width) : this.t('control.keep');
  },

  get controlHeightPlaceholder() {
    const height = this.controlActiveTemplate.height;
    return height ? this.t('control.keepValue').replace('{value}', height) : this.t('control.keep');
  },

  get controlScalePlaceholder() {
    const scale = this.controlActiveTemplate.scale;
    return scale != null && scale !== '' ? this.t('control.keepValue').replace('{value}', scale) : this.t('control.keep');
  },

  get controlSeedPlaceholder() {
    const seed = this.controlActiveTemplate.seed;
    return seed != null && seed !== '' ? this.t('control.keepValue').replace('{value}', seed) : this.t('control.keep');
  },

  get controlStepsPlaceholder() {
    const steps = this.controlActiveTemplate.sample_steps;
    return steps ? this.t('control.keepValue').replace('{value}', steps) : this.t('control.modelDefaultSteps');
  },

  get controlSampleHint() {
    if (this.controlState?.state === 'paused') return this.t('control.previewPaused');
    if (this.controlState?.command?.status === 'pending') {
      return this.t(this.controlState.command.phase === 'encoding' ? 'control.encodingPending' : 'control.pending');
    }
    if (this.controlUsesText && !this.controlState?.new_prompt) return this.t('control.previewCache');
    if (this.controlPromptIsPreset && !this.controlPromptModified) {
      return this.controlExternalEncoder ? this.t('control.presetCacheHint') : '';
    }
    if (this.controlPromptModified) {
      const n = Number(this.controlIndex) + 1;
      const key = this.controlExternalEncoder ? 'control.modifiedCpuHint' : 'control.modifiedHint';
      return this.t(key).replace('{n}', n);
    }
    if (this.controlIndex === 'new') {
      const parts = [];
      if (this.controlExternalEncoder) parts.push(this.t('control.newCpuHint'));
      if (this.controlHasQualityPrompts) parts.push(this.t('control.newQualityHint'));
      return parts.join(' ');
    }
    return '';
  },

  get controlRunName() {
    const raw = this.monitorData?.config?.output_name
      || this.trainParams?.find(p => p.key === 'output_name')?.value
      || this.monitorData?.output_name
      || String(this.monitorData?.output_dir || '').split(/[\\/]/).filter(Boolean).pop()
      || '';
    return String(raw).trim();
  },

  get controlStepText() {
    const progress = this.controlState?.progress;
    if (progress?.step == null) return '';
    return this.t('control.atStep').replace('{step}',
      progress.total_steps ? progress.step + ' / ' + progress.total_steps : progress.step);
  },

  _formatSaveStatusMeta(savedStep, fallbackEmptyKey = 'control.notSavedYet') {
    if (!this.controlHasNativeControl) return { text: '', tone: 'muted' };
    if (savedStep == null) return { text: this.t(fallbackEmptyKey), tone: 'muted' };
    const currentStep = this.controlState?.progress?.step;
    if (currentStep != null && currentStep === savedStep) {
      return { text: this.t('control.savedAtCurrentStep'), tone: 'saved' };
    }
    if (currentStep != null && currentStep > savedStep) {
      return {
        text: this.t('control.savedEarlierDelta')
          .replace('{step}', savedStep)
          .replace('{delta}', currentStep - savedStep),
        tone: 'unsaved',
      };
    }
    return { text: this.t('control.savedAtStep').replace('{step}', savedStep), tone: 'muted' };
  },

  get controlWeightsSaveMeta() {
    return this._formatSaveStatusMeta(this.controlState?.last_checkpoint_step);
  },

  get controlStateSaveMeta() {
    return this._formatSaveStatusMeta(this.controlState?.last_state_step, 'control.notSavedYetState');
  },

  get controlStopButtonLabel() {
    return this.t(this.controlSaveWeights || this.controlSaveState ? 'control.saveAndStop' : 'common.stopTraining');
  },

  get controlStopConsequence() {
    const saving = this.controlSaveWeights || this.controlSaveState;
    if (this.controlState?.state === 'paused') {
      return this.t(saving ? 'control.stopPausedSave' : 'control.stopPausedDiscard');
    }
    return this.t(saving ? 'control.stopConsequenceSave' : 'control.stopConsequenceDiscard');
  },

  selectControlPrompt(index) {
    this.controlIndex = index;
    this.controlPrompt = index === 'new' ? '' : this.controlChoices[Number(index)]?.prompt || '';
  },

  canSubmitControlDialog(action = this.controlDialog) {
    if (!this.controlDialog || this.controlLoading || this.controlSubmitting || this.controlDialogTask !== this.liveTaskId) return false;
    if (action === 'force') return this.controlDialog === 'stop';
    if (action !== this.controlDialog || !this.controlState?.allowed.includes(action) || this.controlState.command?.status === 'pending') return false;
    if (action === 'stop') return true;
    return this.controlUsesText ? this.controlState.new_prompt && !!this.controlPrompt.trim() : this.controlPromptIsPreset;
  },

  async openTrainingControl(action) {
    const id = this.liveTaskId || this.taskId;
    if (!id || this.controlSubmitting) return;
    const seq = ++this.controlRequest;
    this.controlDialogTask = id;
    this.controlDialog = action;
    this.controlLoading = true;
    this.controlSaveWeights = false;
    this.controlSaveState = false;
    this.controlIndex = '';
    this.controlChoices = [];
    this.controlDefaults = {};
    this.controlExternalEncoder = false;
    this.controlSeed = this.controlSteps = this.controlWidth = this.controlHeight = this.controlScale = this.controlPrompt = '';
    try {
      const res = await fetch('/api/monitor/control/' + encodeURIComponent(id) + '?prompts=' + (action === 'sample'));
      if (!res.ok) throw new Error(this.t('control.unavailable'));
      const state = await res.json();
      if (seq !== this.controlRequest || this.liveTaskId !== id || !this.controlDialog) return;
      this.applyTrainingControl(id, state);
      this.controlChoices = state.prompts || [];
      this.controlDefaults = state.preview_defaults || {};
      this.controlExternalEncoder = !!state.external_encoder;
      if (action === 'sample') {
        this.selectControlPrompt(this.controlChoices.length ? '0' : 'new');
      }
    } catch (e) {
      if (seq === this.controlRequest) { this.controlDialog = ''; this.toast(e.message, 'error'); }
    } finally { if (seq === this.controlRequest) this.controlLoading = false; }
  },

  async submitTrainingControl(action, id = this.liveTaskId) {
    if (!id || id !== this.liveTaskId || this.controlSubmitting) return;
    if (['stop', 'force', 'sample'].includes(action)) {
      if (!this.canSubmitControlDialog(action)) return;
    } else if (!this.controlState?.allowed.includes(action) || this.controlState.command?.status === 'pending') return;
    const body = {action};
    if (action === 'stop') {
      if (this.controlSaveWeights) body.mode = this.controlSaveState ? 'both' : 'weights';
      else body.mode = this.controlSaveState ? 'state' : 'discard';
    }
    if (action === 'sample') {
      if (this.controlUsesText) {
        body.prompt = this.controlPrompt.trim();
        if (this.controlPromptIsPreset) body.base_index = Number(this.controlIndex);
      } else {
        body.index = Number(this.controlIndex);
      }
      if (this.controlSeed !== '') body.seed = String(this.controlSeed);
      if (this.controlSteps !== '') body.steps = Number(this.controlSteps);
      if (this.controlWidth !== '') body.width = Number(this.controlWidth);
      if (this.controlHeight !== '') body.height = Number(this.controlHeight);
      if (this.controlScale !== '') body.scale = Number(this.controlScale);
    }
    this.controlSubmitting = true;
    if (action === 'force') this.trainingStopping = id;
    try {
      const res = await fetch('/api/monitor/control/' + encodeURIComponent(id), {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
        });
      const data = await res.json();
      if (!res.ok || data.status === 'error') throw new Error(data.message || this.t('control.' + (data.detail === 'pending' ? 'pending' : 'unavailable')));
      if (this.liveTaskId !== id) return;
      this.controlDialog = '';
      if (action !== 'force') {
        this.applyTrainingControl(id, data);
        if (data.command?.status === 'pending' && this.currentRoute !== 'monitor-dashboard') {
          this.toast(this.t(data.command.phase === 'encoding' ? 'control.encodingPending' : 'control.pending'), 'info', {key:'training-control'});
        }
      }
      this._wakeTrainingStatePoll();
    } catch (e) { this.toast(e.message, 'error'); }
    finally { this.controlSubmitting = false; this.trainingStopping = ''; }
  },
};
