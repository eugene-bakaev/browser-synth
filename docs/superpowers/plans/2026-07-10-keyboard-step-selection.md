# Keyboard Command System + Step Selection & Clipboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A centralized, declarative keyboard command system (single window listener, commands as data, contexts, guards) plus its first consumers: tracker row selection and copy/cut/clear/paste on selected step rows.

**Architecture:** Four layers, each ignorant of the layers above: generic `KeyboardService` (keyboard/) → `trackerCommands` factory binding commands to stores/ops → local-only Pinia stores for selection + clipboard → pure step-range drafts dispatched per-leaf through the existing CommandBus path (`projectOps`). No shared-package or server changes; step leaves are already on the sync accept-list.

**Tech Stack:** Vue 3.5 (script setup), Pinia (setup stores), TypeScript, Vitest (jsdom where DOM is needed).

**Source spec:** `docs/superpowers/specs/2026-07-10-keyboard-step-selection-design.md` (approved). Read it if a requirement here seems ambiguous — the spec governs.

## Global Constraints

- Branch: `feat/keyboard-step-selection`. Never commit to main.
- NO changes under `packages/shared` or `packages/server`.
- Never run `npm run dev` (it targets prod). Local manual testing is `npm run dev:obs` only — but implementer tasks need only unit tests, run from `packages/client` with `npx vitest run <file>`.
- Stage ONLY the files you created/modified by name — never `git add -A` or `-u`. Never stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png`.
- Every commit message ends with these two trailer lines:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir
  ```
- Context priority is fixed: `tracker` beats `global`. The only contexts are `'global' | 'tracker'`.
- The editable guard has NO opt-out: keydown originating in an input/textarea/select/contenteditable never dispatches a command.
- Selection and clipboard state are LOCAL ONLY: never dispatched, never enqueued, never persisted.
- `TRACK_NAME_MAX_LENGTH`-style single-sourcing applies: "what an empty step is" comes from `freshStep()` (`@fiddle/shared`), nowhere else.

## Plan-level clarifications (deliberate decisions, not drift)

1. **Paste target = `validSelection.start`** (top of the selection range). When the selection is a single cursor (click, or arrows) `start === head`, matching the spec's "paste at cursor". When a range was extended downward, pasting at the range top is the predictable Excel-like behavior. 
2. **Cursor auto-scroll runs unconditionally on cursor moves** (a keypress is a deliberate act; the user wants to see the cursor). The playhead follow keeps its manual-scroll grace period untouched — that is what "must not fight the grace period" protects.
3. `pasteSteps` returns the number of rows actually written so the command layer can re-select the pasted range without recomputing the clip.

---

### Task 1: Key language — `keyboard/keys.ts`

**Files:**
- Create: `packages/client/src/keyboard/keys.ts`
- Test: `packages/client/src/keyboard/keys.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 2, 5):
  - `type Platform = 'mac' | 'other'`
  - `interface KeyDescriptor { key: string; mod: boolean; shift: boolean; alt: boolean }`
  - `parseBinding(binding: string): KeyDescriptor` — throws on unknown modifier or empty key
  - `matchesEvent(desc: KeyDescriptor, e: KeyboardEventLike, platform: Platform): boolean`
  - `sameDescriptor(a: KeyDescriptor, b: KeyDescriptor): boolean`
  - `detectPlatform(nav?: { platform?: string; userAgent?: string }): Platform`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/src/keyboard/keys.test.ts
import { describe, it, expect } from 'vitest';
import { parseBinding, matchesEvent, sameDescriptor, detectPlatform } from './keys';

// Minimal event stub — matchesEvent only reads these five fields.
function ev(key: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) {
  return {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  };
}

describe('parseBinding', () => {
  it('parses a bare key', () => {
    expect(parseBinding('escape')).toEqual({ key: 'escape', mod: false, shift: false, alt: false });
  });
  it('parses modifiers in any order and lowercases', () => {
    expect(parseBinding('Shift+Mod+C')).toEqual({ key: 'c', mod: true, shift: true, alt: false });
  });
  it('maps the space alias to the literal space key', () => {
    expect(parseBinding('space').key).toBe(' ');
  });
  it('throws on an unknown modifier', () => {
    expect(() => parseBinding('hyper+c')).toThrow(/unknown modifier/i);
  });
  it('throws on an empty key', () => {
    expect(() => parseBinding('mod+')).toThrow(/invalid/i);
  });
});

describe('matchesEvent', () => {
  const modC = parseBinding('mod+c');
  it('mod resolves to metaKey on mac', () => {
    expect(matchesEvent(modC, ev('c', { meta: true }), 'mac')).toBe(true);
    expect(matchesEvent(modC, ev('c', { ctrl: true }), 'mac')).toBe(false);
  });
  it('mod resolves to ctrlKey elsewhere', () => {
    expect(matchesEvent(modC, ev('c', { ctrl: true }), 'other')).toBe(true);
    expect(matchesEvent(modC, ev('c', { meta: true }), 'other')).toBe(false);
  });
  it('is strict: mod+c does not fire on mod+shift+c', () => {
    expect(matchesEvent(modC, ev('C', { meta: true, shift: true }), 'mac')).toBe(false);
  });
  it('is strict: bare arrowup does not fire when shift is held', () => {
    expect(matchesEvent(parseBinding('arrowup'), ev('ArrowUp', { shift: true }), 'mac')).toBe(false);
  });
  it('shift+arrowdown matches (event key is case-normalized)', () => {
    expect(matchesEvent(parseBinding('shift+arrowdown'), ev('ArrowDown', { shift: true }), 'other')).toBe(true);
  });
  it('shifted letters match by lowercased event key', () => {
    expect(matchesEvent(parseBinding('shift+arrowup'), ev('ArrowUp', { shift: true }), 'mac')).toBe(true);
    expect(matchesEvent(parseBinding('mod+shift+z'), ev('Z', { meta: true, shift: true }), 'mac')).toBe(true);
  });
});

describe('sameDescriptor', () => {
  it('equal descriptors compare equal, different keys or mods do not', () => {
    expect(sameDescriptor(parseBinding('mod+c'), parseBinding('Mod+C'))).toBe(true);
    expect(sameDescriptor(parseBinding('mod+c'), parseBinding('mod+x'))).toBe(false);
    expect(sameDescriptor(parseBinding('mod+c'), parseBinding('mod+shift+c'))).toBe(false);
  });
});

describe('detectPlatform', () => {
  it('detects mac from platform or userAgent', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; ...)' })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT ...)' })).toBe('other');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/client && npx vitest run src/keyboard/keys.test.ts`
Expected: FAIL — cannot resolve `./keys`.

- [ ] **Step 3: Implement `keys.ts`**

```ts
// packages/client/src/keyboard/keys.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/client && npx vitest run src/keyboard/keys.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/keyboard/keys.ts packages/client/src/keyboard/keys.test.ts
git commit -m "feat(client): keyboard key language — binding parse/match with injected platform"
```
(with the trailer lines from Global Constraints)

---

### Task 2: Bindings table, KeyboardService, composable, AppRuntime wiring

**Files:**
- Create: `packages/client/src/keyboard/bindings.ts`
- Create: `packages/client/src/keyboard/KeyboardService.ts`
- Create: `packages/client/src/keyboard/useKeyboardCommand.ts`
- Modify: `packages/client/src/app/AppRuntime.ts` (add `keyboard` to the runtime)
- Modify: `packages/client/src/app/synthContext.ts` (expose `keyboard` on the context)
- Test: `packages/client/src/keyboard/KeyboardService.test.ts`

