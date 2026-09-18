import { lstat, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubjectStartupCapture, SubjectStartupDiagnostic } from '../../../contracts/execution.js';

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

/** Longest message published from a frame; a frame is an identity and a sentence, not a transcript. */
const framedMessage = 512;
const maximumFrames = 8;
export const withholdDetectors = ['declared-secret', 'bearer', 'pem', 'opaque-run'] as const;
export type WithholdDetector = typeof withholdDetectors[number];

/**
 * Which detector refuses this text, named rather than counted.
 *
 * Knowing that a bearer header fired tells an operator "the runtime threw with a
 * capability token in the message"; knowing that a long opaque run fired tells
 * them "something printed a blob". Without the name, a withheld stream is
 * indistinguishable from a crash with no output at all.
 */
function withholdingDetectors(text: string, survivingSecret: boolean): WithholdDetector[] {
  const detectors: WithholdDetector[] = [];
  if (survivingSecret) detectors.push('declared-secret');
  if (credentialShaped[0]!.test(text)) detectors.push('bearer');
  if (credentialShaped[1]!.test(text)) detectors.push('pem');
  if ([...text.matchAll(opaqueRun)].some(match => !/^[0-9a-f]+$/u.test(match[0]))) detectors.push('opaque-run');
  return detectors;
}

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
export function redactNativeDiagnostic(text: string, secrets: readonly string[]): { text: string; clean: boolean; detectors: readonly WithholdDetector[] } {
  const substitutable = [...new Set(secrets.filter(secret => secret.length >= shortestRedactableSecret))];
  let value = text;
  for (const secret of substitutable.sort((left, right) => right.length - left.length)) value = value.split(secret).join(redactedMarker);
  value = value.replace(assignment, (_match, lead: string, key: string) => `${lead}${key}=${redactedMarker}`);
  value = value.replace(credentialPath, redactedPathMarker);
  const detectors = withholdingDetectors(value, substitutable.some(secret => value.includes(secret)));
  return { text: value, clean: !detectors.length, detectors };
}

/** Every `{"schema":…}` line the runtime printed, with the field it states its failure in. */
function readFrames(stream: 'stdout' | 'stderr', text: string, secrets: readonly string[]): SubjectStartupDiagnostic['frames'] {
  const frames: NonNullable<SubjectStartupDiagnostic['frames']> = [];
  for (const line of text.split(/\r?\n/u)) {
    if (frames.length >= maximumFrames || !line.trim().startsWith('{')) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!row || typeof row !== 'object' || typeof row.schema !== 'string' || !row.schema) continue;
    const stated = [row.error, row.reason, row.message].find(value => typeof value === 'string' && value);
    if (stated === undefined) { frames.push({ stream, schema: row.schema }); continue; }
    // The schema is an identity, never a secret, so it publishes even when the message it carries cannot.
    const message = redactNativeDiagnostic(String(stated).slice(0, framedMessage), secrets);
    frames.push({ stream, schema: row.schema, ...(message.clean ? { message: message.text } : { withheldBy: message.detectors }) });
  }
  return frames.length ? frames : undefined;
}

const lineCount = (text: string): number => text ? text.split(/\r?\n/u).length : 0;

/** The worker's own stated failure is the best reason; a frame from any layer beats an exit status. */
function classify(frames: SubjectStartupDiagnostic['frames'], exitCode: number | null, exitSignal: string | null, fallback: string): string {
  const stated = frames?.filter(frame => frame.message !== undefined) ?? [];
  const worker = stated.find(frame => frame.schema === 'paideia.daimon-native.start-failed.v1');
  // Any layer's own account — the worker's, or a caller bootstrap's — outranks an exit code.
  const frame = worker ?? stated.at(-1);
  if (frame) return `${frame.schema}: ${frame.message!}`;
  if (exitSignal) return `Native worker terminated by signal ${exitSignal}: ${fallback}`;
  if (exitCode !== null && exitCode !== 0) return `Native worker exited with code ${exitCode}: ${fallback}`;
  return fallback;
}

