import {
  CREDENTIAL_PROVISIONING_RECEIPT_VERSION,
  CREDENTIAL_PROVISIONING_REQUEST_VERSION,
  RESOLVED_WORLD_GRANTS_VERSION,
} from "../auth/index.js";
import {
  DOWN_RECEIPT_VERSION,
  EXPORT_INDEX_VERSION,
  LIFECYCLE_INVOCATION_VERSION,
  LIFECYCLE_LOOKUP_VERSION,
  UP_RECEIPT_VERSION,
} from "../deployment/index.js";
import { PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION } from "../evidenceExportHelper/index.js";
import {
  COMPOSED_PREPARATION_RECEIPT_VERSION,
  COMPOSED_PREPARATION_REQUEST_VERSION,
  SELECTED_TARGET_VERSION,
  TARGET_EXPORT_INDEX_VERSION,
  TARGET_OPERATION_LOOKUP_VERSION,
  TARGET_RESOURCE_RECEIPT_VERSION,
  TARGET_RESOURCE_REQUEST_VERSION,
  TARGET_TOPOLOGY_ATTESTATION_REQUEST_VERSION,
  TARGET_TOPOLOGY_RECEIPT_VERSION,
  TARGET_WORLD_CLOCK_RECEIPT_VERSION,
  TARGET_WORLD_CLOCK_REQUEST_VERSION,
  TARGET_WORLD_READINESS_RECEIPT_VERSION,
  TARGET_WORLD_READINESS_REQUEST_VERSION,
} from "../target/index.js";
import {
  TARGET_LOCAL_BUNDLE_LOOKUP_VERSION,
  TARGET_LOCAL_BUNDLE_PREPARE_RECEIPT_VERSION,
  TARGET_LOCAL_BUNDLE_PREPARE_REQUEST_VERSION,
} from "../target/containerBundleContracts.js";
import { TARGET_LOCAL_CONTAINER_BUNDLE_POLICY } from "../target/containerBundlePolicy.js";
import {
  TARGET_PUBLIC_ARTIFACT_SNAPSHOT_NOT_PRESENT_VERSION,
  TARGET_PUBLIC_ARTIFACT_SNAPSHOT_REQUEST_VERSION,
  TARGET_PUBLIC_ARTIFACT_SNAPSHOT_VERSION,
} from "../target/publicArtifactSnapshot.js";
import { TARGET_TOPOLOGY_ACTIVATION_RECEIPT_VERSION } from "../target/topologyActivation.js";

import {
  LIFECYCLE_PLAN_REQUEST_VERSION,
} from "./lifecyclePlan.js";
import {
  TARGET_DEFAULT_CONFIG_STDIN_VERSION,
  TARGET_LOOKUP_CONFIG_STDIN_VERSION,
} from "./targetDefaultConfigStdin.js";
import {
  TARGET_CONFIG_PREPARED_PLAN_ABI_VERSION,
  TARGET_CONFIG_RESOLUTION_VERSION,
} from "./targetConfigResolver.js";
import {
  TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION,
  TARGET_SECRET_SOURCE_RECEIPT_VERSION,
  TARGET_SECRET_SOURCE_REQUEST_VERSION,
} from "./targetSecretSourceInput.js";

export const COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION =
  "spawnfile.composed-lifecycle-contract-set.v1" as const;

export type LifecycleCommandStdout = "json" | "text";

/**
 * One closed machine-facing command surface. Empty version lists are
 * intentional: they mean the command has no versioned value in that role.
 */
export interface ComposedLifecycleCommandContract {
  readonly argv: readonly string[];
  readonly invocation_versions: readonly string[];
  readonly pending_versions: readonly string[];
  readonly receipt_versions: readonly string[];
  readonly request_versions: readonly string[];
  readonly stdin_versions: readonly string[];
  readonly stdout: LifecycleCommandStdout;
}

interface CommandVersions {
  readonly invocation_versions?: readonly string[];
  readonly pending_versions?: readonly string[];
  readonly receipt_versions?: readonly string[];
  readonly request_versions?: readonly string[];
  readonly stdin_versions?: readonly string[];
  readonly stdout: LifecycleCommandStdout;
}

const immutable = (values: readonly string[] = []): readonly string[] =>
  Object.freeze([...values]);

const command = (
  argv: readonly string[],
  versions: CommandVersions,
): ComposedLifecycleCommandContract => Object.freeze({
  argv: immutable(argv),
  invocation_versions: immutable(versions.invocation_versions),
  pending_versions: immutable(versions.pending_versions),
  receipt_versions: immutable(versions.receipt_versions),
  request_versions: immutable(versions.request_versions),
  stdin_versions: immutable(versions.stdin_versions),
  stdout: versions.stdout,
});

