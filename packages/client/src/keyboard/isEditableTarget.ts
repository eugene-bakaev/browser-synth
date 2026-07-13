// Classifies an event target as an editable field — the keyboard system's
// editable guard and the focus-deselect composable both key off this.
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // isContentEditable is the correct (inherited/computed) check in real
  // browsers. jsdom (used by this file's tests) doesn't implement it, so
  // fall back to the raw property/attribute value — a no-op in real
  // browsers, where isContentEditable is already true whenever this is.
  return t.isContentEditable || t.contentEditable === 'true';
}