**Interfaces:**
- Consumes (Task 1): `parseBinding`, `matchesEvent`, `sameDescriptor`, `detectPlatform`, `Platform` from `./keys`.
- Produces (used by Tasks 5, 6):
  - `KEY_BINDINGS: Record<string, string | readonly string[]>` (bindings.ts)
  - `type KeyboardContext = 'global' | 'tracker'`
  - `interface KeyboardCommand { id: string; description: string; context: KeyboardContext; isEnabled?: () => boolean; allowRepeat?: boolean; run: (e: KeyboardEvent) => void }`
  - `class KeyboardService { constructor(opts?); register(cmd): () => void; handleKeydown(e): void; dispose(): void }`
  - `useKeyboardCommand(service: KeyboardService, cmds: KeyboardCommand | KeyboardCommand[]): void`
  - `AppRuntime.keyboard: KeyboardService`; `SynthContext.keyboard: KeyboardService`

- [ ] **Step 1: Write the bindings table**

```ts
// packages/client/src/keyboard/bindings.ts
//
// THE single human-readable table of every keyboard shortcut in the app.
// Command id → binding string (or array of alternates). "mod" is ⌘ on mac
// and Ctrl elsewhere (see keys.ts). A command registered without an entry
// here is legal (invocable-only, e.g. from a future palette); an entry with
// no registered command is caught by the hygiene test in trackerCommands.test.
export const KEY_BINDINGS: Record<string, string | readonly string[]> = {
  'tracker.clear': ['delete', 'backspace'],
  'tracker.copy': 'mod+c',
  'tracker.cursorDown': 'arrowdown',
  'tracker.cursorUp': 'arrowup',
  'tracker.cut': 'mod+x',
  'tracker.deselect': 'escape',
  'tracker.extendDown': 'shift+arrowdown',
  'tracker.extendUp': 'shift+arrowup',
  'tracker.paste': 'mod+v',
};
```

- [ ] **Step 2: Write the failing service tests**

```ts
// packages/client/src/keyboard/KeyboardService.test.ts
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { KeyboardService, type KeyboardCommand } from './KeyboardService';

const BINDINGS = {
  'test.copy': 'mod+c',
  'test.clear': ['delete', 'backspace'],
  'test.up': 'arrowup',
  'test.globalUp': 'arrowup',
} as const;

function svc(opts: { platform?: 'mac' | 'other' } = {}) {
  // target: null — no real listener; tests drive handleKeydown directly.
  return new KeyboardService({ bindings: BINDINGS, platform: opts.platform ?? 'other', target: null });
}

function cmd(over: Partial<KeyboardCommand> & { id: string }): KeyboardCommand {
  return { description: 'test', context: 'tracker', run: vi.fn(), ...over };
}

function kev(key: string, over: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, ...over });
}

describe('KeyboardService dispatch', () => {
  it('runs a matching enabled command and preventDefaults', () => {
    const s = svc();
    const c = cmd({ id: 'test.copy' });
    s.register(c);
    const e = kev('c', { ctrlKey: true });
    s.handleKeydown(e);
    expect(c.run).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('does not preventDefault when nothing matches or nothing is enabled', () => {
    const s = svc();
    s.register(cmd({ id: 'test.copy', isEnabled: () => false }));
    const noMatch = kev('q');
    s.handleKeydown(noMatch);
    expect(noMatch.defaultPrevented).toBe(false);
    const disabled = kev('c', { ctrlKey: true });
    s.handleKeydown(disabled);
    expect(disabled.defaultPrevented).toBe(false);
  });

  it('supports alternate bindings for one command', () => {
    const s = svc();
    const c = cmd({ id: 'test.clear' });
    s.register(c);
    s.handleKeydown(kev('Delete'));
    s.handleKeydown(kev('Backspace'));
    expect(c.run).toHaveBeenCalledTimes(2);
  });

  it('editable guard: events from input/textarea/select/contenteditable never dispatch', () => {
    const s = svc();
    const c = cmd({ id: 'test.copy' });
    s.register(c);
    for (const el of [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      Object.assign(document.createElement('div'), { contentEditable: 'true' }),
    ]) {
      document.body.appendChild(el);
      const e = kev('c', { ctrlKey: true, bubbles: true });
      el.dispatchEvent(e); // sets e.target
      s.handleKeydown(e);
      el.remove();
    }
    expect(c.run).not.toHaveBeenCalled();
  });

  it('repeat guard: e.repeat only dispatches when allowRepeat', () => {
    const s = svc();
    const noRepeat = cmd({ id: 'test.copy' });
    const repeats = cmd({ id: 'test.up', allowRepeat: true });
    s.register(noRepeat);
    s.register(repeats);
    s.handleKeydown(kev('c', { ctrlKey: true, repeat: true }));
    s.handleKeydown(kev('ArrowUp', { repeat: true }));
    expect(noRepeat.run).not.toHaveBeenCalled();
    expect(repeats.run).toHaveBeenCalledTimes(1);
  });

  it('context priority: tracker beats global; disabled tracker falls through to global', () => {
    const s = svc();
    const tracker = cmd({ id: 'test.up', context: 'tracker' });
    const global = cmd({ id: 'test.globalUp', context: 'global' });
    s.register(tracker);
    s.register(global);
    s.handleKeydown(kev('ArrowUp'));
    expect(tracker.run).toHaveBeenCalledTimes(1);
    expect(global.run).not.toHaveBeenCalled();
    const disabledTracker = cmd({ id: 'test.up', context: 'tracker', isEnabled: () => false });
    const s2 = svc();
    s2.register(disabledTracker);
    const g2 = cmd({ id: 'test.globalUp', context: 'global' });
    s2.register(g2);
    s2.handleKeydown(kev('ArrowUp'));
    expect(g2.run).toHaveBeenCalledTimes(1);
  });

  it('conflict: same binding twice in one context throws; other context is fine', () => {
    const s = svc();
    s.register(cmd({ id: 'test.up', context: 'tracker' }));
    expect(() => s.register(cmd({ id: 'test.globalUp', context: 'tracker' }))).toThrow(/conflict/i);
    expect(() => s.register(cmd({ id: 'test.globalUp', context: 'global' }))).not.toThrow();
  });

  it('unregister removes the command', () => {
    const s = svc();
    const c = cmd({ id: 'test.copy' });
    const off = s.register(c);
    off();
    s.handleKeydown(kev('c', { ctrlKey: true }));
    expect(c.run).not.toHaveBeenCalled();
  });

  it('a command with no binding entry registers fine and never key-dispatches', () => {
    const s = svc();
    const c = cmd({ id: 'test.unbound' });
    expect(() => s.register(c)).not.toThrow();
    s.handleKeydown(kev('c', { ctrlKey: true }));
    expect(c.run).not.toHaveBeenCalled();
  });
});

describe('KeyboardService window listener', () => {
  let s: KeyboardService | null = null;
  afterEach(() => { s?.dispose(); s = null; });

  it('listens on window by default and dispose removes the listener', () => {
    s = new KeyboardService({ bindings: BINDINGS, platform: 'other' });
    const c = cmd({ id: 'test.copy' });
    s.register(c);
    window.dispatchEvent(kev('c', { ctrlKey: true, bubbles: true }));
    expect(c.run).toHaveBeenCalledTimes(1);
    s.dispose();
    window.dispatchEvent(kev('c', { ctrlKey: true, bubbles: true }));
    expect(c.run).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/client && npx vitest run src/keyboard/KeyboardService.test.ts`
Expected: FAIL — cannot resolve `./KeyboardService`.

- [ ] **Step 4: Implement `KeyboardService.ts`**

