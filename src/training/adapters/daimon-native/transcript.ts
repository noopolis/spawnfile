import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redactNativeDiagnostic, type WithholdDetector } from './child/index.js';
import { readPrivateFile } from './receipt/index.js';
import type { NativeTrace } from './worker/index.js';

/**
 * Recovers what the engine was actually asked, and what it actually answered.
 *
 * Daimon reduces both to a digest and a character count before either leaves
 * its runtime, which is enough to detect a change and not enough to diagnose
 * one: a turn that files nothing looks identical to a turn that was never asked
 * to. The Grok CLI writes its own transcript inside the Daimon-owned
 * `$GROK_HOME`, the same runtime home this adapter already reads tool receipts
 * and closed traces from, so the text is recoverable as observed evidence
 * rather than reconstructed from the adapter's side of the wake.
 *
 * This capture is operator-only. Every trial observation persists at `raw`
 * visibility, which no viewer, optimizer or evaluator projection can read, and
 * it is published as a `diagnostic` so it never becomes `snapshot.output`, a
 * captured tool call, or any judge's input. Nothing here changes what a trial
 * evaluates.
 */
export const NATIVE_TRANSCRIPT_SCHEMA = 'paideia.daimon-native.transcript.v1';

/** Sessions scanned under one engine home; an isolated trial closes exactly one execution. */
const maximumSessions = 8;
/** One session's transcript; larger than this is not a turn, it is a defect. */
const maximumTranscriptBytes = 8 * 1024 * 1024;
/** Published text bound. A transcript is for reading a turn, not for archiving a corpus. */
const publishedChars = 32_768;
/** `sessions/<percent-encoded-cwd>/<session-id>/chat_history.jsonl`. */
const transcriptName = 'chat_history.jsonl';
const sessionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const userQuery = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/u;

export interface NativeTranscriptText {
  chars: number;
  sha256: string;
  /** Present only when redaction left nothing credential-shaped behind. */
  text?: string;
  truncated: boolean;
  redaction: 'applied' | 'withheld';
  detectors?: readonly WithholdDetector[];
}

export interface NativeTranscriptSession {
  sessionId: string;
  rows: number;
  /** The wake text the engine received, unwrapped from the CLI's own query envelope when it used one. */
  prompt?: NativeTranscriptText;
  promptEnvelope: 'user_query' | 'bare' | 'absent';
  /** The engine's final assistant message. */
  reply?: NativeTranscriptText;
}

export interface NativeTranscriptCapture {
  schema: typeof NATIVE_TRANSCRIPT_SCHEMA;
  engine: 'grok';
  sessions: NativeTranscriptSession[];
  /** Which session this turn's closed Daimon trace identifies, when it identifies one. */
  selected?: string;
  /** Daimon's own reduction of the same turn, the only thing that can confirm this capture. */
  trace?: { turnId: string; promptSha256?: string; promptChars?: number; replyChars?: number };
  agreement: {
    promptSha256: 'match' | 'differs' | 'unknown';
    replyChars: 'match' | 'differs' | 'unknown';
  };
}

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Publishes a transcript field, or refuses to.
 *
 * The digest and the character count are identities, never secrets, so they
 * publish unconditionally — they are what Daimon's trace can be checked
 * against. The text itself publishes only when the shared native redactor finds
 * nothing credential-shaped left in it; otherwise the named detectors say why
 * the bytes were withheld, which is the difference between "the reply could not
 * be published" and "there was no reply".
 */
export function transcriptText(value: string): NativeTranscriptText {
  const truncated = value.length > publishedChars;
  const candidate = truncated ? value.slice(0, publishedChars) : value;
  // Declared secrets belong to the child lifecycle that owns the token and the
  // process environment. With none to substitute, the detectors decide alone,
  // which withholds more text than it would otherwise, never less.
  const redacted = redactNativeDiagnostic(candidate, []);
  return {
    chars: value.length,
    sha256: digest(value),
    ...(redacted.clean ? { text: redacted.text } : {}),
    truncated,
    redaction: redacted.clean ? 'applied' : 'withheld',
    ...(redacted.clean ? {} : { detectors: redacted.detectors }),
  };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A CLI message body is a string, or the text parts of a content array. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      const row = asRecord(part);
      return row && row.type === 'text' && typeof row.text === 'string' ? row.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * The wake text and the final reply in one session transcript.
 *
 * The CLI prepends its own user rows (environment, skills, reminders) before the
 * wake, and wraps the wake itself in `<user_query>`. The last wrapped row is
 * therefore the delivered prompt; a transcript with no wrapper at all reports
 * the last user row as `bare` rather than silently presenting a CLI preamble as
 * the assignment.
 */
export function parseGrokTranscript(id: string, lines: readonly string[]): NativeTranscriptSession {
  const users: string[] = [];
  let reply: string | undefined;
  let rows = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const row = asRecord(value);
    if (!row) continue;
    rows++;
    if (row.type === 'user') {
      const text = messageText(row.content);
      if (text) users.push(text);
      continue;
    }
    if (row.type !== 'assistant') continue;
    // An assistant message that carries tool calls is work in progress, not the
    // turn's answer. Treating one as the reply would report a turn that ended
    // mid-tool-call as if it had answered.
    const calls = Array.isArray(row.tool_calls) ? row.tool_calls.length : 0;
    const text = messageText(row.content);
    reply = calls > 0 || !text.trim() ? undefined : text;
  }
  const wrapped = users.filter(text => userQuery.test(text));
  const last = wrapped.at(-1);
  const bare = users.at(-1);
  const prompt = last !== undefined ? userQuery.exec(last)![1]! : bare;
  return {
    sessionId: id,
    rows,
    ...(prompt === undefined ? {} : { prompt: transcriptText(prompt) }),
    promptEnvelope: last !== undefined ? 'user_query' : bare === undefined ? 'absent' : 'bare',
    ...(reply === undefined ? {} : { reply: transcriptText(reply) }),
  };
}

