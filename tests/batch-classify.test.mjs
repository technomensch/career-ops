import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLASSIFY_SH = join(ROOT, 'batch', 'batch-classify.sh');

function sourceAndRun(expr) {
  return execFileSync('bash', ['-c', `source "${CLASSIFY_SH}"; ${expr}`], {
    encoding: 'utf8',
  });
}

test('is_signal_killed classifies signal exits, excludes SIGINT (130)', () => {
  const cases = [
    ['143', 'yes'], // SIGTERM
    ['137', 'yes'], // SIGKILL
    ['130', 'no'],  // SIGINT -- must NOT be reclassified
    ['0', 'no'],
    ['1', 'no'],
  ];
  for (const [code, expected] of cases) {
    const out = sourceAndRun(`is_signal_killed ${code} && echo yes || echo no`).trim();
    assert.equal(out, expected, `is_signal_killed(${code})`);
  }
});

test('is_interruption_signature_log matches sleep/network phrases only', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'batch-classify-test-'));
  const sleepLog = join(tmp, 'sleep.log');
  writeFileSync(sleepLog, 'API Error: Your computer went to sleep mid-response.\n');
  const normalLog = join(tmp, 'normal.log');
  writeFileSync(normalLog, 'TypeError: cannot read property of undefined\n');

  const sigOut = sourceAndRun(`is_interruption_signature_log "${sleepLog}" && echo yes || echo no`).trim();
  const normOut = sourceAndRun(`is_interruption_signature_log "${normalLog}" && echo yes || echo no`).trim();

  assert.equal(sigOut, 'yes');
  assert.equal(normOut, 'no');
});

test('has_worker_terminal_verdict detects a parseable status field, rejects absence/malformed JSON', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'batch-classify-test-'));
  const verdictLog = join(tmp, 'verdict.log');
  writeFileSync(verdictLog, [
    'some reasoning text',
    '```json',
    '{"status": "failed", "error": "bad JD"}',
    '```',
  ].join('\n') + '\n');
  const noVerdictLog = join(tmp, 'no-verdict.log');
  writeFileSync(noVerdictLog, 'reasoning that never finishes...\n');
  const malformedLog = join(tmp, 'malformed.log');
  writeFileSync(malformedLog, ['```json', '{not valid json', '```'].join('\n') + '\n');

  const hasVerdict = sourceAndRun(`has_worker_terminal_verdict "${verdictLog}" && echo yes || echo no`).trim();
  const noVerdict = sourceAndRun(`has_worker_terminal_verdict "${noVerdictLog}" && echo yes || echo no`).trim();
  const badVerdict = sourceAndRun(`has_worker_terminal_verdict "${malformedLog}" && echo yes || echo no`).trim();

  assert.equal(hasVerdict, 'yes');
  assert.equal(noVerdict, 'no');
  assert.equal(badVerdict, 'no');
});
