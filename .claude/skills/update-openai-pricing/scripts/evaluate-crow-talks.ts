#!/usr/bin/env node
/**
 * The crow's talks A/B: answers the bundled talks with two models through the
 * bot's own talk code, counts what a script can see in the answers, and prepares
 * two blind files for the judges. The judges decide — only a reader can tell
 * whether she was right to speak, understood and on the point — and
 * `score-crow-talks.ts` decodes their verdicts.
 *
 * Nothing about answering a talk is re-implemented here: `crow-talk-worker.ts`
 * calls the crow's `CrowLlm.conversation`, `talkNumbers` and `writeTalk`, so the
 * prompts, the schema, the checks and the one rewrite are the ones the bot runs.
 *
 * Costs real tokens. Run from the repository root (Node >= 26):
 *   node .claude/skills/update-openai-pricing/scripts/evaluate-crow-talks.ts --help
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, stdout } from 'node:process';
import { parseArgs } from 'node:util';

import { paint, requireNode, runCli, setColor } from './cli.ts';
import { type Side, sideNames, SIDES } from './crow-checks.ts';
import { callWorker } from './crow-run.ts';
import { blindTalksFile, type CrowTalksFixture, talkRows, type TalkRun, tallyTalks } from './crow-talk-checks.ts';
import { DEFAULT_PRICING_FILE, findPricingBlock, type ModelPrice } from './pricing.ts';

// resolved against this file rather than the cwd, so moving the skill cannot break the defaults
const DEFAULT_TALKS = join(import.meta.dirname, '..', 'fixtures', 'crow-talks.json');
const WORKER = join(import.meta.dirname, 'crow-talk-worker.ts');
/** A talk call measured on 12.10.2026: a 5.5k-token prompt, the persona's part cached, and a short answer */
const TYPICAL_CALL = { input: 5500, cached: 3100, output: 150 };
/** A rewrite doubles a talk's cost; about one in ten needs one */
const REWRITE_MARGIN = 1.1;
/** Two judges, each with the labels shuffled their own way, so position bias cancels out */
const JUDGES = [1, 2];

const options = {
  baseline: { type: 'string' },
  candidate: { type: 'string' },
  effort: { type: 'string', default: 'medium' },
  'baseline-effort': { type: 'string' },
  'candidate-effort': { type: 'string' },
  runs: { type: 'string', default: '1' },
  talks: { type: 'string', default: DEFAULT_TALKS },
  out: { type: 'string' },
  timeout: { type: 'string', default: '900000' },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  color: { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const USAGE = `the crow's talks A/B — does the candidate answer the cats as well as the model in use?

Usage: node .claude/skills/update-openai-pricing/scripts/evaluate-crow-talks.ts --baseline <model> --candidate <model>

  --baseline <model>   the talk model in use today (OPENAI_CROW_TALK_MODEL)
  --candidate <model>  the model being considered
  --effort <value>     OPENAI_CROW_TALK_REASONING_EFFORT for both   (default: medium, the talks' rung)
  --baseline-effort, --candidate-effort
                       per-model overrides: the effort ladders differ between generations, so run each
                       model on its own equivalent rung
  --runs <n>           answers per talk and model     (default: 1; 2 for a close call, 3 at most)
  --talks <path>       the talks                      (default: the bundled ones, from the chat's real talks)
  --out <dir>          where the answers, metrics and blind files go
                       (default: data/crow-ab/talks-<date-time>; the keys go to <dir>-keys)
  --timeout <ms>       per worker                     (default: 900000)
  --dry-run            print the plan and the estimated cost, call nothing
  --json               print the report as JSON
  --no-color           disable coloured output
  -h, --help           show this help

What a script counts: answers returned, spoken and kept back, failing the bot's checks, rewrites,
answers opening with «котику», the magpie as an excuse, nicknames, length, cost and time. The judges
decide the rest; then run score-crow-talks.ts on the same --out.

Exit codes: 0 done, 2 failure.`;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowNegative: true; strict: true }>>['values'];

function main(): Promise<number> {
  requireNode();
  const { values } = parseArgs({ args: argv.slice(2), options, allowNegative: true, strict: true });
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return Promise.resolve(0);
  }
  return run(values);
}

const callCost = (price: ModelPrice): number =>
  ((TYPICAL_CALL.input - TYPICAL_CALL.cached) * price.input +
    TYPICAL_CALL.cached * price.cached +
    TYPICAL_CALL.output * price.output) /
  1_000_000;

