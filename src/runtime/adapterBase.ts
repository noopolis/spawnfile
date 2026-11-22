import type { EffectiveModelTarget, ResolvedAgentNode } from "../compiler/types.js";
import { SpawnfileError } from "../shared/index.js";
import {
  createRuntimeImageCopyCommand, globalNpmInstallCommand,
  type RuntimeInstallCapability
} from "./containerRecipe.js";
import {
  createVendorCopyCommand, needsVendorCopyCommand, resolveInstallPackageSpec
} from "./containerPackageOverrides.js";
import type { AdapterCompileResult, RuntimeAdapter, RuntimeCompileContext, RuntimeContainerMeta } from "./types.js";

export const standardRuntimeInstall: RuntimeInstallCapability = Object.freeze({
  hints: {
    container_image: { ecosystem: "node", installHint: "Copy files from the pinned runtime image." },
    github_release_archive: { ecosystem: "go", installHint: "Download the pinned runtime release archive." },
    npm: { ecosystem: "node", installHint: "Install the pinned npm runtime package." },
    source_repo: { ecosystem: "node", installHint: "Use the pinned runtime source ref." }
  },
  createRecipe({ containerEnv, installRoot, packageOverrides, runtimeName, selection }) {
    switch (selection.kind) {
      case "npm": {
        const spec = resolveInstallPackageSpec(selection.packageName, selection.version, packageOverrides);
        return {
          commands: [globalNpmInstallCommand([spec])],
          copyCommands: needsVendorCopyCommand([selection.packageName], packageOverrides) ? [createVendorCopyCommand()] : [],
          env: containerEnv,
          runtimeName,
          runtimeRoot: `/usr/local/lib/node_modules/${selection.packageName}`
        };
      }
      case "container_image": {
        const image = selection.digest ? `${selection.image}@${selection.digest}` : `${selection.image}:${selection.tag}`;
        return {
          commands: [],
          copyCommands: [createRuntimeImageCopyCommand(image, installRoot)],
          env: containerEnv,
          runtimeName,
          runtimeRoot: installRoot
        };
      }
      default:
        throw new SpawnfileError("runtime_error", `Runtime ${runtimeName} must supply a recipe for ${selection.kind}`);
    }
  }
} satisfies RuntimeInstallCapability);

export abstract class RuntimeAdapterBase implements RuntimeAdapter {
  abstract readonly name: string;
  abstract readonly container: RuntimeContainerMeta;
  abstract compileAgent(node: ResolvedAgentNode, context?: RuntimeCompileContext): Promise<AdapterCompileResult>;
  readonly install: RuntimeInstallCapability = standardRuntimeInstall;

  /** Override for model or auth restrictions specific to the runtime. */
  assertSupportedModelTarget(_target: EffectiveModelTarget): void {}
}
