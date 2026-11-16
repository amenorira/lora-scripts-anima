/* Shared large-image loading. Galleries keep native lazy loading; only opened
   images are decoded eagerly. Promises are kept only while loading; viewers may
   opt into a small, explicitly cleared cache of decoded originals.

   Alpine: <img x-image="{src: item.original, placeholder: item.thumbnail}">
   The optional image-ready event carries original width/height. Directive
   cleanup cancels stale writes; imperative callers use display()/cancel().
   decode() is for state-driven viewers. Do not apply eager decoding to lazy grids. */
(() => {
  const pending = new Map();
  const requests = new WeakMap();

  function decode(source, {priority = 'high'} = {}) {
    if (!source) return Promise.reject(new Error('Missing image URL'));
    const existing = pending.get(source);
    if (existing) {
      // A neighbor may become the image the user is waiting for while its
      // low-priority prefetch is still in flight.
      if (priority === 'high') existing.image.fetchPriority = 'high';
      return existing.ready;
    }
    const image = new Image();
    image.decoding = 'async';
    image.fetchPriority = priority;
    image.src = source;
    const ready = image.decode().then(() => image);
    const flight = {image, ready};
    pending.set(source, flight);
    const release = () => { if (pending.get(source) === flight) pending.delete(source); };
    ready.then(release, release);
    return ready;
  }

  function cancel(element) { requests.delete(element); }

  // A viewer owns this cache for the lifetime of one open dialog. Prefetch is
  // serial and its queue is replaced on navigation, so scrubbing a long run
  // cannot start a request for every time point passed on the way.
  function createReadyCache(maxEntries = 5, {maxPixels = 16 * 1024 * 1024} = {}) {
    const limit = Math.max(1, Math.min(6, Math.floor(maxEntries) || 5));
    const images = new Map();
    let pixels = 0;
    let generation = 0, active = null, queue = [], desired = new Set();

    function get(key) {
      const entry = images.get(key);
      if (entry) { images.delete(key); images.set(key, entry); }
      return entry?.image;
    }

    function remove(key) {
      const entry = images.get(key);
      if (!entry) return;
      pixels -= entry.pixels;
      images.delete(key);
    }

    function put(key, image, ticket = generation) {
      if (!key || !image || ticket !== generation) return;
      const size = (image.naturalWidth || 0) * (image.naturalHeight || 0);
      remove(key);
      // A very large opened image can still be displayed by its owner without
      // retaining an extra cache reference or evicting every smaller neighbor.
      if (size > maxPixels) return;
      images.set(key, {image, pixels: size});
      pixels += size;
      while (images.size > limit || pixels > maxPixels) remove(images.keys().next().value);
    }

    function drain() {
      if (active || !queue.length) return;
      const task = {...queue.shift(), ticket: generation}, ticket = generation;
      active = task;
      decode(task.source, {priority: 'low'}).then(image => {
        if (desired.has(task.key)) put(task.key, image, ticket);
      }, () => {}).finally(() => {
        active = null;
        drain();
      });
    }

    function prefetch(candidates) {
      const unique = new Map();
      for (const candidate of candidates) {
        if (candidate?.key && candidate.source) unique.set(candidate.key, candidate);
      }
      desired = new Set(unique.keys());
      queue = [...unique.values()].filter(item => !images.has(item.key)
        && (item.key !== active?.key || active.ticket !== generation)).slice(0, 2);
      drain();
    }

    function cancelPrefetch() { desired.clear(); queue = []; }
    function clear() { generation++; cancelPrefetch(); images.clear(); pixels = 0; }
    return {get, put, prefetch, cancelPrefetch, clear, ticket: () => generation};
  }

  function display(element, source, placeholder = '', options = {}) {
    const cache = options.cache, cacheKey = options.key || source;
    const previous = requests.get(element);
    if (previous && previous.source === source && previous.placeholder === placeholder
        && previous.cache === cache && previous.cacheKey === cacheKey) return previous.ready;
    const request = {source, placeholder, cache, cacheKey};
    requests.set(element, request);
    element.decoding = 'async';
    const current = () => requests.get(element) === request && element.isConnected;
    const ticket = cache?.ticket();
    request.ready = (async () => {
      if (!source) { element.removeAttribute('src'); return false; }
      // Resolve cache hits synchronously: do not replace an already decoded
      // original with a thumbnail for a single frame while navigating back.
      const cached = cache?.get(cacheKey);
      if (cached) {
        if (!current()) return false;
        element.src = cached.src;
        element.dispatchEvent(new CustomEvent('image-ready', {detail: {width: cached.naturalWidth, height: cached.naturalHeight}}));
        return true;
      }
      if (placeholder) element.src = placeholder;
      else element.removeAttribute('src');
      try {
        const image = await decode(source);
        if (!current()) return false;
        cache?.put(cacheKey, image, ticket);
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

  window.AnimaImages = {decode, display, cancel, createReadyCache};
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
