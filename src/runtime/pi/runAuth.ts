import path from "node:path";
import { chmod } from "node:fs/promises";

import { loadImportedCodexCredential } from "../../auth/index.js";
import { ensureDirectory, writeUtf8File } from "../../filesystem/index.js";
import type { RuntimeAuthPreparationInput, RuntimeAuthPreparationResult } from "../types.js";

const createMountArgs = (hostPath: string, containerPath: string): string[] => [
  "-v",
  `${hostPath}:${containerPath}`
];

const writeJsonFile = async (
  tempRoot: string,
  relativePath: string,
  value: Record<string, unknown>
): Promise<string> => {
  const hostPath = path.join(tempRoot, relativePath);
  const hostDirectory = path.dirname(hostPath);
  await ensureDirectory(hostDirectory);
  await writeUtf8File(hostPath, `${JSON.stringify(value, null, 2)}\n`);
  await chmod(hostDirectory, 0o777);
  await chmod(hostPath, 0o666);
  return hostPath;
};

export const preparePiRuntimeAuth = async (
  input: RuntimeAuthPreparationInput
): Promise<RuntimeAuthPreparationResult> => {
  if (!input.instance.home_path) {
    return { coveredModelSecrets: [], mountArgs: [] };
  }

  const codex = input.authProfile.imports.codex
    ? await loadImportedCodexCredential(input.authProfile.imports.codex.path)
    : null;

  const useCodex = input.instance.model_auth_methods.openai === "codex" && codex;
  if (!useCodex) {
    return { coveredModelSecrets: [], mountArgs: [] };
  }

  const authPath = await writeJsonFile(
    input.tempRoot,
    path.join("runtime-auth", "pi", input.instance.id, "auth.json"),
    {
      "openai-codex": {
        access: codex.access,
        ...(codex.accountId ? { accountId: codex.accountId } : {}),
        expires: codex.expires,
        refresh: codex.refresh,
        type: "oauth"
      }
    }
  );

  return {
    coveredModelSecrets: [],
    mountArgs: createMountArgs(
      path.dirname(authPath),
      path.posix.join(input.instance.home_path, ".pi", "agent")
    )
  };
};
