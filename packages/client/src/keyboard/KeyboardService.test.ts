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
