export type ModulePort = AudioNode | AudioParam;

export interface Module {
  readonly name: string;
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;
}

export interface SoundEngine {
  trigger(freq: number, duration: number, time?: number): void;
  dispose(): void;
}
