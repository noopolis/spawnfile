import { expect, it } from 'vitest';
import { subjectStartupCapture, subjectStartupDiagnostic, TRIAL_EVIDENCE_DIRECTORY, writeOperatorCapture, writeTurnFailure } from './diagnostics.js';
import { runTrial } from './trial.js';
import { complete, setup } from './fixture.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const valid = { schema: 'spawnfile.training.daimon-native.startup-diagnostic.v1', trialId: 'trial', reason: 'worker exited',
  exitCode: 1, exitSignal: null, redaction: 'applied' as const,
  streams: { stdout: '', stderr: 'boom', truncated: { stdout: false, stderr: false } }, protectedArtifact: '/run/x.json' };

it('accepts the documented adapter record, with or without published streams', () => {
  expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: valid }))).toEqual(valid);
  const withheld = { ...valid, redaction: 'withheld' as const, streams: undefined };
  expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: withheld }))?.redaction).toBe('withheld');
});

it('refuses anything that is not that record, so the runner never stores a shape it cannot read', () => {
  const cases: unknown[] = [undefined, null, 'error', new Error('plain'),
    Object.assign(new Error('x'), { diagnostic: null }),
    Object.assign(new Error('x'), { diagnostic: [valid] }),
    ...(['schema', 'trialId', 'reason', 'exitCode', 'exitSignal', 'redaction'] as const)
      .map(key => Object.assign(new Error('x'), { diagnostic: { ...valid, [key]: undefined } })),
    Object.assign(new Error('x'), { diagnostic: { ...valid, reason: '' } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, exitCode: 1.5 } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, redaction: 'partial' } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, protectedArtifact: 7 } }),
    // Streams must be complete when claimed, and absent when redaction was withheld.
    Object.assign(new Error('x'), { diagnostic: { ...valid, streams: { stdout: '', stderr: '' } } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, streams: { stdout: '', stderr: '', truncated: { stdout: false } } } }),
    Object.assign(new Error('x'), { diagnostic: { ...valid, redaction: 'withheld' } }),
  ];
  for (const value of cases) expect(subjectStartupDiagnostic(value)).toBeUndefined();
});

it('requires a withheld stream to name the detector that fired', () => {
  const base = { ...valid, redaction: 'withheld' as const, streams: undefined };
  const unexplained = { ...base, withheld: [{ stream: 'stderr', bytes: 1, lines: 1, frame: null, detectors: [] }] };
  expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: unexplained }))).toBeUndefined();
  const explained = { ...base, withheld: [{ stream: 'stderr', bytes: 1, lines: 1, frame: null, detectors: ['bearer'] }] };
  expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: explained }))?.withheld).toHaveLength(1);
  for (const withheld of [{}, [{ stream: 'other', bytes: 1, lines: 1, frame: null, detectors: ['bearer'] }],
    [{ stream: 'stderr', bytes: 1.5, lines: 1, frame: null, detectors: ['bearer'] }],
    [{ stream: 'stderr', bytes: 1, lines: 1, frame: '', detectors: ['bearer'] }],
    [{ stream: 'stderr', bytes: 1, lines: 1, frame: null, detectors: ['Bearer Token'] }],
    [1], [{}, {}, {}]]) {
    expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: { ...base, withheld } }))).toBeUndefined();
  }
});

it('accepts published frames and refuses malformed ones', () => {
  const frames = [{ stream: 'stderr', schema: 'example.spawnfile.training.bootstrap-failed.v1', message: 'rejected' },
    { stream: 'stdout', schema: 'x.v1', withheldBy: ['bearer'] }, { stream: 'stderr', schema: 'y.v1' }];
  expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: { ...valid, frames } }))?.frames).toHaveLength(3);
  for (const bad of [{}, [{ stream: 'stderr' }], [{ stream: 'other', schema: 'x' }], [{ stream: 'stderr', schema: '' }],
    [{ stream: 'stderr', schema: 'x', message: 7 }], [{ stream: 'stderr', schema: 'x', withheldBy: ['BAD NAME'] }],
    [{ stream: 'stderr', schema: 'x', withheldBy: 'bearer' }], [null], Array.from({ length: 33 }, () => ({ stream: 'stderr', schema: 'x' }))]) {
    expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: { ...valid, frames: bad } }))).toBeUndefined();
  }
  expect(subjectStartupDiagnostic(Object.assign(new Error('x'), { diagnostic: { ...valid, operatorCapture: 7 } }))).toBeUndefined();
});

