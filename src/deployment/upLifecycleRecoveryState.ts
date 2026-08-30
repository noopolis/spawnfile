/**
 * Ephemeral grants issued only by the durable up reconciler. They are kept
 * process-local: a restart reconstructs them by re-reading and re-verifying
 * the lifecycle records, never by trusting caller-supplied recovery data.
 */
export interface NoDockerMutationRecovery {
  readonly kind: "no_docker_mutation";
}

export interface DeploymentRecordRecovery {
  readonly kind: "deployment_record";
}

export interface DetachedContainerRecovery {
  readonly containerId: string;
  readonly containerName: string;
  readonly deploymentLabels: Readonly<Record<string, string>>;
  readonly imageId: string;
  readonly kind: "detached_container";
}

export type UpLifecycleRecovery =
  | NoDockerMutationRecovery
  | DeploymentRecordRecovery
  | DetachedContainerRecovery;

const grants = new WeakSet<object>();

const grant = <T extends UpLifecycleRecovery>(value: T): T => {
  const result = Object.freeze(value);
  grants.add(result);
  return result;
};

export const noDockerMutationRecovery = (): NoDockerMutationRecovery =>
  grant({ kind: "no_docker_mutation" });

export const deploymentRecordRecovery = (): DeploymentRecordRecovery =>
  grant({ kind: "deployment_record" });

export const detachedContainerRecovery = (
  value: Omit<DetachedContainerRecovery, "kind">,
): DetachedContainerRecovery => grant({ ...value, kind: "detached_container" });

export const isTrustedUpLifecycleRecovery = (
  value: unknown,
): value is UpLifecycleRecovery => value !== null
  && typeof value === "object"
  && grants.has(value);