async function run(values: Values): Promise<number> {
  setColor(values.color);
  const baseline = values.baseline;
  const candidate = values.candidate;
  if (!baseline || !candidate) throw new Error('Both --baseline and --candidate are required.');
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer.');

  const fixture = JSON.parse(await readFile(values.talks, 'utf8')) as CrowTalksFixture;
  if (fixture.talks.length === 0) throw new Error(`${values.talks} has no talks.`);
  const models: Record<Side, string> = { baseline, candidate };
  const efforts: Record<Side, string> = {
    baseline: values['baseline-effort'] ?? values.effort,
    candidate: values['candidate-effort'] ?? values.effort,
  };
  const talksPerModel = fixture.talks.length * runs;

  if (values['dry-run']) {
    const prices = findPricingBlock(await readFile(DEFAULT_PRICING_FILE, 'utf8')).entries;
    const estimate = (model: string) => {
      const price = prices.get(model);
      return price ? `≈ $${(callCost(price) * talksPerModel * REWRITE_MARGIN).toFixed(2)}` : 'not in MODEL_PRICING';
    };
    stdout.write(
      [
        `2 workers, one per model, ${runs} run(s) each; each run answers ${fixture.talks.length} talks`,
        `${talksPerModel * 2} talk calls in total, and one more for every answer the checks send back`,
        `${baseline} at ${efforts.baseline}: ${estimate(baseline)}`,
        `${candidate} at ${efforts.candidate}: ${estimate(candidate)}`,
        `Then two judges read ${talksPerModel} items each in the session; they cost no API money.`,
        'Nothing was called.',
      ].join('\n') + '\n',
    );
    return 0;
  }

  const job = { runs, talks: fixture.talks.map(({ name, request }) => ({ name, request })) };
  const [baselineRuns, candidateRuns] = await Promise.all(
    SIDES.map((side) =>
      callWorker<TalkRun>(
        WORKER,
        { OPENAI_CROW_TALK_MODEL: models[side], OPENAI_CROW_TALK_REASONING_EFFORT: efforts[side] },
        job,
        Number(values.timeout),
        'talks',
      ),
    ),
  );
  const talks: Record<Side, TalkRun[]> = { baseline: baselineRuns, candidate: candidateRuns };
  const names = sideNames(models, efforts);
  const tallies = { baseline: tallyTalks(talks.baseline), candidate: tallyTalks(talks.candidate) };

  const stamp = new Date().toISOString().slice(0, 16).replace(':', '-');
  const out = values.out ?? join('data', 'crow-ab', `talks-${stamp}`);
  const keys = `${out}-keys`;
  await mkdir(out, { recursive: true });
  await mkdir(keys, { recursive: true });
  await writeFile(join(out, 'talks.json'), `${JSON.stringify({ models, efforts, runs, talks }, null, 2)}\n`);
  const rows = talkRows(tallies);
  await writeFile(
    join(out, 'metrics.md'),
    [
      `# The crow's talks A/B: ${names.baseline} (baseline) against ${names.candidate}`,
      '',
      `| | ${names.baseline} | ${names.candidate} |`,
      '| --- | --- | --- |',
      ...rows.map(([label, a, b]) => `| ${label} | ${a} | ${b} |`),
      '',
    ].join('\n'),
  );
  for (const judge of JUDGES) {
    const { markdown, key } = blindTalksFile(fixture, talks, judge);
    await writeFile(join(out, `blind_${judge}.md`), markdown);
    await writeFile(join(keys, `key_${judge}.json`), `${JSON.stringify(key, null, 2)}\n`);
  }

  if (values.json) {
    stdout.write(`${JSON.stringify({ models, efforts, runs, out, keys, tallies }, null, 2)}\n`);
    return 0;
  }
  const width = Math.max(names.baseline.length, names.candidate.length, 12) + 2;
  const lines = [`${''.padEnd(30)}${paint('bold', names.baseline.padEnd(width))}${paint('bold', names.candidate)}`];
  for (const [label, a, b] of rows) lines.push(`${paint('dim', label.padEnd(30))}${a.padEnd(width)}${b}`);
  for (const side of SIDES) {
    for (const talk of talks[side].filter((entry) => entry.error)) {
      lines.push(paint('red', `${names[side]} ${talk.talk} #${talk.run}: ${talk.error}`));
    }
  }
  lines.push(
    '',
    `Answers, metrics and the blind files: ${out}/ (blind_${JUDGES.join('.md, blind_')}.md)`,
    `Keys, away from the judges: ${keys}/`,
    paint('dim', 'Next: one judge per blind file (SKILL.md, "The crow\'s talks"), then score-crow-talks.ts --out ' + out),
  );
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

await runCli(main);
