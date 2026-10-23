import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childDiagnostics, redactNativeDiagnostic, redactedMarker, redactedPathMarker } from './diagnostics.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const secret = 'unit-transport-value-not-a-login';

it('substitutes every declared secret and never publishes a named environment value', () => {
  const result = redactNativeDiagnostic(`failed with ${secret}\nNATIVE_TRANSPORT_TOKEN=${secret}\nUNIT_MODE=exit`, [secret]);
  expect(result.clean).toBe(true);
  expect(result.text).not.toContain(secret);
  expect(result.text).toContain(`failed with ${redactedMarker}`);
  expect(result.text).toContain(`NATIVE_TRANSPORT_TOKEN=${redactedMarker}`);
  // Even a value this adapter was never told was secret is published as its name only.
  expect(result.text).toContain(`UNIT_MODE=${redactedMarker}`);
});

it('publishes a credential path as a class and keeps ordinary paths readable', () => {
  const result = redactNativeDiagnostic('cannot read /var/lib/spawnfile/realm/auth.json for /run/paideia/config.json', []);
  expect(result.clean).toBe(true);
  expect(result.text).toBe(`cannot read ${redactedPathMarker} for /run/paideia/config.json`);
});

it('refuses to call a stream clean when it carries a credential nobody declared', () => {
  for (const text of [`upstream refused: Bearer sk-live-${'A1b2C3d4'.repeat(6)}`,
    `key ${'A1b2C3d4'.repeat(6)}`, '-----BEGIN PRIVATE KEY-----']) {
    expect(redactNativeDiagnostic(text, []).clean).toBe(false);
  }
});

it('keeps content digests and short identifiers publishable', () => {
  for (const text of [`config digest sha256:${'a'.repeat(64)}`, 'trial 05f6d99d23fb2e54d8965a97b5ff9300 exited', 'exit code 1']) {
    expect(redactNativeDiagnostic(text, []).clean).toBe(true);
  }
});

it('treats a declared value too short to carry credential entropy as not a redaction target', () => {
  // Substituting it would corrupt unrelated text and prove nothing; the assignment scrub still hides it.
  const result = redactNativeDiagnostic('mode exit failed\nUNIT_CHILD_MODE=exit', ['exit']);
  expect(result.clean).toBe(true);
  expect(result.text).toContain('mode exit failed');
  expect(result.text).toContain(`UNIT_CHILD_MODE=${redactedMarker}`);
});

async function capture(): Promise<{ root: string; make: (secrets?: string[]) => ReturnType<typeof childDiagnostics> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paideia-diagnostics-')));
  await chmod(root, 0o700);
  roots.push(root);
  return { root, make: (secrets = []) => childDiagnostics(root, 'trial', 'a'.repeat(64), secrets) };
}

it('states the exit status when the worker never emitted a start-failed frame', async () => {
  const f = await capture();
  const signalled = await f.make();
  signalled.append(Buffer.from('bootstrap noise\nnot json\n'), false);
  await signalled.save(null, 'SIGKILL');
  expect(signalled.startupFailure(new Error('outer reason')).diagnostic.reason)
    .toBe('Native worker terminated by signal SIGKILL: outer reason');
});

it('states the exit code, and falls back to the caller reason when there is no status at all', async () => {
  const f = await capture();
  const coded = await f.make();
  await coded.save(3, null);
  expect(coded.startupFailure('string reason').diagnostic.reason).toBe('Native worker exited with code 3: string reason');
  // Nothing saved yet, and a clean exit code, leave the caller's own account as the reason.
  const g = await capture();
  const pending = await g.make();
  expect(pending.startupFailure(new Error('sandbox preflight failed')).diagnostic)
    .toMatchObject({ reason: 'sandbox preflight failed', exitCode: null, exitSignal: null, redaction: 'applied' });
  const zero = await (await capture()).make();
  await zero.save(0, null);
  expect(zero.startupFailure(new Error('idle')).diagnostic.reason).toBe('idle');
});

