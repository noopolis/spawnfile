import { z } from "zod";

/**
 * `spawnfile.down-receipt.v1` — the machine contract `spawnfile down --json` writes to
 * stdout (contracts.md's Spawnfile down-receipt registry row; Decision 21's Piece 4).
 * `units_stopped` names the deployment record's own unit ids (`record.ts`'s
 * `unit.id`, e.g. `"<deployment>-container"`), not raw Docker container ids, so a caller
 * can cross-reference the up-receipt/deployment record without re-deriving anything.
 * `retained_volumes` is "named volumes still present on disk after this call returns" —
 * true whether they were never touched (the default), survived an attempted
 * `--volumes` removal that failed (surfaced in `errors`, not silently dropped), or
 * were deliberately skipped as shared project state (`skipped_volumes`).
 *
 * `skipped_volumes` is the third outcome this contract originally could not express.
 * An author-declared volume name (a workspace resource `name`, a
 * `store.persistence.name`, a memory bank's `persistence.name`) is verbatim in every
 * mode and every deployment, so it is NOT "this deployment's named volume" — a
 * `down --volumes` of a dev or scratch deployment would otherwise destroy the
 * production state that same name refers to, whenever production happens to be
 * stopped (Docker only refuses a volume that is currently in use). Those volumes are
 * skipped, listed here AND in `retained_volumes`, and removing one is a deliberate
 * project-level act: `docker volume rm <name>`.
 *
 * The field is OMITTED when nothing was skipped, so every receipt that could be
 * produced before this existed is still byte-identical.
 */
export const DOWN_RECEIPT_VERSION = "spawnfile.down-receipt.v1" as const;

export const downReceiptSchema = z
  .object({
    version: z.literal(DOWN_RECEIPT_VERSION),
    deployment: z.string().min(1),
    units_stopped: z.array(z.string().min(1)),
    retained_volumes: z.array(z.string().min(1)),
    skipped_volumes: z.array(z.string().min(1)).optional(),
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
