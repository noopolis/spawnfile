import { TARGET_SECRET_SOURCE_ERROR, type OpaqueTargetSecretSourceHandle } from "./targetSecretSourceRecordCommon.js";
import {
  initializeTargetSecretSourceFsPublish,
  type TargetSecretSourceFsPublish
} from "./targetSecretSourceFsPublish.js";
import {
  initializeTargetSecretSourceRecordPublish,
  type TargetSecretSourceRecordPublish
} from "./targetSecretSourceRecordPublish.js";
import {
  createTargetSecretSourceAliasRecordBytes,
  createTargetSecretSourceVersionRecordBytes,
  type TargetSecretSourceEntropy
} from "./targetSecretSourceVersionRecords.js";

export interface TargetSecretSourceAuthor {
  authorVersion(secret: Uint8Array): Promise<Readonly<{ source_handle: OpaqueTargetSecretSourceHandle }>>;
}

export interface TargetSecretSourceAuthorOptions {
  readonly aliasEntropy?: TargetSecretSourceEntropy;
  readonly aliasPublicationEntropy?: TargetSecretSourceEntropy;
  readonly recordPublisher?: Pick<TargetSecretSourceRecordPublish, "publishAlias">;
  readonly versionEntropy?: TargetSecretSourceEntropy;
  readonly versionPublicationEntropy?: TargetSecretSourceEntropy;
  readonly versionPublisher?: Pick<TargetSecretSourceFsPublish, "publishVersion">;
}

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };

export const initializeTargetSecretSourceAuthor = async (
  options: TargetSecretSourceAuthorOptions = {}
): Promise<TargetSecretSourceAuthor> => {
  // Both defaults establish and pin the same auth-owned directory hierarchy.
  // Initialize them sequentially so a fresh home has no mkdir election race.
  const versionPublisher = options.versionPublisher ?? await initializeTargetSecretSourceFsPublish();
  const recordPublisher = options.recordPublisher ?? await initializeTargetSecretSourceRecordPublish();
  return Object.freeze({
    authorVersion: async (secret: Uint8Array) => {
      let workingSecret: Uint8Array | undefined;
      let versionBytes: Uint8Array | undefined;
      let aliasBytes: Uint8Array | undefined;
      try {
        if (!(secret instanceof Uint8Array)) fail();
        workingSecret = Uint8Array.from(secret);
        const version = createTargetSecretSourceVersionRecordBytes(workingSecret, {
          entropy: options.versionEntropy,
          publicationEntropy: options.versionPublicationEntropy
        });
        versionBytes = version.private_bytes;
        const alias = createTargetSecretSourceAliasRecordBytes(version.metadata, {
          entropy: options.aliasEntropy,
          publicationEntropy: options.aliasPublicationEntropy
        });
        aliasBytes = alias.private_bytes;
        if (
          alias.metadata.source_handle === version.private_metadata.publication_handle
          || alias.private_metadata.publication_handle === version.private_metadata.publication_handle
        ) fail();

        // Alias publication is the public commit point. A process interruption
        // before it may leave only an unreachable immutable version record.
        await versionPublisher.publishVersion({
          bytes: versionBytes,
          private_metadata: version.private_metadata
        });
        await recordPublisher.publishAlias(aliasBytes);
        return Object.freeze({ source_handle: alias.metadata.source_handle });
      } catch {
        return fail();
      } finally {
        workingSecret?.fill(0);
        versionBytes?.fill(0);
        aliasBytes?.fill(0);
      }
    }
  });
};
