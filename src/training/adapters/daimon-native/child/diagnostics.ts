import { lstat, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubjectStartupDiagnostic } from '../../../contracts/execution.js';

const limit = 65_536;
/** Published tails are for identifying a defect class, not for reading a transcript. */
const published = 4_096;
/**
 * Below this length a value cannot carry credential entropy, and substituting it
 * would corrupt unrelated text while proving nothing. Such values are not
 * redaction targets; the assignment scrub below still keeps them from being
 * published as a named environment value.
 */
const shortestRedactableSecret = 8;
/** Environment values are never published verbatim, including ones this adapter was never told were secret. */
const assignment = /(^|[\s"'([{,;])([A-Za-z_][A-Za-z0-9_]{1,63})=(\S+)/gu;
/** Paths whose name says credential: published as a class, never as a location. */
const credentialPath = /(?:^|(?<=\s))\S*\/\S*(?:auth\.json|\.pem|\.key|token)\S*/giu;
/** Undeclared credential-shaped material: what substitution cannot remove because nobody declared it. */
const credentialShaped = [/bearer\s+\S+/iu, /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/u];
const opaqueRun = /[A-Za-z0-9_-]{40,}/gu;
export const redactedMarker = '[redacted]';
export const redactedPathMarker = '[redacted-path]';

const truncate = (text: string): string => text.length > published ? `${text.slice(0, published)}…` : text;

/** A long opaque run that is not a content digest is the shape of a credential nobody declared. */
const carriesUndeclaredCredential = (text: string): boolean =>
  credentialShaped.some(pattern => pattern.test(text)) ||
  [...text.matchAll(opaqueRun)].some(match => !/^[0-9a-f]+$/u.test(match[0]));

/**
 * Removes every value this adapter knows to be secret, then refuses to call the
 * result clean if anything credential-shaped is left.
 *
 * Substitution covers the control token, the declared environment values and the
 * credential file paths. The assignment scrub covers a secret nobody declared: a
 * line that echoes `SOMETHING=value` publishes the name and drops the value. What
 * substitution cannot reach is an undeclared credential printed on its own — a
 * bearer header, a PEM block, a long opaque token — so its presence makes the
 * text unpublishable rather than published in the hope that it is harmless.
 */
export function redactNativeDiagnostic(text: string, secrets: readonly string[]): { text: string; clean: boolean } {
  const substitutable = [...new Set(secrets.filter(secret => secret.length >= shortestRedactableSecret))];
  let value = text;
  for (const secret of substitutable.sort((left, right) => right.length - left.length)) value = value.split(secret).join(redactedMarker);
  value = value.replace(assignment, (_match, lead: string, key: string) => `${lead}${key}=${redactedMarker}`);
  value = value.replace(credentialPath, redactedPathMarker);
  const clean = !substitutable.some(secret => value.includes(secret)) && !carriesUndeclaredCredential(value);
  return { text: value, clean };
}

/** The worker's own stated failure is the best reason; an exit status is the fallback. */
function classify(stderr: string, exitCode: number | null, exitSignal: string | null, fallback: string): string {
  for (const line of stderr.split(/\r?\n/u).reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const row = JSON.parse(line) as { schema?: unknown; error?: unknown };
      if (row.schema === 'paideia.daimon-native.start-failed.v1' && typeof row.error === 'string' && row.error) return row.error;
    } catch { /* Bootstrap logging is not protocol; keep looking for the real frame. */ }
  }
  if (exitSignal) return `Native worker terminated by signal ${exitSignal}: ${fallback}`;
  if (exitCode !== null && exitCode !== 0) return `Native worker exited with code ${exitCode}: ${fallback}`;
  return fallback;
}

/** Carries the publishable record out of startup so the caller can persist it durably. */
export class NativeStartupFailure extends Error {
  constructor(message: string, readonly diagnostic: SubjectStartupDiagnostic) {
    super(message);
    this.name = 'NativeStartupFailure';
  }
}

/** Protected process output, never a public observation or a model/judge input. */
export async function childDiagnostics(root: string, trialId: string, configSha256: string, secrets: readonly string[] = []) {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(root) !== root || (directory.mode & 0o777) !== 0o700) {
    throw new Error('Native diagnostics require the protected canonical control directory');
  }
  const file = join(root, 'child-diagnostics.json');
  const streams = { stdout: { bytes: Buffer.alloc(0), truncated: false }, stderr: { bytes: Buffer.alloc(0), truncated: false } };
  let saved: Promise<void> | undefined;
  let status: { exitCode: number | null; exitSignal: NodeJS.Signals | null } = { exitCode: null, exitSignal: null };
  return {
    file,
    append(chunk: Buffer, stdout: boolean): void {
      if (saved) return;
      const stream = stdout ? streams.stdout : streams.stderr;
      const remaining = limit - stream.bytes.length;
      stream.truncated ||= chunk.length > remaining;
      if (remaining > 0) stream.bytes = Buffer.concat([stream.bytes, chunk.subarray(0, remaining)]);
    },
    save(exitCode: number | null, exitSignal: NodeJS.Signals | null): Promise<void> {
      status = { exitCode, exitSignal };
      return saved ??= writeFile(file, JSON.stringify({ schema: 'paideia.daimon-native.child-diagnostics.v1', trialId, configSha256,
        exitCode, exitSignal, limitBytesPerStream: limit,
        stdout: streams.stdout.bytes.toString('utf8'), stderr: streams.stderr.bytes.toString('utf8'),
        truncated: { stdout: streams.stdout.truncated, stderr: streams.stderr.truncated },
      }) + '\n', { flag: 'wx', mode: 0o600 });
    },
    /**
     * The durable half of the protected file above.
     *
     * The full capture stays in the control root, which on a training slot is
     * tmpfs that dies with the container; this redacted record is what an
     * operator can still read afterwards, and it always names the failure class
     * even when the bytes themselves have to be withheld.
     */
    startupFailure(caught: unknown): NativeStartupFailure {
      const fallback = caught instanceof Error ? caught.message : String(caught);
      const out = redactNativeDiagnostic(streams.stdout.bytes.toString('utf8'), secrets);
      const err = redactNativeDiagnostic(streams.stderr.bytes.toString('utf8'), secrets);
      const reason = redactNativeDiagnostic(classify(streams.stderr.bytes.toString('utf8'), status.exitCode, status.exitSignal, fallback), secrets);
      const clean = out.clean && err.clean;
      const diagnostic: SubjectStartupDiagnostic = {
        schema: 'paideia.daimon-native.startup-diagnostic.v1', trialId,
        // A withheld stream still leaves the class identified, so the reason is kept whenever it is itself clean.
        reason: reason.clean ? truncate(reason.text) : 'Native worker failed before readiness; its stated reason could not be published safely',
        exitCode: status.exitCode, exitSignal: status.exitSignal,
        redaction: clean ? 'applied' : 'withheld',
        ...(clean ? { streams: { stdout: truncate(out.text), stderr: truncate(err.text),
          truncated: { stdout: streams.stdout.truncated || out.text.length > published, stderr: streams.stderr.truncated || err.text.length > published } } } : {}),
        protectedArtifact: file,
      };
      return new NativeStartupFailure(`Native worker failed before readiness: ${diagnostic.reason}`, diagnostic);
    },
  };
}
