export type SiblingFileFact = { path: string; mtimeMs: number };

export type SiblingBuildFacts = {
  packageName: string;
  packageDirectory: string;
  hasSourceDirectory: boolean;
  sourceFiles: SiblingFileFact[];
  outputFiles: SiblingFileFact[];
};

export type SiblingBuildFreshness = {
  packageName: string;
  linked: boolean;
  sourcesScanned: number;
  outputsScanned: number;
  ok: boolean;
  message?: string;
};

const excludedSource = /(?:\.test\.ts|\.test-helper\.ts|\.d\.ts)$/u;

export function checkSiblingBuildFreshness(facts: SiblingBuildFacts): SiblingBuildFreshness {
  if (!facts.hasSourceDirectory) return { packageName: facts.packageName, linked: false, sourcesScanned: 0, outputsScanned: 0, ok: true };
  const sourceFiles = facts.sourceFiles.filter(({ path }) => !excludedSource.test(path));
  const outputFiles = facts.outputFiles.filter(({ path }) => path.endsWith(".js"));
  const command = `run "npm run build" in ${facts.packageDirectory}`;
  if (sourceFiles.length === 0) return failure(facts.packageName, sourceFiles.length, outputFiles.length, `linked package ${facts.packageName} scanned zero source files; ${command}`);
  if (outputFiles.length === 0) return failure(facts.packageName, sourceFiles.length, outputFiles.length, `linked package ${facts.packageName} has no emitted JavaScript; ${command}`);
  const newestSource = sourceFiles.reduce((newest, file) => file.mtimeMs > newest.mtimeMs ? file : newest);
  const oldestOutput = outputFiles.reduce((oldest, file) => file.mtimeMs < oldest.mtimeMs ? file : oldest);
  if (newestSource.mtimeMs > oldestOutput.mtimeMs) return failure(facts.packageName, sourceFiles.length, outputFiles.length, `linked package ${facts.packageName} is stale: newest source ${newestSource.path} (${newestSource.mtimeMs}) is newer than oldest output ${oldestOutput.path} (${oldestOutput.mtimeMs}); ${command}`);
  return { packageName: facts.packageName, linked: true, sourcesScanned: sourceFiles.length, outputsScanned: outputFiles.length, ok: true };
}

function failure(packageName: string, sourcesScanned: number, outputsScanned: number, message: string): SiblingBuildFreshness {
  return { packageName, linked: true, sourcesScanned, outputsScanned, ok: false, message };
}
