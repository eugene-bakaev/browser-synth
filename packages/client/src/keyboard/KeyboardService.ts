// The app's keyboard dispatcher — owns the app's single COMMAND-DISPATCH
// window keydown listener. Two legacy window Escape listeners coexist for
// now, outside this service: App.vue's sidebar-close handler and
// BaseModal.vue's dialog-close handler. Migrating them into the keyboard
// system as a higher-priority overlay/modal context is backlogged
// (docs/BACKLOG.md); see the modal guard below in handleKeydown for how the
// two worlds interact meanwhile.
// Commands are declarative data registered at runtime; bindings come from
// the KEY_BINDINGS table (or an injected one in tests). Created once per
// page by AppRuntime and disposed in its shutdown().
import {
  parseBinding, matchesEvent, sameDescriptor, detectPlatform,
  type KeyDescriptor, type Platform,
} from './keys';
import { KEY_BINDINGS } from './bindings';
import { isEditableTarget } from './isEditableTarget';

// Re-exported so existing/future importers can keep using it from here.
export { isEditableTarget };

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
  /** Default false. When true, the command fires even while an editable
   *  target is focused (still suppressed under an open modal). Reserved for
   *  truly app-global commands (undo/redo). */
  focusIndependent?: boolean;
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

// Guarded with typeof document !== 'undefined' because the service is
// constructible without a DOM (e.g. bindings-hygiene tests build one with
// target: null and never touch a real document).
function isModalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[aria-modal="true"]') !== null;
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
    // Guard 1 — modal dialog open: a modal is a stronger mode, so the whole
    // command system (including focusIndependent commands) stands down while
    // one is open. Left completely untouched — no preventDefault. Without
    // this, e.g. Escape would both close the modal (BaseModal's own
    // listener) AND run tracker.deselect behind it, and Delete/Backspace/
    // mod+v with an active selection would clear/paste steps invisibly
    // behind the open dialog. Detected semantically via aria-modal, which
    // BaseModal's dialog carries. When modal/overlay commands are migrated
    // into this service as a higher-priority context (backlogged,
    // docs/BACKLOG.md), this guard is replaced by that context.
    if (isModalOpen()) return;
    // Guard 2 — editable target: typing in a field NEVER triggers commands,
    // EXCEPT commands that opt in via focusIndependent (undo/redo). The
    // guard must stay for everything else so plain keys are not swallowed
    // from the field. Component-local key handling (e.g. Enter in
    // TrackNameEditor) is untouched: we listen in the bubble phase.
    const editable = isEditableTarget(e.target);
    const matches = this.registrations.filter((r) =>
      // Guard 3 — key auto-repeat, unless the command opted in.
      (!e.repeat || r.cmd.allowRepeat === true)
      && (!editable || r.cmd.focusIndependent === true)
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
