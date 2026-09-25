import { describe, expect, it } from "vitest";

import {
  libraryCount,
  missingTag,
  scaleCollection,
  scaleMembers,
  scaleRules,
} from "./collectionScale";
import { referenceTag } from "./largeLibrary";

const ids = Array.from(
  { length: 700 },
  (_, i) => `vortex-ai-library-${String(i).padStart(5, "0")}`,
);

describe("scale collections", () => {
  it("are all-required and rule-free without options, as the check always was", () => {
    const collection = scaleCollection(ids, "vortexaisandbox", { members: 100, extra: 0 }, 1, "C");
    expect(collection.members).toHaveLength(100);
    expect(
      collection.members.every((m) => m.optional === false && m.fileExpression === undefined),
    ).toBe(true);
    expect(collection.members[0]).toMatchObject({ files: {}, tag: referenceTag(ids[0]!) });
    expect(collection.modRules).toEqual([]);
  });

  it("mark a fraction optional, glob some references, and add duplicates of both types", () => {
    const options = { members: 400, optional: 0.1, glob: 0.04, duplicates: 20 };
    const members = scaleMembers(ids, options, 1);
    expect(members.filter((m) => m.optional).length).toBeGreaterThanOrEqual(40);
    const globs = members.filter((m) => m.fileExpression !== undefined);
    expect(globs.length).toBeGreaterThanOrEqual(16);
    expect(globs[0]?.fileExpression).toMatch(/^Bundled - vortex-ai-library-\d{4}\?\*$/);
    expect(members).toHaveLength(420);
    const names = members.map((m) => m.name);
    const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicated).toHaveLength(20);
    const flipped = duplicated.filter((name) => {
      const entries = members.filter((m) => m.name === name);
      return new Set(entries.map((m) => m.optional)).size > 1;
    });
    expect(flipped.length).toBeGreaterThan(0);
  });

  it("change revision 2: drop members, flip optional ones, add extras", () => {
    const options = { members: 400, optional: 0.1, extra: 50 };
    const rev1 = scaleMembers(ids, options, 1);
    const rev2 = scaleMembers(ids, options, 2);
    const names1 = new Set(rev1.map((m) => m.name));
    const names2 = new Set(rev2.map((m) => m.name));
    expect([...names1].filter((n) => !names2.has(n))).toHaveLength(20);
    expect([...names2].filter((n) => !names1.has(n))).toHaveLength(50);
    const optional1 = new Set(rev1.filter((m) => m.optional).map((m) => m.name));
    const optional2 = new Set(rev2.filter((m) => m.optional).map((m) => m.name));
    expect([...optional1].some((n) => optional2.has(n))).toBe(false);
    expect(optional2.size).toBeGreaterThan(0);
    expect(libraryCount(options)).toBe(450);
    expect(() => scaleMembers(ids.slice(0, 420), options, 2)).toThrow(/450 are needed/);
  });

  it("write every kind of rule reference, acyclically, with duplicates and before/after pairs", () => {
    const rules = scaleRules(ids, { members: 600, rules: 300 }, 1);
    const kinds = new Set(
      rules.map((r) =>
        r.reference.tag !== undefined
          ? "tag"
          : r.reference.logicalFileName !== undefined
            ? "unresolvable"
            : /\[/.test(r.reference.fileExpression ?? "")
              ? "glob"
              : "literal",
      ),
    );
    expect([...kinds].toSorted()).toEqual(["glob", "literal", "tag", "unresolvable"]);
    expect(rules.length - new Set(rules.map((r) => JSON.stringify(r))).size).toBeGreaterThan(0);
    // A before and an after on the same pair of mods.
    const pairs = rules.filter((r) => r.reference.tag !== undefined);
    expect(
      pairs.some(
        (b) =>
          b.type === "before" &&
          pairs.some(
            (a) =>
              a.type === "after" &&
              a.source.tag === b.source.tag &&
              a.reference.tag === b.reference.tag,
          ),
      ),
    ).toBe(true);
    // Every `before` points to a later mod and every `after` to an earlier one: no cycles.
    const index = (tag: string | undefined): number =>
      ids.findIndex((id) => referenceTag(id) === tag);
    for (const rule of rules) {
      if (rule.reference.tag === undefined || rule.source.tag === rule.reference.tag) continue;
      const [from, to] = [index(rule.source.tag), index(rule.reference.tag)];
      // The last quarter (150 of 600) holds the deliberate before-then-after pairs.
      if (Math.max(from, to) >= 450) continue;
      if (rule.type === "before") expect(from).toBeLessThan(to);
      else expect(from).toBeGreaterThan(to);
    }
    const rev2 = scaleRules(ids, { members: 600, rules: 300 }, 2);
    expect(rev2).not.toEqual(rules);
  });
});

describe("missing optional members", () => {
  it("give optional members a tag nothing installed has and a file, so the review offers them", () => {
    const options = { members: 200, optional: 0.1, duplicates: 40, missingOptional: true };
    const members = scaleMembers(ids, options, 1);
    // The members themselves; a duplicate of a required member flipped to optional stays installed.
    const optional = members.slice(0, 200).filter((m) => m.optional === true);
    expect(optional.length).toBeGreaterThanOrEqual(20);
    for (const m of optional) {
      expect(m.tag).toBe(missingTag(m.name));
      expect(Object.keys(m.files)).toEqual([`${m.name}-optional.txt`]);
    }
    // Required members are the installed library mods, as without the option.
    for (const required of members.filter((m) => m.optional !== true)) {
      expect(required.tag).toBe(referenceTag(required.name));
    }
    // No duplicate turns a missing optional member into a required one.
    const required = new Set(members.filter((m) => m.optional !== true).map((m) => m.tag));
    expect(optional.some((m) => required.has(m.tag))).toBe(false);
    // Without the option, every member is in the library.
    expect(
      scaleMembers(ids, { members: 200, optional: 0.1 }, 1).every(
        (m) => m.tag === referenceTag(m.name),
      ),
    ).toBe(true);
  });
});
