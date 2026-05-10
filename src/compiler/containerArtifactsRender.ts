import path from "node:path";

import { createRuntimeInstallRecipe } from "../runtime/index.js";
import type { EmittedFile } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import type {
  ContainerEnvVariable,
  RuntimeTargetPlan
} from "./containerArtifactsTypes.js";
import type { EntrypointOptions } from "./containerEntrypointRender.js";
export { renderEntrypoint } from "./containerEntrypointRender.js";
export type { EntrypointOptions } from "./containerEntrypointRender.js";
import { MOLTNET_BIN_DIRECTORY, MOLTNET_BINARY_NAMES } from "./moltnetBinaries.js";
import type { ResolvedPackage } from "./types.js";

const CONTAINER_ROOTFS_ROOT = "container/rootfs";
const GATEWAY_PORT_PLACEHOLDER = "<gateway-port>";
const MOLTNET_INSTALL_SCRIPT_URL = "https://moltnet.dev/install.sh";
const WORKSPACE_PLACEHOLDER = "<workspace-path>";

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

const extractNodeMajorVersion = (image: string): number =>
  Number(image.match(/^node:(\d+)/)?.[1] ?? "0");

const createPackageInstallCommand = (packages: string[]): string =>
  `RUN apt-get update && apt-get install -y --no-install-recommends ${packages.join(" ")} && rm -rf /var/lib/apt/lists/*`;

const createNpmPackageInstallCommand = (packages: string[]): string =>
  `RUN npm install -g --omit=dev --no-fund --no-audit ${packages.join(" ")}`;

const createPipxPackageInstallCommand = (packages: string[]): string =>
  `RUN PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install ${packages.join(" ")}`;

const createStateOwnershipCommand = (persistentMountPaths: string[] = []): string => {
  const mountPaths = [...new Set(persistentMountPaths)].sort();
  const mkdirPaths = [...new Set(["/var/lib/spawnfile", ...mountPaths])].sort();
  const markerCommands = mountPaths.map((mountPath) =>
    `touch ${shellQuote(path.posix.join(mountPath, ".spawnfile-volume-init"))}`
  );
  const chownPaths = [
    ...new Set([
      "/var/lib/spawnfile",
      "/opt/spawnfile",
      ...mountPaths.filter((mountPath) => !mountPath.startsWith("/var/lib/spawnfile/"))
    ])
  ].sort();

  return [
    `mkdir -p ${mkdirPaths.map(shellQuote).join(" ")}`,
    ...markerCommands,
    `chown -R spawnfile:spawnfile ${chownPaths.map(shellQuote).join(" ")}`
  ].join(" && ");
};

const dedupePackages = (packages: ResolvedPackage[]): ResolvedPackage[] => {
  const seen = new Map<string, ResolvedPackage>();
  for (const currentPackage of packages) {
    seen.set(
      `${currentPackage.manager}\u0000${currentPackage.name}\u0000${currentPackage.version ?? ""}\u0000${currentPackage.scope ?? ""}`,
      currentPackage
    );
  }

  return [...seen.values()].sort((left, right) =>
    `${left.manager}\u0000${left.name}\u0000${left.version ?? ""}\u0000${left.scope ?? ""}`.localeCompare(
      `${right.manager}\u0000${right.name}\u0000${right.version ?? ""}\u0000${right.scope ?? ""}`
    )
  );
};

const createPackageIdentity = (pkg: ResolvedPackage): string =>
  `${pkg.manager}\u0000${pkg.name}\u0000${pkg.version ?? ""}\u0000${pkg.scope ?? ""}`;

const createPackageConflictIdentity = (pkg: ResolvedPackage): string =>
  `${pkg.manager}\u0000${pkg.name}`;

const assertImagePackageCompatibility = (packages: ResolvedPackage[]): void => {
  const byName = new Map<string, ResolvedPackage>();
  for (const currentPackage of packages) {
    const conflictIdentity = createPackageConflictIdentity(currentPackage);
    const existingPackage = byName.get(conflictIdentity);
    if (!existingPackage) {
      byName.set(conflictIdentity, currentPackage);
      continue;
    }

    if (createPackageIdentity(existingPackage) !== createPackageIdentity(currentPackage)) {
      throw new SpawnfileError(
        "validation_error",
        `Generated container declares conflicting package definitions for ${currentPackage.manager} package ${currentPackage.name}`
      );
    }
  }
};

const createAptPackageInstallItem = (pkg: ResolvedPackage): string =>
  pkg.version ? `${pkg.name}=${pkg.version}` : pkg.name;

const createNpmPackageInstallItem = (pkg: ResolvedPackage): string =>
  pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;

const createPipxPackageInstallItem = (pkg: ResolvedPackage): string =>
  pkg.version ? `${pkg.name}==${pkg.version}` : pkg.name;

