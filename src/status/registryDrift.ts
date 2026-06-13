import { spawn } from "node:child_process";

import {
  dockerContextNameForTarget,
  dockerHostValueForTarget,
  type DeploymentRecord
} from "../deployment/index.js";

import type { StatusObservation } from "./types.js";

export type RegistryDigestResolver = (
  imageRef: string,
  baseArgs: string[]
) => Promise<string | null>;

export interface RegistryDriftInput {
  deployments: DeploymentRecord[];
  dockerCommand?: string;
  resolveDigest?: RegistryDigestResolver;
  timeoutMs?: number;
}

/* v8 ignore start -- docker manifest inspect is covered by distribution E2E */
const defaultResolveDigest: RegistryDigestResolver = async (imageRef, baseArgs) =>
  new Promise<string | null>((resolve) => {
    const child = spawn("docker", [...baseArgs, "manifest", "inspect", "--verbose", imageRef], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.join("")) as unknown;
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
          const digest = (entry as { Descriptor?: { digest?: string } }).Descriptor?.digest
            ?? (entry as { digest?: string }).digest;
          if (typeof digest === "string" && digest.length > 0) {
            resolve(digest);
            return;
          }
        }
        resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
/* v8 ignore stop */

const baseArgsForTarget = (record: DeploymentRecord): string[] => {
  const context = dockerContextNameForTarget(record.target);
  if (context) {
    return ["--context", context];
  }
  const host = dockerHostValueForTarget(record.target);
  return host ? ["--host", host] : [];
};

/**
 * Compares each image deployment's recorded source.digest against the digest
 * the registry tag currently resolves to. Networked: runs only behind the
 * explicit --pull-check flag. A digest-pinned ref needs no lookup; a null
 * recorded digest renders unknown.
 */
export const collectRegistryDriftObservations = async (
  input: RegistryDriftInput
): Promise<StatusObservation[]> => {
  const resolveDigest = input.resolveDigest ?? defaultResolveDigest;
  const observations: StatusObservation[] = [];

  for (const record of input.deployments) {
    if (record.source.kind !== "image") {
      continue;
    }
    const subject = `deployment-unit:${record.name}`;
    const ref = record.source.ref;

    if (ref.includes("@sha256:")) {
      observations.push({
        key: "registry.drift",
        label: "registry",
        message: `${ref} is digest-pinned; registry drift does not apply`,
        severity: "ok",
        source: "deployment",
        subject
      });
      continue;
    }

    if (!record.source.digest) {
      observations.push({
        key: "registry.drift",
        label: "registry",
        message: `${ref} has no recorded registry digest; drift is unknown`,
        severity: "unknown",
        source: "deployment",
        subject
      });
      continue;
    }

    const current = await resolveDigest(ref, baseArgsForTarget(record));
    if (!current) {
      observations.push({
        key: "registry.drift",
        label: "registry",
        message: `Unable to resolve the current registry digest for ${ref}`,
        severity: "unknown",
        source: "deployment",
        subject
      });
      continue;
    }

    if (current === record.source.digest) {
      observations.push({
        key: "registry.drift",
        label: "registry",
        message: `${ref} matches the recorded registry digest`,
        severity: "ok",
        source: "deployment",
        subject
      });
      continue;
    }

    observations.push({
      key: "registry.drift",
      label: "registry",
      message: `A newer build of ${ref} has been published since this deployment`,
      severity: "warn",
      source: "deployment",
      subject
    });
  }

  return observations;
};
