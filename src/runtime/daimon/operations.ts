import type { RuntimeOperations } from "../operations.js";
import { daimonDrain } from "./drain.js";
import { daimonReadiness } from "./readiness.js";
import { daimonRecording } from "./recording.js";
import { daimonUsage, planDaimonFiles, planDaimonPrivateDirectories } from "./artifactEvidence.js";

export const daimonOperations: RuntimeOperations = {
  drain: daimonDrain,
  readiness: daimonReadiness,
  recording: daimonRecording,
  exportFiles: planDaimonFiles,
  privateExportDirectories: planDaimonPrivateDirectories,
  usage: daimonUsage
};
