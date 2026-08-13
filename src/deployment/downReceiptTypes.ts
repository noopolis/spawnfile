import { z } from "zod";

/**
 * `spawnfile.down-receipt.v1` — the machine contract `spawnfile down --json` writes to
 * stdout (contracts.md's Spawnfile down-receipt registry row; Decision 21's Piece 4).
 * `units_stopped` names the deployment record's own unit ids (`record.ts`'s
 * `unit.id`, e.g. `"<deployment>-container"`), not raw Docker container ids, so a caller
 * can cross-reference the up-receipt/deployment record without re-deriving anything.
 * `retained_volumes` is "named volumes still present on disk after this call returns" —
 * true whether they were never touched (the default) or survived an attempted
 * `--volumes` removal that failed (surfaced in `errors`, not silently dropped).
 */
export const DOWN_RECEIPT_VERSION = "spawnfile.down-receipt.v1" as const;

export const downReceiptSchema = z
  .object({
    version: z.literal(DOWN_RECEIPT_VERSION),
    deployment: z.string().min(1),
    units_stopped: z.array(z.string().min(1)),
    retained_volumes: z.array(z.string().min(1)),
    errors: z.array(z.string().min(1))
  })
  .strict();

export type DownReceipt = z.infer<typeof downReceiptSchema>;

export const parseDownReceipt = (raw: unknown): DownReceipt => {
  const result = downReceiptSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `invalid ${DOWN_RECEIPT_VERSION}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return result.data;
};
