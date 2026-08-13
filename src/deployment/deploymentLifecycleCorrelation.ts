import { createHash } from "node:crypto";

import { SpawnfileError } from "../shared/index.js";
import type { DeploymentRecord } from "./record.js";

export interface DeploymentLifecycleCorrelation {
  compile_fingerprint: string;
  deployment_instance_digest: string;
  deployment: string;
  run_id: string | null;
  target: string;
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const createDeploymentInstanceDigest = (
  record: DeploymentRecord,
): string => {
  const { export_index: _mutableExport, ...immutable } = record;
  return `sha256:${createHash("sha256")
    .update(canonical(immutable))
    .digest("hex")}`;
};

export const createDeploymentLifecycleCorrelation = (
  record: DeploymentRecord,
): DeploymentLifecycleCorrelation => ({
  compile_fingerprint: record.compile_fingerprint,
  deployment: record.name,
  deployment_instance_digest: createDeploymentInstanceDigest(record),
  run_id: record.run_id ?? null,
  target: JSON.stringify(record.target),
});

export const assertDeploymentLifecycleCorrelation = (
  record: DeploymentRecord,
  expected: DeploymentLifecycleCorrelation | undefined,
): void => {
  if (
    expected &&
    JSON.stringify(createDeploymentLifecycleCorrelation(record)) !==
      JSON.stringify(expected)
  )
    throw new SpawnfileError(
      "runtime_error",
      "Deployment changed after lifecycle admission; refusing effect",
    );
};
