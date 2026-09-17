/** Pure helpers for the Docker-deferred training image mode comparison. */

/** One `find -printf` record per entry: path, octal mode, owner, group, type, link target. */
export const MODE_LISTING_FORMAT = "%p\\t%m\\t%u\\t%g\\t%y\\t%l\\n";
export const MODE_ROOTS = ["/opt/training", "/opt/training/paideia/bridges/dspy/.venv"] as const;
/** The former recipe's whole-tree closure; a control recipe without it is not a control. */
export const CONTROL_CLOSURE = "chmod -R a+rX /opt/training";

export interface ModeListingDiff { onlyNew: string[]; onlyControl: string[]; changed: { path: string; next: string; control: string }[] }

/** Instruction text only: Dockerfile comments may mention the closure without running it. */
const instructions = (dockerfile: string): string => dockerfile.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n");

export function assertControlRecipe(dockerfile: string): void {
  if (!instructions(dockerfile).includes(CONTROL_CLOSURE)) throw Error(`Control recipe must run "${CONTROL_CLOSURE}"`);
}

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
