#!/usr/bin/env node
//
// AGENTS.md enforcement (Stop hook): block ending a turn that reports
// implementation work as "done" when files under packages/ were edited but NO
// Playwright/browser MCP verification ran AFTER the last such edit.
//
// Rationale: AGENTS.md requires browser verification (drive the dev app, confirm
// a clean console) before reporting work done, and closing the tab afterward.
// Green unit tests are not a substitute. This makes the rule mechanical instead
// of relying on in-the-moment judgment.
//
// Contract: reads the Stop-hook JSON on stdin; to block, prints
// {"decision":"block","reason":...} on stdout. FAIL-OPEN: any parse/IO error or
// ambiguity exits 0 (allow stop) so the hook can never wedge a session.
//
import { readFileSync } from 'node:fs';

const allow = () => process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow();
}

try {
  // Loop guard: if we already blocked once this stop, don't block again.
  if (input.stop_hook_active) allow();

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) allow();

  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    allow();
  }

  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  let lastPkgEditIdx = -1;
  const browserToolIdxs = [];
  let lastAssistantText = '';

  lines.forEach((line, i) => {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    const content = e && e.message && e.message.content;
    if (!Array.isArray(content)) return;
    const role = (e.message && e.message.role) || e.type;
    const textParts = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_use') {
        const name = String(c.name || '');
        const fp = String((c.input && (c.input.file_path || c.input.path)) || '');
        if (EDIT_TOOLS.has(name) && fp.includes('/packages/')) lastPkgEditIdx = i;
        if (/browser/i.test(name)) browserToolIdxs.push(i); // Playwright/chrome MCP
      }
      if (c.type === 'text' && typeof c.text === 'string') textParts.push(c.text);
    }
    if (role === 'assistant' && textParts.length) lastAssistantText = textParts.join('\n');
  });

  // No app-code edits this session => nothing for this gate to enforce.
  if (lastPkgEditIdx < 0) allow();

  // A browser verification after the last packages/ edit clears the gate.
  if (browserToolIdxs.some(idx => idx > lastPkgEditIdx)) allow();

  // Does the closing message claim the work is finished?
  const t = lastAssistantText;
  const claimsDone =
    /\b(complete|completed|finished|landed|shipped)\b/i.test(t) ||
    /\bit'?s\s+done\b/i.test(t) ||
    /\b(work|task|tasks|implementation|feature|branch|gate)\b[^.\n]{0,60}\bdone\b/i.test(t) ||
    /ready to merge/i.test(t) ||
    /gate[^.\n]{0,15}green/i.test(t) ||
    /✅/.test(t); // ✅
  if (!claimsDone) allow();

  const reason =
    'AGENTS.md (Browser verification) NOT satisfied: you edited files under ' +
    'packages/ and are reporting the work as done, but no Playwright/browser MCP ' +
    'tool ran after the last edit. Before finishing you MUST: (1) ensure the dev ' +
    'app is running (`npm run dev`); (2) drive the changed flow in the browser via ' +
    'the Playwright MCP; (3) report the behavior you observed and the console; ' +
    '(4) close the tab/session and stop any dev server you started. Do this now — ' +
    'do not present the browser check as optional or hand it back to the user. ' +
    '(If the user explicitly told you to skip browser verification this turn, say ' +
    'so and stop.)';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
} catch {
  allow();
}
