// THE single human-readable table of every keyboard shortcut in the app.
// Command id → binding string (or array of alternates). "mod" is ⌘ on mac
// and Ctrl elsewhere (see keys.ts). A command registered without an entry
// here is legal (invocable-only, e.g. from a future palette); an entry with
// no registered command is caught by the hygiene test in trackerCommands.test.
export const KEY_BINDINGS: Record<string, string | readonly string[]> = {
  'global.redo': ['shift+mod+z', 'mod+y'],
  'global.undo': 'mod+z',
  'tracker.clear': ['delete', 'backspace'],
  'tracker.copy': 'mod+c',
  'tracker.cursorDown': 'arrowdown',
  'tracker.cursorUp': 'arrowup',
  'tracker.cut': 'mod+x',
  'tracker.deselect': 'escape',
  'tracker.extendDown': 'shift+arrowdown',
  'tracker.extendUp': 'shift+arrowup',
  'tracker.moveDown': 'alt+arrowdown',
  'tracker.moveUp': 'alt+arrowup',
  'tracker.paste': 'mod+v',
  'tracker.toggleMute': 'm',
};
