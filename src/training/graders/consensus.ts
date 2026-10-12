import type { Label, Labels, Option } from './format/index.js';

export interface Consensus {
  answer?: Option;
  disputed: boolean;
  source: 'human' | 'editor' | 'consensus' | 'single-teacher';
  votes: Record<string, Option>;
}

/** Explicit instance dispatch wins; legacy labels retain their conservative output-wide denominator. */
export function askedForInstance(label: Label, key: string): string[] {
  const asked = label.askedByInstance ? label.askedByInstance[key] ?? [] :
    [...label.asked ?? [], ...Object.values(label.votes).flatMap(votes => Object.keys(votes))];
  return [...new Set([...asked, ...Object.keys(label.votes[key] ?? {})])];
}

/** Missing/abstaining teachers stay in the denominator. Signals remain in receipts only. */
export function deriveConsensus(label: Label, labelers: Labels['labelers'], instanceKeys = Object.keys(label.votes)): Record<string, Consensus> {
  return Object.fromEntries(instanceKeys.map(key => {
    const votes = label.votes[key] ?? {};
    const teachers = askedForInstance(label, key).filter(name => labelers[name]?.kind === 'model');
    for (const kind of ['human', 'editor'] as const) {
      const answers = new Set(Object.entries(votes).filter(([name, vote]) =>
        labelers[name]?.kind === kind && vote !== 'abstain').map(([, vote]) => vote));
      if (answers.size) {
        const answer = answers.size === 1 ? [...answers][0] : undefined;
        return [key, { answer, disputed: answer === undefined, source: kind, votes }];
      }
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
