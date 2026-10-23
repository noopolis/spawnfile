import { installBuiltinGraderProviders } from '../../../src/runtime/trainingGraderProviders.js';
installBuiltinGraderProviders();
export { grokWindowOpen, defaultGrokWindow } from '../../../src/runtime/trainingGraderProviders.js';
import { providers } from './providers.js';
import { buildAtomicRuntime as buildCoreAtomicRuntime } from '../../../src/training/cli/grader/atomic/runtime.js';
import { CliDatasets as CoreCliDatasets } from '../../../src/training/cli/datasets.js';
import type { GraderDependencies } from '../../../src/training/cli/grader/index.js';
export const buildAtomicRuntime: typeof buildCoreAtomicRuntime = (file, dependencies = {}) =>
  buildCoreAtomicRuntime(file, { inferenceProviders: providers, ...dependencies });
export class CliDatasets extends CoreCliDatasets {
  override buildGraders(dependencies: GraderDependencies = {}, exclusions = false) {
    return super.buildGraders({ inferenceProviders: providers, ...dependencies }, exclusions);
  }
}
