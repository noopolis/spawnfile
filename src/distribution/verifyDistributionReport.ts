import { parseDistributionReport } from "./distributionReportSchema.js";
import type { DistributionReport } from "./types.js";
import { SpawnfileError } from "../shared/index.js";

export interface VerifyDistributionReportInput {
  forbiddenPathFragments?: string[];
  report: unknown;
}

/**
 * Pre-push verification for a published image's distribution report. Confirms
 * the report parses, is free of creator host-path fragments, and that every
 * secret entry carries the required/generated markers. Throws on any violation
 * so publishing refuses to ship a leaky or malformed image.
 */
export const verifyDistributionReport = (
  input: VerifyDistributionReportInput
): DistributionReport => {
  const report = parseDistributionReport(input.report, "distribution report for publish");
  const serialized = JSON.stringify(report);

  for (const fragment of input.forbiddenPathFragments ?? []) {
    const trimmed = fragment.trim();
    if (trimmed.length > 0 && serialized.includes(trimmed)) {
      throw new SpawnfileError(
        "validation_error",
        `Distribution report leaks a creator path fragment and must not be published: ${trimmed}`
      );
    }
  }

  if (serialized.includes("/Users/") || serialized.includes("\\Users\\")) {
    throw new SpawnfileError(
      "validation_error",
      "Distribution report contains an absolute home path and must not be published"
    );
  }

  for (const category of ["model", "project", "runtime", "surface"] as const) {
    for (const entry of report.secrets[category]) {
      if (typeof entry.required !== "boolean" || typeof entry.generated !== "boolean") {
        throw new SpawnfileError(
          "validation_error",
          `Secret ${entry.name} is missing required/generated markers`
        );
      }
    }
  }

  return report;
};
