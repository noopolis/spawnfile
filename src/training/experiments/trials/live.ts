import type { EvaluationContext, EvaluationRegistry, EvaluationResult, EvaluationSnapshot } from '../../contracts/evaluation.js';
import type { CheckNode, LiveCheck } from '../../contracts/dataset.js';
import { evaluateNode, mayStop } from '../../evaluation/index.js';
import type { TrialReport } from './types.js';

function semantic(node: CheckNode, registry: EvaluationRegistry): boolean {
  if (node.eval) return registry[node.eval]?.definition.kind !== 'mechanical';
  if (node.not) return semantic(node.not, registry);
  return (node.all ?? node.any ?? []).some(child => semantic(child, registry));
}
export function createLiveMonitor(options: {
  checks: readonly LiveCheck[];
  registry: EvaluationRegistry;
  evaluation: Pick<EvaluationContext, 'judges' | 'embeddings' | 'readText'>;
  persist(entry: TrialReport['live'][number]): Promise<void>;
  stop(reason: string): void;
  signal?: AbortSignal;
}) {
  const history: TrialReport['live'] = [];
  const pending: Promise<void>[] = [];
  const latest = new Map<string, EvaluationResult>();
  const artifactDigests = new Map<string, string>();
  let decisive: EvaluationResult | undefined;
  let failed: unknown;
  const checks = structuredClone(options.checks);
  const selected = checks.filter(check => mayStop(check, options.registry));
  async function evaluate(check: LiveCheck, snapshot: EvaluationSnapshot, boundary: string): Promise<void> {
    const evaluated = await evaluateNode(check, { ...options.evaluation, snapshot, results: {}, scores: {}, signal: options.signal }, options.registry);
    const entry = { checkId: check.id, boundary, result: evaluated };
    await options.persist(entry);
    history.push(entry);
    latest.set(check.id, evaluated);
    if (selected.includes(check) && evaluated.status === 'fail' && evaluated.finality === 'final' && !decisive) {
      decisive = evaluated;
      options.stop(`Decisive mechanical violation: ${check.id}`);
    }
  }
  return {
    history,
    get decisive() { return decisive; },
    async checkpoint(snapshot: EvaluationSnapshot, boundary: string): Promise<void> {
      for (const check of checks) {
        if (typeof check.on === 'object' && !snapshot.closed) {
          const artifact = snapshot.artifacts[check.on.artifact];
          if (!artifact || artifactDigests.get(check.id) === artifact.digest) continue;
          artifactDigests.set(check.id, artifact.digest);
        }
        const frozen = structuredClone(snapshot);
        if (semantic(check, options.registry) && !snapshot.closed) {
          // Advisory cognition cannot delay a native callback or gate a later stimulus.
          pending.push(evaluate(check, frozen, boundary).catch(error => { failed = error; }));
        } else await evaluate(check, frozen, boundary);
      }
    },
    async close(snapshot: EvaluationSnapshot, evaluateFinal = true): Promise<EvaluationResult[]> {
      if (evaluateFinal && !decisive) {
        for (const check of selected) {
          await evaluate(check, structuredClone(snapshot), 'closed');
          if (decisive) break;
        }
      }
      await Promise.all(pending);
      if (failed) throw failed;
      if (evaluateFinal && !decisive) {
        for (const check of checks.filter(check => !selected.includes(check))) await evaluate(check, structuredClone(snapshot), 'closed');
      }
      return selected.flatMap(check => latest.has(check.id) ? [latest.get(check.id)!] : []);
    },
  };
}
