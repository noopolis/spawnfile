import path from "node:path/posix";

import { z } from "zod";

import { SpawnfileError } from "../../shared/index.js";
import type { RuntimeReadinessOperations } from "../operations.js";

export const DAIMON_RUNTIME_ACCEPTANCE_STORE_DIRECTORY = "state/wake-acceptance";
export const daimonReadinessReceiptPath = (instanceRoot: string): string =>
  path.join(instanceRoot, DAIMON_RUNTIME_ACCEPTANCE_STORE_DIRECTORY, "runtime-readiness.json");

const agentSchema = z.object({ agent_id: z.string(), engine: z.string() }).strict();
const receiptSchema = z.object({
  version: z.literal("noopolis.daimon.readiness-receipt.v1"),
  agents: z.array(agentSchema)
}).strict();

export const daimonReadiness: RuntimeReadinessOperations = {
  compileEvidence(instance) {
    const expected = Object.entries(instance.engine_by_node_id ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agent_id, engine]) => ({ agent_id, engine }));
    if (expected.length === 0) {
      throw new SpawnfileError("compile_error", "organization readiness evidence is inconsistent: Daimon readiness has no compiled agent engines");
    }
    const instanceRoot = path.dirname(path.dirname(instance.config_path));
    return { receiptPath: daimonReadinessReceiptPath(instanceRoot), expected };
  },
  validateReceipt(expected, receipt) {
    try {
      const parsed = receiptSchema.safeParse(JSON.parse(receipt));
      return parsed.success && JSON.stringify(parsed.data.agents) === JSON.stringify(expected);
    } catch {
      return false;
    }
  }
};
