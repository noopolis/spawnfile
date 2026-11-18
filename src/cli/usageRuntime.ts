import { readHomeDeploymentReport, type DeploymentRecord } from "../deployment/index.js";
import { parseDistributionReport } from "../distribution/distributionReportSchema.js";
import type { RuntimeUsageOperations } from "../runtime/operations.js";
import { getRuntimeOperations, listRuntimeOperations } from "../runtime/registry.js";
import { loadCompileReport } from "../status/compileReport.js";

const recordedRuntimeNames = async (record: DeploymentRecord): Promise<ReadonlyMap<string, string>> => {
  if (record.source.kind === "image") {
    try {
      const report = parseDistributionReport(JSON.parse(await readHomeDeploymentReport(record.name)));
      if (report.compile_fingerprint === record.compile_fingerprint) {
        return new Map(report.runtime_instances.map(({ id, runtime }) => [id, runtime]));
      }
    } catch {
      // Older deployments may lack a cached report.
    }
  } else if (record.output_directory !== null) {
    const loaded = await loadCompileReport(record.output_directory);
    if (loaded.kind === "loaded" && loaded.report.compileFingerprint === record.compile_fingerprint) {
      return new Map(loaded.report.runtimeInstances.map(({ id, runtime }) => [id, runtime]));
    }
  }
  return new Map();
};

export const registeredUsage = (): RuntimeUsageOperations[] =>
  listRuntimeOperations().flatMap(({ usage }) => usage ? [usage] : []);

export const usageByDeploymentUnit = async (
  record: DeploymentRecord
): Promise<ReadonlyMap<string, readonly RuntimeUsageOperations[]>> => {
  const runtimes = await recordedRuntimeNames(record);
  const registered = registeredUsage();
  return new Map(record.units.map((unit) => {
    const usage = new Set<RuntimeUsageOperations>();
    for (const id of unit.runtime_instances) {
      const runtime = runtimes.get(id);
      if (runtime === undefined) {
        for (const operations of registered) {
          if (operations.matchesLegacyInstance?.(id)) usage.add(operations);
        }
      } else {
        const operations = getRuntimeOperations(runtime)?.usage;
        if (operations) usage.add(operations);
      }
    }
    return [unit.id, [...usage]];
  }));
};
