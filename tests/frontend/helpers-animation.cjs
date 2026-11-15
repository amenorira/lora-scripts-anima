function withAnimationFrames(callback) {
  const previous = {request: global.requestAnimationFrame, cancel: global.cancelAnimationFrame, match: window.matchMedia};
  const frames = new Map(); let nextId = 0;
  global.requestAnimationFrame = fn => {frames.set(++nextId, fn); return nextId;};
  global.cancelAnimationFrame = id => frames.delete(id);
  window.matchMedia = () => ({matches: false});
  const tick = time => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(fn => fn(time));
  };
  try {return callback({tick, frames});}
  finally {
    global.requestAnimationFrame = previous.request; global.cancelAnimationFrame = previous.cancel;
    window.matchMedia = previous.match;
  }
}

module.exports = {withAnimationFrames};
