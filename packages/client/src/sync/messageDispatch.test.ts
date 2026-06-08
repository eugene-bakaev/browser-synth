import { describe, it, expect, vi } from 'vitest';
import { dispatchServerMessage, type DispatchDeps } from './messageDispatch.js';
import { freshProject, TRACK_POOL_SIZE, type Project, type ServerMessage } from '@fiddle/shared';

function deps(project: Project): DispatchDeps {
  return {
    project,
    wsClient: { recordOpIdSeen: vi.fn() } as unknown as DispatchDeps['wsClient'],
    outbox: { onLive: vi.fn(), onEcho: vi.fn(), onNack: vi.fn(), reassertPending: vi.fn() } as unknown as DispatchDeps['outbox'],
    onFatalError: vi.fn(),
  };
}

describe('snapshot normalization', () => {
  it('pads a legacy 4-track snapshot to 32 slots before applying', () => {
    const target = freshProject();
    const legacy = freshProject();
    legacy.tracks = legacy.tracks.slice(0, 4); // simulate an old server snapshot
    const msg: ServerMessage = { v: 1, type: 'snapshot', opId: 0, project: legacy };

    dispatchServerMessage(msg, deps(target));

    expect(target.tracks).toHaveLength(TRACK_POOL_SIZE);
    expect(target.tracks.slice(0, 4).every((t) => t.enabled)).toBe(true);
  });
});

describe('snapshot reconcile', () => {
  it('re-asserts pending edits after applying a snapshot', () => {
    const project = freshProject();
    const d = deps(project);
    dispatchServerMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() }, d);
    expect(d.outbox.reassertPending).toHaveBeenCalledTimes(1);
  });
});
