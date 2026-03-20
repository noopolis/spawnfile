# Manifest Guide

This folder owns Spawnfile parsing and validation of user-authored schema.

## Structure

```text
src/manifest/
├── index.ts                  # Barrel for manifest APIs
├── schemas.ts                # Zod schema and manifest type exports
├── skillFrontmatter.ts       # `SKILL.md` frontmatter parsing
├── loadManifest.ts           # YAML loading and local manifest validation
├── schemas.test.ts           # Schema validation tests
├── skillFrontmatter.test.ts  # Skill file parsing tests
└── loadManifest.test.ts      # Manifest loading and validation tests
```

This folder stops at authored-input validation. It should not perform graph resolution or adapter-specific lowering.

## Rules

- Keep parsing separate from compile-time resolution.
- Validate enough here to produce good user errors before graph walking.
- Reflect spec terminology directly in local type names.
