/* Seamless hover scrolling shared by prompt summaries and snapshot paths. */
(() => {
  const instances = new WeakMap();
  window.initLoopMarquee = function(element, source) {
    instances.get(element)?.();
    source ||= element.firstElementChild;
    if (!source) return () => {};
    const track = document.createElement('span');
    const copy = document.createElement('span');
    track.className = 'loop-marquee-track';
    copy.className = 'loop-marquee-copy';
    copy.setAttribute('aria-hidden', 'true');
    element.classList.add('loop-marquee');
    source.classList.add('loop-marquee-text');
    source.replaceWith(track);
    track.append(source, copy);
    const update = () => {
      const width = source.scrollWidth;
      const overflowing = element.clientWidth > 0 && width > element.clientWidth + 1;
      element.classList.toggle('is-overflowing', overflowing);
      copy.textContent = overflowing ? source.textContent : '';
      const gap = parseFloat(getComputedStyle(track).columnGap) || 64;
      const distance = width + gap;
      element.style.setProperty('--loop-marquee-distance', `${distance}px`);
      element.style.setProperty('--loop-marquee-duration', `${Math.max(4, distance / 35).toFixed(2)}s`);
    };
    const resize = window.ResizeObserver ? new ResizeObserver(update) : null;
    resize?.observe(element);
    resize?.observe(source);
    const mutations = window.MutationObserver ? new MutationObserver(update) : null;
    mutations?.observe(source, {childList:true, characterData:true, subtree:true});
    element.addEventListener('mouseenter', update);
    element.addEventListener('focusin', update);
    update();
    const destroy = () => {
      resize?.disconnect(); mutations?.disconnect();
      element.removeEventListener('mouseenter', update);
      element.removeEventListener('focusin', update);
      if (track.parentElement === element) track.replaceWith(source);
      element.classList.remove('is-overflowing');
      instances.delete(element);
    };
    instances.set(element, destroy);
    return destroy;
  };
  document.addEventListener('alpine:init', () => {
    Alpine.directive('loop-marquee', (element, {}, {cleanup}) => {
      Alpine.mutateDom(() => cleanup(window.initLoopMarquee(element)));
    });
  });
})();
