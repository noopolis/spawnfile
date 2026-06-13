# Distribution Guide

This folder owns the distribution report and image-contract artifacts for published Spawnfile images, per `DISTRIBUTION.md` and `specs/DISTRIBUTION.md`.

## Structure

```text
src/distribution/
├── index.ts                     # Barrel for distribution exports
├── types.ts                     # Distribution report schema and image-contract constants
├── buildDistributionReport.ts   # Pure report builder and image-label factory
├── fingerprint.ts               # Stable compile fingerprint over the path-free report
├── projectName.ts               # Manifest-name to label-slug normalization
└── *.test.ts                    # Tests next to the modules they cover
```

## Rules

- The distribution report is the public interface of a published image. It must stay secret-free (names only, never values) and creator-host-path-free (no project roots, output directories, or node source paths). Tests enforce both.
- This folder is pure: no filesystem access, no compiler imports. The compiler projects its plan/report data into the structural input types defined here.
- The fingerprint is computed over the report body excluding `generated_at`, so identical compiles fingerprint identically across machines and times.
- Frozen contract values (`spawnfile.distribution-report.v1`, `spawnfile.image.v1`, the in-image report path) live in `types.ts` and change only with a contract version bump.
