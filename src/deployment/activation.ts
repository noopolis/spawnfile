import { setTimeout } from "node:timers/promises";
import type { DeploymentActivation } from "./resourceLog.js";

/** Strictly later than the stopped observation, even at millisecond clock resolution. */
export const activationBeforeStart = async (
  stoppedAt: number | undefined, now: () => Date = () => new Date()
): Promise<DeploymentActivation> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const instant = now();
    if (stoppedAt === undefined || instant.getTime() > stoppedAt) {
      return { activated_at: instant.toISOString(), activation_exact: true };
    }
    await setTimeout(1);
  }
  throw new Error("Host clock did not advance after the previous container stopped");
};
