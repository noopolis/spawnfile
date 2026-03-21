import { SpawnfileError } from "../shared/index.js";

import { assertRuntimeCanCompile, loadRuntimeRegistry } from "./registry.js";

export interface RuntimeInstallSelection {
  ecosystem: "go" | "node";
  installHint: string;
  kind: "source_repo";
  remote: string;
  runtimeName: string;
  runtimeRef: string;
  selectionSource: "runtime_registry_ref";
}

const GITHUB_SSH_REMOTE_PATTERN = /^git@github\.com:(.+)$/;

const convertRemoteToHttps = (remote: string): string => {
  const githubSshMatch = remote.match(GITHUB_SSH_REMOTE_PATTERN);
  if (githubSshMatch) {
    return `https://github.com/${githubSshMatch[1]}`;
  }

  return remote.replace(/^git\+/, "");
};

const installHints = new Map<string, Omit<RuntimeInstallSelection, "kind" | "remote" | "runtimeName" | "runtimeRef" | "selectionSource">>([
  [
    "openclaw",
    {
      ecosystem: "node",
      installHint: "Checkout the pinned repo ref and install from the repository root."
    }
  ],
  [
    "picoclaw",
    {
      ecosystem: "go",
      installHint: "Checkout the pinned repo ref and build/install from the repository root."
    }
  ],
  [
    "tinyclaw",
    {
      ecosystem: "node",
      installHint: "Checkout the pinned repo ref and run the TinyAGI install flow from the repository root."
    }
  ]
]);

export const resolveRuntimeInstallSelection = async (
  runtimeName: string
): Promise<RuntimeInstallSelection> => {
  const runtime = await assertRuntimeCanCompile(runtimeName);
  const installHint = installHints.get(runtime.name);

  if (!installHint) {
    throw new SpawnfileError(
      "runtime_error",
      `Runtime ${runtime.name} has no install selection profile`
    );
  }

  return {
    ...installHint,
    kind: "source_repo",
    remote: convertRemoteToHttps(runtime.remote),
    runtimeName: runtime.name,
    runtimeRef: runtime.ref,
    selectionSource: "runtime_registry_ref"
  };
};

export const listInstallSelectionRuntimes = (): string[] =>
  [...installHints.keys()].sort();

export const assertInstallSelectionsCoverCompileableRuntimes = async (): Promise<void> => {
  const compileableRuntimeNames = (await loadRuntimeRegistry())
    .filter((entry) => entry.status === "active" || entry.status === "deprecated")
    .map((entry) => entry.name)
    .sort();

  const coveredRuntimeNames = listInstallSelectionRuntimes();
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
