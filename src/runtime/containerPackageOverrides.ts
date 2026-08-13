/**
 * Contract for overriding one runtime install npm package (e.g.
 * `@noopolis/daimon`) with a locally packed tarball instead of the pinned
 * registry version, inside a generated container build.
 *
 * This is opt-in and compile-time only: `createRuntimeInstallRecipe`
 * (container.ts) accepts an optional `packageOverrides` map and, for each
 * package name it installs, swaps the registry `name@version` spec for the
 * vendored tarball path only when an override entry exists for that exact
 * package name. With no overrides the generated Dockerfile install line is
 * byte-identical to before this module existed.
 *
 * The actual packing (`npm pack` into the container build context) is
 * compiler-level I/O and lives in
 * src/compiler/containerPackageOverrides.ts, which produces the
 * `RuntimeContainerPackageOverrides` map this module's helpers consume.
 */

export const VENDOR_BUILD_CONTEXT_DIR = "container/vendor";
export const VENDOR_CONTAINER_DIR = "/opt/spawnfile/vendor";

export interface RuntimeContainerPackageOverride {
  /** Tarball filename `npm pack` wrote into VENDOR_BUILD_CONTEXT_DIR, e.g.
   * "noopolis-daimon-0.1.2.tgz" — whatever npm itself names it. */
  filename: string;
}

/** Keyed by npm package name, e.g. "@noopolis/daimon". */
export type RuntimeContainerPackageOverrides = Record<string, RuntimeContainerPackageOverride>;

/** The single Dockerfile COPY line that stages the packed vendor tarballs
 * into the image; emitted at most once per runtime install recipe, only
 * when that recipe actually installs an overridden package. */
export const createVendorCopyCommand = (): string =>
  `COPY ${VENDOR_BUILD_CONTEXT_DIR}/ ${VENDOR_CONTAINER_DIR}/`;

/** Resolves the npm install spec for one runtime install package: the
 * vendored tarball path when overridden, otherwise the unchanged
 * `name@version` registry spec. */
export const resolveInstallPackageSpec = (
  packageName: string,
  version: string,
  overrides?: RuntimeContainerPackageOverrides
): string => {
  const override = overrides?.[packageName];
  return override ? `${VENDOR_CONTAINER_DIR}/${override.filename}` : `${packageName}@${version}`;
};

/** True when at least one of the given package names has an override,
 * i.e. this recipe's Dockerfile needs the vendor COPY line. */
export const needsVendorCopyCommand = (
  packageNames: string[],
  overrides?: RuntimeContainerPackageOverrides
): boolean => Boolean(overrides) && packageNames.some((name) => Boolean(overrides?.[name]));
