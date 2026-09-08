import path from "node:path";

import { readUtf8File } from "../filesystem/index.js";
import type { ContainerRuntimeInstanceReport } from "../report/index.js";
import {
  codexNativeSandboxDockerSecurityArgsForConfigs,
  SpawnfileError
} from "../shared/index.js";

import type { CompileProjectResult } from "./compileProject.js";

export { DAIMON_CODEX_NATIVE_SANDBOX_DOCKER_SECURITY_OPTS } from "../shared/index.js";

const assertContainedPath = (root: string, candidate: string): string => {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon generated config path escapes the compiled container rootfs"
    );
  }
  return normalizedCandidate;
};

const configPathInOutput = (
  outputDirectory: string,
  instance: ContainerRuntimeInstanceReport
): string => {
  if (!instance.config_path.startsWith("/")) {
    throw new SpawnfileError(
      "validation_error",
      "Daimon runtime instance has a non-absolute generated config path"
    );
  }
  const rootfs = path.join(outputDirectory, "container", "rootfs");
  return assertContainedPath(rootfs, path.join(rootfs, `.${instance.config_path}`));
};

export const resolveDaimonCodexNativeSandboxDockerSecurityOptions = async (
  compileResult: CompileProjectResult
): Promise<string[]> => {
  const instances = compileResult.report.container?.runtime_instances
    .filter((instance) => instance.runtime === "daimon") ?? [];
  const sources: string[] = [];
  for (const instance of instances) {
    try {
      sources.push(await readUtf8File(configPathInOutput(compileResult.outputDirectory, instance)));
    } catch (error) {
      if (error instanceof SpawnfileError) throw error;
      throw new SpawnfileError(
        "validation_error",
        "Could not read Daimon's generated organization config before Docker launch"
      );
    }
  }
  return codexNativeSandboxDockerSecurityArgsForConfigs(sources);
};
