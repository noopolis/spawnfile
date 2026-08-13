export interface EvidenceExportPublicationOptions {
  readonly beforeImmutableTempOpen?: (temporary: string) => Promise<void>;
  readonly afterImmutableTempIdentity?: (temporary: string) => Promise<void>;
  readonly afterImmutableFinalLinkBeforeTempUnlink?: () => Promise<void>;
  readonly beforeDestinationKeyTempOpen?: (temporary: string) => Promise<void>;
  readonly afterDestinationKeyTempIdentity?: (temporary: string) => Promise<void>;
  readonly afterImmutableTransientRead?: () => Promise<void>;
  readonly beforeDestinationKeyLink?: () => Promise<void>;
  readonly afterDestinationKeyInitialFinalAbsent?: () => Promise<void>;
  readonly afterDestinationKeyLinkBeforePendingUnlink?: () => Promise<void>;
  readonly afterDestinationKeyPendingLinkBeforeTempUnlink?: () => Promise<void>;
  readonly afterDestinationKeyPendingLstatBeforeOpen?: () => Promise<void>;
  readonly afterDestinationKeyPendingLink?: () => Promise<void>;
  readonly afterDestinationKeyRecovered?: () => Promise<void>;
  readonly afterDestinationKeyFinalSnapshot?: () => Promise<void>;
}
