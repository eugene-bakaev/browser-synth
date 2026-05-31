// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { router } from './index';

describe('router', () => {
  it('redirects / to /studio', () => {
    const route = router.getRoutes().find((r) => r.path === '/');
    expect(route?.redirect).toBe('/studio');
  });

  it('registers /studio and /account routes', () => {
    const paths = router.getRoutes().map((r) => r.path);
    expect(paths).toContain('/studio');
    expect(paths).toContain('/account');
  });
});
