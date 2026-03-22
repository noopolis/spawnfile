import { SpawnfileError } from "../shared/index.js";

import {
  assertRuntimeCanCompile,
  loadRuntimeRegistry
} from "./registry.js";

export type RuntimeInstallSelection =
  | {
      ecosystem: "node";
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
      asset: string;
      ecosystem: "node";
      installHint: string;
      kind: "github_release_bundle";
      repository: string;
      runtimeName: string;
      runtimeRef: string;
      selectionSource: "runtime_registry_install";
      tag: string;
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

const installHints = new Map<
  string,
  Record<
    RuntimeInstallSelection["kind"],
    {
      ecosystem: "go" | "node";
      installHint: string;
    }
  >
>([
  [
    "openclaw",
    {
      container_image: {
        ecosystem: "node",
        installHint:
          "Copy the pinned OpenClaw runtime files from the official container image."
      },
      github_release_archive: {
        ecosystem: "node",
        installHint: "Download the pinned OpenClaw artifact archive from the release."
      },
      github_release_bundle: {
        ecosystem: "node",
        installHint: "Download the pinned OpenClaw bundle artifact from the release."
      },
      npm: {
        ecosystem: "node",
        installHint: "Install the pinned OpenClaw package version from npm."
      },
      source_repo: {
        ecosystem: "node",
        installHint: "Checkout the pinned repo ref and install from the repository root."
      }
    }
  ],
  [
    "picoclaw",
    {
      container_image: {
        ecosystem: "go",
        installHint: "Copy the pinned PicoClaw runtime files from the official container image."
      },
      github_release_archive: {
        ecosystem: "go",
        installHint: "Download the pinned PicoClaw release archive for the target platform."
      },
      github_release_bundle: {
        ecosystem: "node",
        installHint: "Download the pinned PicoClaw bundle artifact from the release."
      },
      npm: {
        ecosystem: "node",
        installHint: "Install the pinned PicoClaw package version from npm."
      },
      source_repo: {
        ecosystem: "go",
        installHint: "Checkout the pinned repo ref and build/install from the repository root."
      }
    }
  ],
  [
    "tinyclaw",
    {
      container_image: {
        ecosystem: "node",
        installHint: "Copy the pinned TinyClaw runtime files from the official container image."
      },
      github_release_archive: {
        ecosystem: "go",
        installHint: "Download the pinned TinyClaw release archive for the target platform."
      },
      github_release_bundle: {
        ecosystem: "node",
        installHint: "Download the pinned TinyClaw bundle artifact from the release."
      },
      npm: {
        ecosystem: "node",
        installHint: "Install the pinned TinyClaw package version from npm."
      },
      source_repo: {
        ecosystem: "node",
        installHint: "Checkout the pinned repo ref and run the TinyAGI install flow from the repository root."
      }
    }
  ]
]);

export const resolveRuntimeInstallSelection = async (
  runtimeName: string
): Promise<RuntimeInstallSelection> => {
  const runtime = await assertRuntimeCanCompile(runtimeName);
  const installProfile = installHints.get(runtime.name);

  if (!installProfile) {
    throw new SpawnfileError(
      "runtime_error",
      `Runtime ${runtime.name} has no install selection profile`
    );
  }

  switch (runtime.install?.kind) {
    case "container_image":
      return {
        ecosystem: "node",
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
    case "github_release_bundle":
      return {
        ecosystem: "node",
        installHint: installProfile.github_release_bundle.installHint,
        asset: runtime.install.asset,
        kind: "github_release_bundle",
        repository: runtime.install.repository,
        runtimeName: runtime.name,
        runtimeRef: runtime.ref,
        selectionSource: "runtime_registry_install",
        tag: runtime.install.tag
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
  [...installHints.keys()].sort();

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
