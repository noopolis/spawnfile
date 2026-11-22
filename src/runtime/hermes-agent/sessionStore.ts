import type { ContainerTargetPersistentMount } from "../types.js";

const sessionStoreDirectory = ".spawnfile-session-store";
const imageLinks = ["config.yaml", "SOUL.md", "auth.json", "auth.lock", "cron"];

export function hermesSessionMount(slug: string): ContainerTargetPersistentMount {
  return {
    id: `hermes-agent-${slug}-sessions`,
    lifecycle: "exclusive-reattach",
    mountPath: `<instance-root>/hermes/${sessionStoreDirectory}`,
    reason: "Hermes Agent native sessions and transcript recovery"
  };
}

export const hermesSessionStoreCommand = [
  "find /var/lib/spawnfile/instances/hermes-agent -mindepth 2 -maxdepth 2 -type d -name hermes",
  `-exec bash -ec 'for home; do install -d -m 0700 "$home/${sessionStoreDirectory}"; done' bash {} +`
].join(" ");

// The pinned gateway reserves its profile only if the resolved session database is a
// direct child of HERMES_HOME. Launch against the mounted native profile and link back
// to the rebuilt compiler config and independently mounted credentials and cron state.
export const hermesNativeSessionCommand = [
  "bash", "-ec",
  [
    "fail() { echo 'Could not prepare the private Hermes session home.' >&2; exit 1; }",
    `store="$HERMES_HOME/${sessionStoreDirectory}"`,
    '[ -d "$store" ] && [ ! -L "$store" ] && [ "$(stat -c %a:%u "$store")" = "700:$(id -u)" ] || fail',
    `for name in ${imageLinks.join(" ")}; do
  target="$store/$name"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    ln -sT -- "../$name" "$target" 2>/dev/null || [ -L "$target" ] || fail
  fi
  [ "$(readlink -- "$target")" = "../$name" ] || fail
done`,
    'export HERMES_HOME="$store"',
    'exec "$@"'
  ].join("\n"),
  "hermes-session-home"
];
