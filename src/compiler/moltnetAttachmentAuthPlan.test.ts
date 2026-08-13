import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { removeDirectory, writeUtf8File } from "../filesystem/index.js";

import { buildCompilePlan } from "./buildCompilePlan.js";

const temporaryDirectories: string[] = [];

const writeProject = async (
  selectedToken: string | null,
  selectedTokenYaml: string
): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moltnet-auth-"));
  temporaryDirectories.push(directory);
  await writeUtf8File(path.join(directory, "red.md"), "# Red\n");
  await writeUtf8File(
    path.join(directory, "Spawnfile"),
    [
      'spawnfile_version: "0.1"',
      "kind: team",
      "name: auth-bound-team",
      "mode: swarm",
      "members:",
      "  - id: red",
      "    runtime: openclaw",
      "    workspace:",
      "      docs:",
      "        system: ./red.md",
      "    surfaces:",
      "      moltnet:",
      "        - network: pitch",
      ...(selectedToken
        ? [
            "          auth:",
            `            token_id: ${selectedToken}`
          ]
        : []),
      "          rooms:",
      "            field:",
      "              wake: mentions",
      "networks:",
      "  - id: pitch",
      "    provider: moltnet",
      "    server:",
      "      mode: managed",
      "      listen:",
      "        bind: 127.0.0.1",
      "        port: 19971",
      "      store:",
      "        kind: memory",
      "      auth:",
      "        mode: bearer",
      "        public_read: false",
      "        agent_registration: disabled",
      "        tokens:",
      "          - id: world",
      "            secret: WORLD_TOKEN",
      "            scopes: [admin, observe, write]",
      "            agents: [world]",
      ...selectedTokenYaml.split("\n"),
      "        client:",
      "          token_id: world",
      "    rooms:",
      "      - id: field",
      "        members: [red]",
      "        visibility: private",
      "        write_policy: members",
      ""
    ].join("\n")
  );
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeDirectory));
});

describe("Moltnet attachment credential plan validation", () => {
  it.each([
    {
      expected: /references unknown token missing/,
      selected: "missing",
      token: ""
    },
    {
      expected: /must declare exactly agents: \[red\]/,
      selected: "shared",
      token: [
        "          - id: shared",
        "            secret: SHARED_TOKEN",
        "            scopes: [attach, write]",
        "            agents: [red, blue]"
      ].join("\n")
    },
    {
      expected: /must declare exactly agents: \[red\]/,
      selected: "blue-agent",
      token: [
        "          - id: blue-agent",
        "            secret: BLUE_TOKEN",
        "            scopes: [attach, write]",
        "            agents: [blue]"
      ].join("\n")
    },
    {
      expected: /must include attach and write scopes/,
      selected: "red-agent",
      token: [
        "          - id: red-agent",
        "            secret: RED_TOKEN",
        "            scopes: [attach]",
        "            agents: [red]"
      ].join("\n")
    },
    {
      expected: /secret environment bindings must be unique/,
      selected: "red-agent",
      token: [
        "          - id: red-agent",
        "            secret: WORLD_TOKEN",
        "            scopes: [attach, write]",
        "            agents: [red]"
      ].join("\n")
    },
    {
      expected: /must select its own attach\+write token/,
      selected: null,
      token: ""
    }
  ])("rejects $selected before compile artifacts are emitted", async ({ expected, selected, token }) => {
    await expect(buildCompilePlan(await writeProject(selected, token))).rejects.toThrow(expected);
  });
});
