import type { Concept } from "./concepts.ts";
import type { Graph, GraphConcept, Score } from "./graph.ts";
import type { JevClient, ScoreAnswer } from "./jev.ts";
import type { RequestProgress } from "./judge.ts";
import type { Section } from "./sections.ts";

import { runPooled } from "./http.ts";
import { askJev } from "./jev.ts";
import { hash, judgedState, judgedWordLimit, model, requestsInFlight, round } from "./judge.ts";

/** The score question's levels, from 0 to 3. */
const scoreLevels = [
  "Not about it at all.",
  "Mentions it in passing.",
  "Covers part of it.",
  "Is mainly about it.",
];
/** The input step lists a section's scores from "Mentions it in passing" up. */
export const mentionedScore = 1;
/** A section is covered well by a concept that scores at least "Covers part of it". */
export const coveredScore = 2;
/** A concept that covers more than this share of all sections is over-broad. */
const overBroadShare = 0.1;
/** A concept that covers this many sections or fewer is never over-broad, however few there are. */
const fewestOverBroadSections = 5;

function scoreInstructions(concept: Pick<Concept, "label" | "definition">) {
  return `How much is this documentation section about ${concept.label}: ${concept.definition}`;
}

const scoreQuestionHash = hash([
  model,
  judgedWordLimit,
  scoreInstructions({ label: "", definition: "" }),
  scoreLevels,
]);

type Cell = { score: number; confidence: number };

/** One request: a section and the concepts it is scored against. */
type ScoreJob = { section: number; concepts: Array<number> };

/** What scoring a build's sections takes, and the scores known so far. */
export type ScorePlan = {
  /** The concepts as the concept file defines them. */
  definitions: Array<Concept>;
  concepts: Array<GraphConcept>;
  jobs: Array<ScoreJob>;
  /** Scores keyed by the hashes of the section and the concept. */
  cells: Map<string, Cell>;
  toScore: number;
};

type ScoreProgress = RequestProgress & { scored: number };

export type OverBroadConcept = { id: string; sections: number };

export type ScoreReport = {
  total: number;
  reused: number;
  scored: number;
  overBroad: Array<OverBroadConcept>;
};

/** A build's scoring: the graph fields it writes, its requests and its report. */
export type ScoreRun = {
  fields: Partial<ReturnType<typeof graphScores>>;
  progress: ScoreProgress;
  report: ScoreReport | undefined;
};

const noScoreRequests: ScoreProgress = {
  requests: 0,
  inputTokens: 0,
  scored: 0,
  failure: undefined,
};

/** The hash of what Jev reads about a concept, so a changed definition is scored again. */
export function conceptHash(concept: Concept) {
  return hash([concept.label, concept.definition]);
}

function cellKey(sectionHash: string, conceptHash: string) {
  return `${sectionHash}>${conceptHash}`;
}

/** Scores from an earlier graph, keyed by section and concept hashes, when its question matches. */
function reusableCells(previous: Graph | undefined): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  const isReusable = previous?.scoreQuestion === scoreQuestionHash;
  if (!isReusable || previous.concepts === undefined || previous.scores === undefined) {
    return cells;
  }

  for (const [section, concept, score, confidence] of previous.scores) {
    const sectionHash = previous.sections[section]?.hash;
    const previousConcept = previous.concepts[concept];
    if (sectionHash !== undefined && previousConcept !== undefined) {
      cells.set(cellKey(sectionHash, previousConcept.hash), { score, confidence });
    }
  }

  return cells;
}

/** Plans one request per section that has concepts without a reusable score. */
export function planScores(
  concepts: Array<Concept>,
  hashes: Array<string>,
  previous: Graph | undefined,
): ScorePlan {
  const graphConcepts = concepts.map((concept) => ({
    id: concept.id,
    label: concept.label,
    hash: conceptHash(concept),
  }));
  const cells = reusableCells(previous);
  const jobs: Array<ScoreJob> = [];

  hashes.forEach((sectionHash, section) => {
    const missing: Array<number> = [];
    graphConcepts.forEach((concept, index) => {
      if (!cells.has(cellKey(sectionHash, concept.hash))) {
        missing.push(index);
      }
    });
    if (missing.length > 0) {
      jobs.push({ section, concepts: missing });
    }
  });

  const toScore = jobs.reduce((count, job) => count + job.concepts.length, 0);

  return { definitions: concepts, concepts: graphConcepts, jobs, cells, toScore };
}

