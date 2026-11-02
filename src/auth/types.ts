export type ImportedAuthKind = "claude-code" | "codex" | "grok";

export interface ImportedAuthEntry {
  kind: ImportedAuthKind;
  relativePath: string;
}

/**
 * A login that lives in Docker volumes rather than an importable file: the
 * engine's durable realm volume, the volume holding its unlock secret, and the
 * volume holding the engine's login files from its runtime home (seeded into
 * each fresh home at boot, written back after the container stops).
 * Created once by `spawnfile auth login <engine>`; the profile records names only.
 */
export interface SubscriptionRealmBinding {
  realmVolume: string;
  unlockVolume: string;
  /** Absent on a login recorded before home login files were kept: log in again. */
  homeVolume?: string;
}

export interface AuthProfile {
  env: Record<string, string>;
  imports: Partial<Record<ImportedAuthKind, ImportedAuthEntry>>;
  realms?: Record<string, SubscriptionRealmBinding>;
  version: 1;
}

export interface ResolvedAuthProfile {
  authHome: string;
  env: Record<string, string>;
  imports: Partial<Record<ImportedAuthKind, { kind: ImportedAuthKind; path: string }>>;
  name: string;
  profileDirectory: string;
  profilePath: string;
  /** Volume-held logins by engine id; absent means none. */
  realms?: Record<string, SubscriptionRealmBinding>;
  version: 1;
}
