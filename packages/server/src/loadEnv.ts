// Loads packages/server/.env for local dev so SUPABASE_JWKS_URL / DATABASE_URL
// (and PORT/HOST) can live in a gitignored file. Imported for its side effect
// as the very first import in index.ts, so it runs before any env is read.
//
// Render/production inject env vars straight into process.env and ship no .env
// file, so loadEnvFile throws ENOENT there — we swallow it and fall back to the
// ambient environment. The same path serves the guest-only (no Supabase) case.
try {
  process.loadEnvFile();
} catch {
  // No .env file present — use the ambient environment as-is.
}
