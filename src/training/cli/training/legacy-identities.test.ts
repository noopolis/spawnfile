import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { InferenceProvider, TrainingConfiguration } from '../../contracts/index.js';
import { parseDatasetYaml, resolveDataset, trainingJudgeVersions } from '../../cases/index.js';
import { snapshotCandidate, deriveCandidate, deriveAuthoredCandidate } from '../../candidates/index.js';
import { createJudgeCache, evaluateRubric } from '../../evaluation/semantic/index.js';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';
import { parseGrader, parseLabels, loadLabels, stableDigest, type Labels } from '../../graders/format/index.js';
import { goldenIdentity, createCalibrationIdentity, type CalibrationFile } from '../../graders/index.js';
import { groupLabelInstances, buildLabelPrompt, teacherPolicyDigest, validateStoredVotes, adjudicationRows } from '../../graders/labeling/index.js';
import { runCouncil, councilPrompt } from '../../graders/references/index.js';
import type { CheckInstance } from '../../graders/decomposition/index.js';
import { gradeOutput, decisionBackendIdentity } from '../../graders/runtime/index.js';
import { decisionPrompt, createJevDecision, createOllamaDecision } from '../../inference/decision/index.js';
import { TrainingCheckpoint, type TrainingOptions } from '../../experiments/training/index.js';
import { createTrainingInference } from './inference.js';
import { commandCheckpoint } from './checkpoint.js';