```ts
// packages/client/src/keyboard/KeyboardService.ts
//
// The app's keyboard dispatcher — owns the ONLY window keydown listener.
// Commands are declarative data registered at runtime; bindings come from
// the KEY_BINDINGS table (or an injected one in tests). Created once per
// page by AppRuntime and disposed in its shutdown().
import {
  parseBinding, matchesEvent, sameDescriptor, detectPlatform,
  type KeyDescriptor, type Platform,
} from './keys';
import { KEY_BINDINGS } from './bindings';

export type KeyboardContext = 'global' | 'tracker';

// Higher wins. 'tracker' outranks 'global' so selection ops shadow future
// app-wide keys while a selection exists, and fall through when disabled.
const CONTEXT_PRIORITY: Record<KeyboardContext, number> = { global: 0, tracker: 1 };

export interface KeyboardCommand {
  /** Key into KEY_BINDINGS. Commands without a table entry are legal (palette-only later). */
  id: string;
  /** Human-readable action name — the future help overlay / palette renders this. */
  description: string;
  context: KeyboardContext;
  /** Evaluated at dispatch time; default true. Disabled commands fall through to lower contexts. */
  isEnabled?: () => boolean;
  /** Default false: held-key auto-repeat is ignored. Cursor movement opts in. */
  allowRepeat?: boolean;
  run: (e: KeyboardEvent) => void;
}

export interface KeyboardServiceOptions {
  bindings?: Record<string, string | readonly string[]>;
  platform?: Platform;
  /** Event target to listen on. Default: window (when it exists). Pass null for no listener (tests drive handleKeydown directly). */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

interface Registration {
  cmd: KeyboardCommand;
  descriptors: KeyDescriptor[];
}

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export class KeyboardService {
  private registrations: Registration[] = [];
  private readonly bindings: Record<string, string | readonly string[]>;
  private readonly platform: Platform;
  private readonly target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  private readonly onKeydown = (e: Event): void => this.handleKeydown(e as KeyboardEvent);

  constructor(opts: KeyboardServiceOptions = {}) {
    this.bindings = opts.bindings ?? KEY_BINDINGS;
    this.platform = opts.platform ?? detectPlatform();
    this.target = opts.target !== undefined
      ? opts.target
      : (typeof window !== 'undefined' ? window : null);
    this.target?.addEventListener('keydown', this.onKeydown);
  }

  /** Registers a command; returns its unregister function. Throws on a binding conflict within the same context. */
  register(cmd: KeyboardCommand): () => void {
    const raw = this.bindings[cmd.id];
    const strings = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw as string]);
    const descriptors = strings.map(parseBinding);
    for (const reg of this.registrations) {
      if (reg.cmd.context !== cmd.context) continue;
      for (const d of descriptors) {
        if (reg.descriptors.some((rd) => sameDescriptor(rd, d))) {
          throw new Error(
            `Keyboard binding conflict: "${cmd.id}" and "${reg.cmd.id}" both bind the same key in context "${cmd.context}"`,
          );
        }
      }
    }
    const reg: Registration = { cmd, descriptors };
    this.registrations.push(reg);
    return () => {
      const i = this.registrations.indexOf(reg);
      if (i >= 0) this.registrations.splice(i, 1);
    };
  }

  // Public so tests (and future synthetic invocation) can drive dispatch
  // without a real listener.
  handleKeydown(e: KeyboardEvent): void {
    // Guard 1 — editable target: typing in a field NEVER triggers commands.
    // No opt-out by design (spec). Component-local key handling (e.g. Enter
    // in TrackNameEditor) is untouched: we listen in the bubble phase.
    if (isEditableTarget(e.target)) return;
    const matches = this.registrations.filter((r) =>
      // Guard 2 — key auto-repeat, unless the command opted in.
      (!e.repeat || r.cmd.allowRepeat === true)
      && r.descriptors.some((d) => matchesEvent(d, e, this.platform)),
    );
    matches.sort((a, b) => CONTEXT_PRIORITY[b.cmd.context] - CONTEXT_PRIORITY[a.cmd.context]);
    const winner = matches.find((r) => r.cmd.isEnabled?.() !== false);
    if (!winner) return; // untouched: disabled mod+c still lets the browser copy page text
    e.preventDefault();
    winner.cmd.run(e);
  }

  dispose(): void {
    this.target?.removeEventListener('keydown', this.onKeydown);
    this.registrations = [];
  }
}
```

- [ ] **Step 5: Implement `useKeyboardCommand.ts`**

```ts
// packages/client/src/keyboard/useKeyboardCommand.ts
//
// Vue glue: register command(s) for the lifetime of the current effect scope
// (component setup). Components declare commands; they never touch listeners.
import { onScopeDispose } from 'vue';
import type { KeyboardCommand, KeyboardService } from './KeyboardService';

export function useKeyboardCommand(
  service: KeyboardService,
  cmds: KeyboardCommand | KeyboardCommand[],
): void {
  const list = Array.isArray(cmds) ? cmds : [cmds];
  const disposers = list.map((c) => service.register(c));
  onScopeDispose(() => { for (const off of disposers) off(); });
}
```

- [ ] **Step 6: Wire into AppRuntime and synthContext**

In `packages/client/src/app/AppRuntime.ts`:
- Add import: `import { KeyboardService } from '../keyboard/KeyboardService';`
- Add to the `AppRuntime` interface (after `audio: AudioEngine;`):
  ```ts
  keyboard: KeyboardService;
  ```
- In `createAppRuntime`, after `const audio = new AudioEngine(...)`:
  ```ts
  const keyboard = new KeyboardService();
  ```
- In `shutdown()`, add `keyboard.dispose();` before `audio.dispose();`
- Add `keyboard` to the returned object: `return { pinia, store, bus, session, audio, keyboard, shutdown };`

In `packages/client/src/app/synthContext.ts`, inside `createSynthContext`, add `keyboard: runtime.keyboard,` to the returned object (the big `return { ... }` at the end of the function — place it near `projectOps`). This is how components reach the service (they already inject `SYNTH_CONTEXT`).

- [ ] **Step 7: Run the tests and the existing suites**