const targetMutation = (
  operation: string,
  receiptVersions: readonly string[] = [TARGET_RESOURCE_RECEIPT_VERSION],
): ComposedLifecycleCommandContract => command(
  ["target", "--config", "-", operation, "<request-file>"],
  {
    receipt_versions: receiptVersions,
    request_versions: [TARGET_RESOURCE_REQUEST_VERSION],
    stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
    stdout: "json",
  },
);

const machineLifecycle = (argv: readonly string[], receiptVersion: string): ComposedLifecycleCommandContract =>
  command(argv, {
    invocation_versions: [LIFECYCLE_INVOCATION_VERSION],
    pending_versions: [LIFECYCLE_LOOKUP_VERSION],
    receipt_versions: [receiptVersion],
    stdout: "json",
  });

/**
 * Closed inventory for consumers that compose only public CLI and receipt
 * contracts. `argv` records one canonical invocation form, not every
 * presentation-only optional flag accepted by Commander.
 */
export const COMPOSED_LIFECYCLE_COMMANDS: readonly ComposedLifecycleCommandContract[] =
  Object.freeze([
    command(["capabilities", "--json"], {
      receipt_versions: ["spawnfile.capabilities.v1"], stdout: "json",
    }),
    command(["validate", "<project>"], { stdout: "text" }),
    command(["compile", "<project>", "--out", "<directory>"], { stdout: "text" }),
    command(["auth", "provision", "<request-file>"], {
      receipt_versions: [CREDENTIAL_PROVISIONING_RECEIPT_VERSION],
      request_versions: [CREDENTIAL_PROVISIONING_REQUEST_VERSION, RESOLVED_WORLD_GRANTS_VERSION],
      stdout: "json",
    }),
    command(["auth", "target-secret", "author"], {
      receipt_versions: [TARGET_SECRET_SOURCE_RECEIPT_VERSION], stdout: "json",
    }),
    command(["auth", "target-secret", "grant", "<request-file>"], {
      receipt_versions: [TARGET_SECRET_SOURCE_RECEIPT_VERSION],
      request_versions: [TARGET_SECRET_SOURCE_GRANT_REQUEST_VERSION],
      stdout: "json",
    }),
    command(["auth", "target-secret", "rotate", "<request-file>"], {
      receipt_versions: [TARGET_SECRET_SOURCE_RECEIPT_VERSION],
      request_versions: [TARGET_SECRET_SOURCE_REQUEST_VERSION],
      stdout: "json",
    }),
    command(["auth", "target-secret", "revoke-grant", "<request-file>"], {
      receipt_versions: [TARGET_SECRET_SOURCE_RECEIPT_VERSION],
      request_versions: [TARGET_SECRET_SOURCE_REQUEST_VERSION],
      stdout: "json",
    }),
    command(["auth", "target-secret", "revoke-version", "<request-file>"], {
      receipt_versions: [TARGET_SECRET_SOURCE_RECEIPT_VERSION],
      request_versions: [TARGET_SECRET_SOURCE_REQUEST_VERSION],
      stdout: "json",
    }),
    command(["helper", "prepare-evidence-export", "--context", "<name>", "--json"], {
      receipt_versions: [PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION], stdout: "json",
    }),
    command(["target", "resolve_config", "--evidence-destination", "<absolute-path>"], {
      receipt_versions: [TARGET_CONFIG_RESOLUTION_VERSION], stdout: "json",
    }),
    command([
      "target", "resolve_config", "--evidence-destination", "<absolute-path>",
      "--prepared-plan", "<private-plan>",
    ], {
      receipt_versions: [TARGET_CONFIG_RESOLUTION_VERSION],
      request_versions: [TARGET_CONFIG_PREPARED_PLAN_ABI_VERSION],
      stdout: "json",
    }),
    command([
      "target", "resolve_config", "--context", "<local-context>",
      "--evidence-destination", "<absolute-path>", "--prepare-evidence-helper",
    ], {
      receipt_versions: [TARGET_CONFIG_RESOLUTION_VERSION, PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "select_target", "<request-file>"], {
      receipt_versions: [SELECTED_TARGET_VERSION],
      request_versions: [TARGET_RESOURCE_REQUEST_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    ...[
      "resolve_world_artifact", "prepare_secret_bindings", "create_data_network",
      "create_evidence_volume", "attach_organization", "create_world_service",
      "start_world_service", "stop_world_service",
      "revoke_secret_bindings", "detach_organization", "cleanup_run", "recover_operation",
    ].map((operation) => targetMutation(operation)),
    command(["target", "--config", "-", "prepare_composed_run", "<request-file>"], {
      receipt_versions: [COMPOSED_PREPARATION_RECEIPT_VERSION],
      request_versions: [COMPOSED_PREPARATION_REQUEST_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "attest_topology", "<request-file>"], {
      receipt_versions: [TARGET_TOPOLOGY_RECEIPT_VERSION],
      request_versions: [TARGET_TOPOLOGY_ATTESTATION_REQUEST_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "activate_topology", "<request-file>"], {
      receipt_versions: [TARGET_TOPOLOGY_ACTIVATION_RECEIPT_VERSION],
      request_versions: [TARGET_TOPOLOGY_ATTESTATION_REQUEST_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "query_world_readiness", "<request-file>"], {
      receipt_versions: [TARGET_WORLD_READINESS_RECEIPT_VERSION],
      request_versions: [TARGET_WORLD_READINESS_REQUEST_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "query_world_clock", "<request-file>"], {
      receipt_versions: [TARGET_WORLD_CLOCK_RECEIPT_VERSION],
      request_versions: [TARGET_WORLD_CLOCK_REQUEST_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "snapshot_public_artifact", "<request-file>"], {
      receipt_versions: [
        TARGET_PUBLIC_ARTIFACT_SNAPSHOT_VERSION,
        TARGET_PUBLIC_ARTIFACT_SNAPSHOT_NOT_PRESENT_VERSION,
      ],
      request_versions: [TARGET_PUBLIC_ARTIFACT_SNAPSHOT_REQUEST_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "lookup_operation", "<request-file>"], {
      pending_versions: [TARGET_OPERATION_LOOKUP_VERSION],
      receipt_versions: [TARGET_OPERATION_LOOKUP_VERSION],
      request_versions: [TARGET_RESOURCE_REQUEST_VERSION],
      stdin_versions: [TARGET_LOOKUP_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "derive_container_bundle_policy", "<claims-file>"], {
      receipt_versions: [TARGET_LOCAL_CONTAINER_BUNDLE_POLICY.version], stdout: "json",
    }),
    command(["target", "--config", "-", "prepare_container_bundle", "<request-file>"], {
      receipt_versions: [TARGET_LOCAL_BUNDLE_PREPARE_RECEIPT_VERSION],
      request_versions: [TARGET_LOCAL_BUNDLE_PREPARE_REQUEST_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "recover_container_bundle", "<request-file>"], {
      receipt_versions: [TARGET_LOCAL_BUNDLE_PREPARE_RECEIPT_VERSION],
      request_versions: [TARGET_LOCAL_BUNDLE_PREPARE_REQUEST_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["target", "--config", "-", "lookup_container_bundle", "<lookup-file>"], {
      pending_versions: [TARGET_LOCAL_BUNDLE_LOOKUP_VERSION],
      receipt_versions: [TARGET_LOCAL_BUNDLE_LOOKUP_VERSION],
      request_versions: [TARGET_LOCAL_BUNDLE_LOOKUP_VERSION],
      stdin_versions: [TARGET_DEFAULT_CONFIG_STDIN_VERSION],
      stdout: "json",
    }),
    command(["lifecycle", "plan", "--request", "<file|->"], {
      receipt_versions: [LIFECYCLE_INVOCATION_VERSION],
      request_versions: [LIFECYCLE_PLAN_REQUEST_VERSION],
      stdout: "json",
    }),
    command(["lifecycle", "lookup", "<id>"], {
      pending_versions: [LIFECYCLE_LOOKUP_VERSION],
      receipt_versions: [LIFECYCLE_LOOKUP_VERSION],
      stdout: "json",
    }),
    machineLifecycle([
      "up", "<project>", "--detach", "--deployment", "<name>", "--json",
      "--lifecycle-invocation", "<id>", "--organization-handoff-run-id", "<run-id>",
      "--descriptor-digest", "<digest>", "--selected-target-receipt", "<file>",
      "--selected-target-receipt-digest", "<digest>", "--network-attachment-handle", "<handle>",
      "--world-bindings", "<file>",
    ], UP_RECEIPT_VERSION),
    machineLifecycle([
      "artifacts", "export", "<project>", "--out", "<directory>", "--json",
      "--lifecycle-invocation", "<id>",
    ], EXPORT_INDEX_VERSION),
    machineLifecycle([
      "down", "<project>", "--deployment", "<name>", "--json",
      "--lifecycle-invocation", "<id>",
    ], DOWN_RECEIPT_VERSION),
    targetMutation("export_evidence_volume", [
      TARGET_RESOURCE_RECEIPT_VERSION, TARGET_EXPORT_INDEX_VERSION,
    ]),
  ]);
