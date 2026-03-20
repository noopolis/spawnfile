import path from "node:path";

import { ensureDirectory, writeUtf8File } from "../filesystem/index.js";
import { REPORT_FILENAME } from "../shared/index.js";
import { CompileReport } from "./types.js";

export const writeCompileReport = async (
  outputDirectory: string,
  report: CompileReport
): Promise<string> => {
  await ensureDirectory(outputDirectory);
  const reportPath = path.join(outputDirectory, REPORT_FILENAME);
  await writeUtf8File(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
};
