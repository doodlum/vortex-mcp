/**
 * Large offline collections for `ai:test:collection-scale`: members that are already
 * installed (a seeded library), with the shapes real collections have and that stress
 * different code paths in Vortex's collection install and update:
 *
 *   - optional members (`recommends` rules, offered after the required ones);
 *   - members referenced by a glob `fileExpression` instead of their literal bundle name;
 *   - duplicate members, exact and with the other type;
 *   - inter-member `modRules` whose references are a tag, a literal fileExpression, a glob
 *     fileExpression, or a logicalFileName nothing installed has (unresolvable, kept as is),
 *     including duplicate rules and a before-then-after pair on the same mods;
 *   - a second revision that drops members, flips members between required and optional,
 *     adds new ones and changes rules, installed the way `collectionUpdate` installs it.
 *
 * Harvested from the QA scenario for Nexus-Mods/Vortex#24283. The generator is pure and
 * deterministic, so a base and a head build get identical collections.
 */
import { referenceTag } from "./largeLibrary";
import type {
  BundledMember,
  CollectionModReference,
  CollectionModRule,
  OfflineCollection,
} from "./offlineCollection";

export interface ScaleOptions {
  /** Members in revision 1. The library must hold `members + extra` mods. */
  members: number;
  /** Fraction of members that are optional (0 to 1). Default 0. */
  optional?: number;
  /** Fraction of members referenced by a glob fileExpression. Default 0. */
  glob?: number;
  /** Duplicate member entries appended; alternate ones flip optional. Default 0. */
  duplicates?: number;
  /** Inter-member modRules (before the duplicates and the before/after pairs). Default 0. */
  rules?: number;
  /** Members revision 2 adds. Default 50. */
  extra?: number;
  /**
   * Leave the optional members out of the library: each gets a tag no installed mod has and a
   * bundled file, so the review offers them (Install optional mods / No Thanks) instead of
   * finding them installed and showing only Done. Default false.
   */
  missingOptional?: boolean;
}

/** Mods the library needs for these options. */
export function libraryCount(options: ScaleOptions): number {
  return options.members + (options.extra ?? 50);
}

/** Library mods are named "Library Mod 00012" (seedLibrary). */
const libraryName = (index: number): string => `Library Mod ${String(index).padStart(5, "0")}`;

/** Every nth index, for a fraction: 0.1 → every 10th. Undefined for none. */
function every(fraction: number | undefined): number | undefined {
  if (fraction === undefined || fraction <= 0) return undefined;
  return Math.max(1, Math.round(1 / Math.min(1, fraction)));
}

/** The tag of an optional member that is not installed (`missingOptional`). */
export const missingTag = (id: string): string => `vortex-mcp-missing-${id}`;

function member(id: string, optional: boolean, glob: boolean, missing = false): BundledMember {
  if (optional && missing) {
    // Not in the library: a tag nothing has, and a file so it can be installed if asked to.
    return {
      name: id,
      files: { [`${id}-optional.txt`]: `${id}\n` },
      tag: missingTag(id),
      optional,
    };
  }
  return {
    name: id,
    files: {},
    tag: referenceTag(id),
    optional,
    // Library ids end in a digit: the glob matches this member's bundle and its nine siblings'.
    ...(glob ? { fileExpression: `Bundled - ${id.slice(0, -1)}?*` } : {}),
  };
}

/**
 * The members of a revision. Revision 2 drops every 20th member, makes the optional ones
 * required and every 10th+5 optional, and adds `extra` members from the library's tail.
 */
