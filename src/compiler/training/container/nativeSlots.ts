import { assertTrainingSlotCount, TRAINING_PORT_BASE, TRAINING_PORT_STRIDE } from "../broker/paths.js";

/** Native trials keep fresh per-trial roots; only their port blocks are provisioned. */
export const nativeTrainingSlotsDocument = (slots: number, workerUid: number) => {
  if (!Number.isInteger(workerUid) || workerUid <= 0 || workerUid > 4_294_967_294) throw Error("Native slots require a non-root worker uid");
  return {
    schema: "spawnfile.training-slots.v2" as const,
    slots: Array.from({ length: assertTrainingSlotCount(slots) }, (_, index) => ({
      index, workerUid, isolation: "shared-uid" as const, roots: {},
      ports: { base: TRAINING_PORT_BASE + index * TRAINING_PORT_STRIDE, count: TRAINING_PORT_STRIDE }
    }))
  };
};