// Executed this identical fixture against origin/main (624a972c) in a detached
// worktree. Values below are outputs of public APIs, not copies of hash formulas.
const historical: Record<string, unknown> = {
  "versions": {
    "narrow": {
      "version": "paideia.authored-judge.v1:sha256:b4c940eb7869b8e7cce9377c72b00ba3a7e82a9d5042297699d50831a04b6120"
    },
    "grok": {
      "version": "paideia.authored-judge.v1:sha256:2edf14eb7de89070f4a7d7eeb8ad26d41e8d7268d1c8f022c964d7c28dc128e0"
    },
    "codex": {
      "version": "paideia.authored-judge.v1:sha256:07c9d8bbd0748462e356aa6a94f6cc4a28287305631c1c943aa3a19991b1be7a"
    },
    "local": {
      "version": "paideia.authored-judge.v1:sha256:5c786c8d41ec600fe611a0acf91217764283d4bee0c024d4d2f8c1e00b7b0c7b"
    },
    "broker": {
      "version": "paideia.authored-judge.v1:sha256:a26e907aaa92d5685dc51b40fcc48a0a707e15eb2de2fd09e2afbe24496b8cbd"
    }
  },
  "legacyVersion": "paideia.legacy-inference:82afc054b5a1454374481cec7d45b4f53efd77d64481530b838ff818df04e217",
  "optimizer": "paideia.optimizer:2b1ec73f57e16784c10550987a41a5af7449c3ad07217fad0b87b34066417a8d",
  "authored": {
    "plan": "sha256:1d169a1ad87e807604674b74c069d44cb925c5a06e176506ab89e7e172f9cbd3",
    "key": "sha256:ca54e4f74855ba25142727b51eb80f6afaaa69a6ab740e3a77c70a0fbf638a5f"
  },
  "legacy": {
    "plan": "sha256:dde141405ddcba3c22bf1e3608524ffe9575faaa9c3d1388a848a5df69348e77",
    "key": "sha256:d1bbb3be4608098e5d0867a7453647a6838b39d88856a5294b42161d608b8806"
  },
  "labeling": {
    "prompt": "b8c9731c5cd4973a9eb0eaea8d238e9bd7512fab7aaac5f83d7e7edf7cffb0eb",
    "system": "5578b7836e99c39b1fd7221321b015dc1abfd25f6fde7499f7bfea2e432bb920",
    "policies": [
      "e865d2da797211aa2b3f8c216b9d5ac0282564f22ef49be4672257dcb55dfdbf",
      "a515c6a3c266ce6c6f11f8d1b7c656a6bb1ebc65f4eb8b588e3bf93c108b5183",
      "0db5f5932aff76b47d98eab066a5fb0f2b13a4fc6b7344d2f1261abcef1386ab"
    ],
    "golden": "a4596b039478a7883f44a8a58bb965a4e91d6566589dd9d679f46074e59bdd3e",
    "directGolden": "a4596b039478a7883f44a8a58bb965a4e91d6566589dd9d679f46074e59bdd3e",
    "sample": [
      "story-10",
      "story-19",
      "story-1",
      "story-5",
      "story-7"
    ],
    "grade": {
      "calibration": {
        "questions": {
          "q": "be99fa471da7e34e6cae7f78f5a74de4d4741a244678e3fa1d08cb42a72727e7"
        },
        "expansion": [
          [
            "q",
            "be99fa471da7e34e6cae7f78f5a74de4d4741a244678e3fa1d08cb42a72727e7"
          ]
        ],
        "promptTemplateVersion": "fixture.v1",
        "segmenter": "Intl.Segmenter:en:sentence:icu=fixture-icu",
        "optionMapping": {
          "q": "b6a3018ba0d49f2db90109834a7cd2415f2ed779d3b35aacb55f48ef5c196b0f"
        },
        "backendModel": "fb91aa645afd74a3ea969d2dc2f64e37891546fc7e5bf8141872749b78534a66",
        "golden": "a4596b039478a7883f44a8a58bb965a4e91d6566589dd9d679f46074e59bdd3e",
        "seed": "0",
        "escalation": "7dc91e780c33cfa883b39b024ab7a9fc21500bac719e227ee26a6e9d3104bbd2",
        "escalationTeacher": "0db5f5932aff76b47d98eab066a5fb0f2b13a4fc6b7344d2f1261abcef1386ab",
        "uncalibrated": "refuse",
        "exclusions": []
      },
      "calibrationDigest": "ef47037e255908a52e5430b44b0e440038c83b853aeb2b089799d761cb8746ad",
      "escalation": "7dc91e780c33cfa883b39b024ab7a9fc21500bac719e227ee26a6e9d3104bbd2",
      "teacherPolicy": "3b64797ad38be8be1b771b54c01a419d654d91064c269c013813ca075b45db57",
      "scoringPolicy": "1f2f421dcff7ef758bc4d96fcc2f45a925274cb5f38e5af75bfef8983d9e5566"
    }
  },
  "council": {
    "identity": "d6184569a5dfcbd9edc571243c1d392e9f353b2ea7ae89d66a54ed4d2755d6c1",
    "prompt": "1cbfdba2025563a588534cdda6c5d146c56a350c7aad2b6b592b024a890a2ceb"
  },
  "decisions": {
    "identity": {
      "backend": "jev-http",
      "model": "qwen3:8b",
      "fingerprint": "94d33ac84a599025b16cd68272eea46542ca6aa65fdf7d8a5e1ed64f2e4b18bb"
    },
    "ollama": {
      "backend": "ollama-logprobs",
      "model": "qwen3:8b",
      "digest": "962bd559804d6655beefb1fa7f9b110f7ad4c5c5b9aa3b2731ee1567258c1eb1"
    },
    "requests": [
      "623f40cef858bec3d07cd0ea72c9c4215b3b5872aa55310b7ddab8718bacdea1",
      "eaec3ab2f3d489dbc0f2b1fc75f9199d54ba1a6c7560dcd62ab1232cf6e52294"
    ],
    "prompt": "d47e21d3c656b20c24a6ea03eb560fe2ccc6c0635dfb9dc9d6a39309b728825a"
  },
  "checkpoints": {
    "baseline": "sha256:96695c5cb96a86243d6312d029dc55b4a78f3713f520f6f452fd95b6c82d754d",
    "candidate": "sha256:5956a0996a1a5e136c5d459390fa534e3a57337b8543cd4f767eaa73b7ee0616",
    "command": "f2893146a7700fe91e17db41a4289e7a29767bf717fc44948f294cf765ab3371",
    "training": "5b2fd8c996006baa68acecf737184e7d21a44a19ddd9b8206d423dc4cd16d337",
    "comparison": "fbdce33f2dfea8af9872e5298cc496b07568d7cabfbaf9b4f8fbf3279da31ec2"
  }
};
const wire = (name: string) => `paideia.${name}`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const training: TrainingConfiguration = {
  models: {
    claude: { provider: 'claude-subscription', model: 'claude-sonnet-4-6' },
    grok: { provider: 'grok-subscription', model: 'grok-4.6', reasoning_effort: 'medium' },
    codex: { provider: 'codex-subscription', model: 'gpt-5' },
    local: { provider: 'ollama', model: 'qwen3:8b' },
    broker: { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'medium' },
  },
  judges: { narrow: { model: 'claude', protocol: 'evidence-ids' }, grok: { model: 'grok' },
    codex: { model: 'codex' }, local: { model: 'local' }, broker: { model: 'broker' } },
  optimizer: { model: 'claude' }, cache: { mode: 'exact', max_entries: 5 },
};
const check = { eval: 'llm-rubric', input: 'artifact:article', evidence: 'input:files', judge: 'narrow',
  rubric: { prompt: 'Judge only the supported quantity.' }, minimum: 0.9 };
