// CLI entry. Parsing is a pure exported function; runCli does the IO. The
// summary block always goes to stdout so the invoking agent sees the numbers
// without opening report.json.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EngineRenderSpec, NoteEvent, MatrixRoute, EngineId } from './render/engine';
import { renderEngine, noteToFreq, ENGINE_IDS } from './render/engine';
import { compareReports } from './analyze/compare';
import { writeRunDir, defaultRunDir, type RunReport } from './report/report';
import { decodeWav } from './report/wav';

const USAGE = `audio-lab usage:
  npm run lab -- render-engine <engine> [--set key=value]... [--matrix src:dest:amount]...
      [--notes NOTE:START:DUR[,...]] [--seconds N] [--mono] [--label NAME] [--out DIR] [--sr HZ]
  npm run lab -- render-project <file.json> [--bars N] [--solo TRACK] [--label NAME] [--out DIR]
  npm run lab -- analyze <file.wav> [--label NAME] [--out DIR]
  npm run lab -- compare <runDirA> <runDirB>

  engines: ${ENGINE_IDS.join(', ')}
  notes syntax: NOTE:START_SECONDS:DURATION_SECONDS, comma-separated (default A3:0:0.5)
  runs land in .audio-lab/runs/<timestamp>-<label>/ unless --out is given`;

export class CliUsageError extends Error {}

export type CliCommand =
  | { kind: 'render-engine'; spec: EngineRenderSpec; label: string; out?: string }
  | { kind: 'analyze'; file: string; label: string; out?: string }
  | { kind: 'compare'; dirA: string; dirB: string }
  | { kind: 'render-project'; file: string; bars: number; soloTrack?: number; label: string; out?: string };

export function parseCliArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === 'render-engine') return parseRenderEngine(rest);
  if (command === 'analyze') return parseAnalyze(rest);
  if (command === 'compare') {
    if (rest.length !== 2) throw new CliUsageError(USAGE);
    return { kind: 'compare', dirA: rest[0], dirB: rest[1] };
  }
  if (command === 'render-project') return parseRenderProject(rest);
  throw new CliUsageError(USAGE);
}

interface FlagBag { positional: string[]; single: Map<string, string>; multi: Map<string, string[]>; bool: Set<string> }

const MULTI_FLAGS = new Set(['--set', '--matrix']);
const BOOL_FLAGS = new Set(['--mono']);

function collectFlags(args: string[]): FlagBag {
  const bag: FlagBag = { positional: [], single: new Map(), multi: new Map(), bool: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      bag.positional.push(a);
      continue;
    }
    if (BOOL_FLAGS.has(a)) {
      bag.bool.add(a);
      continue;
    }
    const v = args[++i];
    if (v === undefined) throw new CliUsageError(`flag ${a} needs a value\n${USAGE}`);
    if (MULTI_FLAGS.has(a)) {
      const arr = bag.multi.get(a) ?? [];
      arr.push(v);
      bag.multi.set(a, arr);
    } else {
      bag.single.set(a, v);
    }
  }
  return bag;
}

function parseNotes(text: string, mono: boolean): NoteEvent[] {
  return text.split(',').map((part) => {
    const bits = part.trim().split(':');
    if (bits.length !== 3) {
      throw new CliUsageError(`bad note '${part}' (want NOTE:START:DUR)\n${USAGE}`);
    }
    return { time: Number(bits[1]), note: bits[0], duration: Number(bits[2]), mono };
  });
}

function parseRenderEngine(args: string[]): CliCommand {
  const bag = collectFlags(args);
  const engine = bag.positional[0] as EngineId | undefined;
  if (!engine) throw new CliUsageError(USAGE);

  const mono = bag.bool.has('--mono');
  const notes = parseNotes(bag.single.get('--notes') ?? 'A3:0:0.5', mono);

  const params: Record<string, number> = {};
  for (const kv of bag.multi.get('--set') ?? []) {
    const eq = kv.indexOf('=');
    if (eq < 1) throw new CliUsageError(`--set wants key=value, got '${kv}'`);
    params[kv.slice(0, eq)] = Number(kv.slice(eq + 1));
  }

  const matrix: MatrixRoute[] = (bag.multi.get('--matrix') ?? []).map((m) => {
    const bits = m.split(':');
    if (bits.length !== 3) throw new CliUsageError(`--matrix wants src:dest:amount, got '${m}'`);
    return { source: bits[0], dest: bits[1], amount: Number(bits[2]) };
  });

  const lastEnd = notes.reduce((mx, n) => Math.max(mx, n.time + n.duration), 0);
  const seconds = bag.single.has('--seconds') ? Number(bag.single.get('--seconds')) : lastEnd + 1;

  const spec: EngineRenderSpec = { engine, notes, seconds };
  if (Object.keys(params).length) spec.params = params;
  if (matrix.length) spec.matrix = matrix;
  if (bag.single.has('--sr')) spec.sampleRate = Number(bag.single.get('--sr'));

  return {
    kind: 'render-engine',
    spec,
    label: bag.single.get('--label') ?? engine,
    out: bag.single.get('--out'),
  };
}

