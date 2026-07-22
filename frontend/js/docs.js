/* ================================================================
   docs.js - Markdown parameter documentation browser
   ================================================================ */

window.docsMixin = {
  docsDocuments: [],
  docsSelectedSlug: '',
  docsHtml: '',
  docsToc: '',
  docsLoading: false,
  docsError: '',
  _docsLocale: '',
  _docsListRequestId: 0,
  _docsContentRequestId: 0,
  _docsRequestedSlug: '',
  _docsRequestedAnchor: '',

  docsCurrentDocument() {
    return this.docsDocuments.find(doc => doc.slug === this.docsSelectedSlug) || null;
  },

  async loadDocsPage(force) {
    const locale = this.locale || 'zh-CN';
    const reloadIndex = !!force || this._docsLocale !== locale || this.docsDocuments.length === 0;
    this.docsError = '';

    if (reloadIndex) {
      const requestId = ++this._docsListRequestId;
      this.docsLoading = true;
      try {
        const response = await fetch('/api/docs?locale=' + encodeURIComponent(locale));
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        if (result.status !== 'success' || !result.data) {
          throw new Error(result.message || this.t('docs.loadError'));
        }
        if (requestId !== this._docsListRequestId) return;
        this.docsDocuments = result.data.documents || [];
        this._docsLocale = result.data.locale || locale;
      } catch (error) {
        if (requestId !== this._docsListRequestId) return;
        this.docsError = this.t('docs.loadError') + ': ' + (error.message || String(error));
        this.docsLoading = false;
        return;
      }
    }

    const requestedSlug = this._docsRequestedSlug || this.docsSelectedSlug;
    const fallbackSlug = this.docsDocuments.length ? this.docsDocuments[0].slug : '';
    const slug = this.docsDocuments.some(doc => doc.slug === requestedSlug) ? requestedSlug : fallbackSlug;
    const anchor = this._docsRequestedAnchor;
    this._docsRequestedSlug = '';
    this._docsRequestedAnchor = '';

    if (!slug) {
      this.docsLoading = false;
      return;
    }
    await this.selectParameterDoc(slug, anchor);
  },

  async selectParameterDoc(slug, anchor) {
    if (!slug) return;
    const requestId = ++this._docsContentRequestId;
    const locale = this.locale || 'zh-CN';
    this.docsSelectedSlug = slug;
    this.docsLoading = true;
    this.docsError = '';

    try {
      const response = await fetch('/api/docs/' + encodeURIComponent(slug) + '?locale=' + encodeURIComponent(locale));
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const result = await response.json();
      if (result.status !== 'success' || !result.data) {
        throw new Error(result.message || this.t('docs.loadError'));
      }
      if (requestId !== this._docsContentRequestId) return;
      this.docsHtml = result.data.html || '';
      this.docsToc = result.data.toc || '';
      this.docsLoading = false;
      this.$nextTick(() => {
        if (anchor) {
          // Route scroll restoration runs on the next paint. Apply the explicit
          // parameter-link anchor just after it so it cannot be reset to the top.
          setTimeout(() => this.scrollToDocAnchor(anchor, false), 32);
        }
        else {
          const scroller = document.getElementById('mainContent');
          if (scroller) scroller.scrollTo({ top: 0, behavior: 'auto' });
        }
      });
    } catch (error) {
      if (requestId !== this._docsContentRequestId) return;
      this.docsLoading = false;
      this.docsError = this.t('docs.loadError') + ': ' + (error.message || String(error));
    }
  },

  openParameterDoc(slug, anchor) {
    this._docsRequestedSlug = slug || 'lora-plus';
    this._docsRequestedAnchor = anchor || '';
    if (this.currentRoute === 'docs') {
      const targetSlug = this._docsRequestedSlug;
      const targetAnchor = this._docsRequestedAnchor;
      this._docsRequestedSlug = '';
      this._docsRequestedAnchor = '';
      this.selectParameterDoc(targetSlug, targetAnchor);
      return;
    }
    this.navigate('docs');
  },

  handleDocsContentClick(event) {
    const link = event.target.closest && event.target.closest('a');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (!href.startsWith('#')) return;
    event.preventDefault();
    this.scrollToDocAnchor(decodeURIComponent(href.slice(1)), true);
  },

  scrollToDocAnchor(anchor, smooth) {
    const article = document.getElementById('docsArticle');
    if (!article || !anchor) return;
    const escaped = window.CSS && typeof window.CSS.escape === 'function'
      ? window.CSS.escape(anchor)
      : anchor.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    const target = article.querySelector('#' + escaped);
    const scroller = document.getElementById('mainContent');
    if (!target || !scroller) return;
    const top = target.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top
      + scroller.scrollTop
      - 18;
    scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  },
};
