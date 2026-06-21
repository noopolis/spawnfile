import { SpawnfileError } from "../shared/index.js";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { ResolvedPackage } from "./types.js";

export interface PackagesByManager {
  apt: ResolvedPackage[];
  npm: ResolvedPackage[];
  pipx: ResolvedPackage[];
}

export const createPackageInstallCommand = (packages: string[]): string =>
  `RUN apt-get update && apt-get install -y --no-install-recommends ${packages.join(" ")} && rm -rf /var/lib/apt/lists/*`;

export const createNpmPackageInstallCommand = (packages: string[]): string =>
  `RUN npm install -g --omit=dev --no-fund --no-audit ${packages.join(" ")}`;

export const createPipxPackageInstallCommand = (packages: string[]): string =>
  `RUN PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install ${packages.join(" ")}`;

const packageIdentity = (pkg: ResolvedPackage): string =>
  `${pkg.manager}\u0000${pkg.name}\u0000${pkg.version ?? ""}\u0000${pkg.scope ?? ""}`;

const packageConflictIdentity = (pkg: ResolvedPackage): string =>
  `${pkg.manager}\u0000${pkg.name}`;

const dedupePackages = (packages: ResolvedPackage[]): ResolvedPackage[] => {
  const seen = new Map<string, ResolvedPackage>();
  for (const currentPackage of packages) {
    seen.set(packageIdentity(currentPackage), currentPackage);
  }

  return [...seen.values()].sort((left, right) =>
    packageIdentity(left).localeCompare(packageIdentity(right))
  );
};

const assertImagePackageCompatibility = (packages: ResolvedPackage[]): void => {
  const byName = new Map<string, ResolvedPackage>();
  for (const currentPackage of packages) {
    const conflictIdentity = packageConflictIdentity(currentPackage);
    const existingPackage = byName.get(conflictIdentity);
    if (!existingPackage) {
      byName.set(conflictIdentity, currentPackage);
      continue;
    }

    if (packageIdentity(existingPackage) !== packageIdentity(currentPackage)) {
      throw new SpawnfileError(
        "validation_error",
        `Generated container declares conflicting package definitions for ${currentPackage.manager} package ${currentPackage.name}`
      );
    }
  }
};

export const createAptPackageInstallItem = (pkg: ResolvedPackage): string =>
  pkg.version ? `${pkg.name}=${pkg.version}` : pkg.name;

export const createNpmPackageInstallItem = (pkg: ResolvedPackage): string =>
  pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;

export const createPipxPackageInstallItem = (pkg: ResolvedPackage): string =>
  pkg.version ? `${pkg.name}==${pkg.version}` : pkg.name;

export const getNpmInstallItemName = (item: string): string => {
  if (!item.startsWith("@")) {
    const versionMarker = item.indexOf("@");
    return versionMarker === -1 ? item : item.slice(0, versionMarker);
  }

  const slashIndex = item.indexOf("/");
  if (slashIndex === -1) {
    return item;
  }

  const versionMarker = item.indexOf("@", slashIndex);
  return versionMarker === -1 ? item : item.slice(0, versionMarker);
};

export const collectPackagesByManager = (
  runtimePlans: RuntimeTargetPlan[]
): PackagesByManager => {
  const packagesByManager: PackagesByManager = {
    apt: [],
    npm: [],
    pipx: []
  };
  const imagePackages = runtimePlans.flatMap((plan) => plan.packages ?? []);
  assertImagePackageCompatibility(imagePackages);

  for (const packageConfig of dedupePackages(imagePackages)) {
    if (packageConfig.manager === "apt") {
      packagesByManager.apt.push(packageConfig);
      continue;
    }

    if (packageConfig.manager === "npm") {
      packagesByManager.npm.push(packageConfig);
      continue;
    }

    packagesByManager.pipx.push(packageConfig);
  }

  return packagesByManager;
};
