/* Shared confirmation/notice service. Layout and interaction belong here;
   business callbacks retain responsibility for validating their target state. */
(function () {
  'use strict';

  function normalize(options, translate) {
    const text = value => String(value ?? '');
    const notice = !!options.notice;
    const tone = ['neutral', 'warning', 'danger', 'error'].includes(options.tone)
      ? options.tone : notice ? 'warning' : 'neutral';
    const message = text(options.message), context = text(options.context), details = text(options.details);
    const secondaryLabel = notice ? '' : text(options.secondaryLabel);
    const content = [message, context, details].filter(Boolean).join('\n');
    const automatic = content.length > 360 || content.split('\n').length > 6
      ? 'wide' : details || secondaryLabel || content.length > 120 || context ? 'standard' : 'compact';
    return {
      title: text(options.title) || translate(notice ? 'common.acknowledge' : 'common.confirm'),
      message, context, details, notice, tone, secondaryLabel,
      size: ['compact', 'standard', 'wide'].includes(options.size) ? options.size : automatic,
      width: Number.isFinite(options.width) && options.width > 0 ? options.width : null,
      actionLabel: text(options.actionLabel) || translate(notice ? 'common.acknowledge' : 'common.confirm'),
      cancelLabel: text(options.cancelLabel) || translate('common.cancel'),
    };
  }

  window.confirmationDialogMixin = {
    showConfirmModal: false,
    confirmDialog: {},
    confirmCopyState: '',
    _confirmQueue: null,
    _confirmRequest: null,
    _confirmClosing: false,

    // openConfirm({ title, message, tone, size, ... }) resolves to
    // 'confirm' | 'secondary' | 'cancel'. Callbacks are optional.
    // size: auto (default), compact (400px), standard (480px), wide (640px).
    // Optional numeric width overrides the preset; viewport limits still apply.
    openConfirm(options = {}) {
      return new Promise(resolve => {
        if (!this._confirmQueue) this._confirmQueue = [];
        this._confirmQueue.push({ config: { ...options }, resolve });
        this._showNextConfirm();
      });
    },

    openNotice(options) {
      return this.openConfirm({ ...options, notice: true });
    },

    _showNextConfirm() {
      if (this._confirmRequest || this._confirmClosing || !this._confirmQueue?.length) return;
      const request = this._confirmQueue.shift();
      this._confirmRequest = request;
      this.confirmDialog = normalize(request.config, key => this.t(key));
      this.confirmCopyState = '';
      this.showConfirmModal = true;
      // Do not carry expanded diagnostic text into the next request.
      if (this.$refs?.confirmDetails) this.$refs.confirmDetails.open = false;
    },

    _finishConfirm(choice) {
      const request = this._confirmRequest;
      if (!request || !this.showConfirmModal) return;
      if (choice === 'secondary' && !this.confirmDialog.secondaryLabel) return;
      this._confirmRequest = null;
      this._confirmClosing = true;
      this.showConfirmModal = false;
      // A programmatic cancellation may happen before x-dialog ever opens.
      // In that case no exit event will be dispatched to drain the queue.
      if (this.$refs?.confirmRoot && !this.$refs.confirmRoot.open) {
        this.$nextTick(() => {
          if (this._confirmClosing && !this.showConfirmModal) this.confirmAfterClose();
        });
      }
      request.resolve(choice);
      const callback = request.config[{ confirm: 'onConfirm', secondary: 'onSecondary', cancel: 'onCancel' }[choice]];
      // Clear the request before callbacks: an action may enqueue another dialog.
      if (typeof callback === 'function') {
        try {
          Promise.resolve(callback.call(this)).catch(error => this._confirmCallbackError(error));
        } catch (error) { this._confirmCallbackError(error); }
      }
    },

    _confirmCallbackError(error) {
      this.toast(error?.message || this.t('common.requestFailed'), 'error');
    },

    confirmAction() { this._finishConfirm('confirm'); },
    confirmSecondaryAction() { this._finishConfirm('secondary'); },
    cancelConfirm() { this._finishConfirm('cancel'); },

    confirmAfterClose() {
      this._confirmClosing = false;
      this._showNextConfirm();
    },

    async copyConfirmDetails() {
      const dialog = this.confirmDialog;
      try {
        await navigator.clipboard.writeText([dialog.title, dialog.context, dialog.message, dialog.details].filter(Boolean).join('\n\n'));
        if (dialog === this.confirmDialog) this.confirmCopyState = 'copied';
      } catch (_) {
        if (dialog === this.confirmDialog) this.confirmCopyState = 'copyFailed';
      }
    },
  };
})();
