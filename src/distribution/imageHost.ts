import { selectedRuntimeHosts } from "../runtime/hostSelection.js";
import { requireRuntimeAdapters } from "../runtime/registry.js";
import type { RuntimePreparedImageLaunch } from "../runtime/hostTypes.js";
import type { DockerCommandRunner } from "./dockerRunner.js";
import type { DistributionReport } from "./types.js";

export const prepareImageHostLaunch = async (
  imageRef: string, report: DistributionReport, runDocker: DockerCommandRunner, securityDirectory: string
): Promise<ReadonlyMap<string, RuntimePreparedImageLaunch>> => {
  const preparations = new Map<string, RuntimePreparedImageLaunch>();
  const hosts = selectedRuntimeHosts(report.runtime_instances.map((instance) => instance.runtime));
  for (const { name, host } of hosts) {
    if (!host.prepareImageLaunch) continue;
    const instances = report.runtime_instances.filter((instance) => instance.runtime === name);
    preparations.set(name, await host.prepareImageLaunch({ imageRef, instances, runDocker, securityDirectory }));
  }
  return preparations;
};

/** Every runtime an image's distribution report names. */
export const imageRuntimeNames = (report: DistributionReport): Array<string | null> => [
  ...report.runtime_instances.map((instance) => instance.runtime),
  ...report.organization.agents.map((agent) => agent.runtime)
];

/**
 * An absent adapter would silently drop its host security arguments, generated
 * secrets and credential preparation, so image start refuses before any effect.
 */
export const requireImageRuntimeAdapters = (report: DistributionReport, operation: string): void =>
  requireRuntimeAdapters(imageRuntimeNames(report), operation);
