import { describe, it, expect } from 'vitest';
import { Voice } from './Voice';
import { MOD_SOURCES } from '@fiddle/shared';
import { PARAM_INDEX } from './params';

describe('Voice mod matrix (I3a)', () => {
  const SR = 48000;

  it('routes velocity → osc1.level (audible gain change)', () => {
    const levelIdx = PARAM_INDEX['osc1.level']; // descriptor index == slot index
    const velSrc = MOD_SOURCES.indexOf('velocity');

    const render = (withRoute: boolean) => {
      const v = new Voice(SR, 1);
      if (withRoute) v.setMatrixSlot(0, velSrc, levelIdx, 1); // +full-range level mod
      v.noteOn(220, 1.0, SR); // full velocity, 1s gate
      const out = new Float32Array(2048);
      v.renderAdd(out, 0, 2048);
      let rms = 0; for (const x of out) rms += x * x;
      return Math.sqrt(rms / out.length);
    };

    // With velocity=1 routed to level at amount=1, the level slot's base (0.8)
    // is pushed up (clamped at 1.0): louder than the unrouted render.
    expect(render(true)).toBeGreaterThan(render(false));
  });

  it('a none/zero matrix leaves output identical to no matrix', () => {
    const v1 = new Voice(SR, 1); v1.noteOn(220, 1, SR);
    const v2 = new Voice(SR, 1);
    for (let s = 0; s < 8; s++) v2.setMatrixSlot(s, 0, -1, 0); // explicit inert
    v2.noteOn(220, 1, SR);
    const a = new Float32Array(1024); const b = new Float32Array(1024);
    v1.renderAdd(a, 0, 1024); v2.renderAdd(b, 0, 1024);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 6);
  });

  it('noteOn resets prev-source memory so a reused voice has no bleed on first sample', () => {
    // Guard: noteOn must zero env1Prev so a stolen voice's first post-retrigger
    // sample is indistinguishable from a clean-state sample. Both voices share
    // identical osc/filter/slot state (same warmup with route inactive); the route
    // is added just before retrigger so only env1Prev differs between the
    // "reset" (real code) and "no-reset" (broken) cases.
    const env1Src = MOD_SOURCES.indexOf('env1');
    const levelIdx = PARAM_INDEX['osc1.level'];

    // Warm-up long enough to reach sustain (attack 480 + decay 9600 frames).
    const gate = 11000;
    const voiceA = new Voice(SR, 1); // will have route → tests the reset
    const voiceB = new Voice(SR, 1); // no route → reference (always unmodded)

    // Run both identically so their osc/filter/slot states are bit-for-bit equal.
    voiceA.noteOn(220, 1.0, gate); voiceB.noteOn(220, 1.0, gate);
    const buf = new Float32Array(gate);
    voiceA.renderAdd(buf, 0, gate);
    voiceB.renderAdd(buf.fill(0), 0, gate);

    // Activate route on A only AFTER warmup; both retrigger into steal mode (level ≈ 0.5).
    voiceA.setMatrixSlot(0, env1Src, levelIdx, 1);
    voiceA.noteOn(220, 1.0, SR); voiceB.noteOn(220, 1.0, SR);

    const outA = new Float32Array(1); const outB = new Float32Array(1);
    voiceA.renderAdd(outA, 0, 1);   voiceB.renderAdd(outB, 0, 1);

    // With reset: env1Prev=0 on first steal frame → A's route has no effect → A==B.
    // Without reset: env1Prev≈0.5 → level 0.8→clamped 1.0 → A≠B by ~0.1.
    expect(outA[0]).toBeCloseTo(outB[0], 6);
  });
});
