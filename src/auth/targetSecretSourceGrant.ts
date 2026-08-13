import { TARGET_SECRET_SOURCE_ERROR, type OpaqueTargetSecretSourceHandle } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceFsRead, type TargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import {
  createTargetSecretSourceGrantRecordBytes,
  createTargetSecretSourceGrantMetadata,
  type TargetSecretSourceEntropy,
  type TargetSecretSourceGrantMetadata
} from "./targetSecretSourceGrantRecords.js";
import {
  initializeTargetSecretSourceRecordPublish,
  type TargetSecretSourceRecordPublish
} from "./targetSecretSourceRecordPublish.js";
import { deriveTargetSecretSourceOwnerEntropy } from "./targetSecretSourceOwnerEntropy.js";
import { assertTargetSecretSourceAliasCorrelation } from "./targetSecretSourceVersionRecords.js";

export type TargetSecretSourceGrantInput = Readonly<
  Omit<TargetSecretSourceGrantMetadata, "source_version_handle" | "version">
>;
export interface TargetSecretSourceGrant {
  grantSource(input: TargetSecretSourceGrantInput): Promise<Readonly<{ source_handle: OpaqueTargetSecretSourceHandle }>>;
}
export interface TargetSecretSourceGrantOptions {
  readonly publicationEntropy?: TargetSecretSourceEntropy;
  readonly publisher?: Pick<TargetSecretSourceRecordPublish, "publishGrant">;
  readonly reader?: Pick<TargetSecretSourceFsRead, "readAlias" | "readGrant" | "readRevocation" | "readVersion">;
}

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const sameGrant = (left: TargetSecretSourceGrantMetadata, right: TargetSecretSourceGrantMetadata): boolean =>
  left.descriptor_digest === right.descriptor_digest
  && left.name === right.name
  && left.run_id === right.run_id
  && left.scope === right.scope
  && left.source_handle === right.source_handle
  && left.source_version_handle === right.source_version_handle
  && left.selected_target.fingerprint === right.selected_target.fingerprint
  && left.selected_target.handle === right.selected_target.handle
  && left.selected_target.version === right.selected_target.version;

export const initializeTargetSecretSourceGrant = async (
  options: TargetSecretSourceGrantOptions = {}
): Promise<TargetSecretSourceGrant> => {
  const reader = options.reader ?? await initializeTargetSecretSourceFsRead();
  const publisher = options.publisher ?? await initializeTargetSecretSourceRecordPublish();
  return Object.freeze({
    grantSource: async (input: TargetSecretSourceGrantInput) => {
      let versionSecret: Uint8Array | undefined;
      let grantBytes: Uint8Array | undefined;
      try {
        const alias = await reader.readAlias(input?.source_handle);
        if (!alias) return fail();
        const version = await reader.readVersion(alias.source_version_handle);
        if (!version) return fail();
        versionSecret = version.secret;
        const aliasMetadata = {
          source_handle: alias.source_handle,
          source_version_handle: alias.source_version_handle,
          version: alias.version
        } as const;
        const versionMetadata = {
          source_version_handle: version.source_version_handle,
          version: version.version
        } as const;
        assertTargetSecretSourceAliasCorrelation(aliasMetadata, versionMetadata);
        if (alias.publication_handle === version.publication_handle) fail();
        const assertNotRevoked = async (): Promise<void> => {
          const [grantRevocation, versionRevocation] = await Promise.all([
            reader.readRevocation(alias.source_handle),
            reader.readRevocation(alias.source_version_handle)
          ]);
          if (grantRevocation || versionRevocation) fail();
        };
        await assertNotRevoked();

        const expected = createTargetSecretSourceGrantMetadata({
          ...input,
          source_handle: alias.source_handle,
          source_version_handle: alias.source_version_handle
        });

        let existing: Awaited<ReturnType<typeof reader.readGrant>>;
        try { existing = await reader.readGrant(alias.source_handle); } catch { existing = null; }
        if (existing) {
          if (!sameGrant(existing, expected)) fail();
          await assertNotRevoked();
          return Object.freeze({ source_handle: alias.source_handle });
        }
        const { version: _grantVersion, ...grantInput } = expected;
        const grant = createTargetSecretSourceGrantRecordBytes(grantInput, {
          publicationEntropy: options.publicationEntropy
            ?? (() => deriveTargetSecretSourceOwnerEntropy("grant.publication_handle", expected))
        });
        grantBytes = grant.private_bytes;
        if (grant.private_metadata.publication_handle === alias.publication_handle
          || grant.private_metadata.publication_handle === version.publication_handle) fail();
        try { await publisher.publishGrant(grantBytes); } catch { /* prove the durable result below */ }
        const joined = await reader.readGrant(alias.source_handle);
        if (!joined || !sameGrant(joined, grant.metadata)) fail();
        await assertNotRevoked();
        return Object.freeze({ source_handle: alias.source_handle });
      } catch {
        return fail();
      } finally {
        versionSecret?.fill(0);
        grantBytes?.fill(0);
      }
    }
  });
};
