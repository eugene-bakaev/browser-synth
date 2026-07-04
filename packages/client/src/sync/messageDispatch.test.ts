import { describe, it, expect, vi } from 'vitest';
import { dispatchServerMessage, type DispatchDeps } from './messageDispatch.js';
import { createCommandBus } from './CommandBus.js';
import { LoadTracker } from './LoadTracker.js';
import { replaceProject } from '../project';
import { freshProject, setDeep, TRACK_POOL_SIZE, type Project, type ServerMessage } from '@fiddle/shared';

function deps(project: Project): DispatchDeps {
  return {
    wsClient: { recordOpIdSeen: vi.fn(), opIdLastSeen: vi.fn(() => 0), requestResync: vi.fn() } as unknown as DispatchDeps['wsClient'],
    outbox: {
      onLive: vi.fn(), onEcho: vi.fn(), onNack: vi.fn(), reassertPending: vi.fn(),
      hasPendingForPath: vi.fn(() => false),
    } as unknown as DispatchDeps['outbox'],
    loadTracker: new LoadTracker({ send: vi.fn(), rollback: vi.fn(), onError: vi.fn(), requireSnapshot: vi.fn() }),
    onFatalError: vi.fn(),
    commandBus: createCommandBus({
      applySet: (path, value) => setDeep(project as unknown as Record<string, unknown>, path, value),
      loadProject: (next) => replaceProject(project, next),
      enqueue: vi.fn(),
    }),
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

describe('self-echo skip (M2)', () => {
  it('does not write a self-echo when a newer local edit is pending for the path', () => {
    const project = freshProject();
    project.bpm = 150; // local state has advanced past the echoed value
    const d = deps(project);
    (d.outbox as any).hasPendingForPath = vi.fn(() => true);

    dispatchServerMessage(
      { v: 1, type: 'set', opId: 1, clientId: 'me', clientSeq: 7, path: ['bpm'], value: 140 },
      d,
    );

    expect(project.bpm).toBe(150); // echo of the older value did not snap it back
    expect(d.outbox.onEcho).toHaveBeenCalledWith(7);
    expect(d.wsClient.recordOpIdSeen).toHaveBeenCalledWith(1);
  });

  it('still advances the per-path opId watermark on a skipped echo', () => {
    const project = freshProject();
    const d = deps(project);
    (d.outbox as any).hasPendingForPath = vi.fn(() => true);

    // Skipped self-echo at opId 5...
    dispatchServerMessage(
      { v: 1, type: 'set', opId: 5, clientId: 'me', clientSeq: 7, path: ['bpm'], value: 140 },
      d,
    );
    // ...must make an older replayed op (opId 3) for the same path a no-op.
    (d.wsClient as any).opIdLastSeen = () => 5;
    dispatchServerMessage(
      { v: 1, type: 'set', opId: 3, clientId: 'peer', path: ['bpm'], value: 99 },
      d,
    );
    expect(project.bpm).not.toBe(99);
  });

  it('applies a self-echo normally when nothing newer is pending', () => {
    const project = freshProject();
    const d = deps(project);
    dispatchServerMessage(
      { v: 1, type: 'set', opId: 1, clientId: 'me', clientSeq: 7, path: ['bpm'], value: 140 },
      d,
    );
    expect(project.bpm).toBe(140);
  });

  it('never skips a peer op (clientSeq absent), pending or not', () => {
    const project = freshProject();
    const d = deps(project);
    (d.outbox as any).hasPendingForPath = vi.fn(() => true);
    dispatchServerMessage(
      { v: 1, type: 'set', opId: 1, clientId: 'peer', path: ['bpm'], value: 133 },
      d,
    );
    expect(project.bpm).toBe(133);
    expect((d.outbox as any).hasPendingForPath).not.toHaveBeenCalled();
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
