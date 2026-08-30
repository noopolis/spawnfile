import path from "node:path";

import { readUtf8File, writeUtf8File } from "../filesystem/index.js";
import { SpawnfileError } from "../shared/index.js";

/**
 * Shared local-rootfs path helpers used by E2E flows that compile a project
 * and then run the generated runtime directly against files on local disk
 * (rather than inside a real container). Extracted out so every harness
 * that walks `outputDirectory/container/rootfs/...` shares one
 * implementation.
 */
export const toRootfsPath = (rootfs: string, containerPath: string): string =>
  path.join(rootfs, containerPath.replace(/^\/+/u, ""));

/**
 * The generated-Pi app config's memory key, in the exact case the Pi app
 * config emitter writes it (`src/runtime/pi/appAgentConfig.ts`, typed in
 * `src/runtime/pi/appTemplateTypes.ts`). It is deliberately snake_case and
 * deliberately NOT the Daimon organization runtime's camelCase
 * `memory.runtimeHomePath` (`src/runtime/daimon/config.ts`): these are two
 * different configs consumed by two different runtimes, and only the Pi one
 * is rewritten onto a host rootfs by these harnesses.
 */
export const PI_APP_CONFIG_MEMORY_HOME_KEY = "runtime_home_path" as const;

interface RewriteMemoryPathsConfig {
  agents?: Array<{ memory?: { [PI_APP_CONFIG_MEMORY_HOME_KEY]?: string } }>;
}

/**
 * Rewrites every agent's `memory.runtime_home_path` in a generated Pi app
 * config from its container-absolute path onto the equivalent local rootfs
 * path, then returns the first rewritten agent's memory events.jsonl path
 * (the conventional location E2E flows read generated memory events from).
 *
 * Throws when it rewrites nothing. A rewrite that silently matches no agent
 * is never a legitimate outcome for a caller that then reads memory events
 * off the returned path: it would leave the runtime pointed at a
 * container-absolute path on the host and surface much later as an empty
 * ledger. A key-case or schema drift in the emitter must fail here, loudly,
 * at the rewrite — not as a confusing "no memories were recalled" assertion
 * several minutes of live model calls later.
 */
export const rewriteMemoryPaths = async (
  configPath: string,
  rootfs: string
): Promise<string> => {
  const config = JSON.parse(await readUtf8File(configPath)) as RewriteMemoryPathsConfig;
  let eventsPath = "";
  for (const agent of config.agents ?? []) {
    const memory = agent.memory;
    const containerHomePath = memory?.[PI_APP_CONFIG_MEMORY_HOME_KEY];
    if (!memory || !containerHomePath?.startsWith("/")) {
      continue;
    }
    memory[PI_APP_CONFIG_MEMORY_HOME_KEY] = toRootfsPath(rootfs, containerHomePath);
    eventsPath ||= path.join(memory[PI_APP_CONFIG_MEMORY_HOME_KEY]!, "memory", "events.jsonl");
  }
  if (!eventsPath) {
    throw new SpawnfileError(
      "runtime_error",
      `Rewrote no agent memory home in ${configPath}: no agent declared an absolute `
        + `memory.${PI_APP_CONFIG_MEMORY_HOME_KEY}. Either the project declares no durable `
        + `memory bank, or the generated config's memory shape changed and this rewrite no `
        + `longer matches it.`
    );
  }
  await writeUtf8File(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return eventsPath;
};
