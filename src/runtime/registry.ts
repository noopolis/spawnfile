import { SpawnfileError } from "../shared/index.js";

import { openClawAdapter } from "./openclaw/adapter.js";
import { picoClawAdapter } from "./picoclaw/adapter.js";
import { tinyClawAdapter } from "./tinyclaw/adapter.js";
import { RuntimeAdapter } from "./types.js";

const runtimeAdapters = new Map<string, RuntimeAdapter>([
  [openClawAdapter.name, openClawAdapter],
  [picoClawAdapter.name, picoClawAdapter],
  [tinyClawAdapter.name, tinyClawAdapter]
]);

export const getRuntimeAdapter = (runtimeName: string): RuntimeAdapter => {
  const adapter = runtimeAdapters.get(runtimeName);
  if (!adapter) {
    throw new SpawnfileError("runtime_error", `Unknown runtime adapter: ${runtimeName}`);
  }

  return adapter;
};

export const listRuntimeAdapters = (): string[] => [...runtimeAdapters.keys()].sort();