async function entries(directory: string): Promise<string[]> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native transcript directory must be real');
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Every `sessions/<cwd>/<session>/chat_history.jsonl` under one engine home, in stable order. */
async function transcriptFiles(engineHome: string): Promise<{ id: string; file: string }[]> {
  const root = join(engineHome, 'sessions');
  const found: { id: string; file: string }[] = [];
  for (const workspace of (await entries(root)).sort()) {
    const directory = join(root, workspace);
    let info;
    try { info = await lstat(directory); } catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    for (const session of (await entries(directory)).sort()) {
      if (!sessionId.test(session)) continue;
      const file = join(directory, session, transcriptName);
      try {
        const entry = await lstat(file);
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
      } catch { continue; }
      if (found.length >= maximumSessions) throw new Error('Native engine transcript count exceeds the isolated trial bound');
      found.push({ id: session, file });
    }
  }
  return found;
}

/**
 * Which captured session is the turn Daimon closed.
 *
 * The digest is the only authority: one session whose prompt hashes to what the
 * trace recorded IS that turn. Failing that, a single captured session in an
 * isolated trial is it by construction. Anything else selects nothing rather
 * than guessing, and every session still publishes.
 */
export function selectTranscriptSession(sessions: readonly NativeTranscriptSession[],
  promptSha256?: string): NativeTranscriptSession | undefined {
  if (promptSha256 !== undefined) {
    const matched = sessions.filter(session => session.prompt?.sha256 === promptSha256);
    if (matched.length === 1) return matched[0];
  }
  return sessions.length === 1 ? sessions[0] : undefined;
}

const traceNumber = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
const traceDigest = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;

/** Daimon's `daimon.turn_trace.v1` reduction of the same turn, read structurally. */
export function traceReduction(trace: NativeTrace | undefined): NativeTranscriptCapture['trace'] {
  if (!trace) return undefined;
  const prompt = asRecord(trace.prompt);
  const reply = asRecord(trace.reply);
  return {
    turnId: trace.turn_id,
    ...(traceDigest(prompt?.sha256) === undefined ? {} : { promptSha256: traceDigest(prompt?.sha256)! }),
    ...(traceNumber(prompt?.chars) === undefined ? {} : { promptChars: traceNumber(prompt?.chars)! }),
    ...(traceNumber(reply?.output_chars) === undefined ? {} : { replyChars: traceNumber(reply?.output_chars)! }),
  };
}

const compare = <T>(observed: T | undefined, recorded: T | undefined): 'match' | 'differs' | 'unknown' =>
  observed === undefined || recorded === undefined ? 'unknown' : observed === recorded ? 'match' : 'differs';

/**
 * Reads the engine's own transcript out of the Daimon-owned engine home.
 *
 * Returns `undefined` when there is nothing to publish, so a Codex trial and a
 * turn whose runtime home was already recycled both stay silent rather than
 * publishing an empty capture that reads like evidence.
 */
export async function readNativeTranscript(runtimeHome: string, trace?: NativeTrace): Promise<NativeTranscriptCapture | undefined> {
  const files = await transcriptFiles(join(runtimeHome, '.grok'));
  if (!files.length) return undefined;
  const sessions: NativeTranscriptSession[] = [];
  for (const { id, file } of files) {
    const source = await readPrivateFile(file, maximumTranscriptBytes);
    sessions.push(parseGrokTranscript(id, source.split('\n')));
  }
  const reduction = traceReduction(trace);
  const selected = selectTranscriptSession(sessions, reduction?.promptSha256);
  return {
    schema: NATIVE_TRANSCRIPT_SCHEMA,
    engine: 'grok',
    sessions,
    ...(selected ? { selected: selected.sessionId } : {}),
    ...(reduction ? { trace: reduction } : {}),
    agreement: {
      promptSha256: compare(selected?.prompt?.sha256, reduction?.promptSha256),
      replyChars: compare(selected?.reply?.chars, reduction?.replyChars),
    },
  };
}
