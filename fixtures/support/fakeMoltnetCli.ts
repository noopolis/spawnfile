import { chmod, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeUtf8File } from "../../src/filesystem/index.js";

/**
 * The compiler shells out to a real `moltnet` executable twice while
 * injecting Moltnet workspace files: once for `version` (the reachability
 * probe in `validateMoltnetCli`) and once for `skill install`.
 *
 * Tests that drive the real `compileProject` therefore need that binary to
 * exist. Resolving it from PATH makes the suite pass only on a machine that
 * happens to have Moltnet installed, so tests point `SPAWNFILE_MOLTNET_CLI`
 * — the documented escape hatch — at this stand-in instead. Staging the
 * pinned release binaries is a separate concern owned by
 * `stageTrustedTestMoltnetRelease`.
 */
export const createFakeMoltnetCli = async (
  register?: (directory: string) => void
): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spawnfile-fake-moltnet-cli-"));
  register?.(directory);

  const cliPath = path.join(directory, "moltnet");
  await writeUtf8File(
    cliPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'version') {",
      "  process.stdout.write('0.0.0-test\\n');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'skill' && args[1] === 'install') {",
      "  const flags = new Map();",
      "  for (let index = 2; index < args.length; index += 2) {",
      "    flags.set(args[index], args[index + 1]);",
      "  }",
      "  const runtime = flags.get('--runtime');",
      "  const workspace = flags.get('--workspace');",
      "  const content = '# name: moltnet\\nMoltnet is a transport, not an implicit reply channel.\\n';",
      "  const targets = runtime === 'codex'",
      "    ? [",
      "        path.join(workspace, '.agents', 'skills', 'moltnet', 'SKILL.md'),",
      "        path.join(workspace, '.codex', 'skills', 'moltnet', 'SKILL.md')",
      "      ]",
      "    : [path.join(workspace, 'skills', 'moltnet', 'SKILL.md')];",
      "  for (const target of targets) {",
      "    fs.mkdirSync(path.dirname(target), { recursive: true });",
      "    fs.writeFileSync(target, content);",
      "  }",
      "  process.stdout.write(`${targets.join(', ')}\\n`);",
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected args: ${args.join(' ')}\\n`);",
      "process.exit(1);"
    ].join("\n") + "\n"
  );
  await chmod(cliPath, 0o755);
  return cliPath;
};
