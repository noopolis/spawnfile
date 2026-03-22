# Manifest Guide

This folder owns Spawnfile parsing and validation of user-authored schema.

## Structure

```text
src/manifest/
├── index.ts                  # Barrel for manifest APIs
├── schemas.ts                # Zod schema and manifest type exports
├── scaffold.ts               # Typed manifest scaffold builders
├── renderSpawnfile.ts        # YAML rendering for authored Spawnfiles
├── skillFrontmatter.ts       # `SKILL.md` frontmatter parsing
├── loadManifest.ts           # YAML loading and local manifest validation
├── scaffold.test.ts          # Scaffold builder tests
├── renderSpawnfile.test.ts   # Manifest render tests
├── schemas.test.ts           # Schema validation tests
├── skillFrontmatter.test.ts  # Skill file parsing tests
└── loadManifest.test.ts      # Manifest loading and validation tests
```

This folder stops at authored-input validation. It should not perform graph resolution or adapter-specific lowering.

## Rules

- Keep parsing separate from compile-time resolution.
- Keep authored manifest rendering and scaffold builders generic; runtime-specific choices stay outside this folder.
- Validate enough here to produce good user errors before graph walking.
- Reflect spec terminology directly in local type names.
