/* ================================================================
   docs.js - Markdown parameter documentation browser
   ================================================================ */

window.docsMixin = {
  docsDocuments: [],
  docsSelectedSlug: '',
  docsPendingSlug: '',
  docsHtml: '',
  docsIndexLoading: false,
  docsContentLoading: false,
  docsError: '',
  docsActiveAnchor: '',
  docsTocItems: [],
  _docsLocale: '',
  _docsContentLocale: '',
  _docsListRequestId: 0,
  _docsContentRequestId: 0,
  _docsRequestedSlug: '',
  _docsRequestedAnchor: '',
  _docsPendingLocale: '',
  _docsPendingAnchor: '',
  _docsContentCache: Object.create(null),
  _docsContentAbortController: null,
  _docsContentPromise: null,
  _docsTocArticle: null,
  _docsTocHeadings: [],
  _docsTocScroller: null,
  _docsTocScrollHandler: null,
  _docsTocUserScrollHandler: null,
  _docsTocRaf: 0,
  _docsScrollTarget: null,
  _docsPinnedAnchor: null,

  docsCurrentDocument() {
    return this.docsDocuments.find(doc => doc.slug === this.docsSelectedSlug) || null;
  },

  docsCategoryLabel(category) {
    return this.t('docs.categories.' + category, category);
  },

  docsDocumentGroups() {
    const groups = [];
    const byCategory = new Map();
    this.docsDocuments.forEach(doc => {
      const category = doc.category || 'other';
      let group = byCategory.get(category);
      if (!group) {
        group = { category, documents: [] };
        byCategory.set(category, group);
        groups.push(group);
      }
      group.documents.push(doc);
    });
    return groups;
  },

  async loadDocsPage(force) {
    const locale = this.locale || 'zh-CN';
    const reloadIndex = !!force || this._docsLocale !== locale || this.docsDocuments.length === 0;

    if (reloadIndex) {
      const requestId = ++this._docsListRequestId;
      this.docsIndexLoading = true;
      if (!this.docsHtml) this.docsError = '';

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
        const message = this.t('docs.loadError') + ': ' + (error.message || String(error));
        if (this.docsHtml && typeof this.toast === 'function') this.toast(message, 'error');
        else this.docsError = message;
        return;
      } finally {
        if (requestId === this._docsListRequestId) this.docsIndexLoading = false;
      }
    }

    const requestedSlug = this._docsRequestedSlug || this.docsSelectedSlug;
    const fallbackSlug = this.docsDocuments.length ? this.docsDocuments[0].slug : '';
    const slug = this.docsDocuments.some(doc => doc.slug === requestedSlug) ? requestedSlug : fallbackSlug;
    const anchor = this._docsRequestedAnchor;
    this._docsRequestedSlug = '';
    this._docsRequestedAnchor = '';

    if (!slug) {
      this._cancelDocsContentRequest();
      this._teardownDocsScrollSpy();
      this.docsSelectedSlug = '';
      this.docsHtml = '';
      this.docsTocItems = [];
      this._docsContentLocale = '';
      return;
    }
    await this.selectParameterDoc(slug, anchor, { force: !!force });
  },

  async selectParameterDoc(slug, anchor, options) {
    if (!slug) return;
    const locale = this.locale || 'zh-CN';
    const normalizedAnchor = anchor || '';
    const force = !!(options && options.force);

    if (!force && this.docsPendingSlug === slug && this._docsPendingLocale === locale) {
      this._docsPendingAnchor = normalizedAnchor;
      return this._docsContentPromise;
    }

    if (!force && this.docsSelectedSlug === slug && this._docsContentLocale === locale && this.docsHtml) {
      this._cancelDocsContentRequest();
      this._updateDocsDocumentTitle();
      const restoreScrollSpy = this.routeTransitioning || !this._docsTocScrollHandler;
      if (normalizedAnchor || restoreScrollSpy) {
        this.$nextTick(() => {
          const delay = this.routeTransitioning ? 32 : 0;
          setTimeout(() => {
            if (normalizedAnchor) this.scrollToDocAnchor(normalizedAnchor, false);
            if (restoreScrollSpy) this._setupDocsScrollSpy();
          }, delay);
        });
      }
      return;
    }

    const cacheKey = locale + ':' + slug;
    const cached = !force ? this._docsContentCache[cacheKey] : null;
    if (cached) {
      this._cancelDocsContentRequest();
      this._commitDocsContent(cached, normalizedAnchor);
      return;
    }

    this._cancelDocsContentRequest();
    const requestId = ++this._docsContentRequestId;
    const controller = new AbortController();
    this._docsContentAbortController = controller;
    this.docsPendingSlug = slug;
    this._docsPendingLocale = locale;
    this._docsPendingAnchor = normalizedAnchor;
    this.docsContentLoading = true;
    if (!this.docsHtml) this.docsError = '';

    const requestPromise = (async () => {
      try {
        const response = await fetch(
          '/api/docs/' + encodeURIComponent(slug) + '?locale=' + encodeURIComponent(locale),
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const result = await response.json();
        if (result.status !== 'success' || !result.data) {
          throw new Error(result.message || this.t('docs.loadError'));
        }
        if (requestId !== this._docsContentRequestId) return;

        this._docsContentCache[cacheKey] = result.data;
        this._commitDocsContent(result.data, this._docsPendingAnchor);
      } catch (error) {
        if (requestId !== this._docsContentRequestId || error.name === 'AbortError') return;
        const message = this.t('docs.loadError') + ': ' + (error.message || String(error));
        if (this.docsHtml && typeof this.toast === 'function') this.toast(message, 'error');
        else this.docsError = message;
      } finally {
        if (requestId === this._docsContentRequestId) {
          this.docsContentLoading = false;
          this.docsPendingSlug = '';
          this._docsPendingLocale = '';
          this._docsPendingAnchor = '';
          this._docsContentAbortController = null;
          this._docsContentPromise = null;
        }
      }
    })();

    this._docsContentPromise = requestPromise;
    return requestPromise;
  },

  _commitDocsContent(documentData, anchor) {
    this.docsSelectedSlug = documentData.slug || '';
    this.docsHtml = documentData.html || '';
    this.docsTocItems = [];
    this.docsError = '';
    this.docsActiveAnchor = '';
    this._docsContentLocale = documentData.locale || this.locale || 'zh-CN';

    this._updateDocsDocumentTitle(documentData.title);

    this.$nextTick(() => {
      const delay = anchor ? 32 : 0;
      setTimeout(() => {
        if (this.currentRoute !== 'docs' || this.docsSelectedSlug !== documentData.slug) return;
        const mobileOutline = document.querySelector('.docs-mobile-outline');
        if (mobileOutline) mobileOutline.open = false;
        this._setupDocsScrollSpy();
        if (anchor) this.scrollToDocAnchor(anchor, false);
        else {
          const scroller = document.getElementById('mainContent');
          if (scroller) {
            scroller.scrollTo({ top: 0, behavior: 'auto' });
            this._queueDocsScrollSpyRefresh();
          }
        }
      }, delay);
    });
  },

  _cancelDocsContentRequest() {
    if (this._docsContentAbortController) {
      this._docsContentAbortController.abort();
      this._docsContentRequestId += 1;
    }
    this._docsContentAbortController = null;
    this._docsContentPromise = null;
    this.docsContentLoading = false;
    this.docsPendingSlug = '';
    this._docsPendingLocale = '';
    this._docsPendingAnchor = '';
  },

  _updateDocsDocumentTitle(title) {
    if (this.currentRoute !== 'docs') return;
    const currentDocument = this.docsCurrentDocument();
    const documentTitle = title || (currentDocument && currentDocument.title) || this.t('docs.title');
    document.title = documentTitle + ' | lora-scripts-anima';
  },

  cleanupDocsReader() {
    this._docsListRequestId += 1;
    this.docsIndexLoading = false;
    this._cancelDocsContentRequest();
    this._teardownDocsScrollSpy();
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
    const mobileOutline = link.closest('.docs-mobile-outline');
    if (mobileOutline) mobileOutline.open = false;
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
    const rawTop = target.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top
      + scroller.scrollTop
      - 18;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const targetTop = Math.min(maxTop, Math.max(0, rawTop));
    const reduceMotion = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const useSmoothScroll = !!smooth && !reduceMotion;
    const pinOnArrival = rawTop - targetTop > 2;

    this._docsPinnedAnchor = null;
    this._docsScrollTarget = useSmoothScroll
      ? { anchor, top: targetTop, pinOnArrival }
      : null;
    if (!useSmoothScroll && pinOnArrival) {
      this._docsPinnedAnchor = { anchor, scrollTop: targetTop };
    }
    this._setDocsActiveAnchor(anchor);
    scroller.scrollTo({ top: targetTop, behavior: useSmoothScroll ? 'smooth' : 'auto' });
    this._queueDocsScrollSpyRefresh();
  },

  _setupDocsScrollSpy() {
    this._teardownDocsScrollSpy();
    const article = document.getElementById('docsArticle');
    const scroller = document.getElementById('mainContent');
    if (!article || !scroller) {
      this.docsTocItems = [];
      return;
    }
    const headings = Array.from(article.querySelectorAll('h2[id], h3[id]'));
    this.docsTocItems = headings.map(heading => ({
      anchor: heading.id,
      level: Number(heading.tagName.slice(1)),
      title: (heading.textContent || '').trim(),
    }));
    if (!headings.length) {
      this.docsActiveAnchor = '';
      return;
    }

    this._docsTocArticle = article;
    this._docsTocHeadings = headings;
    this._docsTocScroller = scroller;
    this._docsTocScrollHandler = () => {
      if (
        this._docsPinnedAnchor
        && Math.abs(scroller.scrollTop - this._docsPinnedAnchor.scrollTop) > 2
      ) {
        this._docsPinnedAnchor = null;
      }
      this._queueDocsScrollSpyRefresh();
    };
    this._docsTocUserScrollHandler = () => {
      this._docsScrollTarget = null;
      this._docsPinnedAnchor = null;
      this._queueDocsScrollSpyRefresh();
    };
    scroller.addEventListener('scroll', this._docsTocScrollHandler, { passive: true });
    scroller.addEventListener('wheel', this._docsTocUserScrollHandler, { passive: true });
    scroller.addEventListener('touchstart', this._docsTocUserScrollHandler, { passive: true });
    scroller.addEventListener('pointerdown', this._docsTocUserScrollHandler, { passive: true });
    this._refreshDocsActiveAnchor();
  },

  _queueDocsScrollSpyRefresh() {
    if (this._docsTocRaf) return;
    const requestFrame = window.requestAnimationFrame
      || (callback => window.setTimeout(callback, 16));
    this._docsTocRaf = requestFrame(() => {
      this._docsTocRaf = 0;
      this._refreshDocsActiveAnchor();
    });
  },

  _refreshDocsActiveAnchor() {
    const headings = this._docsTocHeadings;
    const scroller = this._docsTocScroller;
    if (!headings.length || this.currentRoute !== 'docs') return;

    if (this._docsPinnedAnchor) {
      this._setDocsActiveAnchor(this._docsPinnedAnchor.anchor);
      return;
    }

    if (this._docsScrollTarget) {
      const target = this._docsScrollTarget;
      this._setDocsActiveAnchor(target.anchor);
      if (Math.abs(scroller.scrollTop - target.top) > 2) return;
      this._docsScrollTarget = null;
      if (target.pinOnArrival) {
        this._docsPinnedAnchor = { anchor: target.anchor, scrollTop: scroller.scrollTop };
        return;
      }
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const viewportTop = scrollerRect.top + 18;
    const viewportBottom = scrollerRect.bottom - 18;
    const articleBottom = this._docsTocArticle
      ? Math.min(viewportBottom, this._docsTocArticle.getBoundingClientRect().bottom)
      : viewportBottom;
    const headingRects = headings.map(heading => heading.getBoundingClientRect());
    const scores = [];
    let activeIndex = 0;
    let bestScore = -1;

    for (let index = 0; index < headings.length; index += 1) {
      const headingTop = headingRects[index].top;
      const sectionTop = index === 0 ? Math.min(headingTop, viewportTop) : headingTop;
      const sectionBottom = index + 1 < headings.length
        ? headingRects[index + 1].top
        : Math.max(articleBottom, headingTop);
      const visibleTop = Math.max(viewportTop, sectionTop);
      const visibleBottom = Math.min(viewportBottom, sectionBottom);
      let score = Math.max(0, visibleBottom - visibleTop);
      if (headingTop >= viewportTop && headingTop <= viewportBottom) score += 24;
      scores.push(score);
      if (score > bestScore) {
        bestScore = score;
        activeIndex = index;
      }
    }

    const currentIndex = headings.findIndex(heading => heading.id === this.docsActiveAnchor);
    if (
      currentIndex >= 0
      && scores[currentIndex] > 0
      && bestScore - scores[currentIndex] <= 24
    ) {
      activeIndex = currentIndex;
    }
    this._setDocsActiveAnchor(headings[activeIndex].id);
  },

  _setDocsActiveAnchor(anchor) {
    this.docsActiveAnchor = anchor || '';
  },

  _teardownDocsScrollSpy() {
    const scroller = this._docsTocScroller;
    if (scroller && this._docsTocScrollHandler) {
      scroller.removeEventListener('scroll', this._docsTocScrollHandler);
    }
    if (scroller && this._docsTocUserScrollHandler) {
      scroller.removeEventListener('wheel', this._docsTocUserScrollHandler);
      scroller.removeEventListener('touchstart', this._docsTocUserScrollHandler);
      scroller.removeEventListener('pointerdown', this._docsTocUserScrollHandler);
    }
    if (this._docsTocRaf) {
      const cancelFrame = window.cancelAnimationFrame || window.clearTimeout;
      cancelFrame(this._docsTocRaf);
    }
    this._docsTocArticle = null;
    this._docsTocHeadings = [];
    this._docsTocScroller = null;
    this._docsTocScrollHandler = null;
    this._docsTocUserScrollHandler = null;
    this._docsTocRaf = 0;
    this._docsScrollTarget = null;
    this._docsPinnedAnchor = null;
  },
};
