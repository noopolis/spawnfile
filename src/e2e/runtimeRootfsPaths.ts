import path from "node:path";

import { readUtf8File, writeUtf8File } from "../filesystem/index.js";

/**
 * Shared local-rootfs path helpers used by E2E flows that compile a project
 * and then run the generated runtime directly against files on local disk
 * (rather than inside a real container). Extracted out so every harness
 * that walks `outputDirectory/container/rootfs/...` shares one
 * implementation.
 */
export const toRootfsPath = (rootfs: string, containerPath: string): string =>
  path.join(rootfs, containerPath.replace(/^\/+/u, ""));

interface RewriteMemoryPathsConfig {
  agents?: Array<{ memory?: { runtime_home_path?: string } }>;
}

/**
 * Rewrites every agent's `memory.runtime_home_path` in a generated Pi/Daimon
 * app config from its container-absolute path onto the equivalent local
 * rootfs path, then returns the first rewritten agent's memory events.jsonl
 * path (the conventional location E2E flows read generated memory events
 * from).
 */
export const rewriteMemoryPaths = async (
  configPath: string,
  rootfs: string
): Promise<string> => {
  const config = JSON.parse(await readUtf8File(configPath)) as RewriteMemoryPathsConfig;
  let eventsPath = "";
  for (const agent of config.agents ?? []) {
    const memory = agent.memory;
    if (!memory?.runtime_home_path?.startsWith("/")) {
      continue;
    }
    memory.runtime_home_path = toRootfsPath(rootfs, memory.runtime_home_path);
    eventsPath ||= path.join(memory.runtime_home_path, "memory", "events.jsonl");
  }
  await writeUtf8File(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return eventsPath;
};