export function scaleMembers(
  ids: string[],
  options: ScaleOptions,
  revision: 1 | 2,
): BundledMember[] {
  const n = options.members;
  if (ids.length < libraryCount(options)) {
    throw new Error(
      `The library has ${String(ids.length)} mods; ${String(libraryCount(options))} are needed.`,
    );
  }
  const optionalEvery = every(options.optional);
  const globEvery = every(options.glob);
  const members: BundledMember[] = [];
  for (let i = 0; i < n; i++) {
    if (revision === 2 && i % 20 === 7) continue;
    let optional = optionalEvery !== undefined && i % optionalEvery === 3 % optionalEvery;
    if (revision === 2 && optionalEvery !== undefined) {
      if (optional) optional = false;
      else if (i % optionalEvery === 5 % optionalEvery) optional = true;
    }
    members.push(
      member(
        ids[i]!,
        optional,
        globEvery !== undefined && i % globEvery === 11 % globEvery,
        options.missingOptional === true,
      ),
    );
  }
  if (revision === 2) {
    for (let i = n; i < n + (options.extra ?? 50); i++) members.push(member(ids[i]!, false, false));
  }
  const pool = Math.max(1, Math.min(n, n - 200));
  for (let j = 0; j < (options.duplicates ?? 0); j++) {
    const base = members.find((m) => m.name === ids[(j * 97 + (revision === 2 ? 5 : 0)) % pool]);
    if (base === undefined) continue;
    // A duplicate of a missing optional member stays that member; flipping it to required
    // would make a required member missing, which fails the install.
    const flip = j % 2 === 1 && !(options.missingOptional === true && base.optional === true);
    members.push(flip ? { ...base, optional: base.optional !== true } : { ...base });
  }
  return members;
}

/**
 * Inter-member rules, ordered by index (a before b with a < b; b after a), so they form no
 * cycle. Revision 2 drops every 11th and turns every 9th into an `after` rule.
 */
export function scaleRules(
  ids: string[],
  options: ScaleOptions,
  revision: 1 | 2,
): CollectionModRule[] {
  const count = options.rules ?? 0;
  if (count <= 0) return [];
  const n = options.members;
  // The last 200 members (or fewer, for a small collection) are kept for before/after pairs.
  const reserved = Math.min(200, Math.floor(n / 4));
  const span = n - reserved;
  const tag = (i: number): string => referenceTag(ids[i]!);
  const rules: CollectionModRule[] = [];
  const limit = span > 2 ? count : 0;
  for (let k = 0; k < limit; k++) {
    if (revision === 2 && k % 11 === 4) continue;
    const a = (k * 7) % (span - 1);
    const b = Math.min(span - 1, a + 1 + ((k * 13) % 50));
    if (b <= a) continue;
    const kind = k % 5;
    const reference: CollectionModReference =
      kind === 0
        ? { fileExpression: libraryName(b) }
        : kind === 1
          ? { fileExpression: `${libraryName(b).slice(0, -1)}[${libraryName(b).slice(-1)}]` }
          : kind === 2
            ? { logicalFileName: `vortex-mcp-missing-${String(k)}`, versionMatch: "*" }
            : { tag: tag(b) };
    const after = (revision === 2 && k % 9 === 2) || k % 2 === 1;
    const rule: CollectionModRule = after
      ? { source: { tag: tag(b) }, type: "after", reference: { tag: tag(a) } }
      : { source: { tag: tag(a) }, type: "before", reference };
    rules.push(rule);
    if (k % 17 === 0) rules.push({ ...rule });
  }
  // Before, then after, on the same pair: the second replaces the first.
  for (let j = 0; j < Math.min(40, Math.floor(reserved / 2)); j++) {
    const a = span + 2 * j;
    rules.push({ source: { tag: tag(a) }, type: "before", reference: { tag: tag(a + 1) } });
    if (j % 2 === (revision === 1 ? 0 : 1)) {
      rules.push({ source: { tag: tag(a) }, type: "after", reference: { tag: tag(a + 1) } });
    }
  }
  return rules;
}

/** One revision of the scale collection. */
export function scaleCollection(
  ids: string[],
  gameId: string,
  options: ScaleOptions,
  revision: 1 | 2,
  name: string,
): OfflineCollection {
  return {
    name,
    gameId,
    members: scaleMembers(ids, options, revision),
    modRules: scaleRules(ids, options, revision),
  };
}
