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

describe('Voice LFO sources (I3b)', () => {
  const SR = 48000;

  it('routes lfo1 → osc1.level so the LFO audibly modulates the output', () => {
    const levelIdx = PARAM_INDEX['osc1.level'];
    const lfo1Src = MOD_SOURCES.indexOf('lfo1');
    const render = (route: boolean) => {
      const v = new Voice(SR, 1);
      v.slots[PARAM_INDEX['lfo1.rate']].setBase(200); // fast ⇒ clearly cyclic in-window
      if (route) v.setMatrixSlot(0, lfo1Src, levelIdx, 1);
      v.noteOn(220, 1.0, SR);
      const out = new Float32Array(4096);
      v.renderAdd(out, 0, 4096);
      return out;
    };
    const base = render(false), routed = render(true);
    let maxDiff = 0;
    for (let i = 0; i < base.length; i++) maxDiff = Math.max(maxDiff, Math.abs(base[i] - routed[i]));
    expect(maxDiff).toBeGreaterThan(0.01);
  });

  it('routes lfo2 → osc1.level too (the second LFO is wired symmetrically)', () => {
    const levelIdx = PARAM_INDEX['osc1.level'];
    const lfo2Src = MOD_SOURCES.indexOf('lfo2');
    const render = (route: boolean) => {
      const v = new Voice(SR, 1);
      v.slots[PARAM_INDEX['lfo2.rate']].setBase(200);
      if (route) v.setMatrixSlot(0, lfo2Src, levelIdx, 1);
      v.noteOn(220, 1.0, SR);
      const out = new Float32Array(4096);
      v.renderAdd(out, 0, 4096);
      return out;
    };
    const base = render(false), routed = render(true);
    let maxDiff = 0;
    for (let i = 0; i < base.length; i++) maxDiff = Math.max(maxDiff, Math.abs(base[i] - routed[i]));
    expect(maxDiff).toBeGreaterThan(0.01);
  });

  it('noteOn retriggers LFO phase so a reused voice has no bleed on the first sample', () => {
    // Mirrors the env1Prev bleed test: both voices share identical osc/filter/slot
    // state; only the LFO phase/prev differs between reset (real) and no-reset (broken).
    const lfo1Src = MOD_SOURCES.indexOf('lfo1');
    const levelIdx = PARAM_INDEX['osc1.level'];
    const gate = 11000;

    const a = new Voice(SR, 1); // warmed-up + retriggered → exercises the reset
    const b = new Voice(SR, 1); // fresh reference
    a.slots[PARAM_INDEX['lfo1.rate']].setBase(200);
    b.slots[PARAM_INDEX['lfo1.rate']].setBase(200);

    a.noteOn(220, 1.0, gate); b.noteOn(220, 1.0, gate);
    const buf = new Float32Array(gate);
    a.renderAdd(buf, 0, gate);          // advances A's LFO well past phase 0
    b.renderAdd(buf.fill(0), 0, gate);

    a.setMatrixSlot(0, lfo1Src, levelIdx, 1); // route on A only, after warmup
    a.noteOn(220, 1.0, SR); b.noteOn(220, 1.0, SR); // retrigger both

    const outA = new Float32Array(1); const outB = new Float32Array(1);
    a.renderAdd(outA, 0, 1); b.renderAdd(outB, 0, 1);
    // With phase + lfo1Prev reset: lfo1Prev=0 on the first frame ⇒ A's route is inert ⇒ A==B.
    expect(outA[0]).toBeCloseTo(outB[0], 6);
  });
});

describe('Voice env3 source + loop (I3c)', () => {
  const SR = 48000;

  it('routes env3 → osc1.level so the third envelope modulates output (no longer inert)', () => {
    const levelIdx = PARAM_INDEX['osc1.level'];
    const env3Src = MOD_SOURCES.indexOf('env3');
    const render = (route: boolean) => {
      const v = new Voice(SR, 1);
      if (route) v.setMatrixSlot(0, env3Src, levelIdx, 1);
      v.noteOn(220, 1.0, SR);
      const out = new Float32Array(4096);
      v.renderAdd(out, 0, 4096);
      return out;
    };
    const base = render(false), routed = render(true);
    let maxDiff = 0;
    for (let i = 0; i < base.length; i++) maxDiff = Math.max(maxDiff, Math.abs(base[i] - routed[i]));
    expect(maxDiff).toBeGreaterThan(0.01);
  });

  it('noteOn resets env3Prev so a reused voice has no env3 bleed on the first sample', () => {
    const env3Src = MOD_SOURCES.indexOf('env3');
    const levelIdx = PARAM_INDEX['osc1.level'];
    const gate = 11000; // long enough that env3 (a 0.2 / d 0.3) is mid-contour at retrigger

    const a = new Voice(SR, 1); // warmed-up + retriggered → exercises the reset
    const b = new Voice(SR, 1); // fresh reference
    a.noteOn(220, 1.0, gate); b.noteOn(220, 1.0, gate);
    const buf = new Float32Array(gate);
    a.renderAdd(buf, 0, gate);
    b.renderAdd(buf.fill(0), 0, gate);

    a.setMatrixSlot(0, env3Src, levelIdx, 1); // route on A only, after warmup
    a.noteOn(220, 1.0, SR); b.noteOn(220, 1.0, SR);

    const outA = new Float32Array(1); const outB = new Float32Array(1);
    a.renderAdd(outA, 0, 1); b.renderAdd(outB, 0, 1);
    // With env3Prev reset to 0, A's route is inert on the first frame ⇒ A==B.
    expect(outA[0]).toBeCloseTo(outB[0], 6);
  });

  it('setEnvLoop(_,_,true) keeps env3 cycling so its routed output differs from loop-off', () => {
    const levelIdx = PARAM_INDEX['osc1.level'];
    const env3Src = MOD_SOURCES.indexOf('env3');
    const render = (loop: boolean) => {
      const v = new Voice(SR, 1);
      v.slots[PARAM_INDEX['env3.a']].setBase(0.005);
      v.slots[PARAM_INDEX['env3.d']].setBase(0.01);
      v.slots[PARAM_INDEX['env3.s']].setBase(0);
      v.setEnvLoop(false, false, loop);
      v.setMatrixSlot(0, env3Src, levelIdx, 1);
      v.noteOn(220, 1.0, SR);
      const out = new Float32Array(8192);
      v.renderAdd(out, 0, 8192);
      return out;
    };
    // loop off: env3 decays to 0 (s=0) and stays → no mod after ~15ms.
    // loop on: env3 keeps cycling → keeps modulating. The two diverge.
    const off = render(false), on = render(true);
    let maxDiff = 0;
    for (let i = 0; i < off.length; i++) maxDiff = Math.max(maxDiff, Math.abs(off[i] - on[i]));
    expect(maxDiff).toBeGreaterThan(0.01);
  });
});
