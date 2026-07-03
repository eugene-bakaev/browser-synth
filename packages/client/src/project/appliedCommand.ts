// AppliedCommand — the event the CommandBus emits after every state write.
// Lives under project/ (not sync/) so AudioEngine can consume the type without
// importing from the sync layer (same neutral-leaf rationale as paramDiff.ts).
import type { Path } from '@fiddle/shared';

export type AppliedCommand =
  | { kind: 'set'; path: Path; value: unknown }
  // Wholesale replace (server snapshot / Open / New / room reset): subscribers
  // re-derive from full current state rather than replaying leaves.
  | { kind: 'replace' };

export type AppliedCommandListener = (cmd: AppliedCommand) => void;
