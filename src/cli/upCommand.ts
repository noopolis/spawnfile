import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Command } from "commander";

import {
  createDeploymentInstanceDigest,
  readDeploymentRecord,
  recordLifecycleOutcomeEvidence,
  type UpReceipt
} from "../deployment/index.js";
import { SpawnfileError } from "../shared/index.js";

import { requireMachineLifecycle, runMachineLifecycle } from "./lifecycleMachine.js";
import { resolveCommandInput } from "./resolveCommandInput.js";
import type { CliHandlers, CliStreams } from "./runCli.js";
import { runImageUpCommand } from "./upImageCommand.js";
import { createUpLifecycleInvocation, createUpProjectOptions } from "./upLifecycleInvocation.js";
import { reconcileUpLifecycle } from "./upLifecycleRecovery.js";

const readSelectedTargetReceipt = async (file: string): Promise<unknown> => {
  if (typeof file !== "string" || file.length < 1 || Buffer.byteLength(file, "utf8") > 4096) {
    throw new SpawnfileError("validation_error", "Invalid selected target receipt");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 65_536) throw new Error();
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } catch {
    throw new SpawnfileError("validation_error", "Invalid selected target receipt");
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

interface UpCommandOptions {
  authProfile?: string;
  context?: string;
  detach?: boolean;
  deployment?: string;
  descriptorDigest?: string;
  dockerCommand?: string;
  envFile?: string;
  image?: boolean;
  json?: boolean;
  lifecycleInvocation?: string;
  name?: string;
  out?: string;
  pull?: boolean;
  tag?: string;
  networkAttachmentHandle?: string;
  organizationHandoffRunId?: string;
  selectedTargetReceipt?: string;
  selectedTargetReceiptDigest?: string;
  worldBindings?: string;
}

export const registerUpCommand = (
  program: Command,
  handlers: CliHandlers,
  streams: CliStreams
): void => {
  program
    .command("up")
    .description("Deploy an organization from a project or a published image reference")
    .argument("[path]", "Project directory, Spawnfile path, or image reference", process.cwd())
    .option("-o, --out <directory>", "Output directory")
    .option("-t, --tag <image>", "Docker image tag")
    .option("--auth-profile <name>", "Local Spawnfile auth profile")
    .option("--context <name>", "Docker context for the deployment target")
    .option("--deployment <name>", "Detached deployment record name")
    .option("--docker-command <command>", "Docker command")
    .option("--name <container>", "Docker container name")
    .option("--env-file <file>", "Path to an env file for runtime secrets")
    .option("--world-bindings <file>", "Path to a versioned world-bindings artifact")
    .option("--selected-target-receipt-digest <digest>", "Selected target receipt digest for an organization handoff")
    .option("--selected-target-receipt <file>", "Selected target receipt for an organization handoff")
    .option("--network-attachment-handle <handle>", "Opaque network attachment handle for an organization handoff")
    .option("--organization-handoff-run-id <id>", "Authorized run id for an organization handoff")
    .option("--descriptor-digest <digest>", "Production descriptor digest for an organization handoff")
    .option("--image", "Interpret the argument as an image reference")
    .option("--pull", "Pull the image before deploying")
    .option("-d, --detach", "Run the container in detached mode")
    .option("--json", "Render a spawnfile.up-receipt.v1 machine-readable receipt")
    .option("--lifecycle-invocation <id>", "Durably bind this exact JSON lifecycle invocation")
    .action(async (inputPath: string, options: UpCommandOptions) => {
      requireMachineLifecycle(options.lifecycleInvocation, options.json);
      const upInput = resolveCommandInput(inputPath, { forceImage: options.image });
      if (upInput.kind === "invalid") {
        throw new SpawnfileError(
          "validation_error",
          `Cannot resolve "${inputPath}" as a project path or image reference. ` +
            "Pass a project directory, a Spawnfile path, or an image like 'name:tag' (use --image to force image mode)."
        );
      }

      if (upInput.kind === "image") {
        if (
          options.selectedTargetReceiptDigest !== undefined ||
          options.selectedTargetReceipt !== undefined ||
          options.networkAttachmentHandle !== undefined ||
          options.organizationHandoffRunId !== undefined ||
          options.descriptorDigest !== undefined
        ) {
          throw new SpawnfileError(
            "validation_error",
            "Organization handoff inputs are only supported for project-mode deployments"
          );
        }
        if (options.worldBindings !== undefined) {
          throw new SpawnfileError(
            "validation_error",
            "`--world-bindings` is only supported for project-mode deployments"
          );
        }
        if (options.json) {
          throw new SpawnfileError(
            "validation_error",
            "`spawnfile up --json` is not yet supported for image-mode deployments " +
              "(there is no source Spawnfile to derive compiled_schedule from)."
          );
        }
        await runImageUpCommand(upInput.ref, options, handlers, streams);
        return;
      }

      const handoffValues = [
        options.descriptorDigest,
        options.organizationHandoffRunId,
        options.selectedTargetReceipt,
        options.selectedTargetReceiptDigest,
        options.networkAttachmentHandle,
        options.worldBindings
      ];
      if (
        handoffValues.some((value) => value !== undefined) &&
        handoffValues.some((value) => value === undefined)
      ) {
        throw new SpawnfileError(
          "validation_error",
          "Organization handoff requires --organization-handoff-run-id, --descriptor-digest, --selected-target-receipt, --selected-target-receipt-digest, --network-attachment-handle, and --world-bindings"
        );
      }
      if (
        options.lifecycleInvocation !== undefined &&
        (!options.detach ||
          !options.deployment ||
          handoffValues.some((value) => value === undefined))
      ) {
        throw new SpawnfileError(
          "validation_error",
          "Machine lifecycle up requires a detached deployment with durable organization handoff authority"
        );
      }

      if (options.json) {
        const exactInvocation = options.lifecycleInvocation === undefined
          ? undefined
          : createUpLifecycleInvocation(inputPath, {
              ...options,
              forceImage: options.image,
              lifecycleInvocation: options.lifecycleInvocation
            });
        const render = async (
          capability?: Parameters<typeof recordLifecycleOutcomeEvidence>[2]
        ): Promise<string> => {
          const selectedTargetReceipt = options.selectedTargetReceipt === undefined
            ? undefined
            : await readSelectedTargetReceipt(options.selectedTargetReceipt);
          const result = await handlers.upProject(
            inputPath,
            createUpProjectOptions({ ...options, selectedTargetReceipt })
          );
          const receipt: UpReceipt = await handlers.buildUpReceipt(inputPath, result);
          const bytes = JSON.stringify(receipt, null, 2);
          if (exactInvocation && capability) {
            await recordLifecycleOutcomeEvidence(
              exactInvocation,
              bytes,
              capability,
              result.deploymentRecordPath
                ? createDeploymentInstanceDigest(
                    await readDeploymentRecord(result.deploymentRecordPath)
                  )
                : ""
            );
          }
          return bytes;
        };
        const output = options.lifecycleInvocation === undefined
          ? await render()
          : await runMachineLifecycle(
              exactInvocation!,
              render,
              () => reconcileUpLifecycle(inputPath, options, exactInvocation!)
            );
        streams.stdout(output);
        return;
      }

      const result = await handlers.upProject(inputPath, createUpProjectOptions(options));

      streams.stdout(`built image ${result.imageTag}`);
      streams.stdout(`compiled to ${result.outputDirectory}`);
      streams.stdout(`report: ${result.reportPath}`);
      if (options.detach) {
        streams.stdout(`running container ${result.containerName ?? "unknown"}`);
        streams.stdout(`image: ${result.imageTag}`);
      }
    });
};
