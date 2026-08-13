import path from "node:path";

import { resolveSpawnfileHome } from "../auth/index.js";
import { SpawnfileError } from "../shared/index.js";
import { lifecycleIdSchema } from "./lifecycleCompletionContracts.js";

export const failLifecycleStore = (message: string): never => {
  throw new SpawnfileError(
    "runtime_error",
    `Lifecycle completion store refused: ${message}`
  );
};

export const resolveLifecycleCompletionDirectory = (): string =>
  path.join(resolveSpawnfileHome(), "lifecycle-completions");

export const lifecycleRecordName = (
  id: string,
  kind: "admission" | "completion" | "evidence" | "plan" | "recovery"
): string => `${lifecycleIdSchema.parse(id)}.${kind}`;

const lifecyclePath = (
  id: string,
  kind: "admission" | "completion" | "evidence" | "plan" | "recovery"
): string => path.join(resolveLifecycleCompletionDirectory(), lifecycleRecordName(id, kind));

export const resolveLifecycleCompletionPath = (id: string): string =>
  lifecyclePath(id, "completion");
export const admissionPath = (id: string): string => lifecyclePath(id, "admission");
export const planPath = (id: string): string => lifecyclePath(id, "plan");
export const recoveryPath = (id: string): string => lifecyclePath(id, "recovery");
export const evidencePath = (id: string): string => lifecyclePath(id, "evidence");
export const heartbeatPath = (id: string): string =>
  path.join(resolveLifecycleCompletionDirectory(), `${lifecycleIdSchema.parse(id)}.heartbeat`);
