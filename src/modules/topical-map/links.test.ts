import { describe, expect, it } from "vitest";
import { anchorSuggestions, buildLinkPlans, type LinkItem } from "./links";

const items: LinkItem[] = Array.from({ length: 8 }, (_, i) => ({ id: `id${i}`, keyword: `peinados tema ${i}`, variants: i === 1 ? ["peinados tema uno"] : [], siloIndex: i < 6 ? 0 : 1, priorityRank: i }));

describe("link plans", () => {
  const pillars = new Map([[0, 0], [1, 6]]);
  const edges = [{ a: 1, b: 2, sim: 0.9 }, { a: 1, b: 3, sim: 0.8 }, { a: 1, b: 4, sim: 0.7 }, { a: 1, b: 7, sim: 0.99 }, { a: 2, b: 3, sim: 0.6 }];
  const plans = buildLinkPlans(items, pillars, edges);
  it("the pillar links to every child of its silo", () => {
    expect(plans[0]!.children).toEqual(["id1", "id2", "id3", "id4", "id5"]);
    expect(plans[0]!.pillar).toBeNull();
  });
  it("a child links to its pillar and its most similar siblings, within 2-5, never across silos", () => {
    expect(plans[1]!.pillar).toBe("id0");
    expect(plans[1]!.siblings).toEqual(["id2", "id3", "id4"]);
    expect(plans[1]!.siblings.includes("id7")).toBe(false);
  });
  it("an item with no neighbours still gets at least 2 siblings", () => {
    expect(plans[5]!.siblings.length).toBe(2);
    expect(plans[5]!.siblings.includes("id0")).toBe(false);
  });
  it("a silo of two has the pillar and one child without crashing", () => {
    expect(plans[7]!.pillar).toBe("id6");
    expect(plans[6]!.children).toEqual(["id7"]);
  });
  it("anchors: keyword, variants, short form, no duplicates", () => {
    expect(anchorSuggestions("peinados faciles para boda en casa", ["Peinados faciles para boda en casa", "peinados sencillos"])).toEqual(["peinados faciles para boda en casa", "peinados sencillos", "peinados faciles para boda"]);
  });
});
