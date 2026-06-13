import { createHash } from "node:crypto";

import type { DistributionReport } from "./types.js";

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

export const createDistributionFingerprint = (
  report: Omit<DistributionReport, "compile_fingerprint" | "generated_at">
): string =>
  `sf1:${createHash("sha1").update(stableStringify(report)).digest("hex").slice(0, 12)}`;
