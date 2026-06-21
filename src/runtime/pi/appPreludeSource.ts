export const renderPiPreludeSource = (): string => String.raw`import path from "node:path";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";

import { getModels } from "@earendil-works/pi-ai";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const maxControlBodyBytes = 1 << 20;

const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const collapseExactDouble = (text) => {
  const trimmed = text.trim();
  if (trimmed.length % 2 !== 0) {
    return trimmed;
  }
  const midpoint = trimmed.length / 2;
  const left = trimmed.slice(0, midpoint);
  return left === trimmed.slice(midpoint) ? left.trim() : trimmed;
};

const textFromMessage = (message) => {
  const content = message?.content;
  if (typeof content === "string") {
    return collapseExactDouble(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const textParts = content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .filter((text, index, parts) => index === 0 || text !== parts[index - 1]);
  return collapseExactDouble(textParts.join(""));
};

const parseEveryMs = (value) => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u.exec(value.trim());
  if (!match) {
    throw new Error("Invalid Pi every schedule: " + value);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multipliers = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    ms: 1,
    s: 1000
  };
  return Math.max(1, Math.round(amount * multipliers[unit]));
};

const createIdentityPrompt = (agent, workspacePath) => [
  agent.instructions,
  "",
  "Agent id: " + agent.id,
  "Workspace path: " + workspacePath
].join("\n");

const sendJson = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json"
  });
  response.end(body);
};

const readRequestJson = (request) => new Promise((resolve, reject) => {
  let total = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    total += chunk.length;
    if (total > maxControlBodyBytes) {
      reject(new Error("control request body is too large"));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (chunks.length === 0) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      reject(error);
    }
  });
  request.on("error", reject);
});

const controlEventText = (payload) => [
  "Moltnet control wake.",
  typeof payload.context_id === "string" ? "Context ID: " + payload.context_id : "",
  typeof payload.from === "string" ? "From: " + payload.from : "",
  typeof payload.message === "string" ? payload.message : ""
].filter((line) => line.trim().length > 0).join("\n\n");
`;
