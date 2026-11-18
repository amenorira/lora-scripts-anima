/* Shared image geometry, reset animation and an Alpine pan/zoom controller. */
(() => {
  function zoom(view, requestedScale, anchor) {
    const current = Number(view.scale) || 1;
    const requested = Math.max(1, Math.min(8, Number(requestedScale) || 1));
    const scale = Math.abs(requested - 1) < 0.001 ? 1 : requested;
    if (scale === 1) return { scale: 1, x: 0, y: 0 };
    if (Math.abs(scale - current) < 0.001) return { scale: current, x: view.x || 0, y: view.y || 0 };
    const ratio = scale / current;
    return {
      scale,
      x: anchor ? anchor.x - (anchor.x - (view.x || 0)) * ratio : view.x || 0,
      y: anchor ? anchor.y - (anchor.y - (view.y || 0)) * ratio : view.y || 0,
    };
  }

  function pointerAnchor(event, stage) {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - (rect.left + rect.width / 2), y: event.clientY - (rect.top + rect.height / 2) };
  }

  // Measure the actual drawn image bounds, including for portrait images.
  // Intersect the pan limits to keep each synchronized comparison pane visible.
  function constrain(view, stages) {
    let maxX = Infinity, maxY = Infinity;
    for (const stage of stages || []) {
      const image = stage?.querySelector?.('img');
      const width = stage?.clientWidth, height = stage?.clientHeight;
      const boxWidth = image?.clientWidth, boxHeight = image?.clientHeight;
      if (!width || !height || !boxWidth || !boxHeight || !image.naturalWidth || !image.naturalHeight) continue;
      const fit = Math.min(boxWidth / image.naturalWidth, boxHeight / image.naturalHeight);
      const imageWidth = image.naturalWidth * fit * view.scale;
      const imageHeight = image.naturalHeight * fit * view.scale;
      const limit = (stageSize, imageSize) => (stageSize + imageSize) / 2 - Math.min(160, stageSize / 2, imageSize / 2);
      maxX = Math.min(maxX, limit(width, imageWidth));
      maxY = Math.min(maxY, limit(height, imageHeight));
    }
    return { scale: view.scale, x: Math.max(-maxX, Math.min(maxX, view.x || 0)), y: Math.max(-maxY, Math.min(maxY, view.y || 0)) };
  }

  // Both viewers return scale and position together, keeping the image mounted.
  function animate(from, to, update, complete = () => {}) {
    if (Object.keys(to).every(key => from[key] === to[key]) || typeof requestAnimationFrame !== 'function'
        || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      update(to); complete(); return null;
    }
    let frame, started, cancelled = false;
    const tick = time => {
      if (cancelled) return;
      if (started == null) started = time;
      const progress = Math.min(1, (time - started) / 90), eased = 1 - Math.pow(1 - progress, 3);
      const view = {};
      for (const key of Object.keys(to)) view[key] = from[key] + (to[key] - from[key]) * eased;
      update(view);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else complete();
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }

  function frameWriter(apply) {
    let frame = null, pending;
    const flush = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      const value = pending; pending = undefined;
      if (value !== undefined) apply(value);
    };
    return {
      schedule(value) {
        pending = value;
        if (typeof requestAnimationFrame !== 'function') { flush(); return; }
        if (frame === null) frame = requestAnimationFrame(flush);
      },
      flush,
      cancel() {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null; pending = undefined;
      },
    };
  }

  function create(state = {scale: 1, x: 0, y: 0}) {
    return {
      get scale() { return state.scale; }, set scale(value) { state.scale = value; },
      get x() { return state.x; }, set x(value) { state.x = value; },
      get y() { return state.y; }, set y(value) { state.y = value; },
      panning: false, _pan: null, _panWrite: null, _cancelReset: null,
      view() { return {scale: this.scale, x: this.x, y: this.y}; },
      apply(view) { this.scale = view.scale; this.x = view.x; this.y = view.y; },
      transform() { return 'translate3d(' + this.x + 'px,' + this.y + 'px,0) scale(' + this.scale + ')'; },
      cancelReset() { this._cancelReset?.(); this._cancelReset = null; },
      constrain() { this.cancelReset(); this.stopPan(); this.apply(constrain(this.view(), [this.$refs.viewport])); },
      reset(smooth = true) {
        this.cancelReset(); this.stopPan();
        const target = {scale: 1, x: 0, y: 0};
        if (!smooth) { this.apply(target); return; }
        this._cancelReset = animate(this.view(), target, view => this.apply(view), () => { this._cancelReset = null; });
      },
      zoom(event) {
        if (!event.deltaY || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY)) return;
        event.preventDefault(); event.stopPropagation(); this.cancelReset(); this.stopPan();
        this.$dispatch?.('image-view-interact');
        const stage = this.$refs.viewport;
        this.apply(constrain(zoom(this.view(), this.scale * (event.deltaY < 0 ? 1.18 : 1 / 1.18), pointerAnchor(event, stage)), [stage]));
      },
      startPan(event) {
        if (event.button !== 0 || event.isPrimary === false || this.scale <= 1) return;
        this.cancelReset(); this.stopPan();
        this.$dispatch?.('image-view-interact');
        this._pan = {stage: event.currentTarget, id: event.pointerId, x: event.clientX - this.x, y: event.clientY - this.y};
        const pan = this._pan;
        this._panWrite = frameWriter(point => {
          this.apply(constrain({scale: this.scale, x: point.x - pan.x, y: point.y - pan.y}, [pan.stage]));
          pan.x = point.x - this.x; pan.y = point.y - this.y;
        });
        this.panning = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      },
      movePan(event) {
        const pan = this._pan;
        if (!pan || pan.id !== event.pointerId) return;
        this._panWrite.schedule({x: event.clientX, y: event.clientY});
        event.preventDefault();
      },
      stopPan(event) {
        const pan = this._pan;
        if (!pan || (event && pan.id !== event.pointerId)) return;
        // A child can lose capture as a drag transfers to the viewport.
        // End the drag when the viewport itself loses capture.
        if (event?.type === 'lostpointercapture' && event.target !== pan.stage) return;
        this._panWrite?.flush(); this._panWrite = null;
        this._pan = null; this.panning = false;
        if (pan.stage.hasPointerCapture?.(pan.id)) pan.stage.releasePointerCapture(pan.id);
      },
      destroy() { this.cancelReset(); this._panWrite?.cancel(); this.stopPan(); },
    };
  }

  window.AnimaImageViewport = { zoom, pointerAnchor, constrain, animate, frameWriter, create };
})();
