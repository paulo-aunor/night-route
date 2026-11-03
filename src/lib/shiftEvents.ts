// Tells a screen that the shift on disk changed underneath it (a house ticked from a notification), so it reloads
// instead of saving its older copy over the change.

const listeners = new Set<() => void>();

export function onShiftChangedElsewhere(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function announceShiftChanged(): void {
  listeners.forEach((l) => l());
}
