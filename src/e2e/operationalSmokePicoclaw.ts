import path from "node:path";

const PICOCLAW_MOCK_MODEL_PORT = 19123;
export const PICOCLAW_PORT = 18990;
const PICOCLAW_SCHEDULE_REPLY_SENTINEL = "SF-SPAWNFILE-OPERATIONAL-PICO-SCHEDULE-REPLY";
const PICOCLAW_CRON_JOB_ID = "spawnfile-pico-scheduled";
const PICOCLAW_WORKSPACE =
  "/var/lib/spawnfile/instances/picoclaw/agent-pico-scheduled/picoclaw/workspace";
const PICOCLAW_CRON_STORE = path.posix.join(PICOCLAW_WORKSPACE, "cron", "jobs.json");
const PICOCLAW_SESSIONS_DIR = path.posix.join(PICOCLAW_WORKSPACE, "sessions");

type DockerCommandRunner = (dockerCommand: string, args: string[]) => Promise<string>;

interface PollOptions {
  intervalMs: number;
  sleep: (delayMs: number) => Promise<void>;
  timeoutMs: number;
}

type Poll = <T>(
  description: string,
  options: PollOptions,
  attempt: () => Promise<T | null>
) => Promise<T>;

const dockerExec = (
  runCommand: DockerCommandRunner,
  dockerCommand: string,
  containerName: string,
  args: string[]
): Promise<string> => runCommand(dockerCommand, ["exec", containerName, ...args]);

const dockerCurl = (
  runCommand: DockerCommandRunner,
  dockerCommand: string,
  containerName: string,
  url: string
): Promise<string> => dockerExec(runCommand, dockerCommand, containerName, ["curl", "-sf", url]);

const createPicoClawMockModelServerCommand = (): string => `
cat > /tmp/spawnfile-picoclaw-openai-mock.js <<'JS'
const http = require("http");

const responseText = ${JSON.stringify(PICOCLAW_SCHEDULE_REPLY_SENTINEL)};

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  if (request.method !== "POST" || request.url !== "/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }

  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-spawnfile-picoclaw",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: responseText
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2
      }
    }));
  });
});

server.listen(${PICOCLAW_MOCK_MODEL_PORT}, "127.0.0.1");
JS
nohup node /tmp/spawnfile-picoclaw-openai-mock.js >/tmp/spawnfile-picoclaw-openai-mock.log 2>&1 &
`.trim();

export const assertPicoClawWorkspace = async (
  runCommand: DockerCommandRunner,
  dockerCommand: string,
  containerName: string
): Promise<void> => {
  await dockerExec(runCommand, dockerCommand, containerName, [
    "test",
    "-f",
    PICOCLAW_CRON_STORE
  ]);
  await dockerExec(runCommand, dockerCommand, containerName, [
    "sh",
    "-lc",
    `grep -q ${JSON.stringify(PICOCLAW_CRON_JOB_ID)} ${JSON.stringify(PICOCLAW_CRON_STORE)}`
  ]);
};

export const startPicoClawMockModelServer = async (
  runCommand: DockerCommandRunner,
  dockerCommand: string,
  containerName: string,
  pollOptions: PollOptions,
  poll: Poll
): Promise<void> => {
  await dockerExec(runCommand, dockerCommand, containerName, [
    "sh",
    "-lc",
    createPicoClawMockModelServerCommand()
  ]);

  await poll("PicoClaw mock OpenAI-compatible model", pollOptions, async () => {
    await dockerCurl(
      runCommand,
      dockerCommand,
      containerName,
      `http://127.0.0.1:${PICOCLAW_MOCK_MODEL_PORT}/health`
    );
    return true;
  });
};

export const waitForPicoClawSchedule = async (
  runCommand: DockerCommandRunner,
  dockerCommand: string,
  containerName: string,
  pollOptions: PollOptions,
  poll: Poll
): Promise<void> => {
  await poll("PicoClaw scheduled assistant reply", pollOptions, async () => {
    await dockerExec(runCommand, dockerCommand, containerName, [
      "sh",
      "-lc",
      `test -d ${JSON.stringify(PICOCLAW_SESSIONS_DIR)} && grep -R -q ${JSON.stringify(
        PICOCLAW_SCHEDULE_REPLY_SENTINEL
      )} ${JSON.stringify(PICOCLAW_SESSIONS_DIR)}`
    ]);
    return true;
  });

  await poll("PicoClaw cron run status", pollOptions, async () => {
    await dockerExec(runCommand, dockerCommand, containerName, [
      "sh",
      "-lc",
      `grep -q '"lastStatus": "ok"' ${JSON.stringify(PICOCLAW_CRON_STORE)}`
    ]);
    return true;
  });
};
