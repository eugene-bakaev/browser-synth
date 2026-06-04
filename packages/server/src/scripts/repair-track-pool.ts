// One-time repair sweep: bring every stored session snapshot up to the
// well-formed track-pool shape (32 slots, boolean enabled, >=1 enabled,
// current schemaVersion). Fixes already-corrupted rows (e.g. a session stored
// with 0 enabled tracks) and inoculates legacy pre-pool rows.
//
// normalizeTrackPool is idempotent and returns its input by reference when the
// project is already valid, so this is safe to re-run and only writes rows that
// actually change.
//
// Usage (from packages/server):
//   tsx src/scripts/repair-track-pool.ts          # dry run — reports, writes nothing
//   tsx src/scripts/repair-track-pool.ts --apply   # actually writes repaired rows
//
// DATABASE_URL is read from packages/server/.env (via loadEnv) or the ambient
// environment, exactly like the server.
import '../loadEnv.js';
import postgres from 'postgres';
import { normalizeTrackPool, type Project } from '@fiddle/shared';

const apply = process.argv.includes('--apply');

function describe(p: Project): string {
  const slots = Array.isArray(p.tracks) ? p.tracks.length : 0;
  const enabled = Array.isArray(p.tracks) ? p.tracks.filter(t => t.enabled).length : 0;
  return `slots=${slots} enabled=${enabled} schemaVersion=${p.schemaVersion}`;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL is not set (check packages/server/.env). Aborting.');
    process.exit(1);
  }

  const sql = postgres(dbUrl);
  try {
    const rows = await sql<{ session_id: string; project: Project }[]>`
      select session_id, project from session_snapshots
    `;
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: scanning ${rows.length} snapshot(s)\n`);

    let changed = 0;
    for (const { session_id, project } of rows) {
      const repaired = normalizeTrackPool(project);
      if (repaired === project) continue; // already valid — untouched

      changed++;
      console.log(`${session_id}:`);
      console.log(`  before: ${describe(project)}`);
      console.log(`  after:  ${describe(repaired)}`);

      if (apply) {
        await sql`
          update session_snapshots
          set project = ${sql.json(repaired as unknown as never)}, updated_at = now()
          where session_id = ${session_id}
        `;
      }
    }

    console.log(
      `\n${apply ? 'Repaired' : 'Would repair'} ${changed} of ${rows.length} snapshot(s).` +
        (apply ? '' : ' Re-run with --apply to write.'),
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
