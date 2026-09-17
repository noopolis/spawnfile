import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertControlRecipe, assertNewRecipe, CONTROL_CLOSURE, deriveControlRecipe, diffModeListings, identicalModes, LISTING_ROOTS, MODE_ROOTS } from "./training-image-modes.ts";

const row = (entry: string, mode = "755", type = "d", target = "") => `${entry}\t${mode}\troot\troot\t${type}\t${target}`;
const base = [row("/opt/training"), row("/opt/training/paideia/bridges/dspy/.venv"), row("/opt/training/bin/grok", "555", "f"),
  row("/opt/training/bin/claude", "777", "l", "/opt/training/claude/node_modules/.bin/claude")];

test("identical listings in any order compare equal", () => {
  assert.equal(identicalModes(diffModeListings(base.join("\n"), [...base].reverse().join("\n") + "\n")), true);
});

test("mode, owner, type and link target drift are each reported", () => {
  const drifts: [number, string][] = [[2, row("/opt/training/bin/grok", "755", "f")], [2, base[2]!.replace("\troot\troot", "\ttraining\troot")],
    [3, row("/opt/training/bin/claude", "777", "l", "/elsewhere")], [2, row("/opt/training/bin/grok", "555", "l")]];
  for (const [index, drifted] of drifts) {
    const control = [...base]; control[index] = drifted;
    const diff = diffModeListings(base.join("\n"), control.join("\n"));
    assert.equal(identicalModes(diff), false);
    assert.equal(diff.changed.length, 1);
  }
});

test("entries present on only one side are reported", () => {
  const diff = diffModeListings([...base, row("/opt/training/extra", "644", "f")].join("\n"), base.slice(0, 3).join("\n"));
  assert.deepEqual(diff.onlyNew, ["/opt/training/bin/claude", "/opt/training/extra"]);
  assert.deepEqual(diff.onlyControl, []);
});

test("empty, malformed, duplicated or rootless listings fail instead of comparing equal", () => {
  assert.throws(() => diffModeListings("", ""), /missing a required root/u);
  assert.throws(() => diffModeListings(base.join("\n"), "/opt/training 755"), /Malformed/u);
  assert.throws(() => diffModeListings(base.slice(0, 1).join("\n"), base.join("\n")), /missing a required root/u);
  assert.throws(() => diffModeListings([...base, base[2]!].join("\n"), base.join("\n")), /Duplicate/u);
});

test("recipes must actually differ in the recursive closure", () => {
  assert.doesNotThrow(() => assertControlRecipe("RUN chmod 0555 x \\\n && chmod -R a+rX /opt/training"));
  assert.throws(() => assertControlRecipe("RUN find /opt/training"), /Control recipe/u);
  assert.throws(() => assertNewRecipe("RUN chmod -R a+rX /opt/training"), /still runs/u);
  assert.throws(() => assertControlRecipe("# chmod -R a+rX /opt/training\nRUN true"), /Control recipe/u);
  assert.doesNotThrow(() => assertNewRecipe("# Exactly `chmod -R a+rX /opt/training`, but change-only\nRUN find /opt/training"));
});

test("the listing roots never nest, so find cannot emit a duplicate entry", () => {
  for (const root of LISTING_ROOTS) {
    assert.equal(LISTING_ROOTS.some(other => other !== root && root.startsWith(other + "/")), false, root);
  }
  for (const required of MODE_ROOTS) assert.equal(LISTING_ROOTS.some(root => required === root || required.startsWith(root + "/")), true, required);
});

test("derives a control recipe that reapplies the whole-tree closure this recipe replaced", async () => {
  const recipe = await readFile(new URL("../runtime-images/training/Dockerfile", import.meta.url), "utf8");
  assertNewRecipe(recipe);
  const control = deriveControlRecipe(recipe);
  assertControlRecipe(control);
  assert.equal(/-exec chmod a\+rX \{\} \+/u.test(control), false, "no change-only closure may survive in the control");
  assert.ok(control.includes("RUN chmod 0555 /opt/training/bin/train /opt/training/bin/train-broker"));
  // The closure must RUN after the last COPY, where the former recipe ran it. `indexOf` would find the
  // recipe's own comment about the closure, which sits near the top.
  assert.ok(control.indexOf("\nRUN chmod 0555 ") > control.lastIndexOf("\nCOPY "));
  assert.ok(control.lastIndexOf(CONTROL_CLOSURE) > control.lastIndexOf("\nCOPY "));
  assert.throws(() => deriveControlRecipe(control), /no change-only a\+rX closure/u);
});
