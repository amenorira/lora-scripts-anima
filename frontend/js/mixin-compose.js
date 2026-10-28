/* Preserve accessors and reject accidental shared-state/method overrides at assembly. */
window.composeAppMixins = function(target, sources) {
  const owners = new Map(Reflect.ownKeys(target).map(key => [key, 'base']));
  const descriptors = {};
  for (const [name, source] of Object.entries(sources)) {
    if (!source) continue;
    for (const key of Reflect.ownKeys(source)) {
      if (owners.has(key)) throw new Error(`Duplicate mixin property ${String(key)}: ${owners.get(key)} / ${name}`);
      owners.set(key, name);
      Object.defineProperty(descriptors, key, {
        value: Object.getOwnPropertyDescriptor(source, key), enumerable: true, configurable: true,
      });
    }
  }
  Object.defineProperties(target, descriptors);
  return target;
};
