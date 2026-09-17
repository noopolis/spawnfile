/** Pure helpers for the Docker-deferred training image mode comparison. */

/** One `find -printf` record per entry: path, octal mode, owner, group, type, link target. */
export const MODE_LISTING_FORMAT = "%p\\t%m\\t%u\\t%g\\t%y\\t%l\\n";
export const MODE_ROOTS = ["/opt/training", "/opt/training/paideia/bridges/dspy/.venv"] as const;
/**
 * `find` arguments. Only non-nested roots: `find a a/b` walks `a/b` twice and every
 * entry beneath it would arrive duplicated, which `parse` rejects. The venv stays a
 * required entry above, so its absence is still a failure.
 */
export const LISTING_ROOTS = MODE_ROOTS.filter((root, _index, all) =>
  !all.some(other => other !== root && root.startsWith(other + "/")));
/** The former recipe's whole-tree closure; a control recipe without it is not a control. */
export const CONTROL_CLOSURE = "chmod -R a+rX /opt/training";

export interface ModeListingDiff { onlyNew: string[]; onlyControl: string[]; changed: { path: string; next: string; control: string }[] }

/** Instruction text only: Dockerfile comments may mention the closure without running it. */
const instructions = (dockerfile: string): string => dockerfile.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n");

export function assertControlRecipe(dockerfile: string): void {
  if (!instructions(dockerfile).includes(CONTROL_CLOSURE)) throw Error(`Control recipe must run "${CONTROL_CLOSURE}"`);
}

/**
 * The control recipe: this exact recipe with the old whole-tree closure back.
 *
 * A git-ref control only works while some commit carries the same layout with
 * the recursive chmod, which stops being true the moment the recipe gains a
 * layer. Deriving it keeps the comparison about the one thing under test — the
 * mode mechanism — instead of about everything else that changed since.
 * Each change-only `find` closure becomes a no-op, and the former final
 * `chmod 0555 <entrypoints> && chmod -R a+rX /opt/training` runs after the last
 * COPY, exactly where the old recipe ran it.
 */
export function deriveControlRecipe(dockerfile: string): string {
  const closures = dockerfile.match(/find \S+ \\\( .*? -exec chmod a\+rX \{\} \+/gu) ?? [];
  if (closures.length === 0) throw Error("Recipe has no change-only a+rX closure to replace");
  let control = closures.reduce((text, closure) => text.replace(closure, "true"), dockerfile);
  const anchor = control.indexOf("\nENV PATH=");
  if (anchor === -1) throw Error("Recipe has no trailing ENV PATH to anchor the control closure");
  const restore = `\nRUN chmod 0555 ${ENTRYPOINT_PATHS.join(" ")} \\\n && ${CONTROL_CLOSURE}\n`;
  control = control.slice(0, anchor) + restore + control.slice(anchor + 1);
  assertControlRecipe(control);
  return control;
}

/** The entrypoints the former recipe forced to 0555 before its whole-tree closure. */
export const ENTRYPOINT_PATHS = ["/opt/training/bin/train", "/opt/training/bin/train-broker"] as const;

export function assertNewRecipe(dockerfile: string): void {
  if (instructions(dockerfile).includes(CONTROL_CLOSURE)) throw Error("New recipe still runs the recursive chmod; nothing would be compared");
}

function parse(listing: string, label: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of listing.split("\n")) {
    if (!line) continue;
    const [entry, ...fields] = line.split("\t");
    if (!entry || fields.length !== 5) throw Error(`Malformed ${label} listing line: ${line}`);
    if (entries.has(entry)) throw Error(`Duplicate ${label} listing entry: ${entry}`);
    entries.set(entry, fields.join("\t"));
  }
  if (!MODE_ROOTS.every(root => entries.has(root))) throw Error(`${label} listing is missing a required root (${MODE_ROOTS.join(", ")})`);
  return entries;
}

/** Compares modes, owners, groups, types and link targets; mtimes are deliberately excluded. */
export function diffModeListings(next: string, control: string): ModeListingDiff {
  const left = parse(next, "new"), right = parse(control, "control");
  const diff: ModeListingDiff = { onlyNew: [], onlyControl: [], changed: [] };
  for (const [entry, fields] of left) {
    const other = right.get(entry);
    if (other === undefined) diff.onlyNew.push(entry);
    else if (other !== fields) diff.changed.push({ path: entry, next: fields, control: other });
  }
  for (const entry of right.keys()) if (!left.has(entry)) diff.onlyControl.push(entry);
  for (const list of [diff.onlyNew, diff.onlyControl]) list.sort();
  diff.changed.sort((a, b) => a.path.localeCompare(b.path));
  return diff;
}

export const identicalModes = (diff: ModeListingDiff): boolean =>
  diff.onlyNew.length === 0 && diff.onlyControl.length === 0 && diff.changed.length === 0;
