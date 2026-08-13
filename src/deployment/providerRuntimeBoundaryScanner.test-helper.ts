import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type ProviderRuntimeViolationKind =
  | "moltnet-live-endpoint"
  | "provider-authenticated-http"
  | "docker-exec-http-transport"
  | "transport-receipt"
  | "generated-client"
  | "cursor-operation";

export type ProviderRuntimeViolation = {
  classification: ProviderRuntimeViolationKind;
  file: string;
  matched: string;
};

const forbiddenIdentifiers: Array<[ProviderRuntimeViolationKind, RegExp]> = [
  ["transport-receipt", /spawnfile\.moltnet-transport/u],
  ["transport-receipt", /ContainedMoltnetTransport/u],
  ["generated-client", /CONTAINED_MOLTNET_CLIENT/u],
  ["generated-client", /SendMessageRequest/u],
  ["cursor-operation", /ListRoomMessages/u]
];

const productionFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(file);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".test-helper.ts")) return [];
    return [file];
  }));
  return nested.flat();
};

const violationsForSource = (source: string, file: string): ProviderRuntimeViolation[] => {
  const violations: ProviderRuntimeViolation[] = [];
  for (const endpoint of ["/v1/messages", "/v1/network", "/v1/rooms", "/v1/agents"]) {
    if (source.includes(endpoint)) violations.push({ classification: "moltnet-live-endpoint", file, matched: endpoint });
  }
  const providerSurface = /(?:fetch|httpGet|curl)[\s\S]*(?:\/healthz|\/v1\/)/u.test(source)
    || /(?:\/healthz|\/v1\/)[\s\S]*(?:fetch|httpGet|curl)/u.test(source);
  const authenticatedMarker = [
    [/\bAuthorization\s*:/u, "Authorization property"],
    [/["']Authorization["']\s*:/u, "Authorization string key"],
    [/\[\s*["']Authorization["']\s*\]\s*=/u, "Authorization element assignment"],
    [/`Bearer\s+/u, "Bearer template"],
    [/["']Bearer\s+["']\s*\+/u, "Bearer concatenation"],
    [/["']Bearer\s+/u, "Bearer literal"]
  ].find(([pattern]) => (pattern as RegExp).test(source));
  if (providerSurface && authenticatedMarker) {
    violations.push({
      classification: "provider-authenticated-http",
      file,
      matched: authenticatedMarker[1] as string
    });
  }
  if (/(?:exec\s*\(\s*\[\s*["'](?:curl|wget)["'])|(?:["']exec["'][\s\S]{0,160}["'](?:curl|wget)["'])/u.test(source)) {
    violations.push({ classification: "docker-exec-http-transport", file, matched: "exec curl/wget" });
  }
  for (const [classification, pattern] of forbiddenIdentifiers) {
    if (pattern.test(source)) violations.push({ classification, file, matched: pattern.source });
  }
  return violations;
};

export const scanProviderRuntimeSource = (source: string, file = "synthetic.ts"): ProviderRuntimeViolation[] =>
  violationsForSource(source, file);

export const scanProviderRuntimeTree = async (repositoryRoot: string): Promise<ProviderRuntimeViolation[]> => {
  const roots = ["cli", "compiler", "deployment", "status"].map((folder) => path.join(repositoryRoot, "src", folder));
  const files = (await Promise.all(roots.map(productionFiles))).flat();
  const results = await Promise.all(files.map(async (file) => violationsForSource(await readFile(file, "utf8"), path.relative(repositoryRoot, file))));
  return results.flat();
};
