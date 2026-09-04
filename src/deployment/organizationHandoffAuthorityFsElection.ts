import type { Stats } from "node:fs";
import { lstat as nodeLstat } from "node:fs/promises";

import { OrganizationHandoffAuthorityFailure } from "./organizationHandoffAuthorityFsBudget.js";

/**
 * Leaf inspection and link-election admission for the organization handoff
 * filesystem authority.
 *
 * These three functions decide whether a failed read may be retried or must
 * fail closed, which makes them the authority's most consequential branch and
 * the reason they live behind an injectable `lstat`: the interesting states
 * are mid-race interleavings that cannot be staged on a real filesystem.
 */

const MAX_BYTES = 32_768;

export type AuthorityLeafStat = Stats;
export type AuthorityLstat = (name: string) => Promise<AuthorityLeafStat>;

export interface AuthorityLeafInspector {
  /** Every leaf that could legitimately hold the other end of a two-link publication. */
  aliasesOf(name: string): readonly string[];
  /**
   * Whether an observed publication race is one the caller may retry.
   *
   * `true` permits a retry, `false` fails closed, and `null` reports that the
   * leaf is simply absent.
   */
  expectedElectionState(name: string): Promise<boolean | null>;
  /** Stat a leaf, rejecting anything that is not an ordinary owned record. */
  statFile(name: string): Promise<AuthorityLeafStat | null>;
}

export interface AuthorityLeafInspectorOptions {
  readonly lstat?: AuthorityLstat;
  readonly owner?: number;
}

const fail = (code: string): never => { throw new OrganizationHandoffAuthorityFailure({ code }); };

export const createAuthorityLeafInspector = (
  options: AuthorityLeafInspectorOptions = {}
): AuthorityLeafInspector => {
  const lstat = options.lstat ?? nodeLstat;
  const owner = options.owner;

  const statFile = async (name: string): Promise<AuthorityLeafStat | null> => {
    const stat = await lstat(name).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : fail("lstat_failed"));
    if (stat === null) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 2 || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0
      || owner !== undefined && stat.uid !== owner) return fail("leaf_not_ordinary");
    return stat;
  };

  const aliasesOf = (name: string): readonly string[] => [
    `${name}.pending`, `${name}.recovery`,
    ...(name.endsWith(".pending") ? [name.slice(0, -".pending".length)] : []),
    ...(name.endsWith(".recovery") ? [name.slice(0, -".recovery".length)] : [])
  ];

  const expectedElectionState = async (name: string): Promise<boolean | null> => {
    let stat = await statFile(name); if (stat === null) return null;
    if (stat.nlink === 1) return true;
    for (const alias of aliasesOf(name)) {
      const counterpart = await lstat(alias).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : fail("election_lstat_failed"));
      if (counterpart?.isFile() && !counterpart.isSymbolicLink() && counterpart.nlink === 2 && counterpart.dev === stat.dev && counterpart.ino === stat.ino) return true;
    }
    // The counterpart may have disappeared just before this check. Accept only
    // the resulting ordinary single-link state, never an unknown hard link.
    //
    // The leaf itself may also have gone: the helper that won the election
    // unlinks its staging sidecar immediately after linking the final record,
    // so a peer that observed the sidecar at two links can find it absent one
    // syscall later. That is an absence, not an unknown link. Reporting it as
    // a rejected election turned a benign, converging race into a hard failure
    // for the losing publisher.
    stat = await statFile(name); if (stat === null) return null;
    return stat.nlink === 1;
  };

  return { aliasesOf, expectedElectionState, statFile };
};
