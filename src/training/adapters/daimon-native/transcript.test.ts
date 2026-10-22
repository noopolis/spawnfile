import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Observation } from '../../contracts/execution.js';
import { createNativeObserver } from './observations.js';
import { launchFixture } from './test-fixtures.js';
import { NATIVE_TRANSCRIPT_SCHEMA, parseGrokTranscript, readNativeTranscript, selectTranscriptSession,
  traceReduction, transcriptText } from './transcript.js';
import type { NativeTrace, TerminalEvidence } from './worker/index.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const WAKE = 'Chief has assigned you s-4d5e6f70 for the 2026-09-12 edition. File it.';
const REPLY = 'Read the index and filed the piece with file_article.';

const rows = (wake = WAKE, reply: string | null = REPLY): string[] => [
  JSON.stringify({ type: 'system', content: 'You are Grok 4.6 released by xAI.' }),
  JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_info>\nOS Version: linux\n</user_info>' }] }),
  JSON.stringify({ type: 'user', content: [{ type: 'text', text: `<user_query>\n${wake}\n</user_query>` }] }),
  JSON.stringify({ type: 'reasoning', content: null }),
  JSON.stringify({ type: 'assistant', content: 'Working on it.', tool_calls: [{ id: 'call-1' }] }),
  JSON.stringify({ type: 'tool_result', content: 'ok', tool_call_id: 'call-1' }),
  ...(reply === null ? [] : [JSON.stringify({ type: 'assistant', content: reply })]),
  '',
];

async function engineHome(root: string, sessions: Record<string, readonly string[]>): Promise<string> {
  const runtimeHome = join(root, 'home');
  const workspace = join(runtimeHome, '.grok', 'sessions', '%2Fwork');
  await mkdir(workspace, { recursive: true });
  for (const [id, lines] of Object.entries(sessions)) {
    await mkdir(join(workspace, id), { recursive: true });
    await writeFile(join(workspace, id, 'chat_history.jsonl'), lines.join('\n'));
  }
  return runtimeHome;
}

const trace = (promptText: string, replyChars: number): NativeTrace => ({
  schema: 'daimon.turn_trace.v1', agent_id: 'agent:foreman', turn_id: 'turn-1',
  started_at: '2026-09-17T20:06:00.000Z', completed_at: '2026-09-17T20:06:48.000Z', status: 'completed', tools: [],
  prompt: { chars: promptText.length, lines: promptText.split('\n').length, sha256: sha256(promptText) },
  reply: { output_chars: replyChars, reply_given: replyChars > 0 },
});

test('the capture recovers the wake text and the reply, and Daimon\'s own digest confirms them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-transcript-'));
  try {
    const runtimeHome = await engineHome(root, { 'session-a': rows() });
    const capture = await readNativeTranscript(runtimeHome, trace(WAKE, REPLY.length));
    assert.ok(capture);
    assert.equal(capture.schema, NATIVE_TRANSCRIPT_SCHEMA);
    assert.equal(capture.sessions.length, 1);
    assert.equal(capture.selected, 'session-a');
    assert.equal(capture.sessions[0]?.promptEnvelope, 'user_query');
    // The point of the whole artifact: the verbatim text, not a digest of it.
    assert.equal(capture.sessions[0]?.prompt?.text, WAKE);
    assert.equal(capture.sessions[0]?.reply?.text, REPLY);
    assert.equal(capture.sessions[0]?.prompt?.redaction, 'applied');
    // And it is only trustworthy because Daimon's independent reduction agrees.
    assert.equal(capture.agreement.promptSha256, 'match');
    assert.equal(capture.agreement.replyChars, 'match');
    assert.equal(capture.trace?.turnId, 'turn-1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a wake text that is not what Daimon recorded is reported as a difference, never as agreement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-transcript-'));
  try {
    const runtimeHome = await engineHome(root, { 'session-a': rows() });
    const capture = await readNativeTranscript(runtimeHome, trace('a different prompt entirely', 4));
    assert.equal(capture?.agreement.promptSha256, 'differs');
    assert.equal(capture?.agreement.replyChars, 'differs');
    // Selection still falls back to the only session an isolated trial closed.
    assert.equal(capture?.selected, 'session-a');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a turn with no reply publishes the prompt and says the reply is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-transcript-'));
  try {
    const runtimeHome = await engineHome(root, { 'session-a': rows(WAKE, null) });
    const capture = await readNativeTranscript(runtimeHome, trace(WAKE, 0));
    assert.equal(capture?.sessions[0]?.prompt?.text, WAKE);
    assert.equal(capture?.sessions[0]?.reply, undefined);
    assert.equal(capture?.agreement.replyChars, 'unknown');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an assistant message carrying tool calls is work in progress, not the reply', () => {
  const session = parseGrokTranscript('session-a', [
    JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nwake\n</user_query>' }] }),
    JSON.stringify({ type: 'assistant', content: 'Calling file_article.', tool_calls: [{ id: 'call-1' }] }),
  ]);
  assert.equal(session.prompt?.text, 'wake');
  assert.equal(session.reply, undefined);
});

