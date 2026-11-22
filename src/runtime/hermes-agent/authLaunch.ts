import { hermesAuthDirectory, hermesAuthRouteFile } from "./auth.js";
import { hermesAuthValidatorSource, validHermesAuthStore } from "./authStore.js";

/** Runs inside the image with the directory lease already held. */
function verifyRuntimeStore(home: string, routeFile: string, directoryName: string,
  fs: typeof import("node:fs"), path: typeof import("node:path"), randomUUID: typeof import("node:crypto").randomUUID,
  spawnSync: typeof import("node:child_process").spawnSync, validStore: typeof validHermesAuthStore) {
  const { O_CREAT, O_RDONLY, O_RDWR, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const uid = process.geteuid!();
  const storeDirectory = path.join(home, directoryName);
  const reader = {
    privateRead(filename: string, limit: number) {
      const fd = fs.openSync(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.uid !== uid || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1 || info.size > limit) throw new Error();
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        for (;;) {
          const copied = fs.readSync(fd, bytes, length, bytes.length - length, null);
          length += copied;
          if (length > limit) throw new Error();
          if (!copied) return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  try {
    const route = reader.privateRead(path.join(home, routeFile), 32).trim();
    if (route === "-") return;
    const dir = fs.lstatSync(storeDirectory);
    if (!dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o7777) !== 0o700) throw new Error();
    for (const name of ["auth.json", "auth.lock"]) {
      if (fs.readlinkSync(path.join(home, name)) !== `${directoryName}/${name}`) throw new Error();
    }
    const lock = fs.openSync(path.join(storeDirectory, "auth.lock"), O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK, 0o600);
    try {
      // Child fd 3 refers to the same open file description, so the lock stays held until close.
      const stat = fs.fstatSync(lock);
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o7022) !== 0) throw new Error();
      if (spawnSync("flock", ["-x", "-w", "25", "3"], { stdio: ["ignore", "ignore", "ignore", lock] }).status !== 0) throw new Error();
      const statePath = path.join(storeDirectory, "auth.json");
      const store = JSON.parse(reader.privateRead(statePath, 1024 * 1024));
      if (!validStore(store, route)) throw new Error();

      const rows: Array<Record<string, unknown>> = store.credential_pool?.[route] ?? [];
      const singleton = store.providers?.[route];
      const deviceCodeStore = route === "openai-codex" || route === "xai-oauth";
      const poolOnly = deviceCodeStore && !singleton;
      if (poolOnly) {
        // Codex pre-syncs from a singleton under auth.lock. With xAI, a native auxiliary
        // resolver can refresh through a singleton while leaving an independent pool row stale.
        const row = rows[0]!;
        store.providers ??= {};
        store.providers[route] = { auth_mode: route === "openai-codex" ? "chatgpt" : "oauth_device_code",
          label: row.label, last_refresh: row.last_refresh,
          tokens: { access_token: row.access_token, refresh_token: row.refresh_token, account_id: row.account_id } };
      }
      // Hermes reseeds the derived device_code/oauth entry from the singleton. Drop independent
      // duplicates and stale mirrors so launch cannot briefly select a second token chain.
      const retained = poolOnly ? [] : deviceCodeStore
        ? rows.filter(row => row.source === "device_code" && row.refresh_token === singleton.tokens.refresh_token)
        : route === "minimax-oauth" ? rows.filter(row => row.source === "oauth" && row.refresh_token === singleton.refresh_token) : rows;
      if (!poolOnly && retained.length === rows.length) return;
      store.credential_pool[route] = retained;
      const temporary = path.join(storeDirectory, `.seed-${randomUUID()}`);
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(store));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, statePath);
        const parent = fs.openSync(storeDirectory, O_RDONLY);
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    } finally {
      fs.closeSync(lock);
    }
  } catch {
    process.stderr.write("Hermes Agent needs a valid private native credential store for its selected subscription.\n");
    process.exitCode = 1;
  }
}

export const hermesAuthLaunchScript = [
  'const fs = require("node:fs"), path = require("node:path");',
  'const { randomUUID } = require("node:crypto"), { spawnSync } = require("node:child_process");',
  `const validHermesAuthStore = ${hermesAuthValidatorSource};`,
  `(${verifyRuntimeStore.toString()})(process.env.HERMES_HOME, ${JSON.stringify(hermesAuthRouteFile)}, ${JSON.stringify(hermesAuthDirectory)}, fs, path, randomUUID, spawnSync, validHermesAuthStore);`
].join("\n");

// Retain a shared lease while Hermes is active. Relogin needs the exclusive directory lease
// and auth.lock for replacing the file. Refresh transactions only take native auth.lock.
export const hermesAuthLaunchCommand = [
  "bash", "-c",
  `exec flock -s -n -F "$HERMES_HOME/${hermesAuthDirectory}" bash -c 'node -e "$1" || exit; shift; exec "$@"' hermes-auth "$@"`,
  "hermes-auth-lease", hermesAuthLaunchScript
];
