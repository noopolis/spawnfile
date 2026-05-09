import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

export const createWorkspaceResourceCommands = (plan: RuntimeTargetPlan): string[] =>
  (plan.resources ?? []).flatMap((resource) => {
    const readonlyFlag = resource.mode === "readonly" ? "readonly" : "mutable";
    if (resource.kind === "volume") {
      return [
        `prepare_volume_resource ${shellQuote(resource.id)} ${shellQuote(resource.linkPath)} ${shellQuote(resource.backingPath)} ${shellQuote(readonlyFlag)}`
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
      `prepare_git_resource ${shellQuote(resource.id)} ${shellQuote(resource.linkPath)} ${shellQuote(resource.backingPath)} ${shellQuote(resource.url ?? "")} ${shellQuote(selectorKind)} ${shellQuote(selectorValue)} ${shellQuote(readonlyFlag)}`
    ];
  });

export const createWorkspaceResourceShellFunctions = (): string[] => [
  "directory_is_empty() {",
  '  local target="$1"',
  '  [ -d "$target" ] && [ -z "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]',
  "}",
  "",
  "prepare_resource_link() {",
  '  local id="$1"',
  '  local link_path="$2"',
  '  local backing_path="$3"',
  '  mkdir -p "$(dirname "$link_path")"',
  '  if [ -L "$link_path" ]; then',
  '    local existing_target',
  '    existing_target="$(readlink "$link_path")"',
  '    if [ "$existing_target" != "$backing_path" ]; then',
  '      echo "Workspace resource $id link points to $existing_target, expected $backing_path" >&2',
  "      exit 1",
  "    fi",
  "    return",
  "  fi",
  '  if [ -e "$link_path" ]; then',
  '    echo "Workspace resource $id mount path already exists and is not a symlink: $link_path" >&2',
  "    exit 1",
  "  fi",
  '  ln -s "$backing_path" "$link_path"',
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
  '  local link_path="$2"',
  '  local backing_path="$3"',
  '  local mode="$4"',
  '  mkdir -p "$backing_path"',
  '  if [ ! -d "$backing_path" ]; then',
  '    echo "Workspace volume resource $id backing path is not a directory: $backing_path" >&2',
  "    exit 1",
  "  fi",
  '  mark_readonly_resource "$backing_path" "$mode"',
  '  prepare_resource_link "$id" "$link_path" "$backing_path"',
  "}",
  "",
  "prepare_git_resource() {",
  '  local id="$1"',
  '  local link_path="$2"',
  '  local backing_path="$3"',
  '  local remote="$4"',
  '  local selector_kind="$5"',
  '  local selector_value="$6"',
  '  local mode="$7"',
  '  if [ -d "$backing_path/.git" ]; then',
  '    local existing_remote',
  '    existing_remote="$(git -C "$backing_path" config --get remote.origin.url || true)"',
  '    if [ "$existing_remote" != "$remote" ]; then',
  '      echo "Workspace git resource $id has remote $existing_remote, expected $remote" >&2',
  "      exit 1",
  "    fi",
  '    if [ "$selector_kind" = "branch" ]; then',
  '      local branch',
  '      branch="$(git -C "$backing_path" rev-parse --abbrev-ref HEAD)"',
  '      if [ "$branch" != "$selector_value" ]; then',
  '        echo "Workspace git resource $id is on branch $branch, expected $selector_value" >&2',
  "        exit 1",
  "      fi",
    '    elif [ "$selector_kind" = "tag" ]; then',
    '      local tag',
    '      tag="$(git -C "$backing_path" describe --tags --exact-match 2>/dev/null || true)"',
    '      if [ "$tag" != "$selector_value" ]; then',
    '        echo "Workspace git resource $id is on tag $tag, expected $selector_value" >&2',
    "        exit 1",
    "      fi",
  '    elif [ "$selector_kind" = "ref" ]; then',
  '      local current_ref',
  '      current_ref="$(git -C "$backing_path" rev-parse HEAD)"',
  '      if [ "$current_ref" != "$selector_value" ]; then',
  '        echo "Workspace git resource $id is on ref $current_ref, expected $selector_value" >&2',
  "        exit 1",
  "      fi",
    "    fi",
  '    mark_readonly_resource "$backing_path" "$mode"',
  '    prepare_resource_link "$id" "$link_path" "$backing_path"',
  "    return",
  "  fi",
  '  if [ -e "$backing_path" ] && ! directory_is_empty "$backing_path"; then',
  '    echo "Workspace git resource $id backing path is not empty: $backing_path" >&2',
  "    exit 1",
  "  fi",
  '  mkdir -p "$(dirname "$backing_path")"',
  '  if [ "$selector_kind" = "branch" ]; then',
  '    git clone --branch "$selector_value" "$remote" "$backing_path"',
  "  else",
  '    git clone "$remote" "$backing_path"',
  '    if [ "$selector_kind" = "tag" ] || [ "$selector_kind" = "ref" ]; then',
  '      git -C "$backing_path" checkout "$selector_value"',
  "    fi",
  "  fi",
  '  mark_readonly_resource "$backing_path" "$mode"',
  '  prepare_resource_link "$id" "$link_path" "$backing_path"',
  "}",
  ""
];