it('truncates published tails and marks them truncated without touching the protected capture', async () => {
  const f = await capture();
  const long = await f.make();
  long.append(Buffer.from('stdout chunk\n'.repeat(500)), true);
  long.append(Buffer.from('stderr chunk\n'.repeat(500)), false);
  await long.save(1, null);
  const diagnostic = long.startupFailure(new Error('boom')).diagnostic;
  expect(diagnostic.streams!.stdout.endsWith('…')).toBe(true);
  expect(diagnostic.streams!.truncated).toEqual({ stdout: true, stderr: true });
  expect(diagnostic.streams!.stderr.length).toBeLessThan(6_500);
  expect(JSON.parse(await readFile(join(f.root, 'child-diagnostics.json'), 'utf8')).stdout).toHaveLength(6_500);
});

it('errs toward withholding: any long opaque run that is not a content digest is treated as a credential', async () => {
  // Deliberate trade-off. A base64 blob and an unbroken run of output are indistinguishable here, so the
  // bytes are withheld and the failure class carries the account instead.
  const f = await capture();
  const opaque = await f.make();
  opaque.append(Buffer.from('z'.repeat(64)), false);
  await opaque.save(1, null);
  expect(opaque.startupFailure(new Error('boom')).diagnostic.redaction).toBe('withheld');
  expect(redactNativeDiagnostic('z'.repeat(39), []).clean).toBe(true);
});

it('publishes a frame schema and its detector when the frame message itself cannot be published', async () => {
  const f = await capture();
  const leaking = await f.make();
  leaking.append(Buffer.from(`${JSON.stringify({ schema: 'paideia.daimon-native.start-failed.v1',
    error: `upstream refused Bearer sk-${'A1b2C3d4'.repeat(6)}` })}\n`), false);
  await leaking.save(1, null);
  const diagnostic = leaking.startupFailure(new Error('boom')).diagnostic;
  // The bytes are withheld, but the layer that failed and the reason it was withheld both land.
  expect(diagnostic.redaction).toBe('withheld');
  expect(diagnostic.frames).toEqual([{ stream: 'stderr', schema: 'paideia.daimon-native.start-failed.v1', withheldBy: ['bearer', 'opaque-run'] }]);
  expect(diagnostic.withheld).toEqual([{ stream: 'stderr', bytes: expect.any(Number), lines: 2,
    frame: 'paideia.daimon-native.start-failed.v1', detectors: ['bearer', 'opaque-run'] }]);
  expect(diagnostic.reason).toBe('Native worker exited with code 1: boom');
  expect(diagnostic.exitCode).toBe(1);
  expect(JSON.stringify(diagnostic)).not.toContain('sk-');
});

it('publishes a caller bootstrap frame as the reason when the worker itself never spoke', async () => {
  const f = await capture();
  const bootstrap = await f.make();
  bootstrap.append(Buffer.from('plain progress line\n'), false);
  bootstrap.append(Buffer.from(`${JSON.stringify({ schema: 'example.paideia.bootstrap-failed.v1',
    message: 'launch.v2 receipt rejected by the private bootstrap' })}\n`), false);
  await bootstrap.save(1, null);
  const diagnostic = bootstrap.startupFailure(new Error('Native worker exited or failed before readiness')).diagnostic;
  expect(diagnostic.reason).toBe('example.paideia.bootstrap-failed.v1: launch.v2 receipt rejected by the private bootstrap');
  expect(diagnostic.redaction).toBe('applied');
});

it('hands the caller an unredacted operator capture it never publishes itself', async () => {
  const f = await capture();
  const leaking = await f.make(['unit-transport-value-not-a-login']);
  leaking.append(Buffer.from('token unit-transport-value-not-a-login and Bearer sk-live-xyz\n'), false);
  await leaking.save(1, null);
  const failure = leaking.startupFailure(new Error('boom'));
  expect(failure.capture.basename).toBe('OPERATOR-ONLY.native-startup-capture.json');
  expect(JSON.parse(failure.capture.content)).toMatchObject({ schema: 'paideia.daimon-native.operator-capture.v1', exitCode: 1 });
  expect(failure.capture.content).toContain('unit-transport-value-not-a-login');
  expect(JSON.stringify(failure.diagnostic)).not.toContain('unit-transport-value-not-a-login');
});

it('refuses a control directory that is not the protected canonical root', async () => {
  const f = await capture();
  await chmod(f.root, 0o755);
  await expect(childDiagnostics(f.root, 'trial', 'a'.repeat(64))).rejects.toThrow('protected canonical control directory');
  await chmod(f.root, 0o700);
  await expect(childDiagnostics(join(f.root, 'child-diagnostics.json'), 'trial', 'a'.repeat(64))).rejects.toThrow('ENOENT');
});
