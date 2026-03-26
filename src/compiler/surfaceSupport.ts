import { getRuntimeAdapter } from "../runtime/index.js";

import type { ResolvedAgentSurfaces } from "./types.js";

export const assertRuntimeSupportsAgentSurfaces = (
  runtimeName: string,
  surfaces: ResolvedAgentSurfaces | undefined,
  nodeName: string
): void => {
  const adapter = getRuntimeAdapter(runtimeName);

  try {
    adapter.assertSupportedSurfaces?.(surfaces);
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${error.message} on ${nodeName}`;
    }
    throw error;
  }
};
