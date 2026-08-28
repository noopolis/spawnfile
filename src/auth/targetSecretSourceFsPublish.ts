import {
  resolveAuthHome,
  resolveSpawnfileHome,
  resolveTargetSecretVersionPath,
  resolveTargetSecretVersionsDirectory,
  resolveTargetSecretsRoot
} from "./paths.js";
import { TARGET_SECRET_SOURCE_ERROR, parseTargetSecretSourceOpaqueHandle } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceFsPublishImmutable, type TargetSecretSourceFsPublishImmutablePhase } from "./targetSecretSourceFsPublishImmutable.js";
import { initializeTargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import {
  parseTargetSecretSourceVersionRecordBytes,
  type TargetSecretSourcePrivateVersionMetadata
} from "./targetSecretSourceVersionRecords.js";

export type TargetSecretSourceFsPublishPhase = TargetSecretSourceFsPublishImmutablePhase;
export interface TargetSecretSourceFsPublishInput {
  readonly bytes: Uint8Array;
  readonly private_metadata: Pick<
    TargetSecretSourcePrivateVersionMetadata,
    "publication_handle" | "source_version_handle"
  >;
}
export interface TargetSecretSourceFsPublishOptions {
  readonly contentionForTest?: (reason: string, attempt: number) => void;
  readonly errorForTest?: (error: unknown) => void;
  readonly hookForTest?: (phase: TargetSecretSourceFsPublishPhase, path: string) => Promise<void> | void;
  readonly maxWriteBytesForTest?: number;
}
export interface TargetSecretSourceFsPublish {
  publishVersion(input: TargetSecretSourceFsPublishInput): Promise<void>;
}

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };

export const initializeTargetSecretSourceFsPublish = async (
  options: TargetSecretSourceFsPublishOptions = {}
): Promise<TargetSecretSourceFsPublish> => {
  await initializeTargetSecretSourceFsRead();
  const publisher = await initializeTargetSecretSourceFsPublishImmutable({
    directory_chain: [
      resolveSpawnfileHome(),
      resolveAuthHome(),
      resolveTargetSecretsRoot(),
      resolveTargetSecretVersionsDirectory()
    ],
    contentionForTest: options.contentionForTest,
    hookForTest: options.hookForTest,
    maxWriteBytesForTest: options.maxWriteBytesForTest
  });
  const publishVersion = async (input: TargetSecretSourceFsPublishInput): Promise<void> => {
    try {
      if (!input || typeof input !== "object" || !(input.bytes instanceof Uint8Array)
        || !input.private_metadata || typeof input.private_metadata !== "object") fail();
      const sourceVersionHandle = parseTargetSecretSourceOpaqueHandle(input.private_metadata.source_version_handle);
      const publicationHandle = parseTargetSecretSourceOpaqueHandle(input.private_metadata.publication_handle);
      if (sourceVersionHandle === publicationHandle) fail();
      await publisher.publishImmutable({
        bytes: input.bytes,
        final_path: resolveTargetSecretVersionPath(sourceVersionHandle),
        publication_handle: publicationHandle,
        proveExact: (bytes) => {
          const parsed = parseTargetSecretSourceVersionRecordBytes(bytes, sourceVersionHandle);
          try {
            if (parsed.publication_handle !== publicationHandle) fail();
          } finally {
            parsed.secret.fill(0);
          }
        }
      });
    } catch (error) {
      options.errorForTest?.(error);
      fail();
    }
  };
  return Object.freeze({ publishVersion });
};
