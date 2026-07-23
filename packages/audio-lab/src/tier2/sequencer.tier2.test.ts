import { describe, it, expect } from 'vitest';
import { buildSequencerFixture } from './fixtures/sequencerFixture';
import { expectedOnsets } from './checks/sequencer.checks';
import { renderProjectTier2, toMonoClip } from './driver';
import { analyzeEnvelope } from '../analyze/envelope';

const BARS = 3;
const TOL = 0.02; // onset detected within ~1–3 hops of the trigger (attack ramp)
// Silent warm-up so the master-bus compressor is at steady state before the
// scored pattern plays — its cold-start otherwise masks a quiet t=0 onset
// (docs/BACKLOG.md). Empirically the real threshold is ~0.02-0.03s (a
// silence-only sweep from 0 to 0.15s: 0/0.01s → miss the t=0 onset, 0.03s+ →
// all 4 detected); 0.4s keeps a >10x safety margin. Trimmed by the harness so
// analyzed onset times stay grid-relative — expectedOnsets/TOL are unchanged.
const LEAD_IN_SECONDS = 0.4;

describe('sequencer correctness (browser)', () => {
  for (const trackIndex of [0, 1, 2]) {
    it(`track ${trackIndex}: onsets match the step grid`, async () => {
      const project = buildSequencerFixture();
      const expected = expectedOnsets(project, BARS, trackIndex);
      const res = await renderProjectTier2(project, { bars: BARS, soloTrack: trackIndex, leadInSeconds: LEAD_IN_SECONDS });
      const { onsets } = analyzeEnvelope(toMonoClip(res));

      // (1) onset count == firing steps in the window
      expect(onsets.length).toBe(expected.length);
      // (2) each detected onset aligns to its grid time within tolerance
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(onsets[i] - expected[i])).toBeLessThan(TOL);
      }
    }, 120_000);
  }

  it('track 2 is polymeter: exactly 4 onsets at 0,12,24,36 over 3 bars', async () => {
    const project = buildSequencerFixture();
    const res = await renderProjectTier2(project, { bars: BARS, soloTrack: 2, leadInSeconds: LEAD_IN_SECONDS });
    const { onsets } = analyzeEnvelope(toMonoClip(res));
    expect(onsets.length).toBe(4);
    [0, 12, 24, 36].forEach((k, i) => expect(Math.abs(onsets[i] - k * 0.125)).toBeLessThan(TOL));
  }, 120_000);
});
