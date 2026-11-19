import { SpawnfileError } from "../../../shared/index.js";
import { TRAINING_MOMENT_VERSION, trainingMomentSchema } from "../moments.js";

/** A moment record's only setup is its moment, validated before any trial boots. */
export const momentPreparation = {
  version: TRAINING_MOMENT_VERSION,
  unlockedPaths: ["moment"],
  validate: (parameters: Readonly<Record<string, unknown>>, at: string): void => {
    const extra = Object.keys(parameters).filter((key) => key !== "moment");
    if (extra.length) throw new SpawnfileError("validation_error", `${at}: a moment record sets only setup.moment (${extra.join(", ")})`);
    const parsed = trainingMomentSchema.safeParse(parameters.moment);
    if (!parsed.success) throw new SpawnfileError("validation_error", `${at}.moment: ${parsed.error.issues[0]?.message ?? "invalid moment"}`);
  }
};
