import { stableDigest } from '../format/index.js';
import type { CouncilOutput, TeacherAnswer } from './types.js';

/** Confidence is supported answer mass; unassigned mass remains explicitly unknown. */
export function averageAnswers(options: string[], answers: TeacherAnswer[]) {
  const distribution = Object.fromEntries(options.map(option => [option, 0]));
  for (const vote of answers) {
    if (vote.answer !== null && Object.hasOwn(distribution, vote.answer)) distribution[vote.answer]! += (vote.p ?? 1) / answers.length;
  }
  return { distribution, unknown_mass: Math.max(0, 1 - Object.values(distribution).reduce((sum, p) => sum + p, 0)) };
}

export function councilContentDigest(output: Omit<CouncilOutput, 'digest'>): string { return stableDigest(output); }
export function reusableCouncil(output: CouncilOutput, identity: string): boolean {
  const { digest, ...content } = output;
  return output.complete === true && output.identity === identity && digest === councilContentDigest(content);
}
