import type { ExecutionBlock } from "../manifest/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";

import { listEffectiveExecutionModelTargets } from "./modelEnv.js";

export const assertRuntimeSupportsExecutionModelAuth = (
  runtimeName: string,
  execution: ExecutionBlock | undefined,
  nodeName: string
): void => {
  const adapter = getRuntimeAdapter(runtimeName);
  const modelTargets = listEffectiveExecutionModelTargets(execution);

  for (const target of modelTargets) {
    try {
      adapter.assertSupportedModelTarget(target);
    } catch (error) {
      if (error instanceof Error) {
        error.message = `${error.message} on ${nodeName}`;
      }
      throw error;
    }
  }
};
