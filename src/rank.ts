import type { Edge, GraphSection, Link } from "./graph.ts";

import { relations } from "./graph.ts";

const linksPerSection = 3;
/**
 * Labels below this probability are left out.
 * Above it, independent runs agree on nearly every label.
 */
const minimumProbability = 0.6;
/** Largest share of sections whose links may point to one target. */
const largestTargetShare = 0.1;

type Candidate = { to: number; relation: string; probability: number };

/** Sorts candidates by falling probability, then by target index. */
function mostProbableFirst(first: Candidate, second: Candidate) {
  return second.probability - first.probability || first.to - second.to;
}

/** The scope a page belongs to: the longest scope path that is the page or a folder holding it. */
export function scopeOf(page: string, scopes: Array<string>) {
  let found: string | undefined;
  for (const path of scopes) {
    const scope = path.replace(/\/+$/, "");
    const holdsPage = page === scope || page.startsWith(`${scope}/`);
    if (holdsPage && (found === undefined || scope.length > found.length)) {
      found = scope;
    }
  }

  return found;
}

/** Each section's judged links that may be shown, most probable first. */
function candidatesBySection(
  sections: Array<GraphSection>,
  edges: Array<Edge>,
  scopes: Array<string>,
): Array<Array<Candidate>> {
  const sectionScopes = sections.map((section) => scopeOf(section.page, scopes));
  const candidates: Array<Array<Candidate>> = sections.map(() => []);

  for (const [from, to, relation, probabilities] of edges) {
    const probability = probabilities[relations.indexOf(relation as (typeof relations)[number])];
    const isShown = relation !== "unrelated" && probability !== undefined;

    if (!isShown || probability < minimumProbability) {
      continue;
    }

    const fromScope = sectionScopes[from];
    const toScope = sectionScopes[to];
    // Sections from two different scopes cover different products, so only another way to the
    // same goal is a useful link between them.
    const crossesScopes = fromScope !== undefined && toScope !== undefined && fromScope !== toScope;
    if (crossesScopes && relation !== "alternative") {
      continue;
    }

    candidates[from]!.push({ to, relation, probability });
  }

  for (const list of candidates) {
    list.sort(mostProbableFirst);
  }

  return candidates;
}

/** True when a candidate is not yet picked and adds neither a second prerequisite nor a page already linked. */
function fitsWithPicked(
  candidate: Candidate,
  picked: Array<Candidate>,
  sections: Array<GraphSection>,
) {
  const isPicked = picked.includes(candidate);
  const isSecondPrerequisite =
    candidate.relation === "prerequisite" &&
    picked.some((link) => link.relation === "prerequisite");
  const sharesPage = picked.some(
    (link) => sections[link.to]!.page === sections[candidate.to]!.page,
  );
  return !isPicked && !isSecondPrerequisite && !sharesPage;
}

/**
 * Picks up to three links from the candidates: the most probable `next_step` whenever there is
 * one, then the most probable rest, with at most one `prerequisite` and one link per page.
 */
function pickLinks(candidates: Array<Candidate>, sections: Array<GraphSection>): Array<Candidate> {
  const picked: Array<Candidate> = [];
  const nextStep = candidates.find((candidate) => candidate.relation === "next_step");
  if (nextStep !== undefined) {
    picked.push(nextStep);
  }

  for (const candidate of candidates) {
    const hasRoom = picked.length < linksPerSection;
    if (hasRoom && fitsWithPicked(candidate, picked, sections)) {
      picked.push(candidate);
    }
  }

  return picked.sort(mostProbableFirst);
}

/**
 * Finds targets in the links of more sections than the limit. Each stays with the sections that
 * judged it most probable and is removed from the other sections' candidates.
 * Returns the sections that lost a candidate and need to pick again.
 */
function dropTargetsOverLimit(
  picks: Array<Array<Candidate>>,
  candidates: Array<Array<Candidate>>,
  mostSectionsPerTarget: number,
) {
  const holders = new Map<number, Array<{ from: number; probability: number }>>();
  picks.forEach((links, from) => {
    for (const link of links) {
      const list = holders.get(link.to) ?? [];
      list.push({ from, probability: link.probability });
      holders.set(link.to, list);
    }
  });

  const losers = new Set<number>();
  for (const [to, list] of holders) {
    if (list.length <= mostSectionsPerTarget) {
      continue;
    }
    list.sort(
      (first, second) => second.probability - first.probability || first.from - second.from,
    );
    for (const { from } of list.slice(mostSectionsPerTarget)) {
      candidates[from] = candidates[from]!.filter((candidate) => candidate.to !== to);
      losers.add(from);
    }
  }

  return losers;
}

/**
 * Ranks each section's links. A target may appear in the links of at most a tenth of the
 * sections. Sections that lose a target pick again until no target is over the limit.
 */
export function rankLinks(
  sections: Array<GraphSection>,
  edges: Array<Edge>,
  scopes: Array<string>,
): Array<Array<Link>> {
  const candidates = candidatesBySection(sections, edges, scopes);
  const mostSectionsPerTarget = Math.max(1, Math.floor(largestTargetShare * sections.length));
  let picks = candidates.map((list) => pickLinks(list, sections));

  let repick = dropTargetsOverLimit(picks, candidates, mostSectionsPerTarget);
  while (repick.size > 0) {
    picks = picks.map((links, from) =>
      repick.has(from) ? pickLinks(candidates[from]!, sections) : links,
    );
    repick = dropTargetsOverLimit(picks, candidates, mostSectionsPerTarget);
  }

  return picks.map((links) => links.map((link): Link => [link.to, link.relation]));
}
