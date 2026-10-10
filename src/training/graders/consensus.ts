import type { Label, Labels, Option } from './format/index.js';

export interface Consensus {
  answer?: Option;
  disputed: boolean;
  source: 'human' | 'consensus' | 'single-teacher';
  votes: Record<string, Option>;
}

/** Missing and abstaining teachers stay in the asked denominator. */
export function deriveConsensus(label: Label, labelers: Labels['labelers'], instanceKeys = Object.keys(label.votes)): Record<string, Consensus> {
  const asked = new Set([...(label.asked ?? []), ...Object.values(label.votes).flatMap(votes => Object.keys(votes))]);
  const teachers = [...asked].filter(name => labelers[name]?.kind === 'model');
  return Object.fromEntries(instanceKeys.map(key => {
    const votes = label.votes[key] ?? {};
    const humanAnswers = new Set(Object.entries(votes).filter(([name, vote]) =>
      labelers[name]?.kind === 'human' && vote !== 'abstain').map(([, vote]) => vote));
    if (humanAnswers.size) {
      const answer = humanAnswers.size === 1 ? [...humanAnswers][0] : undefined;
      return [key, { answer, disputed: answer === undefined, source: 'human', votes }];
    }
    const counts = new Map<Option, number>();
    for (const teacher of teachers) {
      const vote = votes[teacher];
      if (vote !== undefined && vote !== 'abstain') counts.set(vote, (counts.get(vote) ?? 0) + 1);
    }
    const answer = [...counts].find(([, count]) => count > teachers.length / 2)?.[0];
    return [key, { answer, disputed: answer === undefined, source: teachers.length === 1 ? 'single-teacher' : 'consensus', votes }];
  }));
}
