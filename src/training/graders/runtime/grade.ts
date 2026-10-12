import type { DecisionRequest, DecisionResult, DecisionRequestReceipt } from '../../contracts/grading.js';
import { allQuestions, decisionModels, expectedOptions, optionsFor, stableDigest, type DecisionQuestion } from '../format/index.js';
import { planCallAdmission } from '../admission.js';
import { expandInstances } from '../instances.js';
import { aggregateGrader, type InstanceOutcome } from '../aggregation.js';
import { checkCalibration, createCalibrationIdentity } from '../identity.js';
import { applyPlatt, inEscalationBand } from '../calibration/index.js';
import { teacherPolicyDigest, type LabelGroup } from '../labeling/index.js';
import { summarizeDecisionAccounting, withDecisionFailureAccounting } from './accounting.js';
import { decisionModelIdentities } from './identity.js';
import { escalateGroup } from './teacher.js';
import type { GradeOptions, GradeResult } from './types.js';

function goodProbability(question: DecisionQuestion, result: DecisionResult): number | undefined {
  if (result.status !== 'ok' || !result.probabilities) return undefined;
  const values = optionsFor(question).map(option => result.probabilities![String(option)]);
  if (values.some(value => !Number.isFinite(value) || value! < 0 || value! > 1) ||
    Math.abs(values.reduce<number>((sum, value) => sum + value!, 0) - 1) > 1e-5) {
    throw new Error(`Invalid decision probabilities: ${question.id}`);
  }
  return expectedOptions(question).reduce<number>((sum, option) => sum + result.probabilities![String(option)]!, 0);
}

/** No golden examples enter requests. Calibration is checked before any scoring. */
export async function gradeOutput(options: GradeOptions): Promise<GradeResult> {
  const backends = options.backends ?? (options.grader.model ? { default: options.backend } : {});
  const receipts: DecisionRequestReceipt[] = [];
  return withDecisionFailureAccounting(new Set(Object.values(backends)), receipts, () => gradeOutputInternal(options, receipts));
}