function parseAnalyze(args: string[]): CliCommand {
  const bag = collectFlags(args);
  const file = bag.positional[0];
  if (!file) throw new CliUsageError(USAGE);
  const base = file.split('/').pop()!.replace(/\.wav$/i, '');
  return { kind: 'analyze', file, label: bag.single.get('--label') ?? base, out: bag.single.get('--out') };
}

function parseRenderProject(args: string[]): CliCommand {
  const bag = collectFlags(args);
  const file = bag.positional[0];
  if (!file) throw new CliUsageError(USAGE);
  const base = file.split('/').pop()!.replace(/\.json$/i, '');
  const bars = bag.single.has('--bars') ? Number(bag.single.get('--bars')) : 2;
  const soloTrack = bag.single.has('--solo') ? Number(bag.single.get('--solo')) : undefined;
  return {
    kind: 'render-project',
    file,
    bars,
    soloTrack,
    label: bag.single.get('--label') ?? base,
    out: bag.single.get('--out'),
  };
}

function summaryText(report: RunReport): string {
  return JSON.stringify(report.summary, null, 2);
}

export async function runCli(cmd: CliCommand): Promise<{ dir?: string; summaryText: string }> {
  if (cmd.kind === 'render-engine') {
    const clip = renderEngine(cmd.spec);
    const dir = cmd.out ?? defaultRunDir(cmd.label);
    const noteTargets = cmd.spec.notes.map((n) => ({
      time: n.time,
      freq: n.freq ?? noteToFreq(n.note!),
    }));
    const report = await writeRunDir({ dir, spec: cmd.spec, clip, noteTargets });
    return { dir, summaryText: summaryText(report) };
  }
  if (cmd.kind === 'analyze') {
    const clip = decodeWav(new Uint8Array(await readFile(cmd.file)));
    const dir = cmd.out ?? defaultRunDir(cmd.label);
    const report = await writeRunDir({ dir, spec: { source: cmd.file }, clip });
    return { dir, summaryText: summaryText(report) };
  }
  if (cmd.kind === 'render-project') {
    const { normalizeProject } = await import('@fiddle/shared');
    const { renderProjectTier2, toMonoClip } = await import('./tier2/driver');
    const raw = JSON.parse(await readFile(cmd.file, 'utf8'));
    const project = normalizeProject(raw);
    const res = await renderProjectTier2(project, { bars: cmd.bars, soloTrack: cmd.soloTrack });
    const clip = toMonoClip(res);
    const dir = cmd.out ?? defaultRunDir(cmd.label);
    const report = await writeRunDir({ dir, spec: { file: cmd.file, bars: cmd.bars, soloTrack: cmd.soloTrack }, clip });
    return { dir, summaryText: summaryText(report) };
  }
  const a = JSON.parse(await readFile(join(cmd.dirA, 'report.json'), 'utf8')) as RunReport;
  const b = JSON.parse(await readFile(join(cmd.dirB, 'report.json'), 'utf8')) as RunReport;
  return { summaryText: JSON.stringify(compareReports(a, b), null, 2) };
}

// Entry point when executed directly (tsx src/cli.ts ...), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  (async () => {
    try {
      const cmd = parseCliArgs(process.argv.slice(2));
      const res = await runCli(cmd);
      if (res.dir) console.log(`run dir: ${res.dir}`);
      console.log(res.summaryText);
    } catch (err) {
      console.error(err instanceof CliUsageError ? err.message : err);
      process.exitCode = 1;
    }
  })();
}
