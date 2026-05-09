import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

export const createWorkspaceResourceCommands = (plan: RuntimeTargetPlan): string[] =>
  (plan.resources ?? []).flatMap((resource) => {
    const readonlyFlag = resource.mode === "readonly" ? "readonly" : "mutable";
    if (resource.kind === "volume") {
      return [
        `prepare_volume_resource ${shellQuote(resource.id)} ${shellQuote(resource.mount)} ${shellQuote(readonlyFlag)}`
      ];
    }

    const selectorKind = resource.branch
      ? "branch"
      : resource.tag
        ? "tag"
        : resource.ref
          ? "ref"
          : "none";
    const selectorValue = resource.branch ?? resource.tag ?? resource.ref ?? "";

    return [
      `prepare_git_resource ${shellQuote(resource.id)} ${shellQuote(resource.mount)} ${shellQuote(resource.url ?? "")} ${shellQuote(selectorKind)} ${shellQuote(selectorValue)} ${shellQuote(readonlyFlag)}`
    ];
  });

export const createWorkspaceResourceShellFunctions = (): string[] => [
  "directory_is_empty() {",
  '  local target="$1"',
  '  [ -d "$target" ] && [ -z "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]',
  "}",
  "",
  "mark_readonly_resource() {",
  '  local target="$1"',
  '  local mode="$2"',
  '  if [ "$mode" = "readonly" ]; then',
  '    chmod -R a-w "$target"',
  "  fi",
  "}",
  "",
  "prepare_volume_resource() {",
  '  local id="$1"',
  '  local target="$2"',
  '  local mode="$3"',
  '  mkdir -p "$target"',
  '  if [ ! -d "$target" ]; then',
  '    echo "Workspace volume resource $id is not a directory: $target" >&2',
  "    exit 1",
  "  fi",
  '  mark_readonly_resource "$target" "$mode"',
  "}",
  "",
  "prepare_git_resource() {",
  '  local id="$1"',
  '  local target="$2"',
  '  local remote="$3"',
  '  local selector_kind="$4"',
  '  local selector_value="$5"',
  '  local mode="$6"',
  '  if [ -d "$target/.git" ]; then',
  '    local existing_remote',
  '    existing_remote="$(git -C "$target" config --get remote.origin.url || true)"',
  '    if [ "$existing_remote" != "$remote" ]; then',
  '      echo "Workspace git resource $id has remote $existing_remote, expected $remote" >&2',
  "      exit 1",
  "    fi",
  '    if [ "$selector_kind" = "branch" ]; then',
  '      local branch',
  '      branch="$(git -C "$target" rev-parse --abbrev-ref HEAD)"',
  '      if [ "$branch" != "$selector_value" ]; then',
  '        echo "Workspace git resource $id is on branch $branch, expected $selector_value" >&2',
  "        exit 1",
  "      fi",
    '    elif [ "$selector_kind" = "tag" ]; then',
    '      local tag',
    '      tag="$(git -C "$target" describe --tags --exact-match 2>/dev/null || true)"',
    '      if [ "$tag" != "$selector_value" ]; then',
    '        echo "Workspace git resource $id is on tag $tag, expected $selector_value" >&2',
    "        exit 1",
    "      fi",
  '    elif [ "$selector_kind" = "ref" ]; then',
  '      local current_ref',
  '      current_ref="$(git -C "$target" rev-parse HEAD)"',
  '      if [ "$current_ref" != "$selector_value" ]; then',
  '        echo "Workspace git resource $id is on ref $current_ref, expected $selector_value" >&2',
  "        exit 1",
  "      fi",
    "    fi",
  '    mark_readonly_resource "$target" "$mode"',
  "    return",
  "  fi",
  '  if [ -e "$target" ] && ! directory_is_empty "$target"; then',
  '    echo "Workspace git resource $id target is not empty: $target" >&2',
  "    exit 1",
  "  fi",
  '  mkdir -p "$(dirname "$target")"',
  '  if [ "$selector_kind" = "branch" ]; then',
  '    git clone --branch "$selector_value" "$remote" "$target"',
  "  else",
  '    git clone "$remote" "$target"',
  '    if [ "$selector_kind" = "tag" ] || [ "$selector_kind" = "ref" ]; then',
  '      git -C "$target" checkout "$selector_value"',
  "    fi",
  "  fi",
  '  mark_readonly_resource "$target" "$mode"',
  "}",
  ""
];
