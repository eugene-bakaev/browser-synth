// Vue glue: register command(s) for the lifetime of the current effect scope
// (component setup). Components declare commands; they never touch listeners.
import { onScopeDispose } from 'vue';
import type { KeyboardCommand, KeyboardService } from './KeyboardService';

export function useKeyboardCommand(
  service: KeyboardService,
  cmds: KeyboardCommand | KeyboardCommand[],
): void {
  const list = Array.isArray(cmds) ? cmds : [cmds];
  const disposers = list.map((c) => service.register(c));
  onScopeDispose(() => { for (const off of disposers) off(); });
}
