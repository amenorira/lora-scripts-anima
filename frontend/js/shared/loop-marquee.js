/* Seamless hover scrolling, with an optional bounded return trip for captions. */
(() => {
  const instances = new WeakMap();
  const visibilityHandlers = new WeakMap();
  const pending = new Set();
  let frame = null, visibilityObserver = null;
  function unschedule(instance) {
    pending.delete(instance);
    if (!pending.size && frame !== null) {cancelAnimationFrame(frame); frame = null;}
  }
  function schedule(instance) {
    if (typeof requestAnimationFrame !== 'function') {instance.write(instance.read()); return;}
    pending.add(instance);
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const jobs = [...pending]; pending.clear();
      // Large grids need all measurements before any class/style write.
      const sizes = jobs.map(job => job.read());
      const write = () => jobs.forEach((job, index) => job.write(sizes[index]));
      if (window.Alpine?.mutateDom) window.Alpine.mutateDom(write);
      else write();
    });
  }
  window.initLoopMarquee = function(element, source, {bounce = false} = {}) {
    instances.get(element)?.();
    source ||= element.firstElementChild;
    if (!source) return () => {};
    const track = document.createElement('span');
    const copy = bounce ? null : document.createElement('span');
    track.className = 'loop-marquee-track';
    if (copy) {copy.className = 'loop-marquee-copy'; copy.setAttribute('aria-hidden', 'true');}
    element.classList.add('loop-marquee');
    element.classList.toggle('is-bouncing', bounce);
    source.classList.add('loop-marquee-text');
    source.replaceWith(track);
    track.append(source);
    if (copy) track.append(copy);
    const instance = {read() {
      const width = source.scrollWidth;
      const overflowing = element.clientWidth > 0 && width > element.clientWidth + (bounce ? 14 : 1);
      const distance = bounce ? Math.max(0, width - element.clientWidth)
        : width + (parseFloat(getComputedStyle(track).columnGap) || 64);
      return {overflowing, distance};
    }, write({overflowing, distance}) {
      element.classList.toggle('is-overflowing', overflowing);
      if (copy) copy.textContent = overflowing ? source.textContent : '';
      element.style.setProperty('--loop-marquee-distance', `${distance}px`);
      element.style.setProperty('--loop-marquee-duration', `${Math.max(4, bounce ? distance * 2 / 28 + 2 : distance / 35).toFixed(2)}s`);
    }};
    const update = () => schedule(instance);
    let resize, mutations, observing = false;
    const watch = () => {
      if (observing) {update(); return;}
      observing = true;
      if (bounce && !element.classList.contains('is-marquee-visible')) element.classList.add('is-marquee-visible');
      const changed = () => {if (observing) update();};
      resize = window.ResizeObserver ? new ResizeObserver(changed) : null;
      resize?.observe(element); resize?.observe(source);
      mutations = window.MutationObserver ? new MutationObserver(changed) : null;
      mutations?.observe(source, {childList:true, characterData:true, subtree:true});
      update();
    };
    const unwatch = () => {
      observing = false;
      if (bounce && element.classList.contains('is-marquee-visible')) element.classList.remove('is-marquee-visible');
      resize?.disconnect(); mutations?.disconnect();
      resize = mutations = null;
      unschedule(instance);
    };
    element.addEventListener('mouseenter', watch);
    element.addEventListener('focusin', watch);
    if (bounce && window.IntersectionObserver) {
      // Keep large sample histories from measuring and observing every caption.
      visibilityObserver ||= new IntersectionObserver(entries => {
        for (const entry of entries) visibilityHandlers.get(entry.target)?.(entry.isIntersecting);
      }, {rootMargin: '320px'});
      visibilityHandlers.set(element, visible => visible ? watch() : unwatch());
      visibilityObserver.observe(element);
    } else watch();
    const destroy = () => {
      if (visibilityHandlers.delete(element)) visibilityObserver.unobserve(element);
      unwatch();
      element.removeEventListener('mouseenter', watch);
      element.removeEventListener('focusin', watch);
      if (track.parentElement === element) track.replaceWith(source);
      element.classList.remove('is-overflowing');
      element.classList.remove('is-bouncing');
      instances.delete(element);
    };
    instances.set(element, destroy);
    return destroy;
  };
  document.addEventListener('alpine:init', () => {
    Alpine.directive('loop-marquee', (element, {modifiers}, {cleanup}) => {
      Alpine.mutateDom(() => cleanup(window.initLoopMarquee(element, null, {bounce: modifiers.includes('bounce')})));
    });
  });
})();