Run: `cd packages/client && npx vitest run src/keyboard/ src/app/`
Expected: new tests PASS; existing `AppRuntime.test.ts` / `synthContext.test.ts` / `projectOps.test.ts` still PASS. (`KeyboardService`'s default target is guarded by `typeof window !== 'undefined'`, so node-env runtime tests keep working.)

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/keyboard/bindings.ts packages/client/src/keyboard/KeyboardService.ts packages/client/src/keyboard/useKeyboardCommand.ts packages/client/src/keyboard/KeyboardService.test.ts packages/client/src/app/AppRuntime.ts packages/client/src/app/synthContext.ts
git commit -m "feat(client): KeyboardService — declarative command registry with contexts, guards, conflict detection"
```
(with the trailer lines)

---

### Task 3: Selection store — `stores/selection.ts`

**Files:**
- Create: `packages/client/src/stores/selection.ts`
- Test: `packages/client/src/stores/selection.test.ts`

**Interfaces:**
- Consumes: `useProjectStore` from `./project` (composed inside the store for validation).
- Produces (used by Tasks 5, 6):
  - `interface ValidSelection { trackId: number; start: number; end: number; head: number }`
  - `useSelectionStore()` returning: state `trackId: number | null`, `anchor: number`, `head: number`; getters `validSelection: ValidSelection | null`, `size: number`; functions `isSelected(trackId, row): boolean`, `place(trackId, row)`, `extendTo(trackId, row)`, `moveCursor(delta)`, `extendCursor(delta)`, `clear()`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/src/stores/selection.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useProjectStore } from './project';
import { useSelectionStore } from './selection';

describe('selection store', () => {
  let project: ReturnType<typeof useProjectStore>;
  let sel: ReturnType<typeof useSelectionStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    project = useProjectStore();
    sel = useSelectionStore();
    project.project.tracks[0].patternLength = 16;
  });

  it('starts empty: validSelection is null', () => {
    expect(sel.validSelection).toBeNull();
  });

  it('place sets a collapsed selection (anchor = head = row)', () => {
    sel.place(0, 5);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 5, end: 5, head: 5 });
    expect(sel.size).toBe(1);
  });

  it('extendTo grows the range from the anchor; upward extension normalizes start/end', () => {
    sel.place(0, 5);
    sel.extendTo(0, 8);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 5, end: 8, head: 8 });
    sel.extendTo(0, 2);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 2, end: 5, head: 2 });
    expect(sel.size).toBe(4);
  });

  it('extendTo on a different track behaves as place', () => {
    project.project.tracks[1].patternLength = 16;
    sel.place(0, 5);
    sel.extendTo(1, 8);
    expect(sel.validSelection).toEqual({ trackId: 1, start: 8, end: 8, head: 8 });
  });

  it('moveCursor collapses and moves, clamped to the pattern window', () => {
    sel.place(0, 5);
    sel.extendTo(0, 8);
    sel.moveCursor(1);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 9, end: 9, head: 9 });
    sel.moveCursor(-100);
    expect(sel.validSelection!.head).toBe(0);
    sel.moveCursor(100);
    expect(sel.validSelection!.head).toBe(15);
  });

  it('extendCursor moves only the head, clamped', () => {
    sel.place(0, 5);
    sel.extendCursor(2);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 5, end: 7, head: 7 });
    sel.extendCursor(-100);
    expect(sel.validSelection).toEqual({ trackId: 0, start: 0, end: 5, head: 0 });
  });

  it('moveCursor/extendCursor are no-ops without a valid selection', () => {
    sel.moveCursor(1);
    sel.extendCursor(1);
    expect(sel.validSelection).toBeNull();
  });

  it('isSelected answers per-track per-row', () => {
    sel.place(0, 3);
    sel.extendTo(0, 5);
    expect(sel.isSelected(0, 4)).toBe(true);
    expect(sel.isSelected(0, 6)).toBe(false);
    expect(sel.isSelected(1, 4)).toBe(false);
  });

  it('validSelection clamps a range that pattern-shrink left partially outside', () => {
    sel.place(0, 10);
    sel.extendTo(0, 14);
    project.project.tracks[0].patternLength = 12;
    expect(sel.validSelection).toEqual({ trackId: 0, start: 10, end: 11, head: 11 });
  });

  it('validSelection is null when the range is fully outside the window', () => {
    sel.place(0, 10);
    project.project.tracks[0].patternLength = 8;
    expect(sel.validSelection).toBeNull();
  });

  it('validSelection is null for a disabled track and clear() empties', () => {
    sel.place(0, 3);
    project.project.tracks[0].enabled = false;
    expect(sel.validSelection).toBeNull();
    project.project.tracks[0].enabled = true;
    sel.clear();
    expect(sel.trackId).toBeNull();
    expect(sel.validSelection).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/client && npx vitest run src/stores/selection.test.ts`
Expected: FAIL — cannot resolve `./selection`.

- [ ] **Step 3: Implement the store**

```ts
// packages/client/src/stores/selection.ts
//
// Tracker row selection — STRICTLY LOCAL UI state. Never dispatched, never
// enqueued, never persisted; each peer has their own selection.
//
// Consumers must read `validSelection`, never the raw refs: it revalidates
// against live project state on every read, so pattern shrink, track disable,
// or a project load can never leave a phantom selection targeting rows that
// don't exist.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useProjectStore } from './project';

export interface ValidSelection {
  trackId: number;
  start: number; // inclusive
  end: number;   // inclusive
  head: number;  // the cursor (the moving end of the range)
}

export const useSelectionStore = defineStore('selection', () => {
  const projectStore = useProjectStore();

  const trackId = ref<number | null>(null);
  const anchor = ref(0);
  const head = ref(0);

  const validSelection = computed<ValidSelection | null>(() => {
    const tid = trackId.value;
    if (tid === null) return null;
    const track = projectStore.project.tracks[tid];
    if (!track || !track.enabled) return null;
    const max = track.patternLength - 1;
    const start = Math.min(anchor.value, head.value);
    const end = Math.max(anchor.value, head.value);
    if (start > max || end < 0) return null;
    return {
      trackId: tid,
      start: Math.max(0, start),
      end: Math.min(end, max),
      head: Math.min(Math.max(head.value, 0), max),
    };
  });

  const size = computed(() => {
    const s = validSelection.value;
    return s ? s.end - s.start + 1 : 0;
  });

  function isSelected(tid: number, row: number): boolean {
    const s = validSelection.value;
    return s !== null && s.trackId === tid && row >= s.start && row <= s.end;
  }

  function place(tid: number, row: number): void {
    trackId.value = tid;
    anchor.value = row;
    head.value = row;
  }

  function extendTo(tid: number, row: number): void {
    if (trackId.value !== tid) { place(tid, row); return; }
    head.value = row;
  }

  function clampToWindow(row: number): number {
    const s = validSelection.value;
    if (!s) return row;
    const max = projectStore.project.tracks[s.trackId].patternLength - 1;
    return Math.min(Math.max(row, 0), max);
  }

  /** Collapse & move: anchor = head = clamped(head + delta). No-op without a valid selection. */
  function moveCursor(delta: number): void {
    const s = validSelection.value;
    if (!s) return;
    const next = clampToWindow(s.head + delta);
    anchor.value = next;
    head.value = next;
  }

  /** Move only the head (Shift+arrow). No-op without a valid selection. */
  function extendCursor(delta: number): void {
    const s = validSelection.value;
    if (!s) return;
    head.value = clampToWindow(s.head + delta);
  }

  function clear(): void {
    trackId.value = null;
  }

  return { trackId, anchor, head, validSelection, size, isSelected, place, extendTo, moveCursor, extendCursor, clear };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/client && npx vitest run src/stores/selection.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/stores/selection.ts packages/client/src/stores/selection.test.ts
git commit -m "feat(client): selection store — local-only tracker row range with self-validating getter"
```
(with the trailer lines)

---

### Task 4: Clipboard store, range drafts, projectOps range ops

**Files:**
- Create: `packages/client/src/stores/stepClipboard.ts`
- Modify: `packages/client/src/project/mutations.ts` (add two drafts)
- Modify: `packages/client/src/app/projectOps.ts` (ranged dispatch + two ops)
- Test: `packages/client/src/stores/stepClipboard.test.ts`
- Test: `packages/client/src/project/mutations.test.ts` (extend existing if present, else create)
- Test: `packages/client/src/app/projectOps.test.ts` (extend existing)

**Interfaces:**
- Consumes: `freshStep`, `type Step` from `@fiddle/shared`; existing `dispatchDiff` machinery in projectOps.
- Produces (used by Task 5):
  - `useStepClipboardStore()`: `rows: Step[] | null`, `set(steps: readonly Step[]): void`
  - `clearRangeDraft(start: number, end: number): Step[]`
  - `pasteStepsDraft(rows: readonly Step[], cursor: number, patternLength: number): Step[]`
  - `projectOps.clearStepRange(trackId: number, start: number, end: number): void`
  - `projectOps.pasteSteps(trackId: number, cursor: number, rows: readonly Step[]): number` — returns rows written

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/src/stores/stepClipboard.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';
import { freshStep, type Step } from '@fiddle/shared';
import { useStepClipboardStore } from './stepClipboard';

describe('step clipboard store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts empty', () => {
    expect(useStepClipboardStore().rows).toBeNull();
  });

  it('set stores plain deep copies — later source mutations do not leak in', () => {
    const clip = useStepClipboardStore();
    const source = reactive<Step[]>([{ ...freshStep(), note: 'C', velocity: 0.5 }]);
    clip.set(source);
    source[0].note = 'G';
    source[0].velocity = 1;
    expect(clip.rows![0].note).toBe('C');
    expect(clip.rows![0].velocity).toBe(0.5);
  });

  it('copies the full row shape', () => {
    const clip = useStepClipboardStore();
    const step: Step = { note: 'E', octave: 5, length: 3, velocity: 0.7, muted: true, isChord: true, chordType: 'min' };
    clip.set([step]);
    expect(clip.rows![0]).toEqual(step);
  });
});
```

Add to `packages/client/src/project/mutations.test.ts` (create the file with this content if it does not exist; if it exists, append the two describe blocks and merge imports):

```ts
import { describe, it, expect } from 'vitest';
import { freshStep, type Step } from '@fiddle/shared';
import { clearRangeDraft, pasteStepsDraft } from './mutations';