it('accepts an adapter capture only as a plain file name with content', () => {
  const capture = { basename: 'OPERATOR-ONLY.native-startup-capture.json', content: '{}' };
  expect(subjectStartupCapture(Object.assign(new Error('x'), { capture }))).toEqual(capture);
  for (const bad of [undefined, null, 'x', [capture], { basename: capture.basename }, { content: '{}' },
    { basename: '../escape.json', content: '{}' }, { basename: 'a/b.json', content: '{}' },
    { basename: '.hidden', content: '{}' }, { basename: capture.basename, content: '' }]) {
    expect(subjectStartupCapture(Object.assign(new Error('x'), { capture: bad }))).toBeUndefined();
  }
  expect(subjectStartupCapture(new Error('x'))).toBeUndefined();
});

it('writes the operator capture once, privately, and never overwrites an existing one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'training-capture-'));
  try {
    const capture = { basename: 'OPERATOR-ONLY.native-startup-capture.json', content: '{"stderr":"secret"}\n' };
    const file = await writeOperatorCapture(root, capture);
    expect(file).toBe(join(root, capture.basename));
    expect(await readFile(file!, 'utf8')).toBe(capture.content);
    expect((await stat(file!)).mode & 0o777).toBe(0o600);
    // A second write cannot silently replace the first account of the failure, and a bad root never throws.
    expect(await writeOperatorCapture(root, capture)).toBeUndefined();
    expect(await writeOperatorCapture(join(root, 'absent'), capture)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps a failed turn\'s whole runtime failure text in the trial evidence directory and out of the durable record', async () => {
  const account = `engine_failed: CLI engine exited with code 1\n${'stderr line\n'.repeat(5_000)}last line`;
  let evidencePath = '';
  const task = await setup(async input => {
    evidencePath = input.evidencePath!;
    return { ...complete, status: 'failed', text: '', failureText: account, error: 'trial wake failed: engine_failed: CLI engine exited with code 1' };
  });
  const report = await runTrial(task.options);
  expect(evidencePath).toBe(join(report.paths.root, TRIAL_EVIDENCE_DIRECTORY));
  const file = join(evidencePath, 'turn-task.failure.txt');
  expect(await readFile(file, 'utf8')).toBe(`${account}\n`);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(report.error).toBe('trial wake failed: engine_failed: CLI engine exited with code 1');
  // Operator-only: neither the report nor any journal event carries the text.
  expect(JSON.stringify([report, task.journal])).not.toContain('last line');
});

it('names the failure file safely and never throws when it cannot be written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'training-failure-'));
  try {
    expect(await writeTurnFailure(join(root, 'evidence'), '../turn 1', 'why')).toBe(join(root, 'evidence', 'turn-.._turn_1.failure.txt'));
    expect(await writeTurnFailure('/dev/null/evidence', 'turn', 'why')).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('gives a stop the acknowledgement bound its adapter declares, so a slow teardown is still a proven closure', async () => {
  // A turn stopped at a limit the subject declared is scored only when its closure is proven.
  const run = async (stopAcknowledgementMs?: number) => {
    const task = await setup(async () => ({ ...complete, status: 'failed', text: '', limit: 'timeout', error: 'wall-clock bound reached' }));
    const { adapter } = task.options;
    task.options.adapter = { ...adapter, capabilities: { ...adapter.capabilities, ...(stopAcknowledgementMs ? { stopAcknowledgementMs } : {}) },
      start: async input => { const session = await adapter.start(input);
        return { ...session, stop: async reason => { await new Promise(resolve => setTimeout(resolve, 2_300)); return session.stop(reason); } }; } };
    const report = await runTrial(task.options);
    return { execution: report.execution, error: report.error };
  };
  expect(await run(10_000)).toEqual({ execution: 'limit-exceeded', error: 'wall-clock bound reached' });
  // Mutation guard: under the default bound the same teardown demoted the trial to a machine failure.
  expect(await run()).toEqual({ execution: 'failed', error: 'Native closure unproven; wall-clock bound reached' });
}, 20_000);
