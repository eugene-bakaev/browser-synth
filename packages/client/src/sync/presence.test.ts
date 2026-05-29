import { describe, it, expect, beforeEach, vi } from 'vitest';
import { roster, selfClientId, noteRemoteTouch, touchedFor, resetPresence } from './presence.js';

// Colors must be real PaletteColor members (the Identity.color type is the
// 8-entry PALETTE union, not arbitrary hex), so the test roster uses two
// actual palette values rather than placeholder #000000/#FF0000.
describe('presence', () => {
  beforeEach(() => { resetPresence(); vi.useFakeTimers(); });

  it('records remote touch with the originator color', () => {
    roster.value = [
      { clientId:'me', color:'#FF4136', handle:'Owl' },
      { clientId:'other', color:'#0074D9', handle:'Fox' },
    ];
    selfClientId.value = 'me';
    noteRemoteTouch(['bpm'], 'other');
    expect(touchedFor(['bpm'])?.color).toBe('#0074D9');
  });

  it('ignores self touches', () => {
    roster.value = [{ clientId:'me', color:'#FF4136', handle:'Owl' }];
    selfClientId.value = 'me';
    noteRemoteTouch(['bpm'], 'me');
    expect(touchedFor(['bpm'])).toBeNull();
  });

  it('expires after 500ms', () => {
    roster.value = [
      { clientId:'me', color:'#FF4136', handle:'Owl' },
      { clientId:'other', color:'#0074D9', handle:'Fox' },
    ];
    selfClientId.value = 'me';
    noteRemoteTouch(['bpm'], 'other');
    expect(touchedFor(['bpm'])).toBeTruthy();
    vi.advanceTimersByTime(600);
    expect(touchedFor(['bpm'])).toBeNull();
  });
});