describe('clearRangeDraft', () => {
  it('produces factory-default steps, one per row in [start, end]', () => {
    const draft = clearRangeDraft(3, 6);
    expect(draft).toHaveLength(4);
    for (const s of draft) expect(s).toEqual(freshStep());
  });
});

describe('pasteStepsDraft', () => {
  const rows: Step[] = [
    { ...freshStep(), note: 'C' },
    { ...freshStep(), note: 'D' },
    { ...freshStep(), note: 'E' },
  ];
  it('returns copies of all rows when they fit', () => {
    const draft = pasteStepsDraft(rows, 2, 16);
    expect(draft.map((s) => s.note)).toEqual(['C', 'D', 'E']);
    expect(draft[0]).not.toBe(rows[0]); // copy, not reference
  });
  it('clips at the pattern window', () => {
    expect(pasteStepsDraft(rows, 14, 16).map((s) => s.note)).toEqual(['C', 'D']);
    expect(pasteStepsDraft(rows, 15, 16)).toHaveLength(1);
  });
  it('returns [] when the cursor is at/past the window edge', () => {
    expect(pasteStepsDraft(rows, 16, 16)).toEqual([]);
  });
});
```

Append to `packages/client/src/app/projectOps.test.ts` (follow the file's existing harness for creating ops with a fake bus; the block below shows the assertions — adapt the setup lines to the existing helpers if they differ):

```ts
describe('step range ops', () => {
  function setup() {
    const project = freshProject();
    const dispatched: { path: Path; value: unknown; priorValue?: unknown }[] = [];
    const ops = createProjectOps({
      project,
      bus: {
        dispatchLocal: (cmd) => { dispatched.push(cmd); },
        loadProject: () => {},
      },
      isSyncLive: () => false,
      enqueue: () => {},
      canBulkLoad: () => false,
      sendLoad: () => {},
    });
    return { project, dispatched, ops };
  }

  it('clearStepRange dispatches only the leaves that differ from an empty step, with priors', () => {
    const { project, dispatched, ops } = setup();
    project.tracks[0].steps[2].note = 'C';
    project.tracks[0].steps[2].velocity = 0.5;
    project.tracks[0].steps[3].note = 'D';
    ops.clearStepRange(0, 2, 3);
    const paths = dispatched.map((d) => d.path.join('.'));
    expect(paths).toContain('tracks.0.steps.2.note');
    expect(paths).toContain('tracks.0.steps.2.velocity');
    expect(paths).toContain('tracks.0.steps.3.note');
    // untouched rows emit nothing
    expect(paths.every((p) => p.startsWith('tracks.0.steps.2') || p.startsWith('tracks.0.steps.3'))).toBe(true);
    const note2 = dispatched.find((d) => d.path.join('.') === 'tracks.0.steps.2.note')!;
    expect(note2.value).toBeNull();
    expect(note2.priorValue).toBe('C');
  });

  it('pasteSteps writes rows at the cursor, clips at patternLength, and returns the written count', () => {
    const { project, dispatched, ops } = setup();
    project.tracks[1].patternLength = 16;
    const rows = [
      { ...freshStep(), note: 'C' },
      { ...freshStep(), note: 'D' },
      { ...freshStep(), note: 'E' },
    ];
    const written = ops.pasteSteps(1, 14, rows);
    expect(written).toBe(2);
    const notePaths = dispatched.filter((d) => String(d.path[d.path.length - 1]) === 'note');
    expect(notePaths.map((d) => d.path.join('.'))).toEqual(['tracks.1.steps.14.note', 'tracks.1.steps.15.note']);
    expect(notePaths.map((d) => d.value)).toEqual(['C', 'D']);
  });

  it('pasteSteps of identical content dispatches nothing (diff-based)', () => {
    const { project, dispatched, ops } = setup();
    project.tracks[0].steps[0].note = 'C';
    const written = ops.pasteSteps(0, 0, [{ ...freshStep(), note: 'C' }]);
    expect(written).toBe(1); // row was in range and processed…
    expect(dispatched).toHaveLength(0); // …but no leaf differed
  });
});
```

(Ensure the test file imports `freshProject`, `freshStep` from `'../project'` or `'@fiddle/shared'` and `type Path` from `'@fiddle/shared'`, matching the file's existing imports.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/client && npx vitest run src/stores/stepClipboard.test.ts src/project/mutations.test.ts src/app/projectOps.test.ts`
Expected: FAIL — missing module / missing exports.

- [ ] **Step 3: Implement the clipboard store**

```ts
// packages/client/src/stores/stepClipboard.ts
//
// In-memory step clipboard — LOCAL ONLY (never synced, never persisted; gone
// on reload). Rows are plain deep copies: every Step field is a primitive, so
// a spread per row fully detaches from the reactive source.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Step } from '@fiddle/shared';

export const useStepClipboardStore = defineStore('stepClipboard', () => {
  const rows = ref<Step[] | null>(null);

  function set(steps: readonly Step[]): void {
    rows.value = steps.map((s) => ({ ...s }));
  }

  return { rows, set };
});
```

- [ ] **Step 4: Implement the drafts** (append to `packages/client/src/project/mutations.ts`)

```ts
export function clearRangeDraft(start: number, end: number): Step[] {
  return Array.from({ length: end - start + 1 }, () => freshStep());
}

// Rows to write starting at `cursor`, clipped at the pattern window: pasting
// never silently writes into invisible rows past the pattern end (spec).
export function pasteStepsDraft(
  rows: readonly Step[],
  cursor: number,
  patternLength: number,
): Step[] {
  return rows.slice(0, Math.max(0, patternLength - cursor)).map((s) => ({ ...s }));
}
```

- [ ] **Step 5: Implement the ops** (in `packages/client/src/app/projectOps.ts`)

Import the new drafts by extending the existing `'../project'` import list with `clearRangeDraft, pasteStepsDraft`, and add `import type { Step } from '@fiddle/shared';` (extend the existing `@fiddle/shared` import).

Generalize the window dispatch: replace the body of `dispatchStepsWindow` with a ranged variant and re-express it (keeping the existing callers unchanged):

```ts
  // Diff-and-dispatch `draft` against live steps starting at `startRow`.
  function dispatchStepsRange(trackId: number, startRow: number, draft: readonly Record<string, unknown>[]): void {
    const live = project.tracks[trackId].steps;
    for (let j = 0; j < draft.length; j++) {
      dispatchDiff(
        ['tracks', trackId, 'steps', startRow + j],
        draft[j],
        live[startRow + j] as unknown as Record<string, unknown>,
      );
    }
  }

  function dispatchStepsWindow(trackId: number, draft: readonly Record<string, unknown>[]): void {
    dispatchStepsRange(trackId, 0, draft);
  }
```

Add to the returned ops object (after `fillTrack`):

