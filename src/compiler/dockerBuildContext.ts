import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const DOCKER_BUILD_CONTEXT_IGNORE_PATTERNS = Object.freeze([
  "runtimes/",
  "spawnfile-report.json",
  "deployments/"
] as const);

export interface DockerBuildContextFile {
  mode: number;
  path: string;
  size: number;
}

export interface DockerBuildContextIgnoreViolation {
  pattern: string;
  source: string;
}

const compareBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

const normalizeContextPath = (relativePath: string): string =>
  relativePath.replaceAll(path.sep, "/").replace(/^\.\/+/u, "");

const normalizeContextPathForContainment = (relativePath: string): string => {
  const normalized = path.posix.normalize(normalizeContextPath(relativePath));
  return normalized === "." ? "" : normalized.replace(/\/+$/u, "");
};

export const matchesDockerBuildIgnorePattern = (
  relativePath: string,
  pattern: string
): boolean => {
  const normalizedPath = normalizeContextPath(relativePath).replace(/\/+$/u, "");
  const normalizedPattern = normalizeContextPath(pattern);
  if (normalizedPattern.endsWith("/")) {
    const directory = normalizedPattern.replace(/\/+$/u, "");
    return normalizedPath === directory || normalizedPath.startsWith(`${directory}/`);
  }
  return normalizedPath === normalizedPattern;
};

export const createDockerIgnoreContent = (): string =>
  `${DOCKER_BUILD_CONTEXT_IGNORE_PATTERNS.join("\n")}\n`;

const isIgnoredContextPath = (relativePath: string): boolean =>
  DOCKER_BUILD_CONTEXT_IGNORE_PATTERNS.some((pattern) =>
    matchesDockerBuildIgnorePattern(relativePath, pattern)
  );

const walkContextFiles = async (
  directory: string,
  relativeDirectory = ""
): Promise<DockerBuildContextFile[]> => {
  const entries = await readdir(path.join(directory, relativeDirectory), {
    withFileTypes: true
  });
  const files: DockerBuildContextFile[] = [];

  for (const entry of entries) {
    const relativePath = normalizeContextPath(path.join(relativeDirectory, entry.name));
    if (isIgnoredContextPath(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await walkContextFiles(directory, relativePath));
      continue;
    }

    const metadata = await stat(path.join(directory, relativePath));
    if (metadata.isFile()) {
      files.push({
        mode: metadata.mode & 0o777,
        path: relativePath,
        size: metadata.size
      });
    }
  }

  return files;
};

export const listDockerBuildContextFiles = async (
  directory: string
): Promise<DockerBuildContextFile[]> =>
  (await walkContextFiles(path.resolve(directory))).sort((left, right) =>
    compareBytes(left.path, right.path)
  );

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareBytes(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const createFileContentHash = async (
  directory: string,
  relativePath: string
): Promise<string> => {
  const content = await readFile(path.join(directory, relativePath));
  if (relativePath !== "distribution-report.json") {
    return createHash("sha256").update(content).digest("hex");
  }

  const report = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
  const { generated_at: _generatedAt, ...normalizedReport } = report;
  return createHash("sha256")
    .update(canonicalJson(normalizedReport))
    .digest("hex");
};

export const createDockerBuildContextDigest = async (
  directory: string
): Promise<string> => {
  const resolvedDirectory = path.resolve(directory);
  const digest = createHash("sha256");
  for (const file of await listDockerBuildContextFiles(resolvedDirectory)) {
    const contentHash = await createFileContentHash(resolvedDirectory, file.path);
    digest.update(`${file.path}\0${file.mode}\0${contentHash}`);
  }
  return `sha256:${digest.digest("hex")}`;
};

const createLogicalDockerfileLines = (dockerfile: string): string[] => {
  const logicalLines: string[] = [];
  let current = "";
  for (const line of dockerfile.split(/\r?\n/u)) {
    const trimmed = line.trim();
    current = current.length === 0 ? trimmed : `${current} ${trimmed}`;
    if (current.endsWith("\\")) {
      current = current.slice(0, -1).trimEnd();
      continue;
    }
    logicalLines.push(current);
    current = "";
  }
  if (current.length > 0) {
    logicalLines.push(current);
  }
  return logicalLines;
};

const tokenizeDockerInstruction = (source: string): string[] => {
  const tokens: string[] = [];
  const pattern = /"((?:\\.|[^"])*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) {
      tokens.push(JSON.parse(`"${match[1]}"`) as string);
    } else {
      tokens.push(match[2] ?? match[3] ?? "");
    }
  }
  return tokens;
};

const stripInstructionFlags = (tokens: string[]): string[] => {
  let index = 0;
  while (tokens[index]?.startsWith("--")) {
    index += tokens[index]?.includes("=") ? 1 : 2;
  }
  return tokens.slice(index);
};

export const extractDockerBuildContextSources = (dockerfile: string): string[] => {
  const sources: string[] = [];
  for (const line of createLogicalDockerfileLines(dockerfile)) {
    const match = line.match(/^(COPY|ADD)\s+(.+)$/iu);
    if (!match) {
      continue;
    }
    const instruction = match[1]!.toUpperCase();
    const argumentsSource = match[2]!.trim();
    const rawTokens = argumentsSource.startsWith("[")
      ? JSON.parse(argumentsSource) as string[]
      : tokenizeDockerInstruction(argumentsSource);
    if (
      instruction === "COPY"
      && rawTokens.some((token) => token === "--from" || token.startsWith("--from="))
    ) {
      continue;
    }
    const tokens = stripInstructionFlags(rawTokens);
    for (const source of tokens.slice(0, -1)) {
      if (instruction === "ADD" && /^(?:https?|git):\/\//u.test(source)) {
        continue;
      }
      sources.push(normalizeContextPath(source));
    }
  }
  return sources;
};

export const findIgnoredDockerBuildSources = (
  dockerfile: string,
  patterns: readonly string[] = DOCKER_BUILD_CONTEXT_IGNORE_PATTERNS
): DockerBuildContextIgnoreViolation[] =>
  extractDockerBuildContextSources(dockerfile).flatMap((source) => {
    const normalizedSource = normalizeContextPathForContainment(source);
    return patterns.flatMap((pattern) => {
      const normalizedPattern = normalizeContextPathForContainment(pattern);
      const swallowsIgnoredPath = normalizedSource.length === 0
        || normalizedPattern === normalizedSource
        || normalizedPattern.startsWith(`${normalizedSource}/`);
      return matchesDockerBuildIgnorePattern(source, pattern) || swallowsIgnoredPath
        ? [{ pattern, source }]
        : [];
    });
  });
