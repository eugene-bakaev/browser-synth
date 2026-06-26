import { describe, it, expect, beforeEach } from 'vitest';
import { promptDraft, resolveActiveDialog, useDialog } from './useDialog';

// Drive the prompt composable directly — no .vue mounting needed.
// promptDraft is the exported module-level ref that DialogHost binds to v-model.

describe('useDialog prompt', () => {
  beforeEach(() => {
    // Reset draft so tests are isolated.
    promptDraft.value = '';
  });

  it('resolves to the trimmed draft when confirmed', async () => {
    const dialog = useDialog();
    const p = dialog.prompt('Preset name');
    promptDraft.value = '  Boom  ';
    resolveActiveDialog(true);
    expect(await p).toBe('Boom');
  });

  it('resolves null when cancelled', async () => {
    const dialog = useDialog();
    const p = dialog.prompt('Preset name');
    promptDraft.value = 'something';
    resolveActiveDialog(false);
    expect(await p).toBeNull();
  });

  it('resolves null when draft is empty string and confirmed', async () => {
    const dialog = useDialog();
    const p = dialog.prompt('Preset name');
    promptDraft.value = '';
    resolveActiveDialog(true);
    expect(await p).toBeNull();
  });

  it('resolves null when draft is whitespace-only and confirmed', async () => {
    const dialog = useDialog();
    const p = dialog.prompt('Preset name');
    promptDraft.value = '   ';
    resolveActiveDialog(true);
    expect(await p).toBeNull();
  });

  it('accepts DialogOptions and pre-fills draft with defaultValue', async () => {
    const dialog = useDialog();
    const p = dialog.prompt({ message: 'Preset name', defaultValue: 'My patch' });
    // draft should have been set to defaultValue at enqueue time
    expect(promptDraft.value).toBe('My patch');
    resolveActiveDialog(true);
    expect(await p).toBe('My patch');
  });
});
