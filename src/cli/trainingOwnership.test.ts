import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const forbidden = /@noopolis\/paideia|\/opt\/(?:training\/)?paideia\b|\bpaideia\s+train\b|\/(?:packages|bin)\/paideia\b/u;
const isTest = (file: string): boolean => /(?:^|\/)(?:__tests__|fixtures)(?:\/|$)|\.(?:test|test-helper)\.[^/]+$/u.test(file);

it("keeps external training packages, install paths and binaries out of maintained files", () => {
  const { TYPESAFE_API_KEY: _key, ...env } = process.env;
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, env, encoding: "utf8" }).split("\0");
  const violations = files.filter(file => file && !file.startsWith("src/training/") && !isTest(file))
    .filter(file => existsSync(path.join(root, file)))
    .filter(file => forbidden.test(readFileSync(path.join(root, file), "utf8")));
  expect(violations).toEqual([]);
});

it.each([
  "import '@noopolis/paideia/cli'", "/opt/training/paideia/dist/cli.js",
  "/opt/paideia/native", "exec paideia train --dry-run", "./packages/paideia", "/usr/bin/paideia"
])("rejects a reintroduced external training dependency: %s", source => {
  expect(forbidden.test(source)).toBe(true);
});

it("allows legacy context paths and versioned wire IDs", () => {
  expect(forbidden.test('/run/paideia/context.json paideia.training-cost-plan.v1')).toBe(false);
});
