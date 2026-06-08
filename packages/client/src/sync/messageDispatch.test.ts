import { describe, it, expect, vi } from 'vitest';
import { dispatchServerMessage, type DispatchDeps } from './messageDispatch.js';
import { freshProject, TRACK_POOL_SIZE, type Project, type ServerMessage } from '@fiddle/shared';

function deps(project: Project): DispatchDeps {
  return {
    project,
    wsClient: { recordOpIdSeen: vi.fn(), opIdLastSeen: vi.fn(() => 0), requestResync: vi.fn() } as unknown as DispatchDeps['wsClient'],
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

describe('opId gap detection', () => {
  it('requests a resync when an inbound set skips an opId', () => {
    const project = freshProject();
    const d = deps(project);
    (d.wsClient as any).opIdLastSeen = () => 5; // applied up to opId 5
    // opId 7 means opId 6 was missed.
    dispatchServerMessage({ v: 1, type: 'set', opId: 7, clientId: 'peer', path: ['bpm'], value: 130 }, d);
    expect(d.wsClient.requestResync).toHaveBeenCalledWith(5);
  });

  it('does not request a resync for a contiguous opId', () => {
    const project = freshProject();
    const d = deps(project);
    (d.wsClient as any).opIdLastSeen = () => 5;
    dispatchServerMessage({ v: 1, type: 'set', opId: 6, clientId: 'peer', path: ['bpm'], value: 130 }, d);
    expect(d.wsClient.requestResync).not.toHaveBeenCalled();
  });
});