```ts
    // Selection ops (keyboard copy/cut/clear/paste). Same draft-diff-dispatch
    // discipline as clearTrack/fillTrack — every leaf carries its prior, so
    // sync rollback and future undo are preserved.
    clearStepRange(trackId: number, start: number, end: number): void {
      dispatchStepsRange(trackId, start, clearRangeDraft(start, end) as unknown as Record<string, unknown>[]);
    },
    /** Writes clipboard rows at `cursor`, clipped at the pattern window. Returns the number of rows written. */
    pasteSteps(trackId: number, cursor: number, rows: readonly Step[]): number {
      const draft = pasteStepsDraft(rows, cursor, project.tracks[trackId].patternLength);
      dispatchStepsRange(trackId, cursor, draft as unknown as Record<string, unknown>[]);
      return draft.length;
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/client && npx vitest run src/stores/stepClipboard.test.ts src/project/mutations.test.ts src/app/projectOps.test.ts`
Expected: PASS (all, including the pre-existing projectOps tests).

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/stores/stepClipboard.ts packages/client/src/stores/stepClipboard.test.ts packages/client/src/project/mutations.ts packages/client/src/project/mutations.test.ts packages/client/src/app/projectOps.ts packages/client/src/app/projectOps.test.ts
git commit -m "feat(client): step clipboard store + range drafts + clearStepRange/pasteSteps ops"
```
(with the trailer lines)

---

### Task 5: Tracker commands — `keyboard/trackerCommands.ts` + StudioView registration

**Files:**
- Create: `packages/client/src/keyboard/trackerCommands.ts`
- Modify: `packages/client/src/views/StudioView.vue` (register the command set)
- Test: `packages/client/src/keyboard/trackerCommands.test.ts`

**Interfaces:**
- Consumes: `KeyboardCommand` (Task 2), `useSelectionStore`/`ValidSelection` (Task 3), `useStepClipboardStore` + `projectOps.clearStepRange`/`pasteSteps` (Task 4), `KEY_BINDINGS` (Task 2).
- Produces:
  - `interface TrackerCommandDeps { selection; clipboard; project: Project; ops: { clearStepRange(trackId, start, end): void; pasteSteps(trackId, cursor, rows): number }; focusedTrackId: () => number | null }`
  - `createTrackerCommands(deps: TrackerCommandDeps): KeyboardCommand[]`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/client/src/keyboard/trackerCommands.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { freshProject } from '@fiddle/shared';
import { useProjectStore } from '../stores/project';
import { useSelectionStore } from '../stores/selection';
import { useStepClipboardStore } from '../stores/stepClipboard';
import { createTrackerCommands, type TrackerCommandDeps } from './trackerCommands';
import { KeyboardService, type KeyboardCommand } from './KeyboardService';
import { KEY_BINDINGS } from './bindings';

function byId(cmds: KeyboardCommand[], id: string): KeyboardCommand {
  const c = cmds.find((x) => x.id === id);
  if (!c) throw new Error(`missing command ${id}`);
  return c;
}
const run = (c: KeyboardCommand) => c.run(new KeyboardEvent('keydown'));

describe('trackerCommands', () => {
  let selection: ReturnType<typeof useSelectionStore>;
  let clipboard: ReturnType<typeof useStepClipboardStore>;
  let projectStore: ReturnType<typeof useProjectStore>;
  let ops: { clearStepRange: ReturnType<typeof vi.fn>; pasteSteps: ReturnType<typeof vi.fn> };
  let focused: number | null;
  let cmds: KeyboardCommand[];

  beforeEach(() => {
    setActivePinia(createPinia());
    projectStore = useProjectStore();
    selection = useSelectionStore();
    clipboard = useStepClipboardStore();
    ops = { clearStepRange: vi.fn(), pasteSteps: vi.fn(() => 0) };
    focused = null;
    const deps: TrackerCommandDeps = {
      selection, clipboard,
      project: projectStore.project,
      ops,
      focusedTrackId: () => focused,
    };
    cmds = createTrackerCommands(deps);
    projectStore.project.tracks[0].patternLength = 16;
    projectStore.project.tracks[0].steps[2].note = 'C';
    projectStore.project.tracks[0].steps[3].note = 'D';
  });

  it('enablement matrix: copy/cut/clear need a selection; paste needs selection AND clipboard', () => {
    for (const id of ['tracker.copy', 'tracker.cut', 'tracker.clear', 'tracker.paste']) {
      expect(byId(cmds, id).isEnabled!()).toBe(false);
    }
    selection.place(0, 2);
    expect(byId(cmds, 'tracker.copy').isEnabled!()).toBe(true);
    expect(byId(cmds, 'tracker.paste').isEnabled!()).toBe(false);
    clipboard.set([projectStore.project.tracks[0].steps[2]]);
    expect(byId(cmds, 'tracker.paste').isEnabled!()).toBe(true);
  });

  it('copy snapshots the selected rows into the clipboard', () => {
    selection.place(0, 2);
    selection.extendTo(0, 3);
    run(byId(cmds, 'tracker.copy'));
    expect(clipboard.rows!.map((s) => s.note)).toEqual(['C', 'D']);
  });

  it('cut = copy + clearStepRange; selection stays', () => {
    selection.place(0, 2);
    selection.extendTo(0, 3);
    run(byId(cmds, 'tracker.cut'));
    expect(clipboard.rows!.map((s) => s.note)).toEqual(['C', 'D']);
    expect(ops.clearStepRange).toHaveBeenCalledWith(0, 2, 3);
    expect(selection.validSelection).toEqual({ trackId: 0, start: 2, end: 3, head: 3 });
  });

  it('clear clears without touching the clipboard', () => {
    selection.place(0, 2);
    run(byId(cmds, 'tracker.clear'));
    expect(ops.clearStepRange).toHaveBeenCalledWith(0, 2, 2);
    expect(clipboard.rows).toBeNull();
  });

  it('paste pastes at the selection start and re-selects the written range', () => {
    clipboard.set([projectStore.project.tracks[0].steps[2], projectStore.project.tracks[0].steps[3]]);
    ops.pasteSteps.mockReturnValue(2);
    selection.place(0, 8);
    run(byId(cmds, 'tracker.paste'));
    expect(ops.pasteSteps).toHaveBeenCalledWith(0, 8, clipboard.rows);
    expect(selection.validSelection).toEqual({ trackId: 0, start: 8, end: 9, head: 9 });
  });

  it('paste that writes 0 rows leaves the selection alone', () => {
    clipboard.set([projectStore.project.tracks[0].steps[2]]);
    ops.pasteSteps.mockReturnValue(0);
    selection.place(0, 8);
    run(byId(cmds, 'tracker.paste'));
    expect(selection.validSelection).toEqual({ trackId: 0, start: 8, end: 8, head: 8 });
  });

  it('cursor commands: seed at row 0 of the focused track when no selection exists', () => {
    focused = 0;
    expect(byId(cmds, 'tracker.cursorDown').isEnabled!()).toBe(true);
    run(byId(cmds, 'tracker.cursorDown'));
    expect(selection.validSelection).toEqual({ trackId: 0, start: 0, end: 0, head: 0 });
  });

  it('cursor commands: disabled with no selection and no focused track', () => {
    expect(byId(cmds, 'tracker.cursorDown').isEnabled!()).toBe(false);
    expect(byId(cmds, 'tracker.extendDown').isEnabled!()).toBe(false);
  });

  it('cursor moves and extends once a selection exists', () => {
    selection.place(0, 5);
    run(byId(cmds, 'tracker.cursorDown'));
    expect(selection.validSelection!.head).toBe(6);
    run(byId(cmds, 'tracker.extendDown'));
    expect(selection.validSelection).toEqual({ trackId: 0, start: 6, end: 7, head: 7 });
    run(byId(cmds, 'tracker.cursorUp'));
    expect(selection.validSelection).toEqual({ trackId: 0, start: 6, end: 6, head: 6 });
  });

  it('deselect clears; enabled only while something is selected', () => {
    expect(byId(cmds, 'tracker.deselect').isEnabled!()).toBe(false);
    selection.place(0, 5);
    expect(byId(cmds, 'tracker.deselect').isEnabled!()).toBe(true);
    run(byId(cmds, 'tracker.deselect'));
    expect(selection.trackId).toBeNull();
  });

  it('cursor/extend commands allow key repeat; clipboard ops do not', () => {
    for (const id of ['tracker.cursorUp', 'tracker.cursorDown', 'tracker.extendUp', 'tracker.extendDown']) {
      expect(byId(cmds, id).allowRepeat).toBe(true);
    }
    for (const id of ['tracker.copy', 'tracker.cut', 'tracker.clear', 'tracker.paste']) {
      expect(byId(cmds, id).allowRepeat).not.toBe(true);
    }
  });
});

describe('bindings hygiene', () => {
  it('registering the full command set has no conflicts, and every tracker.* binding has a command', () => {
    setActivePinia(createPinia());
    const projectStore = useProjectStore();
    const deps: TrackerCommandDeps = {
      selection: useSelectionStore(),
      clipboard: useStepClipboardStore(),
      project: projectStore.project,
      ops: { clearStepRange: () => {}, pasteSteps: () => 0 },
      focusedTrackId: () => null,
    };
    const cmds = createTrackerCommands(deps);
    const service = new KeyboardService({ platform: 'mac', target: null });
    expect(() => { for (const c of cmds) service.register(c); }).not.toThrow();
    const ids = new Set(cmds.map((c) => c.id));
    for (const id of Object.keys(KEY_BINDINGS)) {
      if (id.startsWith('tracker.')) expect(ids.has(id), `binding ${id} has no command`).toBe(true);
    }
    service.dispose();
  });
});

describe('end-to-end keydown flow (service + stores + commands)', () => {
  it('mod+c on a selection copies; escape deselects; keys in an input do nothing', () => {
    setActivePinia(createPinia());
    const projectStore = useProjectStore();
    const selection = useSelectionStore();
    const clipboard = useStepClipboardStore();
    projectStore.project.tracks[0].patternLength = 16;
    projectStore.project.tracks[0].steps[1].note = 'F';
    const cmds = createTrackerCommands({
      selection, clipboard,
      project: projectStore.project,
      ops: { clearStepRange: () => {}, pasteSteps: () => 0 },
      focusedTrackId: () => null,
    });
    const service = new KeyboardService({ platform: 'mac', target: null });
    for (const c of cmds) service.register(c);

    selection.place(0, 1);
    service.handleKeydown(new KeyboardEvent('keydown', { key: 'c', metaKey: true, cancelable: true }));
    expect(clipboard.rows!.map((s) => s.note)).toEqual(['F']);

    // keydown originating from an input is fully ignored
    const input = document.createElement('input');
    document.body.appendChild(input);
    const fromInput = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(fromInput);
    service.handleKeydown(fromInput);
    expect(selection.trackId).toBe(0);
    input.remove();

    service.handleKeydown(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(selection.trackId).toBeNull();
    service.dispose();
  });
});
```

