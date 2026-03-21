import { SpawnfileError } from "../shared/index.js";

import { resolveRuntimeInstallSelection } from "./install.js";

export const RUNTIME_SOURCE_ROOT = "/opt/spawnfile/runtime-sources";

export interface RuntimeInstallRecipe {
  commands: string[];
  runtimeName: string;
  runtimeRoot: string;
}

const createCheckoutCommands = (
  remote: string,
  ref: string,
  runtimeRoot: string
): string[] => [
  `mkdir -p ${RUNTIME_SOURCE_ROOT}`,
  `git clone ${remote} ${runtimeRoot}`,
  `cd ${runtimeRoot} && git fetch --depth 1 origin ${ref} && git checkout --detach FETCH_HEAD`
];

export const createRuntimeInstallRecipe = async (
  runtimeName: string
): Promise<RuntimeInstallRecipe> => {
  const selection = await resolveRuntimeInstallSelection(runtimeName);
  /* c8 ignore next 5 -- v0.1 install selection is source_repo-only */
  if (selection.kind !== "source_repo") {
    throw new SpawnfileError(
      "runtime_error",
      `Unsupported install selection kind for ${runtimeName}: ${selection.kind}`
    );
  }

  const runtimeRoot = `${RUNTIME_SOURCE_ROOT}/${runtimeName}`;
  const checkoutCommands = createCheckoutCommands(
    selection.remote,
    selection.runtimeRef,
    runtimeRoot
  );

  switch (runtimeName) {
    case "openclaw":
      return {
        commands: [
          ...checkoutCommands,
          `cd ${runtimeRoot} && corepack enable`,
          `cd ${runtimeRoot} && pnpm install --frozen-lockfile`,
          `cd ${runtimeRoot} && pnpm canvas:a2ui:bundle`,
          `cd ${runtimeRoot} && pnpm build:docker`
        ],
        runtimeName,
        runtimeRoot
      };
    case "picoclaw":
      return {
        commands: [
          ...checkoutCommands,
          `cd ${runtimeRoot} && cp -R workspace cmd/picoclaw/internal/onboard/workspace`,
          `cd ${runtimeRoot} && go build -o /usr/local/bin/picoclaw ./cmd/picoclaw`
        ],
        runtimeName,
        runtimeRoot
      };
    case "tinyclaw":
      return {
        commands: [
          ...checkoutCommands,
          `cd ${runtimeRoot} && npm install`,
          `cd ${runtimeRoot} && npm run build`
        ],
        runtimeName,
        runtimeRoot
      };
    /* c8 ignore next 5 -- compileable runtimes are exhaustively covered above */
    default:
      throw new SpawnfileError(
        "runtime_error",
        `Runtime ${runtimeName} has no container install recipe`
      );
  }
};
