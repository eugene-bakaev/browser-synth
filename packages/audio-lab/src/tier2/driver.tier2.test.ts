import { describe, it, expect } from 'vitest';
import { freshProject } from '@fiddle/shared';
import { renderProjectTier2, toMonoClip } from './driver';
import { analyzeEnvelope } from '../analyze/envelope';

describe('tier2 driver (browser)', () => {
  it('renders a kick pattern to non-silent audio with onsets', async () => {
    const p = freshProject();
    for (let i = 1; i < p.tracks.length; i++) p.tracks[i].enabled = false;
    p.tracks[0].enabled = true;
    p.tracks[0].engineType = 'kick2';
    for (const s of [0, 4, 8, 12]) p.tracks[0].steps[s] = { ...p.tracks[0].steps[s], note: 'C', muted: false };

    const res = await renderProjectTier2(p, { bars: 1 });
    const clip = toMonoClip(res);

    expect(clip.samples.length).toBeGreaterThan(0);
    const env = analyzeEnvelope(clip);
    expect(Number.isFinite(env.peakDb)).toBe(true);
    expect(env.peakDb).toBeGreaterThan(-40);
    expect(env.onsets.length).toBe(4);
  }, 120_000);
});
