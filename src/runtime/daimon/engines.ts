/** Pinned runtime declaration; shared by compilation and training registration. */
export const DAIMON_ENGINES = ["agy", "codex", "grok"] as const;
export const daimonTrainingDeclaration = { adapterId: 'daimon-native', engines: DAIMON_ENGINES } as const;
