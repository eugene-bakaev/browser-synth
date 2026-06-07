import { metrics } from '@opentelemetry/api';

const METER = 'fiddle-ws';

let framesInst: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | null = null;
let frameBytesInst: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> | null = null;
function frames() {
  return (framesInst ??= metrics.getMeter(METER).createCounter('fiddle.ws.frames'));
}
function frameBytes() {
  return (frameBytesInst ??= metrics.getMeter(METER).createHistogram('fiddle.ws.frame_bytes', { unit: 'By' }));
}

// 'in' = received from a client, 'out' = sent to a client. Counted and sized by
// message type so a chatty path (e.g. per-keystroke 'set' ops, or 224 KB
// 'snapshot' fan-out) is visible in OpenObserve. No-op without an SDK.
export function recordWsFrame(dir: 'in' | 'out', type: string, bytes: number): void {
  frames().add(1, { 'ws.dir': dir, 'ws.type': type });
  frameBytes().record(bytes, { 'ws.dir': dir, 'ws.type': type });
}

// Safe label extraction from an already-parsed (or null) inbound frame.
export function frameType(parsed: unknown): string {
  if (parsed && typeof parsed === 'object' && 'type' in parsed) {
    const t = (parsed as { type: unknown }).type;
    if (typeof t === 'string') return t;
  }
  return 'unknown';
}
