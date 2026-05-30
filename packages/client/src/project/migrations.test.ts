import { describe, it, expect, vi } from 'vitest';
import { migrateToLatest } from './migrations';
import { freshProject } from './factory';
import { PROJECT_SCHEMA_VERSION } from './types';

describe('migrateToLatest', () => {
  it('returns a fresh project for null input', () => {
    expect(migrateToLatest(null).schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('returns a fresh project for undefined input', () => {
    expect(migrateToLatest(undefined).schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('returns a fresh project for string input', () => {
    expect(migrateToLatest('not a project').schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('returns a fresh project for numeric input', () => {
    expect(migrateToLatest(42).schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('passes a valid current-version doc through unchanged', () => {
    const p = freshProject(); // v2
    expect(migrateToLatest(p)).toBe(p);
  });

  it('upgrades a v1 doc past the version gate without throwing', () => {
    const v1 = { schemaVersion: 1, bpm: 120, tracks: [] };
    const out = migrateToLatest(v1);
    expect(out.schemaVersion).toBe(PROJECT_SCHEMA_VERSION); // 2
  });

  it('still throws for an unknown future schemaVersion', () => {
    expect(() => migrateToLatest({ schemaVersion: 99, bpm: 100, tracks: [] }))
      .toThrowError(/Unknown project schemaVersion: 99/);
  });

  it('warns and returns fresh when schemaVersion is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = migrateToLatest({ bpm: 100, tracks: [] });
    expect(out.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
