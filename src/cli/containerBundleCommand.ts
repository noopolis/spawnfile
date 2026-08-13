import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import type { Command } from "commander";

import { createTargetLocalContainerBundleOperations } from "../target/containerBundle.js";
import { createContainerBundlePreparationAuthority } from "../target/containerBundleAuthority.js";
import { createCanonicalTargetLocalBundleLookupBytes, createCanonicalTargetLocalBundleReceiptBytes, parseTargetLocalBundleLookupRequest, parseTargetLocalBundlePrepareRequest, type TargetLocalBundleLookupRequest } from "../target/containerBundleContracts.js";
import { initializeFilesystemTargetLocalBundleStore } from "../target/containerBundleFilesystemStore.js";
import { createDockerTargetLocalBundleBuilder } from "../target/dockerContainerBundleBuilder.js";
import { createDockerTargetExecutors } from "../target/dockerCommandExecutor.js";
import { deriveTargetLocalContainerBundlePolicy } from "../target/containerBundlePolicy.js";
import type { TargetDefaultConfig } from "./targetDefaultConfig.js";
import { readTargetDefaultConfigStdin } from "./targetDefaultConfigStdin.js";

const MAX_BUNDLE_REQUEST_FILE_BYTES = 5_600_000;
const readJson = async (raw: unknown): Promise<unknown> => {
  if (typeof raw !== "string" || raw.includes("\0") || !path.isAbsolute(raw) || path.normalize(raw) !== raw
    || Buffer.byteLength(raw, "utf8") > 4096) throw new Error();
  const file = await open(raw, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > MAX_BUNDLE_REQUEST_FILE_BYTES) throw new Error();
    const bytes = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset <= info.size) { const result = await file.read(bytes, offset, info.size + 1 - offset, offset); if (result.bytesRead === 0) break; offset += result.bytesRead; }
    if (offset !== info.size) throw new Error(); return JSON.parse(bytes.toString("utf8", 0, offset));
  } finally { await file.close(); }
};
const readRequest = async (file: string): Promise<unknown> => parseTargetLocalBundlePrepareRequest(await readJson(file));
const readLookup = async (file: string): Promise<TargetLocalBundleLookupRequest> => parseTargetLocalBundleLookupRequest(await readJson(file));

const operations = async (config: TargetDefaultConfig) => {
  const executors = createDockerTargetExecutors({ dockerCommand: config.dockerCommand });
  return createTargetLocalContainerBundleOperations({
    authority: createContainerBundlePreparationAuthority(config.preparedArtifactMappings),
    builder: createDockerTargetLocalBundleBuilder({ context: config.context, executor: executors.artifact, timeoutMs: config.timeoutMs }),
    store: await initializeFilesystemTargetLocalBundleStore(config.paths.containerBundles)
  });
};

/** Production-only command. Its stdout is the secret-free canonical receipt. */
export const registerContainerBundleCommand = (
  target: Command,
  stdin: AsyncIterable<unknown>,
  streams: { stderr(message: string): void; stdout(message: string): void },
  setExitCode: (value: 1 | 2) => void
): void => {
  target.command("derive_container_bundle_policy")
    .argument("<claims-file>", "Strict target-local bundle policy claims")
    .action(async (claimsFile: string) => {
      try {
        const raw = await readJson(claimsFile);
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)
          || Object.keys(raw as object).sort().join("\0") !== "archiveDigest\0artifactDigest\0baseImageConfigDigest\0bundleDigest\0entrypoint\0launcherDigest\0networkAlias\0platform") {
          throw new Error();
        }
        const policy = deriveTargetLocalContainerBundlePolicy(
          raw as Parameters<typeof deriveTargetLocalContainerBundlePolicy>[0],
        );
        streams.stdout(JSON.stringify({
          version: "spawnfile.target-local-container-bundle-policy.v1",
          build_policy_digest: policy.buildPolicyDigest,
          platform_digest: policy.platformDigest
        }));
      } catch {
        streams.stderr("error: Invalid container bundle policy claims");
        setExitCode(2);
      }
    });
  const execute = (name: "prepare_container_bundle" | "recover_container_bundle") => target.command(name)
    .argument("<request-file>", "Strict container-bundle preparation request")
    .action(async (requestFile: string) => {
      let request; try { request = await readRequest(requestFile); } catch { streams.stderr("error: Invalid container bundle request"); setExitCode(2); return; }
      try {
        const config = await readTargetDefaultConfigStdin(stdin);
        const receipt = await (await operations(config))[name === "prepare_container_bundle" ? "prepare" : "recover"](request);
        streams.stdout(createCanonicalTargetLocalBundleReceiptBytes(receipt));
      } catch { streams.stderr("error: Target-local container bundle preparation failed"); setExitCode(1); }
    });
  execute("prepare_container_bundle"); execute("recover_container_bundle");
  target.command("lookup_container_bundle").argument("<lookup-file>", "Strict semantic bundle lookup")
    .action(async (lookupFile: string) => {
      let request; try { request = await readLookup(lookupFile); } catch { streams.stderr("error: Invalid container bundle lookup"); setExitCode(2); return; }
      try { const config = await readTargetDefaultConfigStdin(stdin); const result = await (await operations(config)).lookup(request); streams.stdout(createCanonicalTargetLocalBundleLookupBytes(result)); }
      catch { streams.stderr("error: Target-local container bundle preparation failed"); setExitCode(1); }
    });
};
