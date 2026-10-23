import { expect, it } from 'vitest';
import type { CandidateManifest } from '../../candidates/index.js';
import type { TrialReport } from '../trials/index.js';
import { evaluateHeldOut } from './held-out.js';

const candidates = [{ id: 'baseline' }, { id: 'selected' }] as CandidateManifest[];
const report = (id: string) => ({ id } as TrialReport);

it('retains the first of simultaneous failures while consuming every worker rejection', async () => {
  const first = new Error('first failure'), second = new Error('second failure');
  const started: string[] = [];
  await expect(evaluateHeldOut({ candidates, caseIds: ['a', 'b', 'c'], concurrency: 2,
    async trial(_candidate, caseId) {
      started.push(caseId);
      throw caseId === 'a' ? first : second;
    }, measurement: captured => ({ id: captured.id, score: 1 }),
  })).rejects.toBe(first);
  expect(started).toEqual(['a', 'b']);
});

it.each([1, 2, 4])('bounds sealed trials at %s and binds scores in declaration order after reverse completion', async concurrency => {
  let active = 0, peak = 0;
  const pending: (() => void)[] = [];
  const measured: string[] = [];
  const result = await evaluateHeldOut({ candidates, caseIds: ['a', 'b'], concurrency,
    async trial(candidate, caseId) {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => {
        pending.push(resolve);
        if (pending.length === concurrency) {
          const batch = pending.splice(0);
          for (const release of batch.reverse()) release();
        }
      });
      active--;
      return report(`${candidate.id}:${caseId}`);
    },
    measurement(captured) {
      measured.push(captured.id);
      return { id: `measurement:${captured.id}`, score: captured.id.startsWith('baseline') ? 1 : 0 };
    },
  });
  expect(active).toBe(0); expect(peak).toBe(concurrency);
  expect(measured.toSorted()).toEqual(['baseline:a', 'baseline:b', 'selected:a', 'selected:b']);
  expect(result).toEqual(candidates.map(candidate => ({ candidateId: candidate.id,
    meanScore: candidate.id === 'baseline' ? 1 : 0,
    trialIds: ['a', 'b'].map(id => `${candidate.id}:${id}`),
    evaluationIds: ['a', 'b'].map(id => `measurement:${candidate.id}:${id}`) })));
});

it.each(['native', 'measurement'])('stops dequeuing on %s failure and drains every active sealed trial before rejecting', async kind => {
  const started: string[] = [];
  let release!: () => void;
  let settled = false, returned = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error('native closure failed');
  const running = evaluateHeldOut({ candidates, caseIds: ['a', 'b', 'c'], concurrency: 2,
    async trial(candidate, caseId) {
      started.push(`${candidate.id}:${caseId}`);
      if (caseId === 'a') {
        if (kind === 'native') throw failure;
        return report('failed');
      }
      await gate; settled = true; return report(caseId);
    }, measurement: captured => {
      if (captured.id === 'failed') throw failure;
      return { id: captured.id, score: 1 };
    },
  }).finally(() => { returned = true; });
  const rejected = expect(running).rejects.toBe(failure);
  await Promise.resolve(); await Promise.resolve();
  expect(returned).toBe(false);
  expect(started).toEqual(['baseline:a', 'baseline:b']);
  release(); await rejected;
  expect(settled).toBe(true); expect(returned).toBe(true);
  expect(started).toHaveLength(2);
});

it.each([undefined, 1])('preserves one native pass when repeats is %s', async testRepeats => {
  const started: string[] = [];
  const scores = await evaluateHeldOut({ candidates, caseIds: ['one'], concurrency: 1, testRepeats,
    async trial(candidate, caseId, repeat) { const id = `${candidate.id}:${caseId}:${repeat}`; started.push(id); return report(id); },
    measurement: captured => ({ id: captured.id, score: 0.5 }),
  });
  expect(started).toEqual(['baseline:one:0', 'selected:one:0']);
  expect(JSON.stringify(scores)).toBe(JSON.stringify(candidates.map(candidate => ({ candidateId: candidate.id, meanScore: 0.5,
    trialIds: [`${candidate.id}:one:0`], evaluationIds: [`${candidate.id}:one:0`] }))));
});

it('schedules every candidate/case/repeat and computes sample standard error over all trials', async () => {
  const started: string[] = [];
  const scores = await evaluateHeldOut({ candidates, caseIds: ['a', 'b'], concurrency: 4, testRepeats: 3,
    async trial(candidate, caseId, repeat) {
      const id = `${candidate.id}:${caseId}:${repeat}`; started.push(id); return report(id);
    }, measurement: captured => ({ id: `score:${captured.id}`, score: Number(captured.id.at(-1)) / 2 }),
  });
  expect(started).toHaveLength(12); expect(new Set(started).size).toBe(12);
  for (const arm of scores) {
    expect(arm.trialIds).toEqual(['a', 'b'].flatMap(id => [0, 1, 2].map(repeat => `${arm.candidateId}:${id}:${repeat}`)));
    expect(arm.evaluationIds).toEqual(arm.trialIds.map(id => `score:${id}`));
    expect(arm.trialScores).toEqual([0, 0.5, 1, 0, 0.5, 1]);
    expect(arm.meanScore).toBe(0.5); expect(arm.standardError).toBeCloseTo(Math.sqrt(1 / 30));
  }
});