Add `// @vitest-environment jsdom` as the FIRST line of the file (KeyboardEvent + DOM elements are used).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/client && npx vitest run src/keyboard/trackerCommands.test.ts`
Expected: FAIL — cannot resolve `./trackerCommands`.

- [ ] **Step 3: Implement `trackerCommands.ts`**

```ts
// packages/client/src/keyboard/trackerCommands.ts
//
// The tracker's keyboard command set: selection movement + copy/cut/clear/
// paste. A pure factory over its dependencies — no component, no service,
// no window — so the whole behavior surface is unit-testable.
import type { Project, Step } from '@fiddle/shared';
import type { KeyboardCommand } from './KeyboardService';
import type { useSelectionStore } from '../stores/selection';
import type { useStepClipboardStore } from '../stores/stepClipboard';

export interface TrackerCommandDeps {
  selection: ReturnType<typeof useSelectionStore>;
  clipboard: ReturnType<typeof useStepClipboardStore>;
  project: Project;
  ops: {
    clearStepRange(trackId: number, start: number, end: number): void;
    pasteSteps(trackId: number, cursor: number, rows: readonly Step[]): number;
  };
  /** The focused-view track (StudioView's activeTrackIndex), or null in the overview. */
  focusedTrackId: () => number | null;
}

export function createTrackerCommands(deps: TrackerCommandDeps): KeyboardCommand[] {
  const { selection, clipboard, project, ops, focusedTrackId } = deps;

  const sel = () => selection.validSelection;
  const hasSelection = () => sel() !== null;

  function copySelection(): void {
    const s = sel();
    if (!s) return;
    clipboard.set(project.tracks[s.trackId].steps.slice(s.start, s.end + 1));
  }

  // Arrows: move the cursor when a selection exists; otherwise, in the
  // focused view, seed it at row 0 (keyboard-only entry — spec).
  function moveOrSeed(delta: number): void {
    if (sel()) { selection.moveCursor(delta); return; }
    const focused = focusedTrackId();
    if (focused !== null) selection.place(focused, 0);
  }

  return [
    {
      id: 'tracker.copy',
      description: 'Copy selected steps',
      context: 'tracker',
      isEnabled: hasSelection,
      run: copySelection,
    },
    {
      id: 'tracker.cut',
      description: 'Cut selected steps',
      context: 'tracker',
      isEnabled: hasSelection,
      run: () => {
        const s = sel();
        if (!s) return;
        copySelection();
        ops.clearStepRange(s.trackId, s.start, s.end);
      },
    },
    {
      id: 'tracker.clear',
      description: 'Clear selected steps',
      context: 'tracker',
      isEnabled: hasSelection,
      run: () => {
        const s = sel();
        if (!s) return;
        ops.clearStepRange(s.trackId, s.start, s.end);
      },
    },
    {
      id: 'tracker.paste',
      description: 'Paste steps at the selection',
      context: 'tracker',
      isEnabled: () => (clipboard.rows?.length ?? 0) > 0 && hasSelection(),
      run: () => {
        const s = sel();
        const rows = clipboard.rows;
        if (!s || !rows || rows.length === 0) return;
        // Paste target = top of the selection (== the cursor for a collapsed
        // selection). The op clips at the pattern window and reports back.
        const written = ops.pasteSteps(s.trackId, s.start, rows);
        if (written > 0) {
          selection.place(s.trackId, s.start);
          selection.extendTo(s.trackId, s.start + written - 1);
        }
      },
    },
    {
      id: 'tracker.cursorUp',
      description: 'Move cursor up',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: () => hasSelection() || focusedTrackId() !== null,
      run: () => moveOrSeed(-1),
    },
    {
      id: 'tracker.cursorDown',
      description: 'Move cursor down',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: () => hasSelection() || focusedTrackId() !== null,
      run: () => moveOrSeed(1),
    },
    {
      id: 'tracker.extendUp',
      description: 'Extend selection up',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: hasSelection,
      run: () => selection.extendCursor(-1),
    },
    {
      id: 'tracker.extendDown',
      description: 'Extend selection down',
      context: 'tracker',
      allowRepeat: true,
      isEnabled: hasSelection,
      run: () => selection.extendCursor(1),
    },
    {
      id: 'tracker.deselect',
      description: 'Clear selection',
      context: 'tracker',
      isEnabled: () => selection.trackId !== null,
      run: () => selection.clear(),
    },
  ];
}
```

- [ ] **Step 4: Register in StudioView**

In `packages/client/src/views/StudioView.vue` script setup, add imports:

```ts
import { useSelectionStore } from '../stores/selection';
import { useStepClipboardStore } from '../stores/stepClipboard';
import { createTrackerCommands } from '../keyboard/trackerCommands';
import { useKeyboardCommand } from '../keyboard/useKeyboardCommand';
```

After the existing `const projectStore = useProjectStore();` line and the `synth` destructuring (which provides `projectOps` and `activeTrackIndex`), add:

```ts
// Tracker keyboard commands (selection + copy/cut/clear/paste). Registered
// for this view's lifetime; the service lives on the runtime (via synth ctx).
const selectionStore = useSelectionStore();
const stepClipboard = useStepClipboardStore();
useKeyboardCommand(synth.keyboard, createTrackerCommands({
  selection: selectionStore,
  clipboard: stepClipboard,
  project,
  ops: projectOps,
  focusedTrackId: () => activeTrackIndex.value,
}));
```

Note: `project` here is the destructured reactive project from the synth context (already in scope). `synth.keyboard` exists after Task 2's synthContext change.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/client && npx vitest run src/keyboard/ && npx vue-tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/keyboard/trackerCommands.ts packages/client/src/keyboard/trackerCommands.test.ts packages/client/src/views/StudioView.vue
git commit -m "feat(client): tracker keyboard commands — copy/cut/clear/paste + cursor movement, registered in StudioView"
```
(with the trailer lines)

