import { z } from "zod";

/**
 * `spawnfile.export-index.v1` — the machine contract `spawnfile artifacts
 * export` writes at `<out>/spawnfile/export-index.json` (contracts.md's
 * Spawnfile export-index registry row; Decision 21's Piece 3). It is the
 * only artifact `simfile observe` needs from spawnfile beyond the raw files
 * themselves: a manifest of what was exported, from where, and its content
 * hash, so a future `simfile.run-manifest.v1` can fold `files` straight into
 * its own `artifacts` array (same `{path, sha256}` shape — see
 * `ecosystem/simfile/src/observe/manifest.ts`) without re-deriving anything.
 *
 * `sha256` is a bare 64-character lowercase hex digest (no `sha256:`
 * prefix), matching `simfile.run-manifest.v1`'s `artifacts[].sha256` exactly
 * — this is deliberate so folding this index into that manifest is a
 * straight copy, never a reformat.
 */
export const EXPORT_INDEX_VERSION = "spawnfile.export-index.v1" as const;

const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "sha256 must be a 64-character lowercase hex digest");

const exportSourceSchema = z
  .object({
    kind: z.union([z.literal("volume"), z.literal("container")]),
    ref: z.string().min(1)
  })
  .strict();

export type ExportIndexSource = z.infer<typeof exportSourceSchema>;

const exportIndexFileSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256HexSchema,
    bytes: z.number().int().nonnegative(),
    source: exportSourceSchema
  })
  .strict();

export type ExportIndexFile = z.infer<typeof exportIndexFileSchema>;

export const exportIndexSchema = z
  .object({
    version: z.literal(EXPORT_INDEX_VERSION),
    run_id: z.string().min(1),
    deployment: z.string().min(1),
    exported_at: z.string().min(1),
    files: z.array(exportIndexFileSchema)
  })
  .strict();

export type ExportIndex = z.infer<typeof exportIndexSchema>;

export const parseExportIndex = (raw: unknown): ExportIndex => {
  const result = exportIndexSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `invalid ${EXPORT_INDEX_VERSION}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return result.data;
};
