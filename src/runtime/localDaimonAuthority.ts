import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { SpawnfileError } from "../shared/index.js";
import { DAIMON_CONTRACT_MANIFEST_SHA256 } from "./daimon/contractManifest.js";

export const DAIMON_LOCAL_RUNTIME_IDENTITY_ENV =
  "SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY";
const LOCAL_DAIMON_REPOSITORY_PATH = "noopolis/spawnfile-runtime-daimon";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_IDENTITY_BYTES = 16 * 1024;

const localDaimonRuntimeIdentitySchema = z
  .object({
    capability_receipt_sha256: z.string().regex(DIGEST),
    development: z
      .object({
        mode: z.literal("local-development"),
        non_production: z.literal(true),
        unpublished: z.literal(true),
        unsigned: z.literal(true)
      })
      .strict(),
    image_architecture: z.literal("amd64"),
    image_config_digest: z.string().regex(DIGEST),
    image_manifest_digest: z.string().regex(DIGEST),
    image_reference: z.string(),
    manifest_sha256: z.string().regex(DIGEST),
    registry_authority: z.string().regex(/^127\.0\.0\.1:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/u),
    version: z.literal("spawnfile.local-daimon-runtime-identity.v3")
  })
  .strict()
  .superRefine((identity, context) => {
    const expected = `${identity.registry_authority}/${LOCAL_DAIMON_REPOSITORY_PATH}@${identity.image_manifest_digest}`;
    if (identity.image_reference !== expected) {
      context.addIssue({
        code: "custom",
        message: "image_reference must bind the approved local registry repository and manifest digest",
        path: ["image_reference"]
      });
    }
  });

export interface LocalDaimonRuntimeIdentity {
  capabilityReceipt: string;
  imageArchitecture: "amd64";
  imageConfigDigest: string;
  imageManifestDigest: string;
  imageReference: string;
  manifestSha256: string;
  registryAuthority: string;
}

const fail = (message: string): never => {
  throw new SpawnfileError("runtime_error", message);
};

export const loadLocalDaimonRuntimeIdentity = async (
  identityPath: string
): Promise<LocalDaimonRuntimeIdentity> => {
  if (!path.isAbsolute(identityPath)) {
    return fail("Local Daimon runtime identity path must be absolute");
  }

  let entry;
  try {
    entry = await lstat(identityPath);
  } catch {
    return fail("Local Daimon runtime identity is missing or unreadable");
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0 || entry.size > MAX_IDENTITY_BYTES) {
    return fail("Local Daimon runtime identity must be a bounded nonempty regular file");
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(identityPath, "utf8"));
  } catch {
    return fail("Local Daimon runtime identity must contain valid JSON");
  }

  const parsed = localDaimonRuntimeIdentitySchema.safeParse(value);
  if (!parsed.success || parsed.data.manifest_sha256 !== DAIMON_CONTRACT_MANIFEST_SHA256) {
    return fail("Local Daimon runtime identity is invalid or incomplete");
  }

  return Object.freeze({
    capabilityReceipt: parsed.data.capability_receipt_sha256,
    imageArchitecture: parsed.data.image_architecture,
    imageConfigDigest: parsed.data.image_config_digest,
    imageManifestDigest: parsed.data.image_manifest_digest,
    imageReference: parsed.data.image_reference,
    manifestSha256: parsed.data.manifest_sha256,
    registryAuthority: parsed.data.registry_authority
  });
};
