export type ModulePort = AudioNode | AudioParam;

export interface Module {
  readonly name: string;
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;
}
