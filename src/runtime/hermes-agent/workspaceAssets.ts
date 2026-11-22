import type { EmittedFile } from "../types.js";
import { hermesWorkspaceReconciler } from "./workspaceReconciler.js";

const imageRoot = "/opt/spawnfile/hermes-workspace-assets";
const workspaceScript = "spawnfile-workspace-assets.py";
const workspaceManifest = "spawnfile-workspace-assets.json";
const python = "/opt/hermes/.venv/bin/python";

export function hermesWorkspaceAssetFiles(files: EmittedFile[]): EmittedFile[] {
  return [
    { path: `home/${workspaceManifest}`, content: JSON.stringify(files.map(file => file.path.slice("workspace/".length))) },
    { path: `home/${workspaceScript}`, content: hermesWorkspaceReconciler }
  ];
}

// Capture after rootfs assembly, including the compiler's Moltnet output. The second copy
// lives outside volume mounts and all paths chowned to the runtime account.
export const hermesWorkspaceCaptureCommand = [
  "find /var/lib/spawnfile/instances/hermes-agent -mindepth 2 -maxdepth 2 -type d -name hermes",
  "-exec bash -ec 'for home; do",
  `instance=\${home%/hermes}; seed="${imageRoot}/\${instance##*/}";`,
  'install -d -m 0755 "$seed" "$instance/workspace";',
  `install -m 0444 "$home/${workspaceScript}" "$seed/reconcile.py";`,
  `${python} "$seed/reconcile.py" capture "$instance/workspace" "$home/${workspaceManifest}";`,
  `rm "$home/${workspaceScript}" "$home/${workspaceManifest}"; done' bash {} +`
].join(" ");

export const hermesWorkspaceLaunchCommand = [
  "bash", "-ec",
  `instance=\${HERMES_HOME%/hermes}; exec ${python} "${imageRoot}/\${instance##*/}/reconcile.py" "$HERMES_WRITE_SAFE_ROOT" "$@"`,
  "hermes-workspace"
];
