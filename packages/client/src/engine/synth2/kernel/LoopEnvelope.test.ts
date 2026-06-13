import { describe, it, expect } from 'vitest';
import { LoopEnvelope } from './LoopEnvelope';
import { ParamSlot } from './ParamSlot';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

const SR = 48000;

function timeSlot(key: string, def: number): ParamSlot {
  const d: Synth2ParamDescriptor = {
    key, min: 0.001, max: 10, default: def, taper: 'expOctaves', modulatable: true, modScale: 4,
  };
  return new ParamSlot(d, SR);
}

function makeEnv(a = 0.01, d = 0.05, s = 0.5, r = 0.05): LoopEnvelope {
  const sus: Synth2ParamDescriptor = {
    key: 'env1.s', min: 0, max: 1, default: s, taper: 'linear', modulatable: true, modScale: 1,
  };
  return new LoopEnvelope(
    timeSlot('env1.a', a), timeSlot('env1.d', d), new ParamSlot(sus, SR), timeSlot('env1.r', r), SR,
  );
}

function run(env: LoopEnvelope, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(env.next());
  return out;
}

describe('LoopEnvelope (I1: plain ADSR)', () => {
  it('is idle (0, inactive) before noteOn', () => {
    const env = makeEnv();
    expect(env.active).toBe(false);
    expect(env.next()).toBe(0);
  });

  it('attack reaches 1 within ~a seconds, then decays to sustain', () => {
    const env = makeEnv(0.01, 0.05, 0.5, 0.05);
    env.noteOn(SR); // 1s gate
    const buf = run(env, Math.round(SR * 0.005)); // halfway through attack
    expect(buf[buf.length - 1]).toBeGreaterThan(0.3);
    run(env, Math.round(SR * 0.01)); // finish attack (1.5×a total)
    expect(env.level).toBeCloseTo(1, 1);
    run(env, Math.round(SR * 0.1)); // well past decay
    expect(env.level).toBeCloseTo(0.5, 1);
  });

  it('releases to 0 over ~r seconds after the gate ends and goes inactive', () => {
    const env = makeEnv(0.001, 0.01, 0.5, 0.05);
    env.noteOn(Math.round(SR * 0.1)); // 100ms gate
    run(env, Math.round(SR * 0.1)); // gate elapses
    expect(env.active).toBe(true);
    run(env, Math.round(SR * 0.06)); // > r
    expect(env.level).toBe(0);
    expect(env.active).toBe(false);
  });

  it('retrigger mid-release ramps to zero over ~1ms first (D3 steal ramp), no upward jump', () => {
    const env = makeEnv(0.05, 0.01, 0.8, 0.5);
    env.noteOn(Math.round(SR * 0.05));
    run(env, Math.round(SR * 0.06)); // into release with level still high
    const heldLevel = env.level;
    expect(heldLevel).toBeGreaterThan(0.1);
    env.noteOn(SR); // steal
    const ramp = run(env, Math.round(SR * 0.001)); // 1ms
    for (let i = 1; i < ramp.length; i++) {
      expect(ramp[i]).toBeLessThanOrEqual(ramp[i - 1] + 1e-9); // monotonically falling
    }
    expect(env.level).toBeLessThan(0.05); // reached ~0, now attacking from the floor
  });
});
