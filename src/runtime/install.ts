import { SpawnfileError } from "../shared/index.js";

import {
  assertRuntimeCanCompile,
  getRuntimeAdapter,
  hasRuntimeAdapter,
  listRuntimeAdapters,
  loadRuntimeRegistry,
  type RuntimeCapabilityReceipts
} from "./registry.js";

export type RuntimeInstallSelection =
  | {
      ecosystem: "go" | "node";
      capabilityReceipt?: string;
      capabilityReceipts?: RuntimeCapabilityReceipts;
      contractManifestSha256?: string;
      digest?: string;
      image: string;
      installHint: string;
      kind: "container_image";
      runtimeName: string;
      runtimeRef: string;
      selectionSource: "runtime_registry_install";
      tag: string;
    }
  | {
      binaryName: string;
      ecosystem: "go";
      installHint: string;
      kind: "github_release_archive";
      repository: string;
      runtimeName: string;
      runtimeRef: string;
      selectionSource: "runtime_registry_install";
      tag: string;
      versionedAssets: Record<string, string>;
    }
  | {
      ecosystem: "node";
      installHint: string;
      kind: "npm";
      packageName: string;
      runtimeName: string;
      runtimeRef: string;
      selectionSource: "runtime_registry_install";
      version: string;
    }
  | {
      ecosystem: "go" | "node";
      installHint: string;
      kind: "source_repo";
      remote: string;
      runtimeName: string;
      runtimeRef: string;
      selectionSource: "runtime_registry_ref";
    };

const GITHUB_SSH_REMOTE_PATTERN = /^git@github\.com:(.+)$/;

const convertRemoteToHttps = (remote: string): string => {
  const githubSshMatch = remote.match(GITHUB_SSH_REMOTE_PATTERN);
  if (githubSshMatch) {
    return `https://github.com/${githubSshMatch[1]}`;
  }

  return remote.replace(/^git\+/, "");
};

export const resolveRuntimeInstallSelection = async (
  runtimeName: string
): Promise<RuntimeInstallSelection> => {
  const runtime = await assertRuntimeCanCompile(runtimeName);
  const installProfile = hasRuntimeAdapter(runtime.name) ? getRuntimeAdapter(runtime.name).install.hints : undefined;

  if (!installProfile) {
    throw new SpawnfileError(
      "runtime_error",
      `Runtime ${runtime.name} has no install selection profile`
    );
  }

  switch (runtime.install?.kind) {
    case "container_image":
      return {
        ecosystem: installProfile.container_image.ecosystem,
        capabilityReceipt: runtime.install.capabilityReceipt,
        ...(runtime.install.capabilityReceipts ? { capabilityReceipts: runtime.install.capabilityReceipts } : {}),
        contractManifestSha256: runtime.install.contractManifestSha256,
        digest: runtime.install.digest,
        image: runtime.install.image,
        installHint: installProfile.container_image.installHint,
        kind: "container_image",
        runtimeName: runtime.name,
        runtimeRef: runtime.ref,
        selectionSource: "runtime_registry_install",
        tag: runtime.install.tag
      };
    case "npm":
      return {
        ecosystem: "node",
        installHint: installProfile.npm.installHint,
        kind: "npm",
        packageName: runtime.install.package,
        runtimeName: runtime.name,
        runtimeRef: runtime.ref,
        selectionSource: "runtime_registry_install",
        version: runtime.install.version
      };
    case "github_release_archive":
      return {
        ecosystem: "go",
        installHint: installProfile.github_release_archive.installHint,
        binaryName: runtime.install.binary,
        kind: "github_release_archive",
        repository: runtime.install.repository,
        runtimeName: runtime.name,
        runtimeRef: runtime.ref,
        selectionSource: "runtime_registry_install",
        tag: runtime.install.tag,
        versionedAssets: runtime.install.assets
      };
    case "source_repo":
    case undefined:
      return {
        ...installProfile.source_repo,
        kind: "source_repo",
        remote: convertRemoteToHttps(runtime.remote),
        runtimeName: runtime.name,
        runtimeRef: runtime.ref,
        selectionSource: "runtime_registry_ref"
      };
    default:
      throw new SpawnfileError(
        "runtime_error",
        `Unsupported install selection kind for ${runtime.name}`
      );
  }
};

export const listInstallSelectionRuntimes = async (): Promise<string[]> =>
  listRuntimeAdapters();

export const assertInstallSelectionsCoverCompileableRuntimes = async (): Promise<void> => {
  const compileableRuntimeNames = (await loadRuntimeRegistry())
    .filter((entry) => entry.status === "active" || entry.status === "deprecated")
    .map((entry) => entry.name)
    .sort();

  const coveredRuntimeNames = await listInstallSelectionRuntimes();
  if (
    compileableRuntimeNames.length !== coveredRuntimeNames.length ||
    compileableRuntimeNames.some((runtimeName, index) => runtimeName !== coveredRuntimeNames[index])
  ) {
    throw new SpawnfileError(
      "runtime_error",
      "Install selection profiles do not cover all compileable runtimes"
    );
  }
};
