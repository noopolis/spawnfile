import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { requireLiveCheckEnvironment } from "./grok-lean-worker-live-check.ts";

test("the Grok lean-worker live check is explicit opt-in and refuses the desktop Grok login", () => {
  const env = { SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY: "/tmp/identity.json", SPAWNFILE_DAIMON_SOURCE_GROK_AUTH: "/tmp/grok-training/auth.json", SPAWNFILE_GROK_LIVE_CHECK: "1" };
  assert.deepEqual(requireLiveCheckEnvironment(env), { grokAuth: "/tmp/grok-training/auth.json", identity: "/tmp/identity.json" });
  assert.throws(() => requireLiveCheckEnvironment({ ...env, SPAWNFILE_GROK_LIVE_CHECK: undefined }), /SPAWNFILE_GROK_LIVE_CHECK=1/u);
  assert.throws(() => requireLiveCheckEnvironment({ ...env, SPAWNFILE_DAIMON_SOURCE_GROK_AUTH: path.join(os.homedir(), ".grok", "auth.json") }), /desktop/u);
  assert.throws(() => requireLiveCheckEnvironment({ ...env, SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY: "relative.json" }), /identity/u);
});
