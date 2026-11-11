/* Start Alpine only after the active translations are ready. Its preload in
   index.html keeps the vendor download parallel with the language request. */
(() => {
  Promise.resolve(window.I18N.ready).then(() => {
    const script = document.createElement('script');
    script.src = '/anima-ui/js/vendor/alpine.min.js';
    document.head.appendChild(script);
  });
})();
