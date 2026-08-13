import {
  MAX_TARGET_SECRET_SOURCE_SECRET_BYTES,
  TARGET_SECRET_SOURCE_ERROR,
  parseTargetSecretSourceOpaqueHandle,
  type OpaqueTargetSecretSourceHandle
} from "./targetSecretSourceRecordCommon.js";
import { initializeTargetSecretSourceAuthor, type TargetSecretSourceAuthor } from "./targetSecretSourceAuthor.js";
import { initializeTargetSecretSourceFsRead, type TargetSecretSourceFsRead } from "./targetSecretSourceFsRead.js";
import { initializeTargetSecretSourceGrant, type TargetSecretSourceGrant } from "./targetSecretSourceGrant.js";
import { assertTargetSecretSourceAliasCorrelation } from "./targetSecretSourceVersionRecords.js";

export type TargetSecretSourceRotateInput = Readonly<{ secret: Uint8Array; source_handle: unknown }>;
export interface TargetSecretSourceRotate {
  rotateSource(input: TargetSecretSourceRotateInput): Promise<Readonly<{ source_handle: OpaqueTargetSecretSourceHandle }>>;
}
export interface TargetSecretSourceRotateOptions {
  readonly author?: TargetSecretSourceAuthor;
  readonly grant?: TargetSecretSourceGrant;
  readonly reader?: Pick<TargetSecretSourceFsRead, "readAlias" | "readGrant" | "readRevocation" | "readVersion">;
}

const fail = (): never => { throw new Error(TARGET_SECRET_SOURCE_ERROR); };

export const initializeTargetSecretSourceRotate = async (
  options: TargetSecretSourceRotateOptions = {}
): Promise<TargetSecretSourceRotate> => {
  const reader = options.reader ?? await initializeTargetSecretSourceFsRead();
  const author = options.author ?? await initializeTargetSecretSourceAuthor();
  const grantService = options.grant ?? await initializeTargetSecretSourceGrant();
  return Object.freeze({
    rotateSource: async (input: TargetSecretSourceRotateInput) => {
      let oldSecret: Uint8Array | undefined;
      let newSecretRead: Uint8Array | undefined;
      let newSecret: Uint8Array | undefined;
      try {
        const sourceHandle = parseTargetSecretSourceOpaqueHandle(input?.source_handle);
        if (!(input?.secret instanceof Uint8Array)
          || input.secret.length === 0
          || input.secret.length > MAX_TARGET_SECRET_SOURCE_SECRET_BYTES) fail();
        newSecret = Uint8Array.from(input.secret);
        const requestedSecret = newSecret;
        const alias = await reader.readAlias(sourceHandle);
        if (!alias) return fail();
        const grant = await reader.readGrant(sourceHandle);
        if (!grant) return fail();
        const version = await reader.readVersion(alias.source_version_handle);
        if (!version) return fail();
        oldSecret = version.secret;
        assertTargetSecretSourceAliasCorrelation(
          { source_handle: alias.source_handle, source_version_handle: alias.source_version_handle, version: alias.version },
          { source_version_handle: version.source_version_handle, version: version.version }
        );
        if (grant.source_handle !== alias.source_handle || grant.source_version_handle !== alias.source_version_handle) fail();
        const associatedPrivate = [alias.publication_handle, grant.publication_handle, version.publication_handle];
        if (new Set(associatedPrivate).size !== associatedPrivate.length
          || associatedPrivate.includes(alias.source_handle)
          || associatedPrivate.includes(alias.source_version_handle)
          || associatedPrivate.includes(grant.selected_target.handle)) fail();
        const assertOldActive = async (): Promise<void> => {
          const [grantRevocation, versionRevocation] = await Promise.all([
            reader.readRevocation(alias.source_handle),
            reader.readRevocation(alias.source_version_handle)
          ]);
          if (grantRevocation || versionRevocation) fail();
        };
        await assertOldActive();

        const authored = await author.authorVersion(newSecret);
        const authoredSourceHandle = parseTargetSecretSourceOpaqueHandle(authored.source_handle);
        const granted = await grantService.grantSource({
          descriptor_digest: grant.descriptor_digest,
          name: grant.name,
          run_id: grant.run_id,
          scope: grant.scope,
          selected_target: grant.selected_target,
          source_handle: authoredSourceHandle
        });
        const grantedSourceHandle = parseTargetSecretSourceOpaqueHandle(granted.source_handle);
        if (grantedSourceHandle !== authoredSourceHandle) fail();
        const newAlias = await reader.readAlias(authoredSourceHandle);
        if (!newAlias) return fail();
        const newGrant = await reader.readGrant(authoredSourceHandle);
        if (!newGrant) return fail();
        const newVersion = await reader.readVersion(newAlias.source_version_handle);
        if (!newVersion) return fail();
        newSecretRead = newVersion.secret;
        if (newSecretRead.length !== requestedSecret.length
          || newSecretRead.some((byte, index) => byte !== requestedSecret[index])) fail();
        assertTargetSecretSourceAliasCorrelation(
          { source_handle: newAlias.source_handle, source_version_handle: newAlias.source_version_handle, version: newAlias.version },
          { source_version_handle: newVersion.source_version_handle, version: newVersion.version }
        );
        if (newAlias.source_handle !== authoredSourceHandle
          || newGrant.source_handle !== newAlias.source_handle
          || newGrant.source_version_handle !== newAlias.source_version_handle
          || newGrant.descriptor_digest !== grant.descriptor_digest
          || newGrant.name !== grant.name
          || newGrant.run_id !== grant.run_id
          || newGrant.scope !== grant.scope
          || newGrant.selected_target.fingerprint !== grant.selected_target.fingerprint
          || newGrant.selected_target.handle !== grant.selected_target.handle
          || newGrant.selected_target.version !== grant.selected_target.version) fail();
        const newPrivate = [newAlias.publication_handle, newGrant.publication_handle, newVersion.publication_handle];
        const allPrivate = [...associatedPrivate, ...newPrivate];
        const allPublic = [
          alias.source_handle, alias.source_version_handle,
          newAlias.source_handle, newAlias.source_version_handle,
          grant.selected_target.handle
        ];
        if (new Set(allPrivate).size !== allPrivate.length
          || new Set(allPublic).size !== allPublic.length
          || allPrivate.some((handle) => allPublic.includes(handle))) fail();
        const [oldGrantRevocation, oldVersionRevocation, newGrantRevocation, newVersionRevocation] = await Promise.all([
          reader.readRevocation(alias.source_handle),
          reader.readRevocation(alias.source_version_handle),
          reader.readRevocation(newAlias.source_handle),
          reader.readRevocation(newAlias.source_version_handle)
        ]);
        if (oldGrantRevocation || oldVersionRevocation || newGrantRevocation || newVersionRevocation) fail();
        return Object.freeze({ source_handle: authoredSourceHandle });
      } catch {
        return fail();
      } finally {
        oldSecret?.fill(0);
        newSecretRead?.fill(0);
        newSecret?.fill(0);
      }
    }
  });
};
