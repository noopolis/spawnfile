import type { ExecutionBlock } from "../manifest/index.js";
import { getRuntimeAdapter } from "../runtime/index.js";
import { SpawnfileError } from "../shared/index.js";

import { resolveExecutionModelAuthMethods } from "./modelEnv.js";

export const assertRuntimeSupportsExecutionModelAuth = (
  runtimeName: string,
  execution: ExecutionBlock | undefined,
  nodeName: string
): void => {
  const adapter = getRuntimeAdapter(runtimeName);
  const authMethods = resolveExecutionModelAuthMethods(execution);

  for (const [provider, method] of Object.entries(authMethods)) {
    const supportedMethods = adapter.supportedModelAuthMethods(provider);
    if (supportedMethods.includes(method)) {
      continue;
    }

    throw new SpawnfileError(
      "validation_error",
      `Runtime ${runtimeName} does not support model auth method ${method} for provider ${provider} on ${nodeName}`
    );
  }
};
