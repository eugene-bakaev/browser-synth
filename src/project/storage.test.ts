import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reactive } from 'vue';
import { loadProject, installAutoSave, serializeProject, deserializeProject } from './storage';
import { freshProject } from './factory';
import { PROJECT_SCHEMA_VERSION } from './types';

const STORAGE_KEY = 'fiddle:project';

function mockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((k: string) => store.has(k) ? store.get(k)! : null),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v); }),
    removeItem: vi.fn((k: string) => { store.delete(k); }),
    clear: vi.fn(() => { store.clear(); }),
    _peek: () => Object.fromEntries(store),
  };
}

describe('loadProject', () => {
  let ls: ReturnType<typeof mockLocalStorage>;
  beforeEach(() => {
    ls = mockLocalStorage();
    vi.stubGlobal('localStorage', ls);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns freshProject when storage is empty', () => {
    const p = loadProject();
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(p.bpm).toBe(120);
  });

  it('returns a restored project for a valid V1 doc', () => {
    const seed = freshProject();
    seed.bpm = 144;
    ls.setItem(STORAGE_KEY, JSON.stringify(seed));
    const p = loadProject();
    expect(p.bpm).toBe(144);
  });

  it('returns freshProject + warns for malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ls.setItem(STORAGE_KEY, '{not json');
    const p = loadProject();
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns freshProject when getItem itself throws', () => {
    ls.getItem.mockImplementation(() => { throw new Error('sandbox'); });
    const p = loadProject();
    expect(p.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('reconciles a loaded doc against current defaults', () => {
    const partial = { schemaVersion: 1, bpm: 100, tracks: [{}, {}, {}, {}] };
    ls.setItem(STORAGE_KEY, JSON.stringify(partial));
    const p = loadProject();
    // Engines filled in from defaults
    expect(p.tracks[0].engines.synth).toBeDefined();
    expect(p.tracks[0].engines.kick).toBeDefined();
    // 16 steps materialized
    expect(p.tracks[0].steps).toHaveLength(16);
  });
});

describe('installAutoSave', () => {
  let ls: ReturnType<typeof mockLocalStorage>;
  beforeEach(() => {
    ls = mockLocalStorage();
    vi.stubGlobal('localStorage', ls);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not write immediately', () => {
    const p = reactive(freshProject());
    installAutoSave(p);
    expect(ls.setItem).not.toHaveBeenCalled();
  });

  it('writes once after debounce window when project mutates', async () => {
    const p = reactive(freshProject());
    installAutoSave(p);
    p.bpm = 140;
    await Promise.resolve();      // let Vue flush the watcher
    vi.advanceTimersByTime(500);
    expect(ls.setItem).toHaveBeenCalledTimes(1);
    const written = JSON.parse(ls.setItem.mock.calls[0][1] as string);
    expect(written.bpm).toBe(140);
  });

  it('coalesces a 200-mutation burst into one write', async () => {
    const p = reactive(freshProject());
    installAutoSave(p);
    for (let i = 0; i < 200; i++) {
      p.bpm = 100 + i;
      await Promise.resolve();
    }
    vi.advanceTimersByTime(500);
    expect(ls.setItem).toHaveBeenCalledTimes(1);
  });

  it('the dispose function stops further writes', async () => {
    const p = reactive(freshProject());
    const stop = installAutoSave(p);
    stop();
    p.bpm = 140;
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(ls.setItem).not.toHaveBeenCalled();
  });

  it('swallows setItem errors (does not crash)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ls.setItem.mockImplementation(() => { throw new Error('quota'); });
    const p = reactive(freshProject());
    installAutoSave(p);
    p.bpm = 140;
    await Promise.resolve();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('serializeProject', () => {
  it('produces JSON identical to JSON.stringify(toRaw(project))', () => {
    const p = freshProject();
    p.bpm = 144;
    p.tracks[0].engines.synth.filterCutoff = 1234;
    const json = serializeProject(p);
    const parsed = JSON.parse(json);
    expect(parsed.bpm).toBe(144);
    expect(parsed.tracks[0].engines.synth.filterCutoff).toBe(1234);
    expect(parsed.schemaVersion).toBe(1);
  });

  it('strips Vue reactive proxies (uses toRaw under the hood)', () => {
    const p = reactive(freshProject());
    p.bpm = 100;
    const json = serializeProject(p);
    // If we hadn't called toRaw, JSON.stringify could leak proxy metadata or
    // throw on circular reactive structures. Spot-check the output is plain.
    const parsed = JSON.parse(json);
    expect(parsed.bpm).toBe(100);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe('deserializeProject', () => {
  it('round-trips through serializeProject', () => {
    const p = freshProject();
    p.bpm = 99;
    p.tracks[1].engines.kick.tune = 70;
    const restored = deserializeProject(serializeProject(p));
    expect(restored.bpm).toBe(99);
    expect(restored.tracks[1].engines.kick.tune).toBe(70);
  });

  it('fills missing fields via the reconciler', () => {
    const partial = JSON.stringify({
      schemaVersion: 1,
      bpm: 130,
      tracks: [{}, {}, {}, {}],
    });
    const restored = deserializeProject(partial);
    expect(restored.tracks[0].engines.synth).toBeDefined();
    expect(restored.tracks[0].steps).toHaveLength(16);
  });

  it('returns freshProject (with warn) on malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restored = deserializeProject('{not json');
    expect(restored.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws for an unknown future schemaVersion', () => {
    const future = JSON.stringify({ schemaVersion: 99, bpm: 100, tracks: [] });
    expect(() => deserializeProject(future)).toThrowError(/Unknown project schemaVersion: 99/);
  });
});
