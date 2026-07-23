import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCliArgs, runCli } from './cli';
import { buildReport } from './report/report';

describe('parseCliArgs', () => {
  it('parses a full render-engine command', () => {
    const cmd = parseCliArgs([
      'render-engine', 'synth2',
      '--set', 'filter.cutoff=800',
      '--set', 'osc1.wave=2',
      '--matrix', 'lfo1:filter.cutoff:0.8',
      '--notes', 'A3:0:0.5,C4:0.5:0.5',
      '--seconds', '2',
      '--mono',
      '--label', 'porta-test',
    ]);
    if (cmd.kind !== 'render-engine') throw new Error('wrong kind');
    expect(cmd.spec.engine).toBe('synth2');
    expect(cmd.spec.params).toEqual({ 'filter.cutoff': 800, 'osc1.wave': 2 });
    expect(cmd.spec.matrix).toEqual([{ source: 'lfo1', dest: 'filter.cutoff', amount: 0.8 }]);
    expect(cmd.spec.notes).toEqual([
      { time: 0, note: 'A3', duration: 0.5, mono: true },
      { time: 0.5, note: 'C4', duration: 0.5, mono: true },
    ]);
    expect(cmd.spec.seconds).toBe(2);
    expect(cmd.label).toBe('porta-test');
  });

  it('defaults notes, seconds and label', () => {
    const cmd = parseCliArgs(['render-engine', 'kick2']);
    if (cmd.kind !== 'render-engine') throw new Error('wrong kind');
    expect(cmd.spec.notes).toEqual([{ time: 0, note: 'A3', duration: 0.5, mono: false }]);
    expect(cmd.spec.seconds).toBeCloseTo(1.5, 5); // last note end (0.5) + 1
    expect(cmd.label).toBe('kick2');
  });

  it('throws usage on unknown commands and bad flags', () => {
    expect(() => parseCliArgs([])).toThrow(/usage/i);
    expect(() => parseCliArgs(['frobnicate'])).toThrow(/usage/i);
    expect(() => parseCliArgs(['render-engine', 'synth2', '--set', 'noequals'])).toThrow(/key=value/);
    expect(() => parseCliArgs(['compare', 'onlyone'])).toThrow(/usage/i);
  });

  it('parses render-project with defaults', () => {
    const c = parseCliArgs(['render-project', 'foo/bar.json']);
    expect(c).toMatchObject({ kind: 'render-project', file: 'foo/bar.json', bars: 2, label: 'bar' });
  });
  it('parses render-project flags', () => {
    const c = parseCliArgs(['render-project', 'p.json', '--bars', '4', '--solo', '2', '--label', 'x']);
    expect(c).toMatchObject({ kind: 'render-project', bars: 4, soloTrack: 2, label: 'x' });
  });
});

describe('runCli', () => {
  it('render-engine writes a run dir and returns a summary', async () => {
    const base = await mkdtemp(join(tmpdir(), 'audio-lab-cli-'));
    try {
      const cmd = parseCliArgs(['render-engine', 'kick2', '--out', join(base, 'run'), '--seconds', '1']);
      const res = await runCli(cmd);
      expect(res.dir).toBe(join(base, 'run'));
      expect(await readdir(join(base, 'run'))).toContain('report.json');
      expect(res.summaryText).toContain('peakDb');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('compare reads two run dirs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'audio-lab-cmp-'));
    try {
      const mk = async (name: string, freq: number) => {
        const samples = new Float32Array(24000);
        for (let i = 0; i < samples.length; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / 48000);
        const dir = join(base, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'report.json'), JSON.stringify(buildReport({ samples, sampleRate: 48000 })));
        return dir;
      };
      const res = await runCli({ kind: 'compare', dirA: await mk('a', 220), dirB: await mk('b', 440) });
      expect(res.summaryText).toContain('medianF0');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
