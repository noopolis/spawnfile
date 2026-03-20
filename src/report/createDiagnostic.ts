import { DiagnosticReport } from "./types.js";

export const createDiagnostic = (
  level: DiagnosticReport["level"],
  message: string
): DiagnosticReport => ({
  level,
  message
});