test('an unwrapped transcript is reported bare rather than presenting a CLI preamble as the assignment', () => {
  const session = parseGrokTranscript('session-a', [
    JSON.stringify({ type: 'user', content: 'plain wake text' }),
    JSON.stringify({ type: 'assistant', content: 'done' }),
  ]);
  assert.equal(session.promptEnvelope, 'bare');
  assert.equal(session.prompt?.text, 'plain wake text');
  assert.equal(parseGrokTranscript('session-b', ['not json', '{}']).promptEnvelope, 'absent');
});

test('credential-shaped text is withheld with its detector named, and its digest still publishes', () => {
  const published = transcriptText('Authorization: Bearer abcdefghijklmnop');
  assert.equal(published.text, undefined);
  assert.equal(published.redaction, 'withheld');
  assert.deepEqual([...published.detectors ?? []], ['bearer']);
  assert.equal(published.sha256, sha256('Authorization: Bearer abcdefghijklmnop'));
  assert.equal(published.chars, 38);
});

test('the digest selects among sibling sessions, and too many sessions is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-transcript-'));
  try {
    const runtimeHome = await engineHome(root, { 'session-a': rows('another turn'), 'session-b': rows() });
    const capture = await readNativeTranscript(runtimeHome, trace(WAKE, REPLY.length));
    assert.equal(capture?.selected, 'session-b');
    assert.equal(capture?.agreement.promptSha256, 'match');
    const ambiguous = await readNativeTranscript(runtimeHome, undefined);
    assert.equal(ambiguous?.selected, undefined);
    assert.equal(ambiguous?.agreement.promptSha256, 'unknown');
    const crowded = await engineHome(join(root, 'crowded'),
      Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`session-${index}`, rows()])));
    await assert.rejects(readNativeTranscript(crowded), /transcript count exceeds/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a Codex home, a recycled home and a symlinked transcript publish nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-transcript-'));
  try {
    assert.equal(await readNativeTranscript(join(root, 'missing')), undefined);
    const runtimeHome = await engineHome(root, {});
    assert.equal(await readNativeTranscript(runtimeHome), undefined);
    const workspace = join(runtimeHome, '.grok', 'sessions', '%2Fwork');
    await mkdir(join(workspace, 'session-a'), { recursive: true });
    await writeFile(join(root, 'elsewhere.jsonl'), rows().join('\n'));
    await symlink(join(root, 'elsewhere.jsonl'), join(workspace, 'session-a', 'chat_history.jsonl'));
    assert.equal(await readNativeTranscript(runtimeHome), undefined);
    assert.equal(traceReduction(undefined), undefined);
    assert.equal(selectTranscriptSession([]), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the observer publishes the transcript as an operator-only diagnostic that never becomes trial output', async () => {
  const fixture = await launchFixture();
  try {
    const runtimeHome = await engineHome(fixture.input.runtimeHomePath, { 'session-a': rows() });
    await mkdir(join(runtimeHome, 'tool-state'), { recursive: true });
    const events: Observation[] = [];
    fixture.input.onObservation = event => { events.push(event); };
    const observer = createNativeObserver(fixture.input, runtimeHome, 'agent:foreman', 'grok');
    await observer.terminal('wake', { status: 'failed', completedAt: new Date().toISOString(),
      native: { usage: [], traces: [trace(WAKE, REPLY.length)] } } as unknown as TerminalEvidence);
    const capture = events.at(-1);
    assert.equal(capture?.type, 'diagnostic');
    assert.equal(capture?.text, 'Native engine transcript captured');
    // A diagnostic carries no captured call and no output channel, so no judge,
    // viewer projection or gate can reach the text.
    assert.equal(capture?.callId, undefined);
    assert.equal(capture?.tool, undefined);
    const published = capture?.native as { sessions: { prompt?: { text?: string } }[] };
    assert.equal(published.sessions[0]?.prompt?.text, WAKE);
    // A Codex trial keeps its previous observation stream byte-for-byte.
    const codex: Observation[] = [];
    fixture.input.onObservation = event => { codex.push(event); };
    await createNativeObserver(fixture.input, runtimeHome, 'agent:foreman').terminal('wake',
      { status: 'failed', completedAt: new Date().toISOString(), native: { usage: [], traces: [] } } as unknown as TerminalEvidence);
    assert.equal(codex.length, 1);
    assert.equal(codex[0]?.text, 'Native execution failed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('non-session entries are skipped and a sessions root that is not a directory is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-transcript-'));
  try {
    const runtimeHome = await engineHome(root, { 'session-a': rows() });
    const sessions = join(runtimeHome, '.grok', 'sessions');
    // A stray file beside the workspace directory, a rejected session name, and a
    // transcript path that is a directory: each is skipped, none is a transcript.
    await writeFile(join(sessions, 'session_search.sqlite'), 'not a directory');
    await mkdir(join(sessions, '%2Fwork', '.hidden'), { recursive: true });
    await mkdir(join(sessions, '%2Fwork', 'session-b', 'chat_history.jsonl'), { recursive: true });
    const capture = await readNativeTranscript(runtimeHome, trace(WAKE, REPLY.length));
    assert.deepEqual(capture?.sessions.map(session => session.sessionId), ['session-a']);
    const broken = join(root, 'broken');
    await mkdir(join(broken, '.grok'), { recursive: true });
    await writeFile(join(broken, '.grok', 'sessions'), 'a file where the sessions root belongs');
    await assert.rejects(readNativeTranscript(broken), /must be real/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an oversized text is truncated at its published bound while its digest covers the whole value', () => {
  const long = 'The index row says the claim is unfalsifiable. '.repeat(1_000);
  const published = transcriptText(long);
  assert.equal(published.truncated, true);
  assert.equal(published.chars, long.length);
  assert.equal(published.text?.length, 32_768);
  assert.equal(published.sha256, sha256(long));
  // Rows that are not messages, and message bodies that are neither string nor
  // parts, contribute nothing rather than being coerced into a prompt.
  const session = parseGrokTranscript('session-a', [
    JSON.stringify(['not an object']), JSON.stringify({ content: 'no type' }),
    JSON.stringify({ type: 'user', content: 42 }), JSON.stringify({ type: 'user', content: [{ type: 'image' }] }),
  ]);
  assert.equal(session.prompt, undefined);
  assert.equal(session.promptEnvelope, 'absent');
});

test('a transcript read that fails publishes the failure instead of failing the metered turn', async () => {
  const fixture = await launchFixture();
  try {
    const runtimeHome = await engineHome(fixture.input.runtimeHomePath,
      Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`session-${index}`, rows()])));
    const events: Observation[] = [];
    fixture.input.onObservation = event => { events.push(event); };
    const usage = await createNativeObserver(fixture.input, runtimeHome, 'agent:foreman', 'grok').terminal('wake',
      { status: 'completed', completedAt: new Date().toISOString(), native: { usage: [], traces: [] } } as unknown as TerminalEvidence);
    assert.equal(usage, null);
    assert.match(String(events.at(-1)?.text), /transcript capture failed: .*count exceeds/u);
    assert.equal(events.at(-1)?.native, undefined);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