---

### Task 6: Tracker.vue selection UI

**Files:**
- Modify: `packages/client/src/components/Tracker.vue`
- Test: `packages/client/src/components/Tracker.test.ts` (extend the existing harness)

**Interfaces:**
- Consumes: `useSelectionStore` (Task 3). No new props/emits — Tracker talks to the store directly.
- Produces: the user-visible selection affordance; nothing programmatic.

- [ ] **Step 1: Write the failing tests**

Extend `packages/client/src/components/Tracker.test.ts`. It already mounts Tracker with a fake `SYNTH_CONTEXT` provide — reuse that harness. Two harness requirements: (a) Pinia must be installed on the test app (`app.use(createPinia())` before mount — add it if the harness doesn't have it; import `createPinia` from `'pinia'`); (b) get the selection store AFTER mounting via `useSelectionStore()` with the same pinia instance (`const pinia = createPinia(); app.use(pinia); ... useSelectionStore(pinia)`).

New tests (adapt prop names to the harness's existing mount helper — Tracker's required props include `steps`, `currentStep`, `title`, `trackId`, `engineType`, `patternLength`, `mixer`):

```ts
describe('step selection UI', () => {
  it('click on a step-number cell places the selection; shift+click extends it', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 2 });
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[3].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(selection.validSelection).toEqual({ trackId: 2, start: 3, end: 3, head: 3 });
    cells[6].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await nextTick();
    expect(selection.validSelection).toEqual({ trackId: 2, start: 3, end: 6, head: 6 });
  });

  it('selected rows get .selected and the head row gets .sel-cursor', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    selection.place(0, 1);
    selection.extendTo(0, 2);
    await nextTick();
    const rows = el.querySelectorAll('.step-row');
    expect(rows[1].classList.contains('selected')).toBe(true);
    expect(rows[2].classList.contains('selected')).toBe(true);
    expect(rows[2].classList.contains('sel-cursor')).toBe(true);
    expect(rows[1].classList.contains('sel-cursor')).toBe(false);
    expect(rows[0].classList.contains('selected')).toBe(false);
  });

  it('rows on a different track render unselected', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    selection.place(1, 1);
    await nextTick();
    expect(el.querySelector('.step-row.selected')).toBeNull();
  });
});
```

Where `mountTrackerWithPinia` is the existing mount helper extended to (1) install a fresh pinia on the app, (2) also mutate the project-store track (`useProjectStore(pinia)`) if the harness drives steps through the store, and (3) return `{ el, selection: useSelectionStore(pinia) }`. IMPORTANT: `selection.validSelection` validates against `useProjectStore().project` — the harness must ensure the project store's track at the tested `trackId` is `enabled` with `patternLength >= 16` (freshProject's default tracks satisfy this; set `patternLength = 16` explicitly if needed).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/client && npx vitest run src/components/Tracker.test.ts`
Expected: new tests FAIL (no click handling / classes yet); pre-existing tests PASS.

- [ ] **Step 3: Implement in Tracker.vue**

Script setup — add:

```ts
import { useSelectionStore } from '../stores/selection';
```

```ts
// Row selection (keyboard copy/cut/clear/paste). The step-number cell is the
// selection handle: click places, shift+click extends. Local UI state only.
const selection = useSelectionStore();

function onStepCellClick(e: MouseEvent, row: number): void {
  if (e.shiftKey) selection.extendTo(props.trackId, row);
  else selection.place(props.trackId, row);
}

// This track's cursor row (selection head), or null when the selection is
// elsewhere/invalid.
const cursorRow = computed(() => {
  const s = selection.validSelection;
  return s && s.trackId === props.trackId ? s.head : null;
});
```

Template — the step-number cell (line ~114, `<div class="col-step">{{ i.toString().padStart(2, '0') }}</div>`) becomes:

```html
<div class="col-step" @click="onStepCellClick($event, i)">{{ i.toString().padStart(2, '0') }}</div>
```

The step-row class binding (the object inside the `:class` array on `.step-row`) gains two entries:

```
{ active: currentStep >= 0 && (currentStep % patternLength) === i, 'step-muted': step.muted, 'with-vel': isFocused && isMelodic, selected: selection.isSelected(trackId, i), 'sel-cursor': cursorRow === i }
```

Auto-scroll — extract the contained-scroll block from the playhead watcher into a helper, call it from both watchers (playhead keeps ALL its guards; cursor-follow runs unconditionally — a keypress is deliberate):

```ts
// Contained scrollTop adjustment (never scrollIntoView, which can scroll the window).
function scrollRowIntoView(row: number): void {
  const el = stepsEl.value;
  if (!el) return;
  const rowEl = el.children[row] as HTMLElement | undefined;
  if (!rowEl) return;
  const e = el.getBoundingClientRect();
  const r = rowEl.getBoundingClientRect();
  if (r.top < e.top) el.scrollTop -= (e.top - r.top);
  else if (r.bottom > e.bottom) el.scrollTop += (r.bottom - e.bottom);
}

watch(() => props.currentStep, (cs) => {
  if (cs < 0 || props.patternLength <= 16) return; // not playing / no overflow → 0 cost
  if (editingInSteps) return;
  if (Date.now() - lastManualScrollAt < FOLLOW_GRACE_MS) return;
  scrollRowIntoView(cs % props.patternLength);
});

// Keyboard cursor follow: unconditional — the user just pressed a key and
// wants to see the cursor. (The manual-scroll grace only protects against
// the PLAYHEAD fighting the user.)
watch(cursorRow, (row) => {
  if (row === null || props.patternLength <= 16) return;
  scrollRowIntoView(row);
});
```

(The existing playhead watcher body is replaced by the guard lines + `scrollRowIntoView` call — delete the now-duplicated rect logic from it.)

Styles — add to the scoped block (near `.step-row.active`):

```css
/* Row selection: translucent track-color tint; distinct from the playhead's
   solid .active and from .step-muted's opacity. */
.step-row.selected {
  background: color-mix(in srgb, var(--track-color) 18%, #1a1a1a);
  border-color: color-mix(in srgb, var(--track-color) 45%, #282828);
}
/* The cursor (selection head): a solid track-color left edge. */
.step-row.sel-cursor {
  box-shadow: inset 3px 0 0 var(--track-color);
}
/* The step-number cell is the selection handle. */
.step-row .col-step {
  cursor: pointer;
  user-select: none; /* shift+click must not smear text selection */
}
.step-row .col-step:hover {
  color: var(--track-color);
}
```

Playhead precedence: `.step-row.active`'s rule already sets `background`/`border-color` and appears — keep `.active` declared AFTER `.selected` in the file so the playhead row stays readable when it crosses a selection.

- [ ] **Step 4: Run the full client suite + typecheck**

Run: `cd packages/client && npx vitest run && npx vue-tsc --noEmit`
Expected: all PASS (including every pre-existing Tracker test), no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Tracker.vue packages/client/src/components/Tracker.test.ts
git commit -m "feat(client): tracker row-selection UI — step-cell click handle, selection/cursor rendering, cursor auto-scroll"
```
(with the trailer lines)

---

## After all tasks (controller, not an implementer subagent)

1. Full gate: `npx vitest run` in `packages/client` (and shared/server suites to confirm untouched), `npm run build` in `packages/client`.
2. Mandatory browser verification on dev:obs (throwaway session) per the spec's Browser verification list: click/shift+click + arrows/shift+arrows/escape in overview AND focused views; cross-track copy→paste with clipping near the pattern end; cut/delete; typing in the name editor and length input with an active selection fires nothing; two-tab sync check; playhead-vs-selection visual distinctness; clean console; close the browser.
3. Update SDD ledger + memory; present finishing options.
