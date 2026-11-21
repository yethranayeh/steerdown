import type { Edge, GraphSection } from "../src/graph.ts";

import { describe, expect, test } from "bun:test";
import { relations } from "../src/graph.ts";
import { rankLinks, scopeOf } from "../src/rank.ts";

/** One section per page, so every section is its own page unless `page` repeats one. */
function sections(pages: string[]): GraphSection[] {
  return pages.map((page, index) => ({
    id: `${page}#s${index}`,
    page,
    pageTitle: page,
    heading: `s${index}`,
    hash: String(index),
  }));
}

function edge(from: number, to: number, relation: string, probability: number): Edge {
  const probabilities = relations.map((name) => (name === relation ? probability : 0));
  return [from, to, relation, probabilities, probability];
}

/** Twenty pages, enough that the limit per target (a tenth of the sections) is two. */
const pages = Array.from({ length: 20 }, (_, index) => `p${index}.md`);

describe("rankLinks", () => {
  test("leaves out unrelated pairs and labels below the cutoff", () => {
    const links = rankLinks(
      sections(pages),
      [edge(0, 1, "detail", 0.9), edge(0, 2, "unrelated", 0.95), edge(0, 3, "detail", 0.5)],
      [],
    );
    expect(links[0]).toEqual([[1, "detail"]]);
  });

  test("shows three links, most probable first", () => {
    const links = rankLinks(
      sections(pages),
      [
        edge(0, 1, "detail", 0.7),
        edge(0, 2, "detail", 0.9),
        edge(0, 3, "alternative", 0.8),
        edge(0, 4, "detail", 0.65),
      ],
      [],
    );
    expect(links[0]).toEqual([
      [2, "detail"],
      [3, "alternative"],
      [1, "detail"],
    ]);
    expect(links.slice(1).every((list) => list.length === 0)).toBe(true);
  });

  test("keeps a next step when more probable links would crowd it out", () => {
    const links = rankLinks(
      sections(pages),
      [
        edge(0, 1, "detail", 0.95),
        edge(0, 2, "detail", 0.9),
        edge(0, 3, "detail", 0.85),
        edge(0, 4, "next_step", 0.65),
      ],
      [],
    );
    expect(links[0]!.map(([to]) => to)).toEqual([1, 2, 4]);
  });

  test("shows at most one prerequisite", () => {
    const links = rankLinks(
      sections(pages),
      [
        edge(0, 1, "prerequisite", 0.9),
        edge(0, 2, "prerequisite", 0.85),
        edge(0, 3, "detail", 0.7),
      ],
      [],
    );
    expect(links[0]).toEqual([
      [1, "prerequisite"],
      [3, "detail"],
    ]);
  });

  test("shows at most one link per page", () => {
    const shared = sections([...pages.slice(0, 18), "p1.md", "p1.md"]);
    const links = rankLinks(
      shared,
      [edge(0, 18, "detail", 0.9), edge(0, 19, "detail", 0.85), edge(0, 2, "detail", 0.7)],
      [],
    );
    expect(links[0]).toEqual([
      [18, "detail"],
      [2, "detail"],
    ]);
  });

  test("links two scopes only as alternatives", () => {
    const scoped = sections([
      "tools/a.md",
      "tools/b.md",
      "plugins/c.md",
      "plugins/d.md",
      "intro.md",
      ...pages.slice(5),
    ]);
    const links = rankLinks(
      scoped,
      [
        edge(0, 1, "detail", 0.9),
        edge(0, 2, "prerequisite", 0.9),
        edge(0, 3, "alternative", 0.8),
        edge(0, 4, "next_step", 0.7),
        edge(4, 2, "detail", 0.9),
      ],
      ["tools", "plugins/"],
    );
    expect(links[0]).toEqual([
      [1, "detail"],
      [3, "alternative"],
      [4, "next_step"],
    ]);
    expect(links[4]).toEqual([[2, "detail"]]);
  });

  test("keeps a popular target where it is most probable and refills the rest", () => {
    const popular = 19;
    const edges: Edge[] = [];
    for (let from = 0; from < 5; from++) {
      edges.push(edge(from, popular, "detail", 0.7 + from * 0.05));
      edges.push(edge(from, 10 + from, "detail", 0.65));
    }
    const links = rankLinks(sections(pages), edges, []);
    const holders = links.flatMap((list, from) =>
      list.some(([to]) => to === popular) ? [from] : [],
    );
    expect(holders).toEqual([3, 4]);
    for (let from = 0; from < 3; from++) {
      expect(links[from]).toEqual([[10 + from, "detail"]]);
    }
  });
});

describe("scopeOf", () => {
  test("takes the longest scope that holds the page", () => {
    const scopes = ["integrations", "integrations/opencode/", "integrations/codex.md"];
    expect(scopeOf("integrations/opencode/theme.md", scopes)).toBe("integrations/opencode");
    expect(scopeOf("integrations/codex.md", scopes)).toBe("integrations/codex.md");
    expect(scopeOf("integrations/rex.md", scopes)).toBe("integrations");
    expect(scopeOf("integrationsx.md", scopes)).toBeUndefined();
  });
});
