import type { DecisionBackend } from '../../contracts/grading.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import type { Grader } from '../../graders/index.js';
import { decisionBackendIdentity } from '../../graders/index.js';
import { createOllamaDecision, createJevDecision, createTeacherDecision } from '../../inference/decision/index.js';
import { createGraderTeacher } from './label.js';

export interface GraderDependencies {
  backend?: (grader: Grader) => DecisionBackend;
  provider?: (teacher: Grader['teachers'][number]) => InferenceProvider;
}

export function graderBackend(grader: Grader, dependencies: GraderDependencies = {}): DecisionBackend {
  if (dependencies.backend) return dependencies.backend(grader);
  const model = grader.model;
  if (model.backend === 'ollama-logprobs') return createOllamaDecision({ endpoint: model.endpoint, model: model.name });
  if (model.backend !== 'teacher') return createJevDecision({ endpoint: model.endpoint });
  const teacher = grader.teachers.find(item => item.id === model.teacher)!;
  return createTeacherDecision({ provider: (dependencies.provider ?? createGraderTeacher)(teacher), model: teacher.model });
}

/** Include routing and teacher policy as well as the backend's reported identity. */
export async function backendIdentity(grader: Grader, backend: DecisionBackend, signal?: AbortSignal): Promise<string> {
  return decisionBackendIdentity(grader, backend, signal);
}
