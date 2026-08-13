import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_LIFECYCLE_PLAN_REQUEST_BYTES,
  readLifecyclePlanRequest,
} from "./lifecyclePlan.js";

const homes: string[] = [];

const request = () => ({
  compiled: null,
  deployment: "default",
  docker_command: null,
  export_to: null,
  force: false,
  lifecycle_invocation_id: "lci_branch0000000000",
  operation: "down",
  path: ".",
  reader_image: null,
  remove_volumes: false,
  timeout_ms: null,
  version: "spawnfile.lifecycle-plan-request.v1",
});

const chunks = (...values: unknown[]): AsyncIterable<unknown> =>
  (async function* () {
    yield* values;
  })();

const invalid = async (source: string, input = chunks()): Promise<void> => {
  await expect(readLifecyclePlanRequest(source, input)).rejects.toMatchObject({
    code: "validation_error",
  });
};

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

describe("lifecycle plan request branch validation", () => {
  it("accepts string and byte chunks, whitespace, escaped keys, arrays, and empty containers", async () => {
    const json = JSON.stringify(request());
    const midpoint = Math.floor(json.length / 2);
    await expect(
      readLifecyclePlanRequest(
        "-",
        chunks(json.slice(0, midpoint), new TextEncoder().encode(json.slice(midpoint))),
      ),
    ).resolves.toEqual(request());

    const nested = ` { "escaped\\u005fkey": [ ], "empty": { } } `;
    await invalid("-", chunks(nested));
  });

  it("rejects every invalid stdin chunk shape and iterator failure", async () => {
    await invalid("-", chunks());
    await invalid("-", chunks(""));
    await invalid("-", chunks({}));
    await invalid("-", chunks(new Uint8Array(MAX_LIFECYCLE_PLAN_REQUEST_BYTES + 1)));
    await invalid(
      "-",
      (async function* () {
        throw new Error("read failed");
      })(),
    );
  });

  it.each([
    '"unterminated',
    "{} trailing",
    '{"key" 1}',
    '{"key":1 "next":2}',
    '{"key":1,',
    "[1 2]",
    "[1,",
    "[",
  ])("rejects malformed duplicate-key scanner input %s", async (json) => {
    await invalid("-", chunks(json));
  });

  it("rejects duplicate escaped keys and invalid UTF-8 or BOM input", async () => {
    await invalid("-", chunks('{"key":1,"k\\u0065y":2}'));
    await invalid("-", chunks(new Uint8Array([0xff])));
    await invalid("-", chunks(`\uFEFF${JSON.stringify(request())}`));
  });

  it("reads an exact file and rejects absent, non-file, empty, and oversized sources", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-plan-branches-"));
    homes.push(home);
    const valid = path.join(home, "valid.json");
    await writeFile(valid, JSON.stringify(request()));
    await expect(readLifecyclePlanRequest(valid, chunks())).resolves.toEqual(request());

    await invalid(path.join(home, "absent.json"));
    const directory = path.join(home, "directory");
    await mkdir(directory);
    await invalid(directory);
    const empty = path.join(home, "empty.json");
    await writeFile(empty, "");
    await invalid(empty);
    const oversized = path.join(home, "oversized.json");
    await writeFile(oversized, new Uint8Array(MAX_LIFECYCLE_PLAN_REQUEST_BYTES + 1));
    await invalid(oversized);
  });
});