const datasetText = `schema: ${wire('dataset.v1')}\nid: historical\nchecks: [${JSON.stringify({ id: 'supported', ...check })}]\nrecords: [{id: story, group: story, input: {prompt: Write the report.}, outputs: {article: article.json}}]\n`;

function provider() {
  return { id: 'claude-subscription', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: vi.fn(async (request) => {
      const data = JSON.parse(request.prompt.split('SOURCE DATA\n')[1]!);
      return { text: JSON.stringify({ score: 0.8, verdict: 'pass', reasons: ['A quantity lacks support.'],
        ...(data.units ? { evidenceIds: [data.units[0].id] } : { citations: [{ source: 'input', quote: 'Claim.' }] }) }),
      model: request.model, route: 'subscription', usage: null };
    }) } satisfies InferenceProvider;
}

async function routes() {
  const p = provider();
  const integration = { id: 'fixture', version: '1', inferenceExecutionIdentity: 'image:historical',
    createAdapter: vi.fn(), prepareEnvironment: vi.fn() };
  const make = (config?: TrainingConfiguration) => createTrainingInference({ command: 'train', flags: {}, training: config },
    { modelInference: () => p, inference: () => p, spawnfile: integration }, 1000,
    { narrow: 'claude-sonnet-4-6' }, { narrow: 0 });
  const authored = make(training), legacy = make();
  const outputs: Record<string, unknown> = { versions: trainingJudgeVersions(training, 'image:historical'),
    legacyVersion: legacy.judges.narrow!.identity, optimizer: authored.inference.id };
  for (const [name, services] of [['authored', authored], ['legacy', legacy]] as const) {
    const route = services.judges.narrow!;
    route.cache ??= createJudgeCache({ maxEntries: 5 });
    const registry = { judges: trainingJudgeVersions(name === 'authored' ? training : undefined, 'image:historical', ['narrow']) };
    const dataset = resolveDataset(parseDatasetYaml(datasetText), { registry });
    const scope = `train:${dataset.id}:${dataset.sourceDigest}:${dataset.sharedPlanDigest}`;
    route.cacheScope = scope;
    const context = evaluationContext({ snapshot: snapshot({ artifacts: { article: artifact('Claim.') } }), judges: { narrow: route } });
    const first = await evaluateRubric(check, context);
    expect(first.status).toBe('fail');
    const cached = await evaluateRubric(check, context);
    expect(cached.cache).toBeDefined();
    outputs[name] = { plan: dataset.sharedPlanDigest, key: cached.cache!.key };
    // Load paid evidence at the historical key and require an actual public-path hit.
    const expected = historical[name] as { key: string } | undefined;
    if (expected) {
      const saved = await route.cache.get(cached.cache!.key);
      route.cache = createJudgeCache({ maxEntries: 5 });
      await route.cache.put(expected.key, { ...saved!, sourceCallId: 'historical-paid' });
      p.generate.mockClear();
      expect((await evaluateRubric(check, context)).cache?.sourceCallId).toBe('historical-paid');
      expect(p.generate).not.toHaveBeenCalled();
      context.snapshot = snapshot({ artifacts: { article: artifact('Changed claim.') } });
      await evaluateRubric(check, context);
      expect(p.generate).toHaveBeenCalledTimes(1);
    }
  }
  return outputs;
}

function grader() {
  return parseGrader({ schema: wire('grader.v1'), id: 'supported', golden: 'labels.yaml', calibration: 'calibration.json',
    teachers: [{ id: 'g', provider: 'grok', model: 'grok-4.6' }, { id: 'c', provider: 'codex', model: 'gpt-5' },
      { id: 'a', provider: 'claude', model: 'claude-sonnet-4-6' }],
    model: { backend: 'jev-http', endpoint: 'http://localhost:8000', name: 'qwen3:8b' },
    escalate: { to: 'a', between: [0.3, 0.7] },
    questions: [{ id: 'q', type: 'yes-no', ask: 'Is the claim supported?', expected: 'yes', reads: ['output.body'] }],
    score: { method: 'weighted', pass_at: 0.75 } });
}

