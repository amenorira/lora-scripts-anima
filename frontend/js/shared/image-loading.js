/* Shared large-image loading. Galleries keep native lazy loading; only opened
   images are decoded eagerly. Keep promises only while loading, never a second
   unbounded cache of decoded full-resolution images.

   Alpine: <img x-image="{src: item.original, placeholder: item.thumbnail}">
   The optional image-ready event carries original width/height. Directive
   cleanup cancels stale writes; imperative callers use display()/cancel().
   decode() is for state-driven viewers; reveal() is for a full-image layer
   above an existing thumbnail. Do not apply eager decoding to lazy grids. */
(() => {
  const pending = new Map();
  const requests = new WeakMap();

  function decode(source) {
    if (!source) return Promise.reject(new Error('Missing image URL'));
    if (pending.has(source)) return pending.get(source);
    const image = new Image();
    image.decoding = 'async';
    image.fetchPriority = 'high';
    image.src = source;
    const ready = image.decode().then(() => image);
    pending.set(source, ready);
    const release = () => { if (pending.get(source) === ready) pending.delete(source); };
    ready.then(release, release);
    return ready;
  }

  function cancel(element) { requests.delete(element); }

  function display(element, source, placeholder = '') {
    const previous = requests.get(element);
    if (previous && previous.source === source && previous.placeholder === placeholder) return previous.ready;
    const request = {source, placeholder};
    requests.set(element, request);
    element.decoding = 'async';
    const current = () => requests.get(element) === request && element.isConnected;
    request.ready = (async () => {
      if (!source) { element.removeAttribute('src'); return false; }
      if (placeholder) element.src = placeholder;
      else element.removeAttribute('src');
      try {
        const image = await decode(source);
        if (!current()) return false;
        element.src = image.src;
        element.dispatchEvent(new CustomEvent('image-ready', {detail: {width: image.naturalWidth, height: image.naturalHeight}}));
        return true;
      } catch (_) {
        // Preserve a usable thumbnail. With no fallback, let the normal <img>
        // error handler show the caller's existing unavailable-image state.
        if (current()) {
          requests.delete(element); // A later refresh may retry this URL.
          if (!placeholder) element.src = source;
        }
        return false;
      }
    })();
    return request.ready;
  }

  async function reveal(element) {
    try {
      await element.decode();
      if (element.isConnected) element.classList.add('is-loaded');
    } catch (_) { /* The thumbnail underneath remains visible. */ }
  }

  window.AnimaImages = {decode, display, cancel, reveal};
  document.addEventListener('alpine:init', () => {
    Alpine.directive('image', (element, {expression}, {evaluateLater, effect, cleanup}) => {
      const evaluate = evaluateLater(expression);
      effect(() => evaluate(value => {
        const options = typeof value === 'string' ? {src: value} : value || {};
        void display(element, options.src, options.placeholder);
      }));
      cleanup(() => cancel(element));
    });
  });
})();
