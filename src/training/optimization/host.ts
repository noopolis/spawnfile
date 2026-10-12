import type { InferenceAttempt, InferenceResult } from '../contracts/execution.js';
import { InferenceFailure } from '../inference/index.js';
import { evaluationSchema, inferenceSchema, type DspyEvaluation, type DspyEvaluateParams,
  type DspyRequest, type DspyStart } from './protocol.js';
import type { OptimizationCheckpoint } from './checkpoint.js';
import type { DspyOptimizationOptions } from './types.js';
import { assertBoundaries, compileBoundaries } from './boundaries.js';

export interface CompletedEvaluation extends DspyEvaluateParams { result: DspyEvaluation }

export class DspyHost {
  evaluations = 0;
  proposals = 0;
  pending = 0;
  readonly completed: CompletedEvaluation[] = [];
  readonly generations: InferenceResult[] = [];
  readonly inferenceAttempts: InferenceAttempt[] = [];
  private readonly calls = new Set<string>();
  private readonly captures = new Set<string>();

  constructor(readonly start: DspyStart, private readonly options: DspyOptimizationOptions, private readonly checkpoint?: OptimizationCheckpoint) {
    for (const entry of checkpoint?.entries ?? []) {
      this.inferenceAttempts.push(...entry.failedAttempts ?? []);
      if (entry.result === undefined) continue;
      if (entry.request.method === 'evaluate') {
        const result = evaluationSchema.parse(entry.result);
        this.evaluations += 1; this.captures.add(result.captureId);
        this.completed.push({ ...entry.request.params, result });
      } else {
        this.proposals += 1; this.generations.push(entry.inference!);
        this.inferenceAttempts.push(...entry.inference!.attempts ?? []);
      }
    }
  }

  async work<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    this.pending += 1;
    const work = Promise.resolve().then(operation);
    void work.then(() => { this.pending -= 1; }, () => { this.pending -= 1; });
    let listener!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      listener = () => reject(new Error('DSPy host work was cancelled'));
      signal.addEventListener('abort', listener, { once: true });
    });
    try { return await Promise.race([work, interrupted]); }
    finally { signal.removeEventListener('abort', listener); }
  }

  async validate(components: Record<string, string>, signal: AbortSignal): Promise<void> {
    const expected = Object.keys(this.start.components);
    if (Object.keys(components).length !== expected.length || expected.some((key) => !Object.hasOwn(components, key))) {
      throw new Error('DSPy candidate changed the declared editable component set');
    }
    assertBoundaries(compileBoundaries(this.start.search?.boundaries ?? [], this.start.components), components);
    await this.work(() => this.options.validateComponents(Object.freeze({ ...components }), signal), signal);
  }

  async handle(request: DspyRequest, signal: AbortSignal): Promise<unknown> {
    if (this.calls.has(request.id)) throw new Error('DSPy reused a callback ID');
    const entry = await this.checkpoint?.begin(request, this.start.budget);
    if (entry?.result !== undefined) { this.calls.add(request.id); return entry.result; }
    if (this.calls.size >= this.start.budget.maxMetricCalls + this.start.budget.maxProposals) {
      throw new Error('DSPy exceeded its total callback budget');
    }
    this.calls.add(request.id);
    if (request.method === 'generate') {
      if (this.proposals >= this.start.budget.maxProposals) throw new Error('DSPy exceeded its proposal budget');
      this.proposals += 1;
      const generated = await this.work(async () => {
        let response: InferenceResult;
        try { response = await this.options.generate(request.params, signal, request.id); }
        catch (error) {
          if (error instanceof InferenceFailure) {
            this.inferenceAttempts.push(...error.attempts);
            if (entry) await this.checkpoint!.failed(entry, error.attempts);
          }
          throw error;
        }
        // Capture settled provider evidence before validation or the outer abort race.
        this.inferenceAttempts.push(...response.attempts ?? []);
        return inferenceSchema.parse(response);
      }, signal);
      this.generations.push(generated);
      const result = { text: generated.text, model: generated.model, usage: generated.usage,
        ...(generated.modelBasis === undefined ? {} : { modelBasis: generated.modelBasis }) };
      if (entry) await this.checkpoint!.complete(entry, result, generated);
      return result;
    }
    const params = request.params;
    const allowed = params.split === 'train' ? this.start.trainCaseIds : this.start.validationCaseIds;
    if (!allowed.includes(params.caseId)) throw new Error('DSPy requested a case outside its declared split');
    if (this.evaluations >= this.start.budget.maxMetricCalls) throw new Error('DSPy exceeded its native evaluation budget');
    await this.validate(params.components, signal);
    this.evaluations += 1;
    const frozen = Object.freeze({ ...params, components: Object.freeze({ ...params.components }) });
    const result = evaluationSchema.parse(await this.work(() => this.options.evaluate(frozen, signal, request.id), signal));
    if (params.split === 'validation' && (result.feedback.length > 0 || result.output.length > 0)) {
      throw new Error('DSPy validation may return only a scalar and capture reference');
    }
    if (this.captures.has(result.captureId)) throw new Error('DSPy evaluations must identify fresh native captures');
    this.captures.add(result.captureId);
    this.completed.push({ ...params, result });
    if (entry) await this.checkpoint!.complete(entry, result);
    return result;
  }
}