const getNpmInstallItemName = (item: string): string => {
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

const collectPackagesByManager = (runtimePlans: RuntimeTargetPlan[]): {
  apt: ResolvedPackage[];
  npm: ResolvedPackage[];
  pipx: ResolvedPackage[];
} => {
  const packagesByManager: {
    apt: ResolvedPackage[];
    npm: ResolvedPackage[];
    pipx: ResolvedPackage[];
  } = {
    apt: [],
    npm: [],
    pipx: []
  };
  const imagePackages = runtimePlans.flatMap((plan) => plan.packages ?? []);
  assertImagePackageCompatibility(imagePackages);
  const resolvedPackages = dedupePackages(imagePackages);

  for (const packageConfig of resolvedPackages) {
    if (packageConfig.manager === "apt") {
      packagesByManager.apt.push(packageConfig);
      continue;
    }

    if (packageConfig.manager === "npm") {
      packagesByManager.npm.push(packageConfig);
      continue;
    }

    if (packageConfig.manager === "pipx") {
      packagesByManager.pipx.push(packageConfig);
      continue;
    }
  }

  return packagesByManager;
};

const selectBaseImage = (runtimePlans: RuntimeTargetPlan[]): string => {
  const firstRuntimeMeta = runtimePlans[0]?.meta;

  if (runtimePlans.length <= 1) {
    return firstRuntimeMeta?.standaloneBaseImage ?? "debian:bookworm-slim";
  }

  const nodeBaseImages = runtimePlans
    .map((plan) => plan.meta.standaloneBaseImage)
    .filter((image) => image.startsWith("node:"))
    .sort((left, right) => extractNodeMajorVersion(right) - extractNodeMajorVersion(left));

  return nodeBaseImages[0] ?? "debian:bookworm-slim";
};

export const renderEnvExample = (variables: ContainerEnvVariable[]): string => {
  if (variables.length === 0) {
    return "# No environment variables were detected during compile.\n";
  }

  const lines = ["# Generated by spawnfile compile", ""];
  const requiredVariables = variables.filter((variable) => variable.required);
  const optionalVariables = variables.filter((variable) => !variable.required);

  if (requiredVariables.length > 0) {
    lines.push("# Required");
    for (const variable of requiredVariables) {
      lines.push(`# ${variable.description}`);
      lines.push(`${variable.name}=`);
      lines.push("");
    }
  }

  if (optionalVariables.length > 0) {
    lines.push("# Optional");
    for (const variable of optionalVariables) {
      lines.push(`# ${variable.description}`);
      lines.push(`${variable.name}=`);
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
};

export const renderDockerfile = async (
  runtimePlans: RuntimeTargetPlan[],
  options: EntrypointOptions = {}
): Promise<string> => {
  const runtimeNames = [...new Set(runtimePlans.map((plan) => plan.runtimeName))];
  const runtimeRecipes = await Promise.all(
    runtimeNames.map((runtimeName) => createRuntimeInstallRecipe(runtimeName))
  );
  const baseImage = selectBaseImage(runtimePlans);
  const needsJsonEnvWriter = runtimePlans.some(
    (plan) => (plan.configEnvBindings?.length ?? 0) > 0
  );
  const needsGit = runtimePlans.some((plan) =>
    (plan.resources ?? []).some((resource) => resource.kind === "git")
  );
  const systemDeps = [
    ...new Set([
      ...runtimePlans.flatMap((plan) => plan.meta.systemDeps),
      ...(needsGit ? ["git"] : []),
      ...(options.hasMoltnet && !options.hasStagedMoltnetBinaries
        ? ["ca-certificates", "curl", "tar"]
        : []),
      ...(needsJsonEnvWriter ? ["python3"] : [])
    ])
  ].sort();
  const { apt: aptPackages, npm: npmPackages, pipx: pipxPackages } =
    collectPackagesByManager(runtimePlans);
  const aptDependencies = [
    ...systemDeps,
    ...aptPackages.map((pkg) => createAptPackageInstallItem(pkg)),
    ...(pipxPackages.length > 0 ? ["pipx"] : [])
  ];
  const aptInstallPackages = [...new Set(aptDependencies)].sort();
  const projectNpmPackages = npmPackages.map((pkg) => createNpmPackageInstallItem(pkg));
  const projectNpmPackageNames = new Set(projectNpmPackages.map(getNpmInstallItemName));
  const runtimeNpmPackages = runtimePlans
    .flatMap((plan) => plan.meta.globalNpmPackages ?? [])
    .filter((pkg) => !projectNpmPackageNames.has(getNpmInstallItemName(pkg)));
  const globalNpmPackages = [
    ...new Set([...runtimeNpmPackages, ...projectNpmPackages])
  ].sort();
  const pipxInstallPackages = [...new Set(pipxPackages.map((pkg) => createPipxPackageInstallItem(pkg)))]
    .sort();
  const runtimePorts = runtimePlans.flatMap((plan) =>
    plan.publishedPort ? [plan.publishedPort] : []
  );
  const moltnetPorts = options.moltnetPublishedPorts ?? [];
  const exposedPorts = [...new Set([...runtimePorts, ...moltnetPorts])].sort(
    (left, right) => left - right
  );

  const lines = [];

  lines.push(`FROM ${baseImage}`);

  lines.push("USER root", "", "WORKDIR /opt/spawnfile");

  if (aptInstallPackages.length > 0) {
    lines.push(createPackageInstallCommand(aptInstallPackages), "");
  }

  if (globalNpmPackages.length > 0) {
    lines.push(createNpmPackageInstallCommand(globalNpmPackages), "");
  }

  if (pipxInstallPackages.length > 0) {
    lines.push(createPipxPackageInstallCommand(pipxInstallPackages), "");
  }

  if (options.hasMoltnet && options.hasStagedMoltnetBinaries) {
    lines.push(
      `COPY ${MOLTNET_BIN_DIRECTORY}/ /usr/local/bin/`,
      `RUN chmod +x ${MOLTNET_BINARY_NAMES.map((binaryName) => `/usr/local/bin/${binaryName}`).join(" ")}`,
      ""
    );
  } else if (options.hasMoltnet) {
    lines.push(
      `RUN MOLTNET_INSTALL_DIR=/usr/local/bin sh -c ${shellQuote(`curl -fsSL ${MOLTNET_INSTALL_SCRIPT_URL} | sh`)}`,
      ""
    );
  }

  for (const recipe of runtimeRecipes) {
    for (const copyCommand of recipe.copyCommands) {
      lines.push(copyCommand);
    }
    for (const command of recipe.commands) {
      lines.push(`RUN ${command}`);
    }
    lines.push("");
  }

  lines.push(
    'RUN if ! id -u spawnfile >/dev/null 2>&1; then useradd --create-home --home-dir /home/spawnfile --shell /bin/bash spawnfile; fi',
    ""
  );

  lines.push(
    "COPY container/rootfs/ /",
    "COPY .env.example /opt/spawnfile/.env.example",
    'COPY entrypoint.sh /opt/spawnfile/entrypoint.sh',
    "RUN chmod +x /opt/spawnfile/entrypoint.sh"
  );

  lines.push(`RUN ${createStateOwnershipCommand(options.persistentMountPaths)}`);

  if (exposedPorts.length > 0) {
    lines.push(`EXPOSE ${exposedPorts.join(" ")}`);
  }

  lines.push("USER spawnfile");
  lines.push('ENTRYPOINT ["/opt/spawnfile/entrypoint.sh"]');
  return `${lines.join("\n").trimEnd()}\n`;
};

export const createRootfsFiles = (runtimePlans: RuntimeTargetPlan[]): EmittedFile[] =>
  runtimePlans.flatMap((plan) =>
    plan.targetFiles.map((file) => {
      if (file.path === plan.meta.configFileName) {
        return {
          content: file.content
            .replaceAll(WORKSPACE_PLACEHOLDER, plan.instancePaths.workspacePath)
            .replaceAll(
              `"${GATEWAY_PORT_PLACEHOLDER}"`,
              plan.port ? String(plan.port) : "0"
            )
            .replaceAll(GATEWAY_PORT_PLACEHOLDER, plan.port ? String(plan.port) : ""),
          path: `${CONTAINER_ROOTFS_ROOT}${plan.instancePaths.configPath}`
        };
      }

      if (file.path.startsWith("workspace/")) {
        const relativeWorkspacePath = file.path.slice("workspace/".length);
        return {
          content: file.content,
          path: `${CONTAINER_ROOTFS_ROOT}${path.posix.join(
            plan.instancePaths.workspacePath,
            relativeWorkspacePath
          )}`
        };
      }

      if (file.path.startsWith("home/")) {
        if (!plan.instancePaths.homePath) {
          throw new SpawnfileError(
            "runtime_error",
            `Container target ${plan.id} for ${plan.runtimeName} emitted home-scoped files without a home path`
          );
        }

        const relativeHomePath = file.path.slice("home/".length);
        return {
          content: file.content,
          path: `${CONTAINER_ROOTFS_ROOT}${path.posix.join(
            plan.instancePaths.homePath,
            relativeHomePath
          )}`
        };
      }

      throw new SpawnfileError(
        "runtime_error",
        `Container target ${plan.id} for ${plan.runtimeName} emitted unsupported path ${file.path}`
      );
    })
  );
