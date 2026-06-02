import type { FastifyCorsOptions } from '@fastify/cors';

// In prod the client (Vercel) and server (Render) live on different origins, so
// the browser needs Access-Control-Allow-Origin on the /api responses or every
// cross-origin fetch fails ("Failed to fetch"). CORS_ORIGIN is an optional
// comma-separated allowlist; when unset we reflect any origin. That's safe here
// because the API authenticates with bearer tokens, not cookies — there are no
// credentialed cross-site requests to lock down.
export function resolveCorsOrigin(
  raw: string | undefined = process.env.CORS_ORIGIN,
): FastifyCorsOptions['origin'] {
  if (!raw) return true;
  const origins = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return origins.length > 0 ? origins : true;
}
