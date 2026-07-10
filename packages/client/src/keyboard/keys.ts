//
// The key language of the keyboard command system. This is the ONLY module
// that reads KeyboardEvent key/modifier fields — everything else treats
// binding strings ("mod+c", "shift+arrowup") as opaque, which is what keeps
// a future chord syntax ("g g") a local change here instead of an API break.

export type Platform = 'mac' | 'other';

export interface KeyDescriptor {
  key: string;   // lowercased KeyboardEvent.key value (' ' for space)
  mod: boolean;  // the platform primary modifier: ⌘ on mac, Ctrl elsewhere
  shift: boolean;
  alt: boolean;
}

// The subset of KeyboardEvent that matching reads — lets tests use stubs.
export interface KeyboardEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MODIFIERS = new Set(['mod', 'shift', 'alt']);
// Binding-string aliases for keys whose KeyboardEvent.key value is awkward
// to write literally.
const KEY_ALIASES: Record<string, string> = { space: ' ' };

export function parseBinding(binding: string): KeyDescriptor {
  const tokens = binding.toLowerCase().split('+');
  const key = tokens[tokens.length - 1];
  if (!key) throw new Error(`Invalid key binding "${binding}": empty key`);
  const desc: KeyDescriptor = { key: KEY_ALIASES[key] ?? key, mod: false, shift: false, alt: false };
  for (const m of tokens.slice(0, -1)) {
    if (!MODIFIERS.has(m)) throw new Error(`Unknown modifier "${m}" in binding "${binding}"`);
    desc[m as 'mod' | 'shift' | 'alt'] = true;
  }
  return desc;
}

// Strict matching: every modifier state must equal the descriptor exactly, so
// mod+c never fires on mod+shift+c, and the non-primary modifier (Ctrl on
// mac, Meta elsewhere) must be up.
export function matchesEvent(desc: KeyDescriptor, e: KeyboardEventLike, platform: Platform): boolean {
  if (e.key.toLowerCase() !== desc.key) return false;
  const expectMeta = platform === 'mac' ? desc.mod : false;
  const expectCtrl = platform === 'mac' ? false : desc.mod;
  return e.metaKey === expectMeta && e.ctrlKey === expectCtrl
    && e.shiftKey === desc.shift && e.altKey === desc.alt;
}

export function sameDescriptor(a: KeyDescriptor, b: KeyDescriptor): boolean {
  return a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;
}

export function detectPlatform(
  nav: { platform?: string; userAgent?: string } = typeof navigator !== 'undefined' ? navigator : {},
): Platform {
  const probe = `${nav.platform ?? ''} ${nav.userAgent ?? ''}`;
  return /mac|iphone|ipad|ipod/i.test(probe) ? 'mac' : 'other';
}
