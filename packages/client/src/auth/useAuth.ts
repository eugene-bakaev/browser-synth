// Reactive auth state for the app. Module-singleton like presence: one session
// per tab. Wraps the Supabase client; no-ops gracefully when supabase is null
// (unconfigured) so guests are unaffected.
import { ref, computed, type Ref } from 'vue';
import { supabase } from './supabase.js';

interface SessionLike {
  user: { id: string };
  access_token: string;
}

const session: Ref<SessionLike | null> = ref(null);

export type SetUsernameResult = { ok: true } | { ok: false; reason: 'taken' | 'not-authed' };

// Resolves once the initial getSession + listener are wired, so callers (and
// tests) can await a known starting point.
const ready: Promise<void> = (async () => {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  session.value = (data.session as SessionLike | null) ?? null;
  supabase.auth.onAuthStateChange((_event, s) => {
    session.value = (s as SessionLike | null) ?? null;
  });
})();

const isAuthenticated = computed(() => session.value !== null);
const accessToken = computed(() => session.value?.access_token);

async function signInWithGoogle(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });
}

async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// Writes the chosen username to the user's own profiles row (RLS-guarded).
// A Postgres unique violation (23505) means the name is taken.
async function setUsername(username: string): Promise<SetUsernameResult> {
  if (!supabase || !session.value) return { ok: false, reason: 'not-authed' };
  const { error } = await supabase
    .from('profiles')
    .update({ username })
    .eq('id', session.value.user.id);
  if (error) {
    if ((error as { code?: string }).code === '23505') return { ok: false, reason: 'taken' };
    throw error;
  }
  return { ok: true };
}

export function useAuth() {
  return { ready, isAuthenticated, accessToken, session, signInWithGoogle, signOut, setUsername };
}