/** Asks Jev to score each planned section against its concepts, stopping at the first failure. */
async function scoreSections({
  plan,
  sections,
  hashes,
  client,
}: {
  plan: ScorePlan;
  sections: Array<Section>;
  hashes: Array<string>;
  client: JevClient;
}): Promise<ScoreProgress> {
  const concepts = plan.definitions;
  const progress: ScoreProgress = { requests: 0, inputTokens: 0, scored: 0, failure: undefined };

  try {
    await runPooled(plan.jobs, requestsInFlight, async (job) => {
      const questions: Record<string, object> = {};
      for (const index of job.concepts) {
        const concept = concepts[index]!;
        questions[concept.id] = {
          type: "score",
          instructions: scoreInstructions(concept),
          criteria: scoreLevels,
        };
      }

      const state = judgedState(sections[job.section]!);
      const response = await askJev<ScoreAnswer>(client, { model, state, questions });

      progress.requests++;
      progress.inputTokens += response.usage.input_tokens;

      for (const index of job.concepts) {
        const answer = response.answers[concepts[index]!.id];
        if (answer !== undefined) {
          const key = cellKey(hashes[job.section]!, plan.concepts[index]!.hash);
          plan.cells.set(key, { score: round(answer.score), confidence: round(answer.confidence) });
          progress.scored++;
        }
      }
    });
  } catch (error) {
    progress.failure = error;
  }

  return progress;
}

/** The graph's score fields: every known score, in order of section and then concept. */
export function graphScores(
  plan: ScorePlan,
  hashes: Array<string>,
): { scoreQuestion: string; concepts: Array<GraphConcept>; scores: Array<Score> } {
  const scores: Array<Score> = [];
  hashes.forEach((sectionHash, section) => {
    plan.concepts.forEach((concept, index) => {
      const cell = plan.cells.get(cellKey(sectionHash, concept.hash));
      if (cell !== undefined) {
        scores.push([section, index, cell.score, cell.confidence]);
      }
    });
  });

  return { scoreQuestion: scoreQuestionHash, concepts: plan.concepts, scores };
}

/** How many sections each concept covers well, in the order of `concepts`. */
export function coveredCounts(concepts: Array<GraphConcept>, scores: Array<Score>) {
  const counts = concepts.map(() => 0);
  for (const [, concept, score] of scores) {
    if (score >= coveredScore) {
      counts[concept]!++;
    }
  }
  return counts;
}

/** Concepts that cover too many sections to tell them apart. */
export function overBroadConcepts(
  sectionCount: number,
  concepts: Array<GraphConcept>,
  scores: Array<Score>,
): Array<OverBroadConcept> {
  const counts = coveredCounts(concepts, scores);
  const overBroad: Array<OverBroadConcept> = [];

  concepts.forEach((concept, index) => {
    const sections = counts[index]!;
    if (sections > fewestOverBroadSections && sections > sectionCount * overBroadShare) {
      overBroad.push({ id: concept.id, sections });
    }
  });

  return overBroad;
}

/** The indexes of sections no concept covers well. */
export function uncoveredSections(sectionCount: number, scores: Array<Score>) {
  const covered = new Set<number>();

  for (const [section, , score] of scores) {
    if (score >= coveredScore) {
      covered.add(section);
    }
  }

  return Array.from({ length: sectionCount }, (_, index) => index).filter(
    (index) => !covered.has(index),
  );
}

/**
 * Scores the sections against the concepts, unless there is no concept file or judging failed,
 * and collects the results.
 */
export async function scoreConcepts({
  plan,
  judgingFailed,
  sections,
  hashes,
  client,
}: {
  plan: ScorePlan | undefined;
  judgingFailed: boolean;
  sections: Array<Section>;
  hashes: Array<string>;
  client: JevClient;
}): Promise<ScoreRun> {
  if (plan === undefined) {
    return { fields: {}, progress: noScoreRequests, report: undefined };
  }

  const progress = judgingFailed
    ? noScoreRequests
    : await scoreSections({ plan, sections, hashes, client });
  const fields = graphScores(plan, hashes);
  const total = sections.length * plan.concepts.length;
  const overBroad = overBroadConcepts(sections.length, fields.concepts, fields.scores);

  return {
    fields,
    progress,
    report: { total, reused: total - plan.toScore, scored: progress.scored, overBroad },
  };
}
