// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { router } from './index';

describe('router', () => {
  it('redirects / to /lobby', () => {
    const route = router.getRoutes().find((r) => r.path === '/');
    expect(route?.redirect).toBe('/lobby');
  });

  it('registers /lobby, /studio and /account routes', () => {
    const paths = router.getRoutes().map((r) => r.path);
    expect(paths).toContain('/lobby');
    expect(paths).toContain('/studio');
    expect(paths).toContain('/account');
  });
});
