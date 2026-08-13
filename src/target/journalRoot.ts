import path from "node:path";

import { resolveSpawnfileHome } from "../auth/paths.js";

/** Legacy provider-neutral journal root used by the public journal API. */
export const resolveTargetJournalRoot = (): string =>
  path.join(resolveSpawnfileHome(), "target-journals");

/** Production target-owner journal root, resolved without loading provider configuration. */
export const resolveTargetDefaultJournalRoot = (): string =>
  path.join(resolveSpawnfileHome(), "target", "journals");
