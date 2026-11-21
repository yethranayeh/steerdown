---
name: steerdown-concepts
description: Propose concepts for a steerdown concept file. Use when the person asks to propose, suggest or improve steerdown concepts, to cover sections no concept covers, or to split over-broad concepts.
---

# Propose steerdown concepts

steerdown scores every section of a Markdown site against the concepts in `steerdown.concepts.json`, a file the site's authors edit by hand next to the graph file. Your job is to propose concepts. A person reviews them and moves the ones they accept into the concept file. You never edit the concept file yourself.

## Steps

1. Run `npx steerdown concepts input`. If the site's build writes its graph file somewhere other than `steerdown.graph.json`, pass that path with `--graph <file>` to this and the later command. The command prints JSON:
   - `sections`: every section in the graph, with its `page` (relative to the Markdown folder the site's `steerdown build` reads), `heading`, and `scores` for the concepts it at least mentions. Scores run from 0 ("not about it at all") to 3 ("is mainly about it").
   - `concepts`: the concept file's concepts. `coveredSections` counts the sections that score 2 or more. It is `null` for a concept that has not been scored with its current definition yet.
   - `proposed`: concepts already proposed and waiting for review. Do not propose them again.
   - `uncovered`: the sections no concept scores 2 or more on.
   - `overBroad`: concepts that score 2 or more on too many sections to tell sections apart.
2. Read the pages behind the `uncovered` sections and the sections of each over-broad concept. The input carries no section text.
3. Write your proposals to a new JSON file outside the site's content, for example in a temporary folder. It holds an array of objects with exactly these fields:

```json
[
  {
    "id": "hook-configuration",
    "label": "Configuring hooks",
    "definition": "Setting up the hooks that run commands when tasks change."
  }
]
```

4. Run `npx steerdown concepts propose <your file>`. It checks every proposal and adds them all to `steerdown.proposals.json`, or adds none and lists each problem. Fix the problems and run it again.
5. Tell the person how many concepts you proposed and why, and that they accept one by moving it from `steerdown.proposals.json` into `steerdown.concepts.json`. The next `steerdown build` scores the accepted ones.

Do not run `steerdown build` unless the person asks. It sends requests to Jev, which needs their API key and costs money.

## What makes a good concept

- It names one topic a reader might want to follow across pages, such as a feature, a task or an idea. Page types ("introduction", "reference") and whole products are not concepts.
- It covers a few sections, at least two, and not more than about a tenth of them. A concept that covers most of a page's sections, or one section only, does not help a reader find more.
- The definition is one sentence that says what belongs to the concept, precise enough that a section either is or is not about it.
- The label is a short noun phrase a reader would recognize.
- The id is lowercase words joined by hyphens, such as `json-output`. Ids are permanent, because readers' saved choices refer to them. Never reuse the id of a concept in the concept file or the proposals.
- It does not overlap a concept that exists already. For an over-broad concept, propose two or more narrower concepts that split it, and say which one they would replace. The person decides whether to remove the broad one.
- Short intros and landing text that are about nothing in particular can stay uncovered.