async function labelsAndGrades() {
  const icu = Object.getOwnPropertyDescriptor(process.versions, 'icu')!;
  Object.defineProperty(process.versions, 'icu', { value: 'fixture-icu', configurable: true });
  try {
  const g = grader(), output = { body: ['Supported claim.'] }, group = groupLabelInstances(g, output, {})[0]!;
  const prompt = buildLabelPrompt(group);
  const labels = parseLabels({ schema: wire('labels.v1'), grader: g.id,
    labelers: { a: { kind: 'model', provider: 'claude', model: 'claude-sonnet-4-6' } },
    labels: [{ id: 'story', lineage: 'story', output, context: {}, votes: { q: { a: 'yes' } },
      provenance: { a: { votes: { q: { question_digest: stableDigest(g.questions[0]), projection_digest: group.projectionDigest,
        teacher_policy_digest: teacherPolicyDigest(g.teachers[2]!) } } } } }] }, g);
  const golden = await loadLabels(labels, g);
  const expected = historical.labeling as { policies: string[] } | undefined;
  if (expected) {
    const vote = labels.labels[0]!.provenance.a!.votes as Record<string, Record<string, unknown>>;
    vote.q!.teacher_policy_digest = expected.policies[2];
    expect(() => validateStoredVotes(g, labels, { resolved: true })).not.toThrow();
    vote.q!.teacher_policy_digest = 'stale';
    expect(() => validateStoredVotes(g, labels, { resolved: true })).toThrow('Stale vote');
  }
  const sample: Labels = { ...labels, labels: Array.from({ length: 20 }, (_, i) => ({ ...labels.labels[0]!, id: `story-${i}`, lineage: `story-${i}` })) };
  const backend = { identity: async () => ({ backend: 'jev-http', model: 'qwen3:8b', fingerprint: 'stable-server' }),
    score: async () => [{ key: 'q', status: 'ok' as const, probabilities: { yes: 0.95, no: 0.05 } }] };
  const calibration: CalibrationFile = { schema: wire('grader-calibration.v1') as CalibrationFile['schema'],
    identity: createCalibrationIdentity(g, { backendModel: await decisionBackendIdentity(g, backend),
      golden: golden.goldenDigest, promptTemplateVersion: 'fixture.v1', seed: '0', exclusions: [] }),
    questions: { q: { status: 'calibrated', failures: [], params: { a: 1, b: 0 }, band: [0.3, 0.7],
      metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5 } } } };
  const grade = await gradeOutput({ grader: g, calibration, backend, goldenDigest: golden.goldenDigest,
    promptTemplateVersion: 'fixture.v1', output, context: {}, resource: {} });
  expect(grade.status).toBe('pass');
  return { prompt: prompt.digest, system: sha(prompt.system), policies: g.teachers.map(teacherPolicyDigest),
    golden: golden.goldenDigest, directGolden: goldenIdentity(golden.labels),
    sample: adjudicationRows(sample, 5).map(row => row.label), grade: grade.identity };
  } finally { Object.defineProperty(process.versions, 'icu', icu); }
}

async function council() {
  const instance: CheckInstance = { id: 'claim@0', template_id: 'support', unit_id: 'claim', type: 'noul',
    instructions: 'Is this supported?', criteria: { true: 'Supported', false: 'Unsupported' }, options: ['true', 'false'], expected: ['true'],
    projection: { text: 'A supported claim.' }, digest: sha('claim'), status: 'ready', reasons: [] };
  const generate = vi.fn(async () => ({ text: '{"q1":{"answer":"true"}}', model: 'actual', route: 'subscription', usage: null }));
  const p: InferenceProvider = { ...provider(), generate };
  const options = { outputDigest: sha('output'), instances: [instance], teachers: [
    { id: 'c', provider: 'codex', model: 'gpt-5' }, { id: 'a', provider: 'claude', model: 'claude-sonnet-4-6' }],
    providers: { c: p, a: p }, now: new Date('2026-10-11T12:00:00Z') };
  const result = await runCouncil(options);
  expect(result.complete).toBe(true);
  generate.mockClear();
  expect(await runCouncil({ ...options, previous: result })).toBe(result);
  expect(generate).not.toHaveBeenCalled();
  return { identity: result.identity, prompt: councilPrompt([instance]).digest };
}

async function decisions() {
  const bodies: string[] = [];
  const backend = createJevDecision({ endpoint: 'http://localhost/jev', fetch: async (_url, init) => {
    const raw = init!.body as string; bodies.push(raw);
    const body = JSON.parse(raw) as { questions: Record<string, unknown> };
    return new Response(JSON.stringify({ model: 'qwen3:8b', fingerprint: 'server-v1',
      answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { probabilities: { true: 0.9, false: 0.1 } }])) }));
  } });
  const identity = await backend.identity();
  const ollama = createOllamaDecision({ endpoint: 'http://localhost', model: 'qwen3:8b', fetch: async url =>
    new Response(JSON.stringify(String(url).endsWith('/tags') ? { models: [{ name: 'qwen3:8b', digest: 'installed-model-bytes' }] } : { version: '0.34.0' })) });
  return { identity, ollama: await ollama.identity(), requests: bodies.map(sha), prompt: sha(decisionPrompt({ key: 'claim', type: 'yes-no',
    instructions: 'Is this supported?', projection: { text: 'A supported claim.' }, optionLabels: ['yes', 'no'] })) };
}

