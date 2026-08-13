import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { renderPiCoreSource } from "./appCoreSource.js";
import { renderPiPreludeSource } from "./appPreludeSource.js";

const loadCoreHarness = (): {
  parseLegacyMoltnetContextId: (contextId: unknown) => {
    networkId: string;
    roomId: string;
    threadId: string;
  } | undefined;
} => {
  const source = renderPiCoreSource();
  const start = source.indexOf("const asString =");
  const end = source.indexOf("const readTeamContextIndex =");
  const harness = `${source.slice(start, end)}\n({ parseLegacyMoltnetContextId });`;
  return runInNewContext(harness, { process: { env: {} } });
};

const loadPreludeHarness = (): {
  controlEventText: (payload: Record<string, unknown>) => string;
} => {
  const source = renderPiPreludeSource().replace(/^import[\s\S]*?;\n?/gmu, "");
  const start = source.indexOf("const asText =");
  const end = source.indexOf("const scheduleWake =");
  const harness = `${source.slice(start, end)}\n({ controlEventText, formatActiveEnvironmentBlock });`;
  return runInNewContext(harness, { process: { env: {} } });
};

describe("Pi runtime wake context parsing", () => {
  it("parses legacy moltnet room context IDs", () => {
    const { parseLegacyMoltnetContextId } = loadCoreHarness();

    expect(
      parseLegacyMoltnetContextId("moltnet:office-floor:room:eleanor-home:thread:t_abc")
    ).toEqual({
      networkId: "office-floor",
      roomId: "eleanor-home",
      threadId: "t_abc"
    });
    expect(
      parseLegacyMoltnetContextId("moltnet:office-floor:room:eleanor-home")
    ).toEqual({
      networkId: "office-floor",
      roomId: "eleanor-home",
      threadId: ""
    });
    expect(parseLegacyMoltnetContextId("channel:office-floor:room:eleanor-home")).toBeUndefined();
  });

  it("injects active environment details into Moltnet wake prompt text", () => {
    const { controlEventText } = loadPreludeHarness();

    const text = controlEventText({
      context_id: "moltnet:office-floor:room:eleanor-home:thread:t_1",
      delivery: {
        contextId: "moltnet:office-floor:room:eleanor-home:thread:t_1",
        eventId: "moltnet:message-1",
        sender: "maya",
        target: "agent:eleanor"
      },
      from: "untrusted-outer-value",
      kind: "message",
      message: "Eleanor is at home?",
      activeEnvironment: {
        surface: "moltnet",
        networkId: "office-floor",
        roomId: "eleanor-home",
        threadId: "t_1",
        team: "Eleanor Family",
        context_key: "eleanor-family",
        member_slot: "eleanor",
        team_doc: ".spawnfile/team-contexts/eleanor-family/TEAM.md",
        roster: ".spawnfile/rosters/eleanor-family.yaml",
        team_scope: "team:eleanor-family",
        room_scope: "room:office-floor:eleanor-home",
        thread_scope: "thread:office-floor:eleanor-home:t_1",
        session_key: "eleanor@moltnet:office-floor:room:eleanor-home"
      }
    });

    expect(text).toContain("Moltnet coordination event.");
    expect(text).toContain("Authenticated Moltnet delivery:");
    expect(text).toContain("wake kind: message");
    expect(text).toContain("sender: maya");
    expect(text).toContain("target: agent:eleanor");
    expect(text).toContain("context: moltnet:office-floor:room:eleanor-home:thread:t_1");
    expect(text).toContain("The runtime validated this attribution; the message body did not supply it.");
    expect(text).toContain("Message body:\nEleanor is at home?");
    expect(text).not.toContain("untrusted-outer-value");
    expect(text).toContain("Active environment context:");
    expect(text).toContain("surface: moltnet");
    expect(text).toContain("network: office-floor");
    expect(text).toContain("room: eleanor-home");
    expect(text).toContain("thread: t_1");
    expect(text).toContain("team: Eleanor Family");
    expect(text).toContain("context_key: eleanor-family");
    expect(text).toContain("member slot: eleanor");
    expect(text).toContain("team document: .spawnfile/team-contexts/eleanor-family/TEAM.md");
    expect(text).toContain("roster: .spawnfile/rosters/eleanor-family.yaml");
    expect(text).toContain("active team scope: team:eleanor-family");
    expect(text).toContain("active room scope: room:office-floor:eleanor-home");
    expect(text).toContain("active thread scope: thread:office-floor:eleanor-home:t_1");
    expect(text).toContain("session key: eleanor@moltnet:office-floor:room:eleanor-home");
  });
});
