export type ModulePort = AudioNode | AudioParam;

export interface Module {
  readonly name: string;
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;
}

export interface SoundEngine {
  readonly engineType: string;
  trigger(freq: number, duration: number, time?: number, velocity?: number): void;
  applyParams(params: Record<string, any>): void;
  dispose(): void;
}
