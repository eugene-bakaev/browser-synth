import { ref, type Ref } from 'vue';
import type { LobbyEntry } from '@fiddle/shared';
import { listSessions } from '../sync/sessionsApi';

// How often the lobby re-fetches the session list while the tab is foregrounded.
// The list changes rarely (sessions created/closed, member counts), so a slow
// poll is plenty — and it stops entirely while the tab is hidden (see below).
// This used to be 3s, which meant a single forgotten lobby tab hammered the DB
// ~1,200x/hour forever, burning the free-tier Disk IO budget while idle.
const DEFAULT_INTERVAL_MS = 30_000;

// Reactive lobby state: the session list plus a poll loop for live member counts.
// The loop pauses while the browser tab is hidden and resumes (with an immediate
// catch-up refresh) when it becomes visible again, so a backgrounded tab costs
// nothing. Logic lives here (unit-testable); LobbyView only wires lifecycle.
export function useLobby() {
  const sessions: Ref<LobbyEntry[]> = ref([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let polling = false;
  let onVisibilityChange: (() => void) | null = null;

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      sessions.value = await listSessions();
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'failed to load sessions';
    } finally {
      loading.value = false;
    }
  }

  function startTicking(): void {
    if (timer) return;
    timer = setInterval(() => { void refresh(); }, intervalMs);
  }

  function stopTicking(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function startPolling(ms = DEFAULT_INTERVAL_MS): void {
    if (polling) return;
    polling = true;
    intervalMs = ms;
    void refresh(); // immediate
    // Only tick while visible; if we start on a hidden tab, wait for it to show.
    if (typeof document === 'undefined' || !document.hidden) startTicking();
    if (typeof document !== 'undefined') {
      onVisibilityChange = () => {
        if (document.hidden) {
          stopTicking(); // pause — a backgrounded tab must not poll
        } else {
          void refresh(); // catch up immediately on return
          startTicking();
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  }

  function stopPolling(): void {
    polling = false;
    stopTicking();
    if (onVisibilityChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      onVisibilityChange = null;
    }
  }

  return { sessions, loading, error, refresh, startPolling, stopPolling };
}
