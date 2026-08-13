import {
  parseTargetSecretSourceAuthorization,
  type TargetSecretSourceAuthorization
} from "../target/dockerSecretsAuthority.js";
import {
  type TargetSecretSourceResolution,
  type TargetSecretSourceResolver,
  type TargetSecretSourceResolverInput
} from "../target/dockerSecrets.js";
import { TARGET_SECRET_SOURCE_ERROR } from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceFsRead, type TargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import {
  assertTargetSecretSourceRedemptionCorrelation,
  createTargetSecretSourceRedemptionMetadata,
  createTargetSecretSourceRedemptionRecordBytes,
  type TargetSecretSourceEntropy,
  type TargetSecretSourceRedemptionMetadata
} from "./targetSecretSourceGrantRecords.js";
import {
  initializeTargetSecretSourceRecordPublish,
  type TargetSecretSourceRecordPublish
} from "./targetSecretSourceRecordPublish.js";
import { deriveTargetSecretSourceOwnerEntropy } from "./targetSecretSourceOwnerEntropy.js";
import { assertTargetSecretSourceAliasCorrelation } from "./targetSecretSourceVersionRecords.js";

export interface TargetSecretSourceResolverOptions {
  readonly publicationEntropy?: TargetSecretSourceEntropy;
  readonly publisher?: Pick<TargetSecretSourceRecordPublish, "publishRedemption">;
  readonly reader?: Pick<
    TargetSecretSourceFsRead,
    "readAlias" | "readGrant" | "readRedemption" | "readRevocation" | "readVersion"
  >;
}

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };
const sameRedemption = (
  left: TargetSecretSourceRedemptionMetadata,
  right: TargetSecretSourceRedemptionMetadata
): boolean => left.source_handle === right.source_handle
  && left.source_version_handle === right.source_version_handle
  && left.authorization.descriptorDigest === right.authorization.descriptorDigest
  && left.authorization.name === right.authorization.name
  && left.authorization.operationHandle === right.authorization.operationHandle
  && left.authorization.requestDigest === right.authorization.requestDigest
  && left.authorization.runId === right.authorization.runId
  && left.authorization.scope === right.authorization.scope
  && left.authorization.sourceHandle === right.authorization.sourceHandle
  && left.authorization.selectedTarget.fingerprint === right.authorization.selectedTarget.fingerprint
  && left.authorization.selectedTarget.handle === right.authorization.selectedTarget.handle
  && left.authorization.version === right.authorization.version;

export const initializeTargetSecretSourceResolver = async (
  options: TargetSecretSourceResolverOptions = {}
): Promise<TargetSecretSourceResolver> => {
  const reader = options.reader ?? await initializeTargetSecretSourceFsRead();
  const publisher = options.publisher ?? await initializeTargetSecretSourceRecordPublish();
  return Object.freeze({
    resolve: async (input: TargetSecretSourceResolverInput): Promise<TargetSecretSourceResolution> => {
      let secret: Uint8Array | undefined;
      let redemptionBytes: Uint8Array | undefined;
      try {
        if (input?.signal?.aborted) fail();
        const authorization: TargetSecretSourceAuthorization = parseTargetSecretSourceAuthorization(input?.authorization);
        const alias = await reader.readAlias(authorization.sourceHandle);
        if (!alias) return fail();
        const grant = await reader.readGrant(alias.source_handle);
        if (!grant) return fail();
        const version = await reader.readVersion(alias.source_version_handle);
        if (!version) return fail();
        secret = version.secret;

        assertTargetSecretSourceAliasCorrelation(
          { source_handle: alias.source_handle, source_version_handle: alias.source_version_handle, version: alias.version },
          { source_version_handle: version.source_version_handle, version: version.version }
        );
        if (grant.source_handle !== alias.source_handle || grant.source_version_handle !== alias.source_version_handle) fail();
        const associatedPrivateHandles = [alias.publication_handle, grant.publication_handle, version.publication_handle];
        if (new Set(associatedPrivateHandles).size !== associatedPrivateHandles.length
          || associatedPrivateHandles.includes(alias.source_handle)
          || associatedPrivateHandles.includes(alias.source_version_handle)
          || associatedPrivateHandles.includes(authorization.operationHandle)
          || associatedPrivateHandles.includes(authorization.selectedTarget.handle)) fail();
        const assertRedemptionPublicationDistinct = (publicationHandle: typeof alias.publication_handle): void => {
          if (associatedPrivateHandles.includes(publicationHandle)) fail();
        };
        const grantMetadata = {
          descriptor_digest: grant.descriptor_digest,
          name: grant.name,
          run_id: grant.run_id,
          scope: grant.scope,
          selected_target: grant.selected_target,
          source_handle: grant.source_handle,
          source_version_handle: grant.source_version_handle,
          version: grant.version
        } as const;
        const assertAdmissible = async (): Promise<void> => {
          const [grantRevocation, versionRevocation] = await Promise.all([
            reader.readRevocation(alias.source_handle),
            reader.readRevocation(alias.source_version_handle)
          ]);
          if (grantRevocation || versionRevocation || input.signal?.aborted) fail();
        };
        await assertAdmissible();

        const expected = createTargetSecretSourceRedemptionMetadata(grantMetadata, authorization);
        let existing: Awaited<ReturnType<typeof reader.readRedemption>>;
        try { existing = await reader.readRedemption(alias.source_handle); } catch { existing = null; }
        if (existing) {
          assertRedemptionPublicationDistinct(existing.publication_handle);
          const existingMetadata = {
            authorization: existing.authorization,
            source_handle: existing.source_handle,
            source_version_handle: existing.source_version_handle,
            version: existing.version
          } as const;
          assertTargetSecretSourceRedemptionCorrelation(existingMetadata, grantMetadata);
          if (!sameRedemption(existing, expected)) fail();
        } else {
          const redemption = createTargetSecretSourceRedemptionRecordBytes(grantMetadata, expected.authorization, {
            publicationEntropy: options.publicationEntropy
              ?? (() => deriveTargetSecretSourceOwnerEntropy("redemption.publication_handle", expected))
          });
          redemptionBytes = redemption.private_bytes;
          assertRedemptionPublicationDistinct(redemption.private_metadata.publication_handle);
          try { await publisher.publishRedemption(redemptionBytes); } catch { /* prove the durable winner below */ }
          const joined = await reader.readRedemption(alias.source_handle);
          if (!joined) return fail();
          assertRedemptionPublicationDistinct(joined.publication_handle);
          assertTargetSecretSourceRedemptionCorrelation({
            authorization: joined.authorization,
            source_handle: joined.source_handle,
            source_version_handle: joined.source_version_handle,
            version: joined.version
          }, grantMetadata);
          if (!sameRedemption(joined, expected)) fail();
        }
        await assertAdmissible();
        const value = secret;
        secret = undefined;
        return Object.freeze({
          authorization: expected.authorization,
          sourceVersionHandle: expected.source_version_handle,
          value
        });
      } catch {
        return fail();
      } finally {
        secret?.fill(0);
        redemptionBytes?.fill(0);
      }
    }
  });
};
