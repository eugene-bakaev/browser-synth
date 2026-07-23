import { chromium, type Browser } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import type { Project } from '@fiddle/shared';
import type { AudioClip } from '../types';

const abs = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const WORKLET_DIR = abs('../../../client/public/worklets');
const REQUIRED = ['synth2', 'kick2', 'snare2', 'hat2', 'clap2'].map((n) => `${n}-processor.js`);

export interface Tier2Result { channels: Float32Array[]; sampleRate: number }

export async function renderProjectTier2(
  project: Project,
  opts: { bars: number; soloTrack?: number },
): Promise<Tier2Result> {
  for (const w of REQUIRED) {
    try {
      await access(join(WORKLET_DIR, w));
    } catch {
      throw new Error(`Tier-2: missing worklet ${w}. Run: npm run build:worklet -w @fiddle/client`);
    }
  }

  const server = await createServer({ configFile: abs('../../vite.harness.config.ts') });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('Tier-2: harness server did not resolve a URL');

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => typeof (window as { renderProject?: unknown }).renderProject === 'function');
    const result = (await page.evaluate(
      ([p, o]) => (window as unknown as { renderProject: (p: unknown, o: unknown) => Promise<{ channels: string[]; sampleRate: number }> }).renderProject(p, o),
      [project, opts] as const,
    )) as { channels: string[]; sampleRate: number };

    const channels = result.channels.map((b64) => {
      const buf = Buffer.from(b64, 'base64');
      return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    });
    return { channels, sampleRate: result.sampleRate };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/** Downmix to the lab's mono AudioClip for the existing analysis core. */
export function toMonoClip(res: Tier2Result): AudioClip {
  const [l, r] = res.channels;
  const mono = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) mono[i] = r ? (l[i] + r[i]) * 0.5 : l[i];
  return { samples: mono, sampleRate: res.sampleRate };
}
