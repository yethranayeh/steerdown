/**
 * The variety rules for a section's links, shared by the build and the browser script. Keep it
 * free of Node and DOM imports.
 */

const linksPerSection = 3;

/** What the variety rules read from a link: its relation and the page it points to. */
export type Pickable = { relation: string; page: string };

/** True when a candidate is not yet picked and adds neither a second prerequisite nor a page already linked. */
function fitsWithPicked<C extends Pickable>(candidate: C, picked: Array<C>) {
  const isPicked = picked.includes(candidate);
  const isSecondPrerequisite =
    candidate.relation === "prerequisite" &&
    picked.some((link) => link.relation === "prerequisite");
  const sharesPage = picked.some((link) => link.page === candidate.page);
  return !isPicked && !isSecondPrerequisite && !sharesPage;
}

/**
 * Picks up to three links from candidates sorted best first: the best `next_step` whenever there
 * is one, then the best rest, with at most one `prerequisite` and one link per page. Returns them
 * in the candidates' order.
 */
export function pickLinks<C extends Pickable>(candidates: Array<C>): Array<C> {
  const picked: Array<C> = [];
  const nextStep = candidates.find((candidate) => candidate.relation === "next_step");
  if (nextStep !== undefined) {
    picked.push(nextStep);
  }

  for (const candidate of candidates) {
    const hasRoom = picked.length < linksPerSection;
    if (hasRoom && fitsWithPicked(candidate, picked)) {
      picked.push(candidate);
    }
  }

  return candidates.filter((candidate) => picked.includes(candidate));
}
