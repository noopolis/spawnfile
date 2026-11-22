import {
  fillMomentVolumes as fillTrialVolumes, type MomentVolume, type TrialDocker
} from "../../../../compiler/training/trial/index.js";
import { DAIMON_ORGANIZATION_UID } from "../../index.js";

export { MOMENT_FILL_PROGRAM, momentVolumesFor, tarOf, type MomentVolume } from "../../../../compiler/training/trial/index.js";

/** Daimon's published helper uses its organization account for every trial volume. */
export function fillMomentVolumes(docker: TrialDocker, image: string, volumes: readonly MomentVolume[]): Promise<void> {
  return fillTrialVolumes(docker, image, volumes, String(DAIMON_ORGANIZATION_UID));
}
