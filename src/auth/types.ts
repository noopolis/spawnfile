export type ImportedAuthKind = "claude-code" | "codex";

export interface ImportedAuthEntry {
  kind: ImportedAuthKind;
  relativePath: string;
}

export interface AuthProfile {
  env: Record<string, string>;
  imports: Partial<Record<ImportedAuthKind, ImportedAuthEntry>>;
  version: 1;
}

export interface ResolvedAuthProfile {
  authHome: string;
  env: Record<string, string>;
  imports: Partial<Record<ImportedAuthKind, { kind: ImportedAuthKind; path: string }>>;
  name: string;
  profileDirectory: string;
  profilePath: string;
  version: 1;
}
