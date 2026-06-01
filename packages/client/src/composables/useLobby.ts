import { ref, type Ref } from 'vue';
import type { LobbyEntry } from '@fiddle/shared';
import { listSessions } from '../sync/sessionsApi';

// Reactive lobby state: the session list plus a poll loop for live member counts.
// Logic-only (no DOM) so it is unit-testable; LobbyView wires it to lifecycle.
export function useLobby() {
  const sessions: Ref<LobbyEntry[]> = ref([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

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

  function startPolling(intervalMs = 3000): void {
    if (timer) return;
    void refresh(); // immediate
    timer = setInterval(() => { void refresh(); }, intervalMs);
  }

  function stopPolling(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { sessions, loading, error, refresh, startPolling, stopPolling };
}
