import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT, getBash, rmSync } from './helpers.mjs';

// Black-box harness: copy the real runner + helpers into a temp batch/ dir
// and put a fake `claude` on PATH. Plan Tasks 7-9 (ADR-004).
function fixture({ claudeScript, urls = ['https://example.com/one'], state }) {
  const root = mkdtempSync(join(tmpdir(), 'batch-interrupt-'));
  const batch = join(root, 'batch');
  const bin = join(root, 'bin');
  mkdirSync(batch, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  copyFileSync(join(ROOT, 'batch/batch-runner.sh'), join(batch, 'batch-runner.sh'));
  copyFileSync(join(ROOT, 'batch/batch-classify.sh'), join(batch, 'batch-classify.sh'));
  // Report-number reservation stub (the runner requires reserve-report-num.mjs).
  writeFileSync(join(root, 'reserve-report-num.mjs'), [
    "import { readFileSync, writeFileSync, existsSync } from 'node:fs';",
    "if (!process.argv.includes('--release')) {",
    "  const n = (existsSync('counter.txt') ? parseInt(readFileSync('counter.txt', 'utf8'), 10) : 0) + 1;",
    "  writeFileSync('counter.txt', String(n));",
    "  console.log(String(n).padStart(3, '0'));",
    '}',
  ].join('\n') + '\n');
  writeFileSync(join(root, 'reconcile-pipeline.mjs'), '');
  writeFileSync(join(root, 'merge-tracker.mjs'), 'console.log("merge fixture");\n');
  writeFileSync(join(root, 'verify-pipeline.mjs'), 'console.log("verify fixture");\n');
  writeFileSync(join(batch, 'batch-prompt.md'), 'URL={{URL}}\nJD={{JD_FILE}}\nREPORT={{REPORT_NUM}}\n');
  writeFileSync(join(batch, 'batch-input.tsv'), ['id\turl\tsource\tnotes',
    ...urls.map((u, i) => `${i + 1}\t${u}\tfixture\t-`)].join('\n') + '\n');
  if (state) writeFileSync(join(batch, 'batch-state.tsv'), state);
  if (claudeScript) writeFileSync(join(bin, 'claude'), claudeScript, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const run = (args) => spawnSync(getBash(), [join(batch, 'batch-runner.sh'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: bin + delimiter + process.env.PATH },
  });
  const rows = () => readFileSync(join(batch, 'batch-state.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t'));
  return { root, batch, run, rows };
}

const SCENARIO_ARGS = ['--parallel', '1', '--max-retries', '3', '--max-interrupt-retries', '3', '--rate-limit-sleep', '0'];

function scenario(claudeScript) {
  const f = fixture({ claudeScript });
  try {
    f.run(SCENARIO_ARGS);
    const row = f.rows()[0];
    return { status: row[2], retries: row[8], interrupts: row[9] };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

test('legacy 9-column state reads without error; interrupts defaults to 0', () => {
  const f = fixture({
    state: 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n'
      + '1\thttps://example.com/legacy\tcompleted\t2026-01-01T00:00:00Z\t2026-01-01T00:01:00Z\t001\t4.0\t-\t0\n',
  });
  try {
    const out = f.run(['--status']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Completed:\s*1/);
    assert.match(out.stdout, /Interrupted: 0/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('--max-interrupt-retries rejects non-integers', () => {
  const f = fixture({});
  try {
    for (const bad of ['x', '-1', '1.5']) {
      const r = f.run(['--max-interrupt-retries', bad]);
      assert.equal(r.status, 1, bad);
      assert.match(r.stdout, /--max-interrupt-retries must be a non-negative integer/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Tier 1: signal-killed (exit 143) is interrupted, retries untouched', () => {
  assert.deepEqual(scenario('#!/usr/bin/env bash\necho "worker output"\nexit 143\n'),
    { status: 'interrupted_exhausted', retries: '0', interrupts: '3' });
});

test('Tier 2: known sleep signature is interrupted, retries untouched', () => {
  assert.deepEqual(scenario('#!/usr/bin/env bash\necho "API Error: Your computer went to sleep mid-response."\nexit 1\n'),
    { status: 'interrupted_exhausted', retries: '0', interrupts: '3' });
});

test('Tier 3: no parseable verdict is interrupted (catch-all), retries untouched', () => {
  assert.deepEqual(scenario('#!/usr/bin/env bash\necho "reasoning that never finishes..."\nexit 1\n'),
    { status: 'interrupted_exhausted', retries: '0', interrupts: '3' });
});

test('negative control: worker-reported failure stays failed and consumes retries, not interrupts', () => {
  const r = scenario([
    '#!/usr/bin/env bash',
    'echo "some reasoning"',
    "echo '```json'",
    "echo '{\"status\": \"failed\", \"error\": \"bad JD, cannot evaluate\"}'",
    "echo '```'",
    'exit 1',
  ].join('\n') + '\n');
  assert.equal(r.status, 'failed');
  assert.equal(r.retries, '1');
  assert.equal(r.interrupts, '0');
});

test('an interrupt that recovers is retried and the interrupt count is recorded', () => {
  // First call dies with SIGTERM-style exit; second call succeeds with no report (=> failed path),
  // which is enough to show interrupts survived the later non-interrupt state writes.
  const f = fixture({
    claudeScript: '#!/usr/bin/env bash\nC="$(dirname "$0")/count"\nn=$(cat "$C" 2>/dev/null || echo 0)\necho $((n+1)) > "$C"\nif [ "$n" = 0 ]; then exit 143; fi\nexit 0\n',
  });
  try {
    f.run(SCENARIO_ARGS);
    const row = f.rows()[0];
    assert.equal(row[9], '1', JSON.stringify(row));
    assert.notEqual(row[2], 'interrupted');
    assert.notEqual(row[2], 'interrupted_exhausted');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('3 consecutive interruptions pause the batch before job 4 is dispatched', () => {
  const f = fixture({
    claudeScript: '#!/usr/bin/env bash\necho "API Error: Your computer went to sleep mid-response."\nexit 1\n',
    urls: ['https://example.com/one', 'https://example.com/two', 'https://example.com/three', 'https://example.com/four'],
  });
  try {
    f.run(['--parallel', '1', '--max-retries', '3', '--max-interrupt-retries', '0', '--rate-limit-sleep', '0']);
    const rows = f.rows();
    assert.equal(rows.length, 3, JSON.stringify(rows));
    assert.ok(rows.every((r) => r[2] === 'interrupted_exhausted'), JSON.stringify(rows));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('exit 130 (SIGINT) is never reclassified as interrupted', () => {
  const f = fixture({ claudeScript: '#!/usr/bin/env bash\necho partial\nexit 130\n' });
  try {
    f.run(SCENARIO_ARGS);
    const row = f.rows()[0];
    assert.equal(row[2], 'failed', JSON.stringify(row));
    assert.equal(row[9], '0');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a worker-reported failure that mentions a network error code stays failed', () => {
  const r = scenario([
    '#!/usr/bin/env bash',
    'echo "fetch failed: getaddrinfo ENOTFOUND jobs.deadco.com"',
    "echo '```json'",
    "echo '{\"status\": \"failed\", \"error\": \"JD unreachable\"}'",
    "echo '```'",
    'exit 1',
  ].join('\n') + '\n');
  assert.deepEqual(r, { status: 'failed', retries: '1', interrupts: '0' });
});

test('re-running an interrupted_exhausted job starts with a fresh interrupt budget', () => {
  const f = fixture({
    claudeScript: '#!/usr/bin/env bash\nC="$(dirname "$0")/count"\nn=$(cat "$C" 2>/dev/null || echo 0)\necho $((n+1)) > "$C"\nif [ "$n" = 0 ]; then exit 143; fi\nexit 0\n',
    state: 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\tinterrupts\n'
      + '1\thttps://example.com/one\tinterrupted_exhausted\tstart\tend\t001\t-\texhausted\t0\t3\n',
  });
  try {
    f.run(SCENARIO_ARGS);
    const calls = Number(readFileSync(join(f.root, 'bin', 'count'), 'utf8'));
    assert.equal(calls, 2, 'second attempt must happen after the first interrupt');
    assert.notEqual(f.rows()[0][2], 'interrupted_exhausted');
    assert.equal(f.rows()[0][9], '1');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
