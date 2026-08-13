import { describe, expect, it } from "vitest";

import {
  agentSlugFromNodeId,
  copyContainerPathToHost,
  countJsonlLines,
  renderMemeticsTranscriptMarkdown,
  resolveInstanceRoot,
  serializeMemeticsTranscriptJsonl
} from "./moltnetMemeticsArtifacts.js";
import type { MoltnetMessage } from "./moltnetMemeticsTypes.js";

const createMessage = (id: string, authorId: string, authorType: string, text: string): MoltnetMessage => ({
  from: { id: authorId, type: authorType },
  id,
  parts: [{ kind: "text", text }]
});

describe("agentSlugFromNodeId", () => {
  it("strips the agent: node-id prefix", () => {
    expect(agentSlugFromNodeId("agent:eleanor")).toBe("eleanor");
    expect(agentSlugFromNodeId("eleanor")).toBe("eleanor");
  });
});

describe("resolveInstanceRoot", () => {
  it("resolves the parent directory of a container home_path", () => {
    expect(resolveInstanceRoot("/var/lib/spawnfile/instances/pi/pi-app/home")).toBe(
      "/var/lib/spawnfile/instances/pi/pi-app"
    );
  });

  it("tolerates a trailing slash", () => {
    expect(resolveInstanceRoot("/var/lib/spawnfile/instances/pi/pi-app/home/")).toBe(
      "/var/lib/spawnfile/instances/pi/pi-app"
    );
  });
});

describe("serializeMemeticsTranscriptJsonl", () => {
  it("serializes one JSON object per line", () => {
    const messages = [
      createMessage("m1", "operator", "human", "Eleanor, confirm the plan with Sam. Reference token: ORCHID-417."),
      createMessage("m2", "eleanor", "agent", "Confirmed, looping Sam in now.")
    ];

    const jsonl = serializeMemeticsTranscriptJsonl(messages);
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(messages[0]);
    expect(JSON.parse(lines[1])).toEqual(messages[1]);
  });

  it("returns an empty string for no messages", () => {
    expect(serializeMemeticsTranscriptJsonl([])).toBe("");
  });
});

describe("renderMemeticsTranscriptMarkdown", () => {
  it("renders a heading per message with the seed token noted", () => {
    const messages = [
      createMessage("m1", "operator", "human", "Eleanor, confirm the plan with Sam. Reference token: ORCHID-417."),
      createMessage("m2", "eleanor", "agent", "Confirmed."),
      createMessage("m3", "sam", "agent", "Sounds good.")
    ];

    const markdown = renderMemeticsTranscriptMarkdown(messages, { roomId: "eleanor-home", seedToken: "ORCHID-417" });

    expect(markdown).toContain("# Moltnet Memetics Transcript: eleanor-home");
    expect(markdown).toContain("Seed token: `ORCHID-417`");
    expect(markdown).toContain("## operator (human)");
    expect(markdown).toContain("## eleanor (agent)");
    expect(markdown).toContain("## sam (agent)");
    expect(markdown).toContain("Confirmed.");
    expect(markdown).toContain("Sounds good.");
  });

  it("renders a placeholder for an empty message body", () => {
    const markdown = renderMemeticsTranscriptMarkdown([createMessage("m1", "eleanor", "agent", "")], {
      roomId: "eleanor-home"
    });

    expect(markdown).toContain("_(empty message)_");
  });
});

describe("countJsonlLines", () => {
  it("counts non-blank lines", () => {
    expect(countJsonlLines('{"a":1}\n{"b":2}\n\n')).toBe(2);
    expect(countJsonlLines("")).toBe(0);
  });
});

describe("copyContainerPathToHost", () => {
  it("returns true when the docker cp command succeeds", async () => {
    const calls: string[][] = [];
    const ok = await copyContainerPathToHost({
      containerName: "container",
      containerPath: "/var/lib/spawnfile/instances/pi/pi-app/runtime/agents",
      dockerCommand: "docker",
      hostPath: "/tmp/out/engine-logs",
      runCommand: async (_command, args) => {
        calls.push(args);
        return "";
      }
    });

    expect(ok).toBe(true);
    expect(calls).toEqual([
      ["cp", "container:/var/lib/spawnfile/instances/pi/pi-app/runtime/agents", "/tmp/out/engine-logs"]
    ]);
  });

  it("returns false instead of throwing when the docker cp command fails", async () => {
    const ok = await copyContainerPathToHost({
      containerName: "container",
      containerPath: "/missing",
      dockerCommand: "docker",
      hostPath: "/tmp/out/engine-logs",
      runCommand: async () => {
        throw new Error("no such path");
      }
    });

    expect(ok).toBe(false);
  });
});
