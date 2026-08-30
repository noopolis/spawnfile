import { CREDENTIAL_PROVISIONING_REQUEST_VERSION } from "../auth/index.js";
import { PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION } from "../evidenceExportHelper/index.js";
import {
  TARGET_PUBLIC_ARTIFACT_SNAPSHOT_NOT_PRESENT_VERSION,
  TARGET_PUBLIC_ARTIFACT_SNAPSHOT_REQUEST_VERSION,
  TARGET_PUBLIC_ARTIFACT_SNAPSHOT_VERSION,
} from "../target/publicArtifactSnapshot.js";

import {
  COMPOSED_LIFECYCLE_COMMANDS,
  COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION,
  type ComposedLifecycleCommandContract,
} from "./composedLifecycleContractSet.js";
import {
  TARGET_DEFAULT_CONFIG_STDIN_VERSION,
} from "./targetDefaultConfigStdin.js";
import {
  TARGET_CONFIG_DIGEST_VERSION,
  TARGET_CONFIG_PREPARED_PLAN_ABI_VERSION,
  TARGET_CONFIG_RESOLUTION_VERSION,
} from "./targetConfigResolver.js";
import { TARGET_CONFIG_RESOLVER_COMMAND } from "./targetConfigResolverCommand.js";

export { COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION } from "./composedLifecycleContractSet.js";

export const CAPABILITIES_RECEIPT_VERSION = "spawnfile.capabilities.v1" as const;

const PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export interface CapabilitiesReceipt {
  readonly capabilities: {
    readonly evidence_export_helper: {
      readonly identity: "docker-image-config-digest";
      readonly local_context_only: true;
      readonly prepare_command: readonly [
        "helper", "prepare-evidence-export", "--context", "<name>", "--json",
      ];
      readonly receipt_version: typeof PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION;
      readonly resolver_option: "--prepare-evidence-helper";
      readonly provisioning: "spawnfile-owned-target-local";
    };
    readonly composed_lifecycle: {
      readonly command_set_version: typeof COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION;
      readonly commands: readonly ComposedLifecycleCommandContract[];
      readonly complete: true;
    };
    readonly optional_model_auth: {
      readonly request_version: typeof CREDENTIAL_PROVISIONING_REQUEST_VERSION;
      readonly required: false;
    };
    readonly target_config_resolver: {
      readonly command: readonly ["target", typeof TARGET_CONFIG_RESOLVER_COMMAND];
      readonly output_version: typeof TARGET_CONFIG_RESOLUTION_VERSION;
      readonly prepared_plan_version: typeof TARGET_CONFIG_PREPARED_PLAN_ABI_VERSION;
      readonly target_config_digest_version: typeof TARGET_CONFIG_DIGEST_VERSION;
      readonly target_config_version: typeof TARGET_DEFAULT_CONFIG_STDIN_VERSION;
    };
    readonly terminal_public_artifact: {
      readonly not_present_version: typeof TARGET_PUBLIC_ARTIFACT_SNAPSHOT_NOT_PRESENT_VERSION;
      readonly request_version: typeof TARGET_PUBLIC_ARTIFACT_SNAPSHOT_REQUEST_VERSION;
      readonly snapshot_version: typeof TARGET_PUBLIC_ARTIFACT_SNAPSHOT_VERSION;
    };
  };
  readonly implementation: {
    readonly cli: "spawnfile";
    readonly package: "spawnfile";
    readonly version: string;
  };
  readonly version: typeof CAPABILITIES_RECEIPT_VERSION;
}

export const createCapabilitiesReceipt = (packageVersion: string): CapabilitiesReceipt => {
  if (!PACKAGE_VERSION.test(packageVersion)) throw new TypeError("Invalid Spawnfile package version");
  return Object.freeze({
    capabilities: Object.freeze({
      evidence_export_helper: Object.freeze({
        identity: "docker-image-config-digest" as const,
        local_context_only: true as const,
        prepare_command: Object.freeze([
          "helper", "prepare-evidence-export", "--context", "<name>", "--json",
        ] as const),
        receipt_version: PREPARED_EVIDENCE_HELPER_RECEIPT_VERSION,
        resolver_option: "--prepare-evidence-helper" as const,
        provisioning: "spawnfile-owned-target-local" as const,
      }),
      composed_lifecycle: Object.freeze({
        command_set_version: COMPOSED_LIFECYCLE_CONTRACT_SET_VERSION,
        commands: COMPOSED_LIFECYCLE_COMMANDS,
        complete: true as const,
      }),
      optional_model_auth: Object.freeze({
        request_version: CREDENTIAL_PROVISIONING_REQUEST_VERSION,
        required: false as const,
      }),
      target_config_resolver: Object.freeze({
        command: Object.freeze(["target", TARGET_CONFIG_RESOLVER_COMMAND] as const),
        output_version: TARGET_CONFIG_RESOLUTION_VERSION,
        prepared_plan_version: TARGET_CONFIG_PREPARED_PLAN_ABI_VERSION,
        target_config_digest_version: TARGET_CONFIG_DIGEST_VERSION,
        target_config_version: TARGET_DEFAULT_CONFIG_STDIN_VERSION,
      }),
      terminal_public_artifact: Object.freeze({
        not_present_version: TARGET_PUBLIC_ARTIFACT_SNAPSHOT_NOT_PRESENT_VERSION,
        request_version: TARGET_PUBLIC_ARTIFACT_SNAPSHOT_REQUEST_VERSION,
        snapshot_version: TARGET_PUBLIC_ARTIFACT_SNAPSHOT_VERSION,
      }),
    }),
    implementation: Object.freeze({
      cli: "spawnfile" as const,
      package: "spawnfile" as const,
      version: packageVersion,
    }),
    version: CAPABILITIES_RECEIPT_VERSION,
  });
};

export const createCapabilitiesReceiptBytes = (receipt: CapabilitiesReceipt): string =>
  JSON.stringify(receipt);
