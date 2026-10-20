import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ResolvedAgentNode } from "../../compiler/types.js";
import { createPiTestNode } from "../pi/testHelpers.js";

import { daimonAdapter } from "./adapter.js";
import { createDaimonContainerTargets } from "./config.js";
import { DAIMON_GROK_SKILLS_MIN_VERSION, daimonGrokSkillsError, pinnedDaimonRuntimeVersion } from "./grokSkillsSupport.js";

const grokNode = (skills?: ResolvedAgentNode["skills"]): ResolvedAgentNode => createPiTestNode({
  execution: { model: { primary: { auth: { method: "grok" }, name: "grok-4.6", provider: "xai", reasoning_effort: "low" } } },
  name: "grokker", runtime: { name: "daimon", options: { engine: "grok" } }, ...(skills ? { skills } : {})
});
const skill = (name: string) => ({ content: "---\nname: x\n---\n", name, ref: `./skills/${name}`, requiresMcp: [], sourcePath: `/tmp/skills/${name}/SKILL.md` });

describe("Daimon Grok skills release guard", () => {
  it("reads the pinned Daimon version from the runtimes.yaml image tag", () => {
    expect(pinnedDaimonRuntimeVersion("runtimes:\n  daimon:\n    install:\n      tag: 0.2.2-00e8f1d\n")).toBe("0.2.2");
    expect(() => pinnedDaimonRuntimeVersion("runtimes:\n  daimon:\n    install:\n      tag: latest\n")).toThrow(/no versioned Daimon/u);
    const tag = /tag: (\S+)/u.exec(readFileSync("runtimes.yaml", "utf8").split("daimon:")[1]!)![1]!;
    expect(pinnedDaimonRuntimeVersion()).toBe(tag.split("-")[0]);
  });

  it.each([["0.2.1", true], ["0.1.9", true], ["0.2.2", false], ["0.3.0", false], ["1.0.0", false]] as const)(
    "pinned Daimon %s refuses Grok skills: %s", (version, refused) => {
      const message = daimonGrokSkillsError(grokNode(), "grok", () => version);
      if (refused) expect(message).toMatch(new RegExp(`pins Daimon ${version.replaceAll(".", "\\.")}.*re-pin the Daimon runtime image to ${DAIMON_GROK_SKILLS_MIN_VERSION}`, "isu"));
      else expect(message).toBeUndefined();
    });

  it("never refuses an agent without skills or a non-Grok engine", () => {
    expect(daimonGrokSkillsError(grokNode([]), "grok", () => "0.2.1")).toBeUndefined();
    expect(daimonGrokSkillsError(grokNode(), "codex", () => "0.2.1")).toBeUndefined();
  });

  it("refuses a skill name or size Daimon's parser refuses, at any pin", () => {
    expect(daimonGrokSkillsError(grokNode([skill(".hidden")]), "grok", () => "9.9.9")).toMatch(/skill name/u);
    expect(daimonGrokSkillsError(grokNode([{ ...skill("big"), content: "x".repeat(262_145) }]), "grok", () => "9.9.9")).toMatch(/size of big/u);
  });

  it("follows the checked-in pin through preflight (spawnfile validate), compile diagnostics and container targets", async () => {
    const node = grokNode();
    const tooOld = daimonGrokSkillsError(node, "grok") !== undefined;
    expect(tooOld).toBe(pinnedDaimonRuntimeVersion().localeCompare(DAIMON_GROK_SKILLS_MIN_VERSION, undefined, { numeric: true }) < 0);
    const compiled = await daimonAdapter.compileAgent(node);
    const targets = createDaimonContainerTargets([{ emittedFiles: [], id: "agent:grokker", kind: "agent", slug: "grokker", value: node }]);
    if (tooOld) {
      expect(() => daimonAdapter.preflightAgent!(node, "agent:grokker")).toThrow(/rejects service\.json skillsSha256/u);
      expect(compiled.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ level: "error", message: expect.stringMatching(/re-pin/iu) })]));
      await expect(targets).rejects.toThrow(/rejects service\.json skillsSha256/u);
    } else {
      expect(() => daimonAdapter.preflightAgent!(node, "agent:grokker")).not.toThrow();
      await expect(targets).resolves.toHaveLength(1);
    }
    expect(() => daimonAdapter.preflightAgent!(grokNode([]), "agent:grokker")).not.toThrow();
    expect(() => daimonAdapter.preflightAgent!(grokNode([skill("bad name")]), "agent:grokker")).toThrow(/skill name/u);
  });
});
