import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ProjectSchema } from '@fiddle/shared';
import { buildSequencerFixture } from './sequencerFixture';

describe('sequencer fixture', () => {
  it('is a schema-valid project', () => {
    expect(() => ProjectSchema.parse(buildSequencerFixture())).not.toThrow();
  });

  it('the committed JSON matches the builder (no drift)', async () => {
    const json = await readFile(fileURLToPath(new URL('./sequencer-check.project.json', import.meta.url)), 'utf8');
    expect(JSON.parse(json)).toEqual(buildSequencerFixture());
  });
});
