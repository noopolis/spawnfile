import type { ExecutionBlock } from "../manifest/index.js";

export const applyExecutionDefaults = (
  execution: ExecutionBlock | undefined
): ExecutionBlock => ({
  model: execution?.model,
  sandbox: execution?.sandbox ?? {
    mode: "workspace"
  },
  workspace: execution?.workspace ?? {
    isolation: "isolated"
  }
});
