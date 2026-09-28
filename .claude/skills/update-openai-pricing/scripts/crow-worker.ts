/**
 * Writes the arcs of the crow's A/B stories with one model, through the crow's
 * own code: the request and the outline (`arcRequest`), the call (`CrowLlm.arc`,
 * so the persona prompt, the arc prompt and the schema are the ones the bot
 * ships) and the checks with one rewrite (`writeArc`). An evaluation that
 * copied any of those would drift the moment someone tuned the real thing.
 *
 * The model and its effort come from the environment (`OPENAI_CROW_ARC_MODEL`,
 * `OPENAI_CROW_ARC_REASONING_EFFORT`), because `ConfigService` reads them once
 * at construction. The stories of a run are written at once, the runs one after
 * another.
 *
 * Runs under tsx, not node: the app's modules import each other without an
 * extension and its entities use decorators. For the same reason the skill's
 * own `tsc` leaves this file out; the app's `tsc` checks what it calls.
 *   OPENAI_CROW_ARC_MODEL=... npx tsx crow-worker.ts < job.json > result.json
 */

import { stdin, stdout } from 'node:process';

import { arcRequest, writeArc } from '../../../../src/crow/arcWriter.js';
import { findCategory, type Importance } from '../../../../src/crow/categories.js';
import { CrowLlm } from '../../../../src/crow/crowLlm.js';

type Story = {
  name: string;
  title: string;
  category: string;
  importance: number;
  isRumor: boolean;
  facts: { id: string; text: string }[];
  recentPosts: string[];
  previousStances: string[];
};
type Job = { runs: number; roster: string[]; stories: Story[] };

const readStdin = async (): Promise<string> => {
  let text = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) text += chunk;
  return text;
};

const job = JSON.parse(await readStdin()) as Job;
const llm = new CrowLlm();
const now = new Date();

const writeStory = async (story: Story, run: number) => {
  const started = Date.now();
  const category = findCategory(story.category);
  if (!category) return { story: story.name, run, outline: [], written: null, ms: 0, error: `unknown category ${story.category}` };
  const { request, outline } = arcRequest(
    {
      title: story.title,
      category,
      importance: Math.min(3, Math.max(1, story.importance)) as Importance,
      isRumor: story.isRumor,
      facts: story.facts,
    },
    job.roster,
    { recentPosts: story.recentPosts, previousStances: story.previousStances },
    now,
  );
  try {
    const written = await writeArc((next) => llm.arc(next), request, outline);
    return { story: story.name, run, outline: request.outline, written, ms: Date.now() - started, error: null };
  } catch (error) {
    return { story: story.name, run, outline: request.outline, written: null, ms: Date.now() - started, error: (error as Error).message };
  }
};

const arcs = [];
for (let run = 1; run <= job.runs; run++) {
  arcs.push(...(await Promise.all(job.stories.map((story) => writeStory(story, run)))));
}

// the service logs usage to stdout as well, so the result goes on a line of its own
stdout.write(`\n${JSON.stringify({ arcs })}\n`);
