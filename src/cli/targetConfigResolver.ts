import path from "node:path";

import { resolveSpawnfileHome } from "../auth/index.js";
import {
  createPreparedEvidenceHelperExecutor,
  parsePreparedEvidenceHelperReceipt,
  prepareEvidenceExportHelper,
  type PreparedEvidenceHelperReceipt,
} from "../evidenceExportHelper/index.js";
import { defaultDockerTargetExecFile, resolveDockerContextEndpoint } from "../target/dockerTargetBinding.js";

import {
  createTargetConfigDigest,
  STANDARD_WORLD_BASE_IMAGE,
  TARGET_CONFIG_RESOLUTION_VERSION,
  type ResolveTargetConfigDependencies,
  type ResolveTargetConfigInput,
  type TargetConfigResolution,
} from "./targetConfigResolverContracts.js";
import { exactJson, executeDocker, resolveCurrentDockerContext } from "./targetConfigResolverDocker.js";
import {
  classifyEndpoint,
  normalizeArchitecture,
  parseBaseImage,
  parseContext,
  parseDockerCommand,
  parseTimeout,
  runtimeFailure,
  validateEvidenceDestination,
  validationFailure,
} from "./targetConfigResolverValidation.js";
import { readTargetConfigPreparedPlan } from "./targetConfigPreparedPlan.js";
import { TARGET_DEFAULT_CONFIG_STDIN_VERSION } from "./targetDefaultConfigStdin.js";

export {
  createCanonicalTargetConfigBytes,
  createTargetConfigDigest,
  createTargetConfigResolutionBytes,
  STANDARD_WORLD_BASE_IMAGE,
  TARGET_CONFIG_DIGEST_VERSION,
  TARGET_CONFIG_PREPARED_PLAN_ABI_VERSION,
  TARGET_CONFIG_RESOLUTION_VERSION,
  type ResolveTargetConfigDependencies,
  type ResolveTargetConfigInput,
  type TargetConfigResolution,
} from "./targetConfigResolverContracts.js";

export const resolveTargetConfig = async (
  input: ResolveTargetConfigInput,
  dependencies: ResolveTargetConfigDependencies = {},
): Promise<TargetConfigResolution> => {
  const baseImage = parseBaseImage(input.baseImage ?? STANDARD_WORLD_BASE_IMAGE);
  const dockerCommand = parseDockerCommand(input.dockerCommand ?? "docker");
  const timeoutMs = parseTimeout(input.timeoutMs ?? 10_000);
  const evidenceDestination = await validateEvidenceDestination(input.evidenceDestination);
  const preparedArtifactMappings = await readTargetConfigPreparedPlan(
    input.preparedPlanPath, evidenceDestination,
  );
  const execFile = input.execFile ?? defaultDockerTargetExecFile;
  const contextSelection = input.context === undefined ? "auto-local" as const : "explicit" as const;
  const context = input.context === undefined
    ? await resolveCurrentDockerContext(execFile, dockerCommand, timeoutMs, input.signal)
    : parseContext(input.context);
  let endpointValue: string;
  try {
    endpointValue = await resolveDockerContextEndpoint(context, {
      dockerCommand, execFile, signal: input.signal, timeoutMs,
    });
  } catch {
    return runtimeFailure(`Unable to inspect Docker context "${context}"`);
  }
  const endpoint = classifyEndpoint(endpointValue);
  if (contextSelection === "auto-local" && endpoint.class !== "local") {
    return validationFailure(
      "Current Docker context is remote; pass --context explicitly to select a remote target",
    );
  }
  if (input.prepareEvidenceHelper === true
    && (contextSelection !== "explicit" || endpoint.class !== "local")) {
    return validationFailure("Evidence helper preparation requires an explicitly selected local Docker context");
  }
  if (input.pull === true && endpoint.class === "remote" && input.allowRemotePull !== true) {
    return validationFailure("Pulling on a remote Docker context requires --allow-remote-pull");
  }

  const infoSource = await executeDocker(
    execFile, dockerCommand, context,
    ["info", "--format", "{\"Architecture\":{{json .Architecture}},\"OSType\":{{json .OSType}}}"],
    timeoutMs, input.signal, "Unable to inspect Docker target platform",
  );
  const info = exactJson(infoSource, ["Architecture", "OSType"], "Docker target platform is invalid");
  if (info.OSType !== "linux") return runtimeFailure("Docker target operating system is unsupported");
  const architecture = normalizeArchitecture(info.Architecture);

  if (input.pull === true) {
    await executeDocker(
      execFile, dockerCommand, context, ["image", "pull", "--quiet", baseImage],
      timeoutMs, input.signal, "Unable to pull the requested base image",
    );
  }
  const imageSource = await executeDocker(
    execFile, dockerCommand, context,
    ["image", "inspect", baseImage, "--format",
      "{\"Architecture\":{{json .Architecture}},\"Id\":{{json .Id}},\"Os\":{{json .Os}}}"],
    timeoutMs, input.signal,
    input.pull === true
      ? "Unable to inspect the pulled base image"
      : "Base image is unavailable in the Docker context; rerun with --pull to fetch it",
  );
  const image = exactJson(
    imageSource, ["Architecture", "Id", "Os"], "Docker base image inspection is invalid",
  );
  const imageArchitecture = normalizeArchitecture(image.Architecture);
  if (image.Os !== "linux" || imageArchitecture !== architecture) {
    return runtimeFailure("Docker base image platform does not match the selected target");
  }
  if (typeof image.Id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(image.Id)) {
    return runtimeFailure("Docker base image config ID is invalid");
  }
  let preparedEvidenceHelper: PreparedEvidenceHelperReceipt | undefined;
  if (input.prepareEvidenceHelper === true) {
    try {
      preparedEvidenceHelper = parsePreparedEvidenceHelperReceipt(
        await (dependencies.prepareEvidenceExportHelper ?? prepareEvidenceExportHelper)({
          baseImage,
          context,
          executor: input.execFile === undefined
            ? createPreparedEvidenceHelperExecutor(dockerCommand)
            : async (file, args, options) => {
            if (file !== "docker") throw new Error("unexpected helper executable");
            return execFile(dockerCommand, args, {
              signal: options.signal,
              stdin: (options as { readonly stdin?: Uint8Array }).stdin,
              timeout: options.timeout,
            });
            },
          privateRoot: path.join(resolveSpawnfileHome(), "target", "evidence-helper"),
          signal: input.signal,
          timeoutMs,
        }),
      );
    } catch {
      return runtimeFailure("Evidence helper preparation failed for the selected local target");
    }
  }

  const targetConfig = Object.freeze({
    context, dockerCommand, evidenceDestination,
    ...(preparedEvidenceHelper === undefined ? {} : {
      evidenceHelperBaseImage: baseImage, preparedEvidenceHelper,
    }),
    ...(preparedArtifactMappings === undefined ? {} : { preparedArtifactMappings }),
    timeoutMs,
    version: TARGET_DEFAULT_CONFIG_STDIN_VERSION,
  });
  return Object.freeze({
    base_image: Object.freeze({
      config_digest: image.Id as `sha256:${string}`, reference: baseImage,
    }),
    context_selection: contextSelection,
    endpoint,
    platform: Object.freeze({ architecture, os: "linux" as const }),
    ...(preparedEvidenceHelper === undefined ? {} : {
      prepared_evidence_helper: preparedEvidenceHelper,
    }),
    target_config: targetConfig,
    target_config_digest: createTargetConfigDigest(targetConfig),
    version: TARGET_CONFIG_RESOLUTION_VERSION,
  });
};
