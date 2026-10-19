import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { TRAINING_FAKETIME_LIBRARY_PATH } from "../index.js";
import { TRAINING_FAKETIME_LIBRARY_PATH as containerPath } from "./index.js";

it("exports the fixed library symlink actually installed by the training recipe", async () => {
  const recipe = await readFile(new URL("../../../../runtime-images/training/Dockerfile", import.meta.url), "utf8");
  expect(TRAINING_FAKETIME_LIBRARY_PATH).toBe("/usr/local/lib/daimon/libfaketime.so.1");
  expect(containerPath).toBe(TRAINING_FAKETIME_LIBRARY_PATH);
  expect(recipe).toContain(`ln -s "$library" ${TRAINING_FAKETIME_LIBRARY_PATH}`);
});
