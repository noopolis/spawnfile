import { createHash } from "node:crypto";

import { SpawnfileError } from "../shared/index.js";

export const createEndpointFingerprint = (endpoint: string): string => {
  const normalized = endpoint.trim();
  if (normalized.length === 0) {
    throw new SpawnfileError("validation_error", "Deployment target endpoint must not be empty");
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
};
