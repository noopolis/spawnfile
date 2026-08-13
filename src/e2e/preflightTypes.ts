export type PreflightCheckStatus = "passed" | "skipped" | "unavailable";

export interface B18PreflightCheck {
  id: string;
  name: string;
  status: PreflightCheckStatus;
  reason: string;
}

export interface B18PreflightReport {
  checks: B18PreflightCheck[];
  readyForLive: boolean;
  summary: {
    passed: number;
    skipped: number;
    unavailable: number;
    total: number;
  };
}

export interface PreflightCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export type PreflightCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<PreflightCommandResult>;

export interface B18PreflightOptions {
  antigravityAuthPath?: string;
  antigravityCliCommand?: string;
  commandTimeoutMs?: number;
  compileProbe?: (fixtureDirectory: string, timeoutMs: number) => Promise<{
    daimon: B18PreflightCheck;
    mneme: B18PreflightCheck;
    moltnet: B18PreflightCheck;
    openclaw: B18PreflightCheck;
    picoclaw: B18PreflightCheck;
  }>;
  codexAuthPath?: string;
  claudeAuthPath?: string;
  commandRunner?: PreflightCommandRunner;
  dockerCommand?: string;
  dockerRemoteContext?: string;
  fetchTimeoutMs?: number;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  grokAuthPath?: string;
  grokCliCommand?: string;
  homeDirectory?: string;
  mixedRuntimeFixtureDirectory?: string;
  moltnetCliCommand?: string;
  moltnetServerUrl?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  projectRoot?: string;
  runtimeAssetRoot?: string;
}

export type JsonObject = Record<string, unknown>;

export const CHECK_IDS = {
  antigravity: "antigravity",
  antigravityAuth: "antigravity-auth",
  claude: "claude",
  codex: "codex",
  dockerContextList: "docker-context-list",
  dockerDaemon: "docker-daemon",
  dockerRemoteContext: "docker-context",
  daimon: "daimon",
  mneme: "mneme",
  grok: "grok",
  grokAuth: "grok-auth",
  moltnetCli: "moltnet-cli",
  moltnet: "moltnet",
  moltnetServer: "moltnet-server",
  openclaw: "openclaw",
  ollama: "ollama-embeddings",
  openclawAssets: "runtime-assets-openclaw",
  picoclaw: "picoclaw",
  picoclawAssets: "runtime-assets-picoclaw"
} as const;

export const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 2_000;
export const DEFAULT_REMOTE_DOCKER_CONTEXT = "4090";
export const DEFAULT_MOLTNET_SERVER_URL = "http://127.0.0.1:19087/healthz";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
