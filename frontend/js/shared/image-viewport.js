/* Image zoom geometry shared by the dataset and training-sample viewers. */
(() => {
  function zoom(view, requestedScale, anchor) {
    const current = Number(view.scale) || 1;
    const scale = Math.max(1, Math.min(8, Number(requestedScale) || 1));
    if (Math.abs(scale - current) < 0.001) return { scale: current, x: view.x || 0, y: view.y || 0 };
    if (scale === 1) return { scale: 1, x: 0, y: 0 };
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

  // Keep a useful portion of each visible image in its stage. Measuring the
  // contained pixels (rather than the full img box) handles portrait images,
  // and intersecting the limits keeps synchronized comparison panes visible.
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

  window.AnimaImageViewport = { zoom, pointerAnchor, constrain };
})();
