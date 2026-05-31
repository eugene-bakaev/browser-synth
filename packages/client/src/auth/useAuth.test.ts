// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mutable mock state. Defined via vi.hoisted so it's initialized before
// the hoisted vi.mock factory (which references fakeClient) runs.
const h = vi.hoisted(() => {
  const authState = { current: null as null | { user: { id: string }; access_token: string } };
  const cb = { current: null as null | ((event: string, session: unknown) => void) };
  const fakeClient = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: authState.current } })),
      onAuthStateChange: vi.fn((c: (e: string, s: unknown) => void) => {
        cb.current = c;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: vi.fn(() => ({
      update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
    })),
  };
  return { authState, cb, fakeClient };
});

vi.mock('./supabase', () => ({ supabase: h.fakeClient }));

import { useAuth, userProfileFromSession } from './useAuth';

beforeEach(() => {
  h.authState.current = null;
  vi.clearAllMocks();
  // useAuth is a module singleton: the auth listener is registered once at
  // import, so we keep the captured callback and reset the session to a known
  // signed-out state by pushing a signed-out event through it.
  h.cb.current?.('SIGNED_OUT', null);
});

describe('useAuth', () => {
  it('starts signed out', async () => {
    const auth = useAuth();
    await auth.ready;
    expect(auth.isAuthenticated.value).toBe(false);
    expect(auth.accessToken.value).toBeUndefined();
  });

  it('reflects a sign-in pushed through onAuthStateChange', async () => {
    const auth = useAuth();
    await auth.ready;
    h.cb.current?.('SIGNED_IN', { user: { id: 'u-1' }, access_token: 'tok-1' });
    expect(auth.isAuthenticated.value).toBe(true);
    expect(auth.accessToken.value).toBe('tok-1');
  });

  it('signInWithGoogle calls signInWithOAuth with provider google', async () => {
    const auth = useAuth();
    await auth.ready;
    await auth.signInWithGoogle();
    expect(h.fakeClient.auth.signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' }),
    );
  });

  it('setUsername maps a unique violation to { ok: false, reason: "taken" }', async () => {
    h.fakeClient.from.mockReturnValueOnce({
      update: () => ({ eq: async () => ({ error: { code: '23505' } }) }),
    } as never);
    const auth = useAuth();
    await auth.ready;
    h.cb.current?.('SIGNED_IN', { user: { id: 'u-1' }, access_token: 'tok-1' });
    const res = await auth.setUsername('taken-name');
    expect(res).toEqual({ ok: false, reason: 'taken' });
  });

  it('userProfileFromSession extracts email/name/avatar, null when absent', () => {
    expect(userProfileFromSession(null)).toEqual({
      email: null,
      name: null,
      avatarUrl: null,
    });
    expect(
      userProfileFromSession({
        user: {
          id: 'u-1',
          email: 'a@b.com',
          user_metadata: { name: 'Ada', avatar_url: 'http://x/a.png' },
        },
        access_token: 'tok',
      }),
    ).toEqual({ email: 'a@b.com', name: 'Ada', avatarUrl: 'http://x/a.png' });
  });

  it('exposes a reactive userProfile from the session', async () => {
    const auth = useAuth();
    await auth.ready;
    expect(auth.userProfile.value).toEqual({ email: null, name: null, avatarUrl: null });
    h.cb.current?.('SIGNED_IN', {
      user: {
        id: 'u-1',
        email: 'a@b.com',
        user_metadata: { name: 'Ada', avatar_url: 'http://x/a.png' },
      },
      access_token: 'tok-1',
    });
    expect(auth.userProfile.value).toEqual({
      email: 'a@b.com',
      name: 'Ada',
      avatarUrl: 'http://x/a.png',
    });
  });
});
