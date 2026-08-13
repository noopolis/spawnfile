import {
  resolveAuthHome,
  resolveSpawnfileHome,
  resolveTargetSecretAliasPath,
  resolveTargetSecretAliasesDirectory,
  resolveTargetSecretGrantPath,
  resolveTargetSecretGrantsDirectory,
  resolveTargetSecretRedemptionPath,
  resolveTargetSecretRedemptionsDirectory,
  resolveTargetSecretRevocationPath,
  resolveTargetSecretRevocationsDirectory,
  resolveTargetSecretsRoot
} from "./paths.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";
import {
  initializeTargetSecretSourceFsPublishImmutable,
  type TargetSecretSourceFsPublishImmutableOptions
} from "./targetSecretSourceFsPublishImmutable.js";
import { initializeTargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import {
  parseTargetSecretSourceGrantRecordBytesForPublication,
  parseTargetSecretSourceRedemptionRecordBytesForPublication,
  parseTargetSecretSourceRevocationRecordBytesForPublication
} from "./targetSecretSourceGrantRecords.js";
import { parseTargetSecretSourceAliasRecordBytesForPublication } from "./targetSecretSourceVersionRecords.js";

export interface TargetSecretSourceRecordPublishOptions extends Pick<
  TargetSecretSourceFsPublishImmutableOptions,
  "hookForTest" | "maxWriteBytesForTest"
> {}
export interface TargetSecretSourceRecordPublish {
  publishAlias(bytes: Uint8Array): Promise<void>;
  publishGrant(bytes: Uint8Array): Promise<void>;
  publishRedemption(bytes: Uint8Array): Promise<void>;
  publishRevocation(bytes: Uint8Array): Promise<void>;
}

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };

export const initializeTargetSecretSourceRecordPublish = async (
  options: TargetSecretSourceRecordPublishOptions = {}
): Promise<TargetSecretSourceRecordPublish> => {
  await initializeTargetSecretSourceFsRead();
  const common = [resolveSpawnfileHome(), resolveAuthHome(), resolveTargetSecretsRoot()];
  const create = (directory: string) => initializeTargetSecretSourceFsPublishImmutable({
    directory_chain: [...common, directory],
    hookForTest: options.hookForTest,
    maxWriteBytesForTest: options.maxWriteBytesForTest
  });
  const [aliases, grants, redemptions, revocations] = await Promise.all([
    create(resolveTargetSecretAliasesDirectory()),
    create(resolveTargetSecretGrantsDirectory()),
    create(resolveTargetSecretRedemptionsDirectory()),
    create(resolveTargetSecretRevocationsDirectory())
  ]);
  return Object.freeze({
    publishAlias: async (bytes: Uint8Array) => {
      try {
        if (!(bytes instanceof Uint8Array)) fail();
        const initial = parseTargetSecretSourceAliasRecordBytesForPublication(bytes);
        await aliases.publishImmutable({
          bytes,
          final_path: resolveTargetSecretAliasPath(initial.source_handle),
          publication_handle: initial.publication_handle,
          proveExact: (exact) => {
            const parsed = parseTargetSecretSourceAliasRecordBytesForPublication(exact);
            if (parsed.source_handle !== initial.source_handle || parsed.publication_handle !== initial.publication_handle) fail();
          }
        });
      } catch { fail(); }
    },
    publishGrant: async (bytes: Uint8Array) => {
      try {
        if (!(bytes instanceof Uint8Array)) fail();
        const initial = parseTargetSecretSourceGrantRecordBytesForPublication(bytes);
        await grants.publishImmutable({
          bytes,
          final_path: resolveTargetSecretGrantPath(initial.source_handle),
          publication_handle: initial.publication_handle,
          proveExact: (exact) => {
            const parsed = parseTargetSecretSourceGrantRecordBytesForPublication(exact);
            if (parsed.source_handle !== initial.source_handle || parsed.publication_handle !== initial.publication_handle) fail();
          }
        });
      } catch { fail(); }
    },
    publishRedemption: async (bytes: Uint8Array) => {
      try {
        if (!(bytes instanceof Uint8Array)) fail();
        const initial = parseTargetSecretSourceRedemptionRecordBytesForPublication(bytes);
        await redemptions.publishImmutable({
          bytes,
          final_path: resolveTargetSecretRedemptionPath(initial.source_handle),
          publication_handle: initial.publication_handle,
          proveExact: (exact) => {
            const parsed = parseTargetSecretSourceRedemptionRecordBytesForPublication(exact);
            if (parsed.source_handle !== initial.source_handle || parsed.publication_handle !== initial.publication_handle) fail();
          }
        });
      } catch { fail(); }
    },
    publishRevocation: async (bytes: Uint8Array) => {
      try {
        if (!(bytes instanceof Uint8Array)) fail();
        const initial = parseTargetSecretSourceRevocationRecordBytesForPublication(bytes);
        await revocations.publishImmutable({
          bytes,
          final_path: resolveTargetSecretRevocationPath(initial.revoked_handle),
          publication_handle: initial.publication_handle,
          proveExact: (exact) => {
            const parsed = parseTargetSecretSourceRevocationRecordBytesForPublication(exact);
            if (parsed.revoked_handle !== initial.revoked_handle || parsed.publication_handle !== initial.publication_handle) fail();
          }
        });
      } catch { fail(); }
    }
  });
};
