import type { EngineType, PresetRecord } from '@fiddle/shared';

export interface CreatePresetInput {
  id: string;
  name: string;
  engineType: EngineType;
  params: unknown;       // already schema-validated at the route
  ownerUserId: string;
  isPublic: boolean;
}

export interface ListPresetsOpts {
  // The own+public scope key. null = a guest viewer (public only).
  viewerUserId: string | null;
  engineType?: EngineType;
}

export interface PresetStore {
  create(input: CreatePresetInput): Promise<PresetRecord>;
  get(id: string): Promise<PresetRecord | null>;
  // The viewer's own presets UNION all public presets, newest-first.
  list(opts: ListPresetsOpts): Promise<PresetRecord[]>;
  updateMeta(id: string, patch: { name?: string; isPublic?: boolean }): Promise<void>;
  delete(id: string): Promise<void>;
}