async function gradeOutputInternal(options: GradeOptions, receipts: DecisionRequestReceipt[]): Promise<GradeResult> {
  const { grader, calibration, signal } = options;
  signal?.throwIfAborted();
  if (grader.gates.some(gate => 'check' in gate && options.gateOutcomes?.[gate.id] === 'fail')) {
    return { ...aggregateGrader(grader, expandInstances(grader, options.output, options.context), {}, options.gateOutcomes),
      judgeCalls: [], decisions: [], ...resultIdentity(options) };
  }
  const models = decisionModels(grader);
  const backends = options.backends ?? (grader.model ? { default: options.backend } : {});
  const selectedId = (question: string) => calibration.questions[question]?.model ?? 'default';
  for (const question of allQuestions(grader)) {
    if (!backends[selectedId(question.id)]) throw new Error(`Decision model ${selectedId(question.id)}: missing backend`);
  }
  const reported = await decisionModelIdentities(grader, backends, signal, receipts);
  const modelIdentities = { ...calibration.identity.modelIdentities, ...reported };
  const backendModel = grader.models ? stableDigest(modelIdentities) : reported.default!;
  const identity = createCalibrationIdentity(grader, { ...calibration.identity, backendModel,
    ...(grader.models ? { modelIdentities } : {}),
    segmenter: undefined, golden: options.goldenDigest, promptTemplateVersion: options.promptTemplateVersion });
  const checked = checkCalibration(grader, calibration, identity);
  if (!checked.ok) throw new Error(checked.refusals.join('; '));
  const questions = new Map(allQuestions(grader).map(question => [question.id, question]));
  const selectedModel = (question: string) => models.find(model => model.id === selectedId(question))!;
  for (const [id] of questions) {
    if (calibration.questions[id]?.status === 'calibrated' && selectedModel(id).backend !== 'teacher' &&
      (!calibration.questions[id]!.params || !calibration.questions[id]!.band)) {
      throw new Error(`question ${id}: calibration lacks Platt parameters or escalation band`);
    }
  }
  const instances = expandInstances(grader, options.output, options.context);
  const outcomes: Record<string, InstanceOutcome> = {};
  const groups = new Map<string, LabelGroup>();
  const escalate = (instance: typeof instances[number]) => {
    let group = groups.get(instance.projectionDigest);
    if (!group) {
      group = { projection: instance.projection, projectionDigest: instance.projectionDigest, instances: [] };
      groups.set(instance.projectionDigest, group);
    }
    group.instances.push({ instance, question: questions.get(instance.questionId)! });
    outcomes[instance.key] = { status: 'missing', escalated: true };
  };
  const requestsByModel = new Map<string, DecisionRequest[]>();
  for (const instance of instances) {
    if (instance.state !== 'ready') continue;
    if (selectedModel(instance.questionId).backend !== 'teacher' && checked.notCalibrated.includes(instance.questionId)) { escalate(instance); continue; }
    const question = questions.get(instance.questionId)!;
    const id = selectedId(instance.questionId);
    const requests = requestsByModel.get(id) ?? [];
    requestsByModel.set(id, requests);
    requests.push({ key: instance.key, type: question.type, optionLabels: optionsFor(question),
      expectedOptions: expectedOptions(question), instructions: question.ask ?? question.id, projection: instance.projection });
  }
  const judgeCalls: GradeResult['judgeCalls'] = [];
  const decisions: NonNullable<GradeResult['decisions']> = [];
  const resultMap = new Map<string, DecisionResult>();
  for (const [model, requests] of requestsByModel) {
    const results = await backends[model]!.score(requests, signal, receipts);
    for (const result of results) {
      if (resultMap.has(result.key) || !requests.some(request => request.key === result.key)) throw new Error(`Unexpected decision key: ${result.key}`);
      resultMap.set(result.key, result);
      judgeCalls.push(...result.judgeCalls ?? []);
    }
    for (const request of requests) decisions.push({ instance: request.key, model,
      status: resultMap.get(request.key)?.status === 'ok' && resultMap.get(request.key)?.probabilities ? 'ok' : 'missing',
      ...(resultMap.get(request.key)?.reason ? { reason: resultMap.get(request.key)!.reason } : {}) });
  }
  for (const instance of instances) {
    const result = resultMap.get(instance.key);
    if (!result) continue;
    const raw = goodProbability(questions.get(instance.questionId)!, result);
    if (raw === undefined) continue;
    const fitted = calibration.questions[instance.questionId]!;
    const teacherModel = selectedModel(instance.questionId).backend === 'teacher';
    const pGood = teacherModel ? raw : applyPlatt(raw, fitted.params!);
    if (!teacherModel && inEscalationBand(pGood, fitted.band!)) escalate(instance);
    else outcomes[instance.key] = { pGood };
  }
  const calls = planCallAdmission(instances.filter(instance => outcomes[instance.key]?.escalated)
    .map(instance => ({ outputId: 'trial', projectionDigest: instance.projectionDigest })), grader.escalate.max_calls_per_trial);
  for (const call of calls) {
    if (!options.teacher || !call.admitted) continue;
    const group = groups.get(call.projectionDigest)!;
    group.instances.sort((a, b) => instances.indexOf(a.instance) - instances.indexOf(b.instance));
    const definition = grader.teachers.find(teacher => teacher.id === grader.escalate.to)!;
    if (options.teacher.model !== definition.model || options.teacher.provider.id !== `${definition.provider}-subscription`) {
      throw new Error('Escalation teacher route does not match declared policy');
    }
    const result = await escalateGroup(group, options.teacher, definition.id, signal);
    judgeCalls.push(result.call);
    for (const { instance, question } of group.instances) {
      const vote = result.votes?.[instance.key];
      if (vote !== undefined && vote !== 'abstain') outcomes[instance.key] = {
        pGood: Number(expectedOptions(question).includes(vote)), escalated: true };
    }
  }
  signal?.throwIfAborted();
  if (stableDigest(await decisionModelIdentities(grader, backends, signal, receipts)) !== stableDigest(reported)) throw new Error('Backend identity changed during grading');
  const apiBackends = [...new Set(Object.values(backends))].filter(backend => backend.capabilities?.billing === 'api');
  return { ...aggregateGrader(grader, instances, outcomes, options.gateOutcomes), judgeCalls, decisions,
    ...(apiBackends.length ? { decisionAccounting: summarizeDecisionAccounting(receipts) } : {}),
    ...resultIdentity(options, identity) };
}

function resultIdentity(options: GradeOptions, identity = options.calibration.identity): Pick<GradeResult, 'identity' | 'backendBilling'> {
  const { grader, calibration } = options;
  const selected = new Set(Object.values(calibration.questions).map(question => question.model ?? 'default'));
  const billing = new Set(decisionModels(grader).filter(model => selected.has(model.id)).map(model => model.backend === 'teacher' ? 'subscription' : model.backend === 'typesafe' ? 'api' : 'local'));
  return {
    backendBilling: billing.size > 1 ? 'mixed' : billing.has('subscription') ? 'subscription' : billing.has('api') ? 'api' : 'local',
    identity: { calibration: identity, calibrationDigest: stableDigest(calibration), escalation: stableDigest(grader.escalate),
      teacherPolicy: stableDigest({ escalation: teacherPolicyDigest(grader.teachers.find(t => t.id === grader.escalate.to)!),
        uncalibrated: grader.uncalibrated }),
      scoringPolicy: stableDigest({ version: 'paideia.grading.v1', questions: grader.questions, gates: grader.gates, score: grader.score }) } };
}
