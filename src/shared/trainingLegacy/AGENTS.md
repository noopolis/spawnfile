# Training legacy compatibility

Owns the shared runtime-neutral readers for historical wire IDs, environment names,
filenames and frozen content-addressing domains. Public entry point: index.ts.

- trainingLegacyWire.ts and its JSON table own exact discriminator aliases.
- trainingLegacyEnvironment.ts owns environment normalization and warnings.
- trainingLegacyFiles.ts owns legacy filename conflicts and bounded file reads.
- trainingLegacyHashDomains.ts pins pre-rename hash inputs and the old cache root.
- Adjacent tests cover accepted legacy inputs and rejected malformed data.

Keep this module independent of runtime, compiler and the parent shared barrel.
Frozen identities include model prompt versions and canary bytes; wire writers keep current wire IDs.
Project only owned schema fields into hash views; never rewrite user content recursively.

- trainingLegacyGraderProviders.ts preserves authored council keys and teacher policy bytes after provider registration becomes external.
- The subscription secret-environment exclusion pattern remains exact compatibility data; never relax credential stripping during provider extraction.