/**
 * Carries the publishable record, and the unredacted capture, out of startup.
 *
 * The caller persists the record durably and writes the capture to the
 * operator's own run output as an operator-only file. The capture never reaches
 * the event stream, a report or a viewer projection.
 */
export class NativeStartupFailure extends Error {
  constructor(message: string, readonly diagnostic: SubjectStartupDiagnostic, readonly capture: SubjectStartupCapture) {
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
    /**
     * The publishable record on its own, for a worker that died *after*
     * readiness. Startup already published one; a mid-turn death published
     * nothing at all, so the one account of why the worker stopped answering
     * lived only in the protected file on the slot's tmpfs and died with the
     * container. Same redaction, same withholding rules, no capture: this
     * travels in the durable event stream, which outlives the container, and an
     * unredacted capture has no business there.
     */
    record(caught: unknown): SubjectStartupDiagnostic {
      return build(caught);
    },
    startupFailure(caught: unknown): NativeStartupFailure {
      const diagnostic = build(caught);
      const raw = { stdout: streams.stdout.bytes.toString('utf8'), stderr: streams.stderr.bytes.toString('utf8') };
      const capture: SubjectStartupCapture = { basename: 'OPERATOR-ONLY.native-startup-capture.json',
        content: `${JSON.stringify({ schema: 'paideia.daimon-native.operator-capture.v1', trialId, configSha256,
          exitCode: status.exitCode, exitSignal: status.exitSignal, protectedArtifact: file,
          limitBytesPerStream: limit, stdout: raw.stdout, stderr: raw.stderr,
          truncated: { stdout: streams.stdout.truncated, stderr: streams.stderr.truncated } }, null, 2)}\n` };
      return new NativeStartupFailure(`Native worker failed before readiness: ${diagnostic.reason}`, diagnostic, capture);
    },
  };
  function build(caught: unknown): SubjectStartupDiagnostic {
      const fallback = caught instanceof Error ? caught.message : String(caught);
      const raw = { stdout: streams.stdout.bytes.toString('utf8'), stderr: streams.stderr.bytes.toString('utf8') };
      const out = redactNativeDiagnostic(raw.stdout, secrets);
      const err = redactNativeDiagnostic(raw.stderr, secrets);
      // Frames publish per field, so one unpublishable message never costs the whole account of the failure.
      const frames = [...readFrames('stdout', raw.stdout, secrets) ?? [], ...readFrames('stderr', raw.stderr, secrets) ?? []];
      const reason = redactNativeDiagnostic(classify(frames, status.exitCode, status.exitSignal, fallback), secrets);
      const clean = out.clean && err.clean;
      const withheld = ([['stdout', raw.stdout, out], ['stderr', raw.stderr, err]] as const)
        .filter(([, , result]) => !result.clean)
        .map(([stream, text, result]) => ({ stream, bytes: Buffer.byteLength(text), lines: lineCount(text),
          frame: frames.find(row => row.stream === stream)?.schema ?? null, detectors: result.detectors }));
      const diagnostic: SubjectStartupDiagnostic = {
        schema: 'paideia.daimon-native.startup-diagnostic.v1', trialId,
        // A withheld stream still leaves the class identified, so the reason is kept whenever it is itself clean.
        reason: reason.clean ? truncate(reason.text) : 'Native worker failed before readiness; its stated reason could not be published safely',
        exitCode: status.exitCode, exitSignal: status.exitSignal,
        redaction: clean ? 'applied' : 'withheld',
        ...(clean ? { streams: { stdout: truncate(out.text), stderr: truncate(err.text),
          truncated: { stdout: streams.stdout.truncated || out.text.length > published, stderr: streams.stderr.truncated || err.text.length > published } } } : {}),
        ...(frames.length ? { frames } : {}),
        ...(withheld.length ? { withheld } : {}),
        protectedArtifact: file,
      };
      return diagnostic;
  }
}