async function checkpoints() {
  const root = await mkdtemp(join(tmpdir(), 'historical-identities-'));
  try {
    await writeFile(join(root, 'AGENTS.md'), 'Follow the task.\n');
    const baseline = await snapshotCandidate({ sourceRoot: root, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
      destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
    const candidate = deriveCandidate(baseline, baseline, { 'instructions#file': 'Follow the task precisely.\n' });
    const legacyBaseline = { ...baseline, schema: wire('candidate.v1') } as typeof baseline;
    expect(deriveCandidate(legacyBaseline, legacyBaseline, { 'instructions#file': 'Follow the task precisely.\n' }).id).toBe(candidate.id);
    expect(deriveAuthoredCandidate(legacyBaseline, { 'AGENTS.md': 'Follow the task precisely.\n' }).id).toBe(candidate.id);
    const dataset = resolveDataset(parseDatasetYaml(datasetText), { registry: { judges: trainingJudgeVersions(training, 'image:historical') } });
    const inputs = { out: join(root, 'command'), candidate: baseline, sourceRoot: '/historical/project', resources: [], model: 'gpt-5' } as unknown as Parameters<typeof commandCheckpoint>[1];
    const command = await commandCheckpoint({ command: 'train', flags: { train: ['train.yaml'], seed: ['7'] }, training }, inputs, {});
    const options = { id: 'experiment', baseline, concurrency: 1, native: { adapter: { id: 'codex' }, model: 'gpt-5', resources: [] },
      inference: { provider: { id: 'claude-subscription' }, model: 'claude-sonnet-4-6' }, seed: 7,
      budget: { maxMetricCalls: 10, maxProposals: 2 }, checkpoint: { directory: join(root, 'training'), identity: command.identity, resume: false } } as unknown as TrainingOptions;
    await TrainingCheckpoint.open(options, [dataset]);
    const comparison = { ...options, candidate, name: 'precise', maxTrials: 2, checkpoint: { ...options.checkpoint!, directory: join(root, 'comparison') } };
    await TrainingCheckpoint.openComparison(comparison, [dataset]);
    const read = async (dir: string) => JSON.parse(await readFile(join(root, dir, 'training.json'), 'utf8')).state.identity as string;
    const values = { baseline: baseline.id, candidate: candidate.id, command: command.identity,
      training: await read('training'), comparison: await read('comparison') };
    const expected = historical.checkpoints as typeof values | undefined;
    if (expected) {
      await writeFile(join(inputs.out, 'checkpoint/command.json'), JSON.stringify({ schema: command.schema, id: command.id, identity: expected.command }));
      expect((await commandCheckpoint({ command: 'train', flags: { train: ['train.yaml'], seed: ['7'], resume: ['true'] }, training }, inputs, {})).identity).toBe(expected.command);
      for (const [dir, identity] of [['training', expected.training], ['comparison', expected.comparison]]) {
        const state = { identity, entries: {}, recoveries: 0 };
        await writeFile(join(root, dir!, 'training.json'), JSON.stringify({ state, digest: sha(JSON.stringify(state)) }));
      }
      await expect(TrainingCheckpoint.open({ ...options, checkpoint: { ...options.checkpoint!, resume: true } }, [dataset])).resolves.toBeDefined();
      await expect(TrainingCheckpoint.openComparison({ ...comparison, checkpoint: { ...comparison.checkpoint, resume: true } }, [dataset])).resolves.toBeDefined();
    }
    return values;
  } finally { await rm(root, { recursive: true, force: true }); }
}

it('reuses historical authored and legacy judge keys through configured routes and dataset plans', async () => {
  const values = await routes();
  expect(values).toEqual(Object.fromEntries(['versions', 'legacyVersion', 'optimizer', 'authored', 'legacy'].map(key => [key, historical[key]])));
});
it('preserves teacher prompt, paid votes, golden labels, sampling and grade identities', async () => {
  expect(await labelsAndGrades()).toEqual(historical.labeling);
});
it('preserves default council identity and the exact digested model prompt', async () => {
  expect(await council()).toEqual(historical.council);
});
it('preserves real decision prompt and both canary requests, not merely a copied fingerprint domain', async () => {
  expect(await decisions()).toEqual(historical.decisions);
});
it('resumes historical command, training and comparison identities with real candidate and dataset inputs', async () => {
  expect(await checkpoints()).toEqual(historical.checkpoints);
});
