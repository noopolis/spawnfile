import path from "node:path";

import { fileExists, readUtf8File, writeUtf8File } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

export type RuntimePackageOverrides = Record<string, string>;

export const applyRuntimePackageOverrides = async (
  packageJsonPath: string,
  overrides: RuntimePackageOverrides | undefined
): Promise<void> => {
  if (!overrides || Object.keys(overrides).length === 0) {
    return;
  }

  const packageJson = JSON.parse(await readUtf8File(packageJsonPath)) as {
    dependencies?: Record<string, string>;
  };
  packageJson.dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...overrides
  };
  await writeUtf8File(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
};

/**
 * Compile-time-only local overrides for CONTAINER runtime install npm
 * packages (see src/compiler/containerPackageOverrides.ts /
 * createContainerArtifacts's `runtimePackageOverrides` option): package
 * name to absolute local package directory, plain (no `file:` prefix,
 * unlike RuntimePackageOverrides above which rewrites a generated
 * package.json's `dependencies` and needs the npm dependency-spec form).
 */
export type RuntimeContainerPackageOverrideRequest = Record<string, string>;

/** Asserts every override package directory in `overrides` has a built
 * `dist/index.js`, throwing a clear `runtime_error` naming the exact
 * package and directory otherwise. This checks the plain-directory
 * RuntimeContainerPackageOverrideRequest form used for container builds, as
 * opposed to the `file:`-prefixed RuntimePackageOverrides form above (used
 * for local-rootfs package.json rewrites). */
export const assertRuntimePackageOverrideDistsBuilt = async (
  overrides: RuntimeContainerPackageOverrideRequest
): Promise<void> => {
  for (const [packageName, packageDirectory] of Object.entries(overrides)) {
    const distEntry = path.join(packageDirectory, "dist", "index.js");
    if (!(await fileExists(distEntry))) {
      throw new SpawnfileError(
        "runtime_error",
        `${packageName} override at ${packageDirectory} has no built dist (${distEntry}); run "npm run build" in that package first`
      );
    }
  }
};
