import path from "node:path";

import type { LifecycleInvocation } from "../deployment/index.js";

import {
  createLifecycleInvocation,
  digestLifecycleBinding,
} from "./lifecycleMachine.js";

export interface UpLifecycleOptions {
  authProfile?: string;
  context?: string;
  deployment?: string;
  descriptorDigest?: string;
  detach?: boolean;
  dockerCommand?: string;
  envFile?: string;
  forceImage?: boolean;
  lifecycleInvocation?: string;
  name?: string;
  networkAttachmentHandle?: string;
  organizationHandoffRunId?: string;
  out?: string;
  pull?: boolean;
  selectedTargetReceipt?: unknown;
  selectedTargetReceiptDigest?: string;
  tag?: string;
  worldBindings?: string;
}

export const createUpLifecycleInvocation = (
  inputPath: string,
  options: UpLifecycleOptions & { lifecycleInvocation: string },
): LifecycleInvocation =>
  createLifecycleInvocation(
    options.lifecycleInvocation,
    "up",
    {
      input_kind: "project",
      project_path: path.resolve(inputPath),
    },
    {
      auth_profile_digest: digestLifecycleBinding(options.authProfile),
      container_name: options.name ?? null,
      deployment: options.deployment ?? null,
      detach: options.detach ?? false,
      docker_command_digest: digestLifecycleBinding(options.dockerCommand),
      docker_context: options.context ?? null,
      descriptor_digest: options.descriptorDigest ?? null,
      env_file_digest: digestLifecycleBinding(options.envFile),
      force_image: options.forceImage ?? false,
      image_tag: options.tag ?? null,
      network_attachment_handle_digest: digestLifecycleBinding(
        options.networkAttachmentHandle,
      ),
      organization_handoff_run_id:
        options.organizationHandoffRunId ?? null,
      output_directory: options.out ? path.resolve(options.out) : null,
      pull: options.pull ?? false,
      selected_target_receipt_digest:
        options.selectedTargetReceiptDigest ?? null,
      world_bindings_digest: digestLifecycleBinding(options.worldBindings),
    },
  );

export const createUpProjectOptions = (options: UpLifecycleOptions) => ({
  authProfile: options.authProfile,
  containerName: options.name,
  detach: options.detach,
  deploymentName: options.deployment,
  dockerCommand: options.dockerCommand,
  dockerContext: options.context,
  descriptorDigest: options.descriptorDigest,
  envFilePath: options.envFile,
  imageTag: options.tag,
  organizationHandoffRunId: options.organizationHandoffRunId,
  outputDirectory: options.out,
  ...(options.networkAttachmentHandle !== undefined
    ? { networkAttachmentHandle: options.networkAttachmentHandle }
    : {}),
  ...(options.selectedTargetReceiptDigest !== undefined
    ? { selectedTargetReceiptDigest: options.selectedTargetReceiptDigest }
    : {}),
  ...(options.selectedTargetReceipt !== undefined
    ? { selectedTargetReceipt: options.selectedTargetReceipt }
    : {}),
  ...(options.worldBindings !== undefined
    ? { worldBindingsPath: options.worldBindings }
    : {}),
});
