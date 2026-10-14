import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseDatasetYaml, resolveDataset, resolveDatasetForCost } from '../cases/index.js';
import type { CostDataset } from '../cases/index.js';
import type { CheckNode, ResolvedDataset, ResolutionOptions } from '../contracts/index.js';
import { buildExecutableGradingRuntime, type GraderDependencies } from './grader/index.js';
import type { AtomicRuntime } from '../graders/atomic/index.js';
import type { GraderBinding } from '../cases/index.js';
import type { GradingRuntime } from '../graders/index.js';
import { assertModelRequestAdmission } from '../inference/index.js';

/** Visit logical check positions only; arbitrary evaluator parameters are data. */
function graderChecks(dataset: ResolvedDataset): CheckNode[] {
  const stages = [...dataset.sharedStages, ...dataset.records.flatMap(record => record.effectiveStages)];
  const checks = [...stages.flatMap(stage => [...stage.checks, ...stage.when ? [stage.when] : [], ...stage.gate ? [stage.gate] : []]),
    ...dataset.live.checks, ...dataset.records.flatMap(record => [...record.live.checks, ...record.turns?.flatMap(turn => turn.checks ?? []) ?? []])];
  const found: CheckNode[] = [];
  function visit(check: CheckNode): void {
    if (check.eval === 'grader') found.push(check);
    [...check.all ?? [], ...check.any ?? [], ...check.not ? [check.not] : []].forEach(visit);
  }
  checks.forEach(visit);
  return found;
}

export function readCliBytes(path: string, maximum: number): Buffer {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > maximum) throw new Error('CLI input must be a bounded regular text file');
    const bytes = readFileSync(file);
    if (bytes.length > maximum) throw new Error('CLI input grew beyond its byte bound');
    return bytes;
  } finally { closeSync(file); }
}

export function readCliText(path: string, maximum: number): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readCliBytes(path, maximum));
}

/** Sidecar bytes are resolved and frozen before a native subject can run. */
export class CliDatasets {
  private readonly sidecars = new Map<string, string>();
  private readonly loaded = new Map<string, ResolvedDataset>();
  readonly protectedDirectories = new Set<string>();

  constructor(private readonly judges: Readonly<Record<string, string>>, private readonly cwd: string,
    private readonly preparation: Pick<ResolutionOptions, 'registry' | 'unlockedSetupPaths' | 'subject' | 'inferenceExecutionIdentity'> = {},
    private readonly versions: Record<string, { version: string }> = {},
    private readonly frozen?: { path: string; sourceDigest: string }) {}

  load(file: string, groups: boolean): ResolvedDataset {
    const dataset = this.resolve(file, groups, resolveDataset);
    this.loaded.set(dataset.sourceName, dataset);
    return dataset;
  }

  /** All model construction happens after resolution and before the native subject. */
  async buildGraders(dependencies: GraderDependencies = {}, requireExclusions = false): Promise<Record<string, GradingRuntime | AtomicRuntime>> {
    const graders: Record<string, GradingRuntime | AtomicRuntime> = {};
    for (const dataset of this.loaded.values()) for (const check of graderChecks(dataset)) {
      assertModelRequestAdmission('native-grader', 'grader');
      const filename = check.grader as string;
      const binding = check.grader_binding as GraderBinding;
      const runtime = graders[filename] ?? await buildExecutableGradingRuntime(filename, dependencies);
      if (runtime.definitionDigest !== binding.definitionDigest || ('kind' in runtime ? runtime.templatesDigest !== binding.templatesDigest || binding.kind !== 'atomic' : runtime.calibrationDigest !== binding.calibrationDigest)) {
        throw new Error(`Grader or calibration changed after dataset resolution: ${filename}`);
      }
      if (requireExclusions && !('kind' in runtime)) for (const excluded of this.loaded.values()) {
        if (!runtime.calibration.identity.exclusions.some(item => item.digest === excluded.sourceDigest.replace(/^sha256:/, ''))) {
          throw new Error(`Grader calibration must exclude dataset ${excluded.sourceName}; internal validation requires excluding the whole training dataset`);
        }
      }
      graders[filename] = runtime;
    }
    return graders;
  }

  loadForCost(file: string, groups: boolean): CostDataset {
    return this.resolve(file, groups, resolveDatasetForCost);
  }

  private resolve<T>(file: string, groups: boolean, resolver: (document: ReturnType<typeof parseDatasetYaml>, options: ResolutionOptions) => T): T {
    const path = resolve(this.cwd, file);
    const root = realpathSync(dirname(path));
    this.protectedDirectories.add(root);
    const document = parseDatasetYaml(readCliText(path, 2_000_000), { sourceName: path });
    if (this.frozen?.path === path && this.frozen.sourceDigest !== document.sourceDigest) {
      throw new Error('Dataset changed after authored configuration was selected');
    }
    return resolver(document, {
      requireGroups: groups,
      ...this.preparation,
      registry: { ...this.preparation.registry, judges: Object.fromEntries(Object.keys(this.judges).map((name) => [name, this.versions[name] ?? { version: 'cli.claude-subscription.v1' }])) },
      readCriterionFile: (selected) => {
        // Dataset resolution has already validated a contained relative selector.
        const canonical = realpathSync(resolve(root, selected));
        const within = relative(root, canonical);
        if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('Criterion sidecar escapes its dataset directory');
        const text = readCliText(canonical, 2_000_000);
        if (this.sidecars.has(selected) && this.sidecars.get(selected) !== text) throw new Error(`Ambiguous criterion sidecar ${selected} across datasets`);
        this.sidecars.set(selected, text);
        return text;
      },
    });
  }

  async readCriterion(path: string): Promise<string> {
    const value = this.sidecars.get(path);
    if (value === undefined) throw new Error(`Criterion sidecar was not frozen: ${path}`);
    return value;
  }
}
