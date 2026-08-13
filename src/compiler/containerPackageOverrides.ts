import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDirectory } from "../filesystem/index.js";
import { VENDOR_BUILD_CONTEXT_DIR } from "../runtime/index.js";
import type { RuntimeContainerPackageOverrides } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

const execFile = promisify(execFileCallback);

/**
 * Compile-time-only request map: runtime install npm package name (e.g.
 * "@noopolis/daimon") to the absolute local package directory that should
 * be packed and installed into the generated container instead of the
 * pinned registry version. Only opt-in local/E2E compiles set this (see
 * src/e2e/AGENTS.md); a standard compile passes no overrides and the
 * generated Dockerfile install line is byte-identical to before this
 * mechanism existed.
 */
export type RuntimePackageOverrideRequest = Record<string, string>;

interface NpmPackEntry {
  filename: string;
}

const packOverride = async (
  packageName: string,
  packageDirectory: string,
  vendorDirectory: string
): Promise<{ filename: string }> => {
  try {
    const { stdout } = await execFile("npm", [
      "pack",
      "--json",
      // Every caller (assertRuntimePackageOverrideDistsBuilt in
      // src/e2e/runtimePackageOverrides.ts) already asserts the
      // override directory's dist is built before packing, so a `prepack`
      // lifecycle script here would only redundantly rebuild it — and, since
      // several packages' own `prepack` runs `rm -rf dist && tsc`, doing so
      // is actively unsafe when two compiles pack the same shared source
      // directory concurrently (one's `rm -rf` can race another's dist read).
      "--ignore-scripts",
      "--pack-destination",
      vendorDirectory,
      packageDirectory
    ]);
    const entries = JSON.parse(stdout) as NpmPackEntry[];
    const filename = entries[0]?.filename;
    if (!filename) {
      throw new Error("npm pack did not report a packed filename");
    }
    return { filename };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SpawnfileError(
      "compile_error",
      `Unable to pack local override for ${packageName} from ${packageDirectory}: ${reason}`
    );
  }
};

/**
 * Packs each overridden runtime install package's local directory into the
 * generated container's build context (`<outputDirectory>/container/vendor`)
 * via `npm pack`, so `renderDockerfile` (containerArtifactsRender.ts) can
 * COPY the tarball into the image and `createRuntimeInstallRecipe`
 * (src/runtime/container.ts) can install from it instead of the registry.
 * Mirrors how `stageMoltnetBinaries` (moltnetBinaries.ts) stages binaries
 * directly onto disk outside the EmittedFile pipeline — a `.tgz` cannot
 * round-trip through EmittedFile's string `content`.
 *
 * The caller is responsible for ensuring each override's `dist` is already
 * built (see `assertRuntimePackageOverrideDistsBuilt` in
 * src/e2e/runtimePackageOverrides.ts) — this function only packs, it never
 * builds.
 */
export const stageRuntimePackageOverrides = async (
  outputDirectory: string,
  overrides: RuntimePackageOverrideRequest | undefined
): Promise<RuntimeContainerPackageOverrides | undefined> => {
  if (!overrides || Object.keys(overrides).length === 0) {
    return undefined;
  }

  const vendorDirectory = path.join(outputDirectory, VENDOR_BUILD_CONTEXT_DIR);
  await ensureDirectory(vendorDirectory);

  const resolved: RuntimeContainerPackageOverrides = {};
  for (const [packageName, packageDirectory] of Object.entries(overrides)) {
    resolved[packageName] = await packOverride(packageName, packageDirectory, vendorDirectory);
  }

  return resolved;
};
