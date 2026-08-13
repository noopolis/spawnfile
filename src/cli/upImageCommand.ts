import { readRunEnvFile } from "../compiler/runProjectAuth.js";

import type { CliHandlers, CliStreams } from "./runCli.js";

interface ImageUpOptions {
  authProfile?: string;
  context?: string;
  deployment?: string;
  dockerCommand?: string;
  envFile?: string;
  pull?: boolean;
}

const shortDigest = (digest: string | null): string =>
  digest ? digest.replace(/^sha256:/, "").slice(0, 12) : "unknown";

const redeploySummary = (
  previous: { digest: string | null; ref: string },
  newRef: string,
  newDigest: string | null,
): string => {
  if (
    previous.ref === newRef &&
    newDigest !== null &&
    previous.digest === newDigest
  ) {
    return `redeployed image ${newRef} (digest unchanged ${shortDigest(newDigest)})`;
  }
  return (
    `redeployed image: ${previous.ref} (${shortDigest(previous.digest)}) ` +
    `→ ${newRef} (${shortDigest(newDigest)})`
  );
};

export const runImageUpCommand = async (
  ref: string,
  options: ImageUpOptions,
  handlers: CliHandlers,
  streams: CliStreams,
): Promise<void> => {
  const authProfile =
    options.authProfile && handlers.requireAuthProfile
      ? await handlers.requireAuthProfile(options.authProfile)
      : null;
  const envFileEnv = await readRunEnvFile(options.envFile);
  const consumed = await handlers.consumeImageUp(ref, {
    authProfile,
    authProfileName: options.authProfile ?? null,
    authValues: authProfile?.env ?? {},
    deploymentName: options.deployment,
    dockerCommand: options.dockerCommand,
    dockerContext: options.context,
    envFileEnv,
    envFilePath: options.envFile ?? null,
    pull: options.pull,
  });
  if (consumed.previous) {
    const digest =
      consumed.record.source.kind === "image"
        ? consumed.record.source.digest
        : null;
    streams.stdout(
      redeploySummary(consumed.previous, consumed.imageRef, digest),
    );
  } else {
    streams.stdout(`deployed image ${consumed.imageRef}`);
  }
  streams.stdout(`deployment: ${consumed.deploymentName}`);
  streams.stdout(`running container ${consumed.containerName}`);
  streams.stdout(`record: ${consumed.recordPath}`);
  streams.stdout(
    `next: spawnfile status --deployment ${consumed.deploymentName} --live`,
  );
};
