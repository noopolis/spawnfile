import { selectedRuntimeHosts } from "../runtime/hostSelection.js";
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
