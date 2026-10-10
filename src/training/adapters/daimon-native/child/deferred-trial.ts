import { createHash } from 'node:crypto';
import { childFixture } from './fixture.js';
import { parseDatasetYaml, resolveDataset } from '../../../cases/index.js';
import { createEvaluationRegistry } from '../../../evaluation/index.js';
import { runTrial, type TrialOptions, type TrialReport } from '../../../experiments/index.js';
import { createDaimonNativeAdapter } from '../index.js';
import type { SubjectAdapter, SubjectSession, SubjectTurnResult } from '../../../contracts/execution.js';

/** One required artifact the filing would produce, so the verdict is exactly the subject's. */
export const filing = () => resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: newsroom
stages:
  - id: accepted-article
    checks:
      - {id: filed, eval: tool-called, tool: mcp_newsroom_file_article}
      - {id: body, eval: contains-any, input: 'artifact:accepted-article#/body', values: [Filed]}
    score:
      linear: {filed: 0.5, body: 0.5}
    gate: {all: [{passed: filed}, {passed: body}]}
records:
  - id: record
    group: unique
    input: {prompt: file the assigned story}
    outputs: {accepted-article: article.json}
`)).records[0]!;

/**
 * No sidecar artifact is registered for these trials, so a read is a defect rather
 * than a missing file: the verdict has to be exactly the subject's own evidence.
 */
export const unregisteredSidecar = async (): Promise<never> => { throw new Error('unregistered sidecar'); };

/**
 * The real child, the real loopback protocol and the real closure query: the only
 * thing borrowed is the trial's own stimulus, because the worker owns the fresh
 * workspace the launch receipt pins. Every continuation the budget admits defers,
 * so the last one exhausts it — and by then the worker has stopped its own host.
 *
 * The caller owns the returned root: these trials write a real workspace and a real
 * control root, and nothing here removes them.
 */
export async function nativeDeferredTrial(mode: string, maxDeliveries = 1,
  supplied?: () => Promise<null>): Promise<{ report: TrialReport; turn: SubjectTurnResult; deliveries: number; root: string }> {
  const fixture = await childFixture(mode);
  const text = 'Sourced research reply';
  let asked = 0;
  const sourced = async () => { const id = `answer-${asked++}`;
    return { id, text, source: { kind: 'transport', id, sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } }; };
  const next = supplied ? async () => { asked++; return supplied(); } : sourced;
  const native = createDaimonNativeAdapter({ timeoutMs: 20_000, execution: { kind: 'child-process', externalInputs: { maxDeliveries, next } } });
  const session = await native.start(fixture.input);
  let turn: SubjectTurnResult | undefined;
  const adapter: SubjectAdapter = { id: 'daimon-native-child', capabilities: native.capabilities,
    async start(): Promise<SubjectSession> {
      return { run: async (value, signal) => { turn = await session.run({ id: value.id, text: value.text }, signal); return turn; },
        stop: reason => session.stop(reason) };
    } };
  const options: TrialOptions = { id: fixture.input.trialId, phase: 'train', record: filing(), candidateId: 'candidate',
    datasetDigest: 'dataset', planDigest: 'plan', adapter, model: fixture.input.model!, root: fixture.root, timeoutMs: 20_000,
    prepare: async () => ({ instructions: fixture.input.instructions }), registry: createEvaluationRegistry(),
    evaluation: { judges: {}, embeddings: {}, readText: unregisteredSidecar },
    persist: async () => undefined };
  const report = await runTrial(options);
  return { report, turn: turn!, deliveries: asked, root: fixture.root };
}
