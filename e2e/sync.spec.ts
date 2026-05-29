import { test, expect, type Page } from '@playwright/test';

// Each run uses a fresh room id so repeated runs (and the in-memory server's
// surviving rooms) never collide.
function freshRoom(): string {
  return `e2e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

// Open the app in a room and click PLAY — sync comes up inside ensureAudio(),
// which the PLAY gesture triggers. Resolve once our own roster chip appears
// (i.e. `welcome` has landed).
async function boot(page: Page, room: string): Promise<void> {
  await page.goto(`/r/${room}`);
  await page.getByRole('button', { name: 'PLAY' }).click();
  // Our own welcome has landed once at least one roster chip is rendered.
  await expect(page.locator('.room-bar .chip').first()).toBeVisible();
}

// First step-note <select> (track 0, step 0) — bound to step.note, so it
// exercises the steps → emitLeafDiff → applyOp round trip.
const firstNote = (page: Page) => page.locator('select:not(.tool-select)').first();

// Focus track 0 (the overview tracker title bar emits select-track) so the
// engine selector + per-track mixer strips are on screen.
async function focusTrack0(page: Page): Promise<void> {
  await page.locator('.tracker-title-bar').first().click();
  await expect(page.locator('.engine-selector')).toBeVisible();
}

test('two clients sync roster, bpm, and step edits', async ({ browser }) => {
  const room = freshRoom();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await boot(a, room);
    await boot(b, room);

    // Presence: each tab sees both members once B has joined.
    await expect(a.locator('.room-bar .chip')).toHaveCount(2);
    await expect(b.locator('.room-bar .chip')).toHaveCount(2);

    // BPM round-trip (B → A): bpm watcher → Outbox → server → applyOp on A.
    await b.locator('.bpm input').fill('143');
    await expect(a.locator('.bpm input')).toHaveValue('143');

    // Step-note round-trip (A → B): the steps watcher's emitLeafDiff path.
    await firstNote(a).selectOption('C');
    await expect(firstNote(b)).toHaveValue('C');

    // Stable — no echo loop pushed A's bpm back off 143.
    await expect(a.locator('.bpm input')).toHaveValue('143');
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('engine swap and mixer mute sync between clients', async ({ browser }) => {
  const room = freshRoom();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await boot(a, room);
    await boot(b, room);
    await focusTrack0(a);
    await focusTrack0(b);

    // engineType round-trip (A → B): the engineType watcher's emit.
    await a.locator('.engine-selector button', { hasText: 'KICK' }).click();
    await expect(b.locator('.engine-selector button.active')).toHaveText('KICK');

    // Mixer mute round-trip (A → B): the mixer watcher's emitLeafDiff (discrete
    // → immediate). Strip 0's mute button reflects tracks[0].mixer.muted.
    await a.locator('.btn-mute').first().click();
    await expect(b.locator('.btn-mute').first()).toHaveClass(/active/);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('reconnects after going offline and flushes the coalesced final value', async ({ browser }) => {
  const room = freshRoom();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    await boot(a, room);
    await boot(b, room);
    await a.locator('.bpm input').fill('120');
    await expect(b.locator('.bpm input')).toHaveValue('120');

    // Cut A's network. The WS drops; A's edits queue in the Outbox offline
    // queue (coalesced per path, last-write-wins) instead of going out.
    await ctxA.setOffline(true);
    await a.locator('.bpm input').fill('150');
    await a.locator('.bpm input').fill('151');
    await a.locator('.bpm input').fill('152');
    // B hasn't seen any of them.
    await expect(b.locator('.bpm input')).toHaveValue('120');

    // Back online → WsClient reconnects (resume) and onLive flushes the single
    // coalesced final value to the server, which broadcasts it to B.
    await ctxA.setOffline(false);
    await expect(b.locator('.bpm input')).toHaveValue('152', { timeout: 20_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('a refused fatal error surfaces the ErrorOverlay', async ({ browser }) => {
  // Fill the room to its cap (4), then a 5th client should get room.full and
  // render the overlay with the "Create a new room" action.
  const room = freshRoom();
  const ctxs = [];
  try {
    for (let i = 0; i < 4; i++) {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await boot(p, room);
      ctxs.push(ctx);
    }
    const ctx5 = await browser.newContext();
    ctxs.push(ctx5);
    const fifth = await ctx5.newPage();
    await fifth.goto(`/r/${room}`);
    await fifth.getByRole('button', { name: 'PLAY' }).click();

    await expect(fifth.locator('.error-overlay')).toBeVisible();
    await expect(fifth.locator('.error-overlay h2')).toHaveText('Room is full');
    await expect(fifth.getByRole('button', { name: 'Create a new room' })).toBeVisible();
  } finally {
    for (const c of ctxs) await c.close();
  }
});
