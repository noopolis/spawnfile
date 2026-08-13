import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

export const createConfigEnvWrites = (plan: RuntimeTargetPlan): string[] =>
  (plan.configEnvBindings ?? []).map(
    (binding) =>
      `apply_json_env_value ${shellQuote(plan.instancePaths.configPath)} ${shellQuote(binding.envName)} ${shellQuote(
        typeof binding.jsonPath === "string" ? binding.jsonPath : JSON.stringify(binding.jsonPath)
      )}${binding.transform ? ` ${shellQuote(binding.transform)}` : ""}`
  );

export const createConfigEnvMaterializationFunction = (): string[] => [
  "apply_json_env_value() {",
  '  local target="$1"',
  '  local name="$2"',
  '  local json_path="$3"',
  '  local transform="${4:-}"',
  '  if [ -z "${!name:-}" ]; then',
  "    return",
  "  fi",
  '  python3 - "$target" "$name" "$json_path" "$transform" <<\'PY\'',
  "import json",
  "import os",
  "import sys",
  "",
  "target_path = sys.argv[1]",
  "env_name = sys.argv[2]",
  "json_path_arg = sys.argv[3]",
  "json_path = json.loads(json_path_arg) if json_path_arg.startswith('[') else json_path_arg.split('.')",
  "transform = sys.argv[4] if len(sys.argv) > 4 else ''",
  "value = os.environ.get(env_name)",
  "if value is None:",
  "    raise SystemExit(0)",
  "if transform == 'bearer':",
  "    value = f'Bearer {value}'",
  "elif transform:",
  "    raise SystemExit(f'Unsupported config env transform: {transform}')",
  "",
  "with open(target_path, encoding='utf-8') as handle:",
  "    data = json.load(handle)",
  "",
  "cursor = data",
  "for part in json_path[:-1]:",
  "    if isinstance(cursor, list):",
  "        cursor = cursor[int(part)]",
  "        continue",
  "    child = cursor.get(part)",
  "    if not isinstance(child, (dict, list)):",
  "        child = {}",
  "        cursor[part] = child",
  "    cursor = child",
  "",
  "if isinstance(cursor, list):",
  "    cursor[int(json_path[-1])] = value",
  "else:",
  "    cursor[json_path[-1]] = value",
  "",
  "with open(target_path, 'w', encoding='utf-8') as handle:",
  "    json.dump(data, handle, indent=2)",
  "    handle.write('\\n')",
  "PY",
  "}",
];
