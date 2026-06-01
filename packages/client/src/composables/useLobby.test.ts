import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../sync/sessionsApi', () => ({
  listSessions: vi.fn(),
}));
import { listSessions } from '../sync/sessionsApi';
import { useLobby } from './useLobby';

const mockList = listSessions as unknown as ReturnType<typeof vi.fn>;

describe('useLobby', () => {
  beforeEach(() => { vi.useFakeTimers(); mockList.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refresh populates sessions and clears loading', async () => {
    mockList.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const { sessions, loading, refresh } = useLobby();
    const p = refresh();
    expect(loading.value).toBe(true);
    await p;
    expect(loading.value).toBe(false);
    expect(sessions.value.map((s: any) => s.id)).toEqual(['a', 'b']);
  });

  it('captures an error message on failure', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    const { error, refresh } = useLobby();
    await refresh();
    expect(error.value).toContain('boom');
  });

  it('startPolling refreshes immediately and on the interval; stopPolling halts it', async () => {
    mockList.mockResolvedValue([]);
    const { startPolling, stopPolling } = useLobby();
    startPolling(3000);
    expect(mockList).toHaveBeenCalledTimes(1); // immediate
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockList).toHaveBeenCalledTimes(2);
    stopPolling();
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockList).toHaveBeenCalledTimes(2); // no more after stop
  });
});
