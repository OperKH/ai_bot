#!/usr/bin/env node
/**
 * The crow's A/B: writes the arcs of the bundled stories with two models
 * through the bot's own arc code, counts what a script can see in them, and
 * prepares two blind files for the judges. The judges decide — only a reader
 * can tell whether a post is funny or bends a fact — and `score-crow.ts`
 * decodes their verdicts.
 *
 * Nothing about writing an arc is re-implemented here: `crow-worker.ts` calls
 * the crow's `arcRequest`, `CrowLlm.arc` and `writeArc`, so the outline, the
 * prompts, the schema, the checks and the one rewrite are the ones the bot
 * runs. This file only decides what to run, counts and prepares the files.
 *
 * One worker process per model; each writes the stories of a run at once, so
 * up to twice the number of stories are in flight.
 *
 * Costs real tokens. Run from the repository root (Node >= 26):
 *   node .claude/skills/update-openai-pricing/scripts/evaluate-crow.ts --help
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, env, stdout } from 'node:process';
import { parseArgs } from 'node:util';

import { paint, requireNode, runCli, setColor } from './cli.ts';
import { type ArcRun, blindFile, type CrowFixture, type Side, SIDES, tallyRows, tallySide } from './crow-checks.ts';
import { DEFAULT_PRICING_FILE, findPricingBlock, type ModelPrice } from './pricing.ts';

// resolved against this file rather than the cwd, so moving the skill cannot break the defaults
const DEFAULT_STORIES = join(import.meta.dirname, '..', 'fixtures', 'crow-stories.json');
const WORKER = join(import.meta.dirname, 'crow-worker.ts');
/** An arc call of the A/B of 26.09.2026: a 7.8k-token prompt, mostly cached, and the answer with its reasoning */
const TYPICAL_CALL = { input: 7800, cached: 5900, output: 1900 };
/** A rewrite doubles an arc's cost; about one arc in ten needs one */
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
  stories: { type: 'string', default: DEFAULT_STORIES },
  out: { type: 'string' },
  timeout: { type: 'string', default: '900000' },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  color: { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const USAGE = `the crow's A/B — does the candidate write the crow's arcs as well as the model in use?

Usage: node .claude/skills/update-openai-pricing/scripts/evaluate-crow.ts --baseline <model> --candidate <model>

  --baseline <model>   the arc model in use today (OPENAI_CROW_ARC_MODEL)
  --candidate <model>  the model being considered
  --effort <value>     OPENAI_CROW_ARC_REASONING_EFFORT for both   (default: medium, the rung the arcs were
                       tuned at)
  --baseline-effort, --candidate-effort
                       per-model overrides: the effort ladders differ between generations, so run each
                       model on its own equivalent rung
  --runs <n>           arcs per story and model       (default: 1; 2 for a close call, 3 at most —
                       more stories would tell more than more runs)
  --stories <path>     the stories                    (default: the bundled six AI releases)
  --out <dir>          where the arcs, metrics and blind files go
                       (default: data/crow-ab/<date-time>; the keys go to <dir>-keys)
  --timeout <ms>       per worker                     (default: 900000)
  --dry-run            print the plan and the estimated cost, call nothing
  --json               print the report as JSON
  --no-color           disable coloured output
  -h, --help           show this help

What a script counts: arcs whose opening failed the bot's checks, rewrites, dropped messages,
cost and time, posts with the chat's swearing, euphemisms instead, worn-out images, posts opening
with «Коти…» or with a name. The judges decide the rest; then run score-crow.ts on the same --out.

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

  const fixture = JSON.parse(await readFile(values.stories, 'utf8')) as CrowFixture;
  if (fixture.stories.length === 0) throw new Error(`${values.stories} has no stories.`);
  const models: Record<Side, string> = { baseline, candidate };
  const efforts: Record<Side, string> = {
    baseline: values['baseline-effort'] ?? values.effort,
    candidate: values['candidate-effort'] ?? values.effort,
  };
  const arcsPerModel = fixture.stories.length * runs;

  if (values['dry-run']) {
    const prices = findPricingBlock(await readFile(DEFAULT_PRICING_FILE, 'utf8')).entries;
    const estimate = (model: string) => {
      const price = prices.get(model);
      return price ? `≈ $${(callCost(price) * arcsPerModel * REWRITE_MARGIN).toFixed(2)}` : 'not in MODEL_PRICING';
    };
    stdout.write(
      [
        `2 workers, one per model, ${runs} run(s) each; each run writes ${fixture.stories.length} arcs`,
        `(${fixture.stories.map((story) => story.name).join(', ')})`,
        `${arcsPerModel * 2} arc calls in total, and one more for every arc the checks send back`,
        `${baseline} at ${efforts.baseline}: ${estimate(baseline)}`,
        `${candidate} at ${efforts.candidate}: ${estimate(candidate)}`,
        'Then two judges read the blind files in the session; they cost no API money.',
        'Nothing was called.',
      ].join('\n') + '\n',
    );
    return 0;
  }

  const job = { runs, roster: fixture.roster, stories: fixture.stories };
  const [baselineRuns, candidateRuns] = await Promise.all(
    SIDES.map((side) => callWorker(models[side], efforts[side], job, Number(values.timeout))),
  );
  const arcs: Record<Side, ArcRun[]> = { baseline: baselineRuns, candidate: candidateRuns };
  const tallies = { baseline: tallySide(arcs.baseline), candidate: tallySide(arcs.candidate) };

  const out = values.out ?? join('data', 'crow-ab', new Date().toISOString().slice(0, 16).replace(':', '-'));
  const keys = `${out}-keys`;
  await mkdir(out, { recursive: true });
  await mkdir(keys, { recursive: true });
  await writeFile(join(out, 'arcs.json'), `${JSON.stringify({ models, efforts, runs, arcs }, null, 2)}\n`);
  const rows = tallyRows(tallies);
  await writeFile(
    join(out, 'metrics.md'),
    [
      `# The crow's A/B: ${baseline} (baseline) against ${candidate}`,
      '',
      `| | ${baseline} | ${candidate} |`,
      '| --- | --- | --- |',
      ...rows.map(([label, a, b]) => `| ${label} | ${a} | ${b} |`),
      '',
    ].join('\n'),
  );
  for (const judge of JUDGES) {
    const { markdown, key } = blindFile(fixture, arcs, judge);
    await writeFile(join(out, `blind_${judge}.md`), markdown);
    await writeFile(join(keys, `key_${judge}.json`), `${JSON.stringify(key, null, 2)}\n`);
  }

  if (values.json) {
    stdout.write(`${JSON.stringify({ models, efforts, runs, out, keys, tallies }, null, 2)}\n`);
    return 0;
  }
  const width = Math.max(baseline.length, candidate.length, 12) + 2;
  const lines = [`${''.padEnd(30)}${paint('bold', baseline.padEnd(width))}${paint('bold', candidate)}`];
  for (const [label, a, b] of rows) lines.push(`${paint('dim', label.padEnd(30))}${a.padEnd(width)}${b}`);
  for (const side of SIDES) {
    for (const arc of arcs[side].filter((entry) => entry.error)) {
      lines.push(paint('red', `${models[side]} ${arc.story} #${arc.run}: ${arc.error}`));
    }
  }
  lines.push(
    '',
    `Arcs, metrics and the blind files: ${out}/ (blind_${JUDGES.join('.md, blind_')}.md)`,
    `Keys, away from the judges: ${keys}/`,
    paint('dim', 'Next: one judge per blind file (SKILL.md, "The crow\'s arcs"), then score-crow.ts --out ' + out),
  );
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** One worker per model, under tsx: the app's modules need it (see crow-worker.ts) */
function callWorker(model: string, effort: string, job: unknown, timeout: number): Promise<ArcRun[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', WORKER], {
      env: { ...env, OPENAI_CROW_ARC_MODEL: model, OPENAI_CROW_ARC_REASONING_EFFORT: effort },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{"arcs"'))
        .at(-1);
      if (!parsed) {
        reject(new Error(`worker for ${model} exited ${code} without a result: ${err.slice(-400) || out.slice(-400)}`));
        return;
      }
      resolve((JSON.parse(parsed) as { arcs: ArcRun[] }).arcs);
    });
    child.stdin.end(JSON.stringify(job));
  });
}

await runCli(main);
