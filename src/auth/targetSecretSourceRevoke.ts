import { TARGET_SECRET_SOURCE_ERROR, parseTargetSecretSourceOpaqueHandle, type OpaqueTargetSecretSourceHandle } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceFsRead, type TargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import {
  createTargetSecretSourceRevocationRecordBytes,
  type TargetSecretSourceEntropy,
  type TargetSecretSourceRevocationRecord
} from "./targetSecretSourceGrantRecords.js";
import { initializeTargetSecretSourceRecordPublish, type TargetSecretSourceRecordPublish } from "./targetSecretSourceRecordPublish.js";
import { deriveTargetSecretSourceOwnerEntropy } from "./targetSecretSourceOwnerEntropy.js";
import { assertTargetSecretSourceAliasCorrelation } from "./targetSecretSourceVersionRecords.js";

type PublicRevocation = Readonly<{ kind: "grant" | "version"; source_handle: OpaqueTargetSecretSourceHandle }>;
export interface TargetSecretSourceRevoke {
  revokeGrant(sourceHandle: unknown): Promise<PublicRevocation>;
  revokeVersion(sourceHandle: unknown): Promise<PublicRevocation>;
}
export interface TargetSecretSourceRevokeOptions {
  readonly entropy?: TargetSecretSourceEntropy;
  readonly publicationEntropy?: TargetSecretSourceEntropy;
  readonly publisher?: Pick<TargetSecretSourceRecordPublish, "publishRevocation">;
  readonly reader?: Pick<TargetSecretSourceFsRead, "readAlias" | "readGrant" | "readRevocation" | "readVersion">;
}

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };

export const initializeTargetSecretSourceRevoke = async (
  options: TargetSecretSourceRevokeOptions = {}
): Promise<TargetSecretSourceRevoke> => {
  const reader = options.reader ?? await initializeTargetSecretSourceFsRead();
  const publisher = options.publisher ?? await initializeTargetSecretSourceRecordPublish();
  const revoke = async (rawSourceHandle: unknown, kind: "grant" | "version"): Promise<PublicRevocation> => {
    let secret: Uint8Array | undefined;
    let privateBytes: Uint8Array | undefined;
    try {
      const sourceHandle = parseTargetSecretSourceOpaqueHandle(rawSourceHandle);
      const alias = await reader.readAlias(sourceHandle);
      if (!alias) return fail();
      const grant = await reader.readGrant(sourceHandle);
      if (kind === "grant" && !grant) return fail();
      const version = await reader.readVersion(alias.source_version_handle);
      if (!version) return fail();
      secret = version.secret;
      assertTargetSecretSourceAliasCorrelation(
        { source_handle: alias.source_handle, source_version_handle: alias.source_version_handle, version: alias.version },
        { source_version_handle: version.source_version_handle, version: version.version }
      );
      if (grant && (grant.source_handle !== alias.source_handle || grant.source_version_handle !== alias.source_version_handle)) fail();
      const associated = [
        alias.publication_handle,
        version.publication_handle,
        ...(grant ? [grant.publication_handle] : [])
      ];
      const associatedPublic = [
        alias.source_handle,
        alias.source_version_handle,
        ...(grant ? [grant.selected_target.handle] : [])
      ];
      if (new Set(associated).size !== associated.length
        || associated.some((handle) => associatedPublic.includes(handle))) fail();
      const revokedHandle = kind === "grant" ? alias.source_handle : alias.source_version_handle;
      const assertExact = (record: TargetSecretSourceRevocationRecord): void => {
        if (record.kind !== kind || record.revoked_handle !== revokedHandle
          || associated.includes(record.revocation_handle)
          || associated.includes(record.publication_handle)
          || associatedPublic.includes(record.revocation_handle)
          || associatedPublic.includes(record.publication_handle)) fail();
      };
      let existing: Awaited<ReturnType<typeof reader.readRevocation>>;
      try { existing = await reader.readRevocation(revokedHandle); } catch { existing = null; }
      if (existing) {
        assertExact(existing);
        return Object.freeze({ kind, source_handle: alias.source_handle });
      }
      const record = createTargetSecretSourceRevocationRecordBytes(
        { kind, revoked_handle: revokedHandle },
        {
          entropy: options.entropy
            ?? (() => deriveTargetSecretSourceOwnerEntropy(
              "revocation.revocation_handle",
              { kind, revoked_handle: revokedHandle }
            )),
          publicationEntropy: options.publicationEntropy
            ?? (() => deriveTargetSecretSourceOwnerEntropy(
              "revocation.publication_handle",
              { kind, revoked_handle: revokedHandle }
            ))
        }
      );
      privateBytes = record.private_bytes;
      assertExact(record.private_metadata);
      try { await publisher.publishRevocation(privateBytes); } catch { /* prove durable winner below */ }
      const joined = await reader.readRevocation(revokedHandle);
      if (!joined) return fail();
      assertExact(joined);
      return Object.freeze({ kind, source_handle: alias.source_handle });
    } catch {
      return fail();
    } finally {
      secret?.fill(0);
      privateBytes?.fill(0);
    }
  };
  return Object.freeze({
    revokeGrant: (sourceHandle: unknown) => revoke(sourceHandle, "grant"),
    revokeVersion: (sourceHandle: unknown) => revoke(sourceHandle, "version")
  });
};
