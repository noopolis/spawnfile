import { readFile } from 'node:fs/promises';
import { loadGrader, loadLabels, parseCalibrationJson, sha256, checkCalibration, createCalibrationIdentity,
  type GradingRuntime } from '../../graders/index.js';
import { validateStoredVotes } from '../../graders/labeling/index.js';
import { DECISION_PROMPT_VERSION } from '../../inference/decision/index.js';
import { graderBackend, backendIdentity, type GraderDependencies } from './backend.js';
import { createGraderTeacher } from './label.js';
import { readExclusions } from './exclusions.js';

/** Endpoint tokens are shared across separately constructed grader routes. */
const resources = new Map<string, object>();

export async function buildGradingRuntime(graderFile: string, dependencies: GraderDependencies = {}, signal?: AbortSignal): Promise<GradingRuntime> {
  const source = await readFile(graderFile, 'utf8');
  const grader = await loadGrader(graderFile);
  const calibrationSource = await readFile(grader.calibration, 'utf8');
  const calibration = parseCalibrationJson(calibrationSource);
  const golden = await loadLabels(grader.golden, grader);
  validateStoredVotes(grader, golden.labels, { resolved: true });
  const exclusions = await readExclusions(calibration.identity.exclusions.map(item => item.dataset));
  const backend = graderBackend(grader, dependencies);
  const identity = createCalibrationIdentity(grader, { backendModel: await backendIdentity(grader, backend, signal),
    promptTemplateVersion: DECISION_PROMPT_VERSION, golden: golden.goldenDigest,
    seed: calibration.identity.seed, exclusions: exclusions.identities });
  const check = checkCalibration(grader, calibration, identity);
  if (!check.ok) throw new Error(check.refusals.join('; '));
  const definition = grader.teachers.find(teacher => teacher.id === grader.escalate.to)!;
  const provider = (dependencies.provider ?? createGraderTeacher)(definition);
  const endpoint = grader.model.backend === 'teacher'
    ? `teacher:${grader.model.teacher}:${grader.teachers.find(t => t.id === (grader.model as { teacher: string }).teacher)!.model}`
    : new URL(grader.model.endpoint).href.replace(/\/$/, '');
  if (!resources.has(endpoint)) resources.set(endpoint, {});
  // Detect an edit between parsing and hashing rather than binding different bytes.
  if (await readFile(graderFile, 'utf8') !== source) throw new Error('Grader file changed while loading');
  return { grader, calibration, backend, teacher: { provider, model: definition.model },
    goldenDigest: golden.goldenDigest, promptTemplateVersion: DECISION_PROMPT_VERSION,
    resource: resources.get(endpoint)!, definitionDigest: sha256(source), calibrationDigest: sha256(calibrationSource) };
}
