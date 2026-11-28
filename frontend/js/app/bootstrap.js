/* Start Alpine only after the active translations are ready. Its preload in
   index.html keeps the vendor download parallel with the language request. */
(() => {
  Promise.resolve(window.I18N.ready).then(() => {
    const script = document.createElement('script');
    const alpineUrl = '/anima-ui/js/vendor/alpine.min.js';
    script.src = window.animaUrl(alpineUrl);
    document.head.appendChild(script);
  });
})();
