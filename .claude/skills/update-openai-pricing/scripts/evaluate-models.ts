#!/usr/bin/env node
/**
 * Runs two models through the bot's own summarisation and image description and
 * reports which of the prompt's hard constraints each one broke.
 *
 * This exists because no metadata can answer "will the output get worse". The
 * capability table rules out models that cannot take an image or a schema; only
 * running the real prompts shows whether a model still keeps topics apart. The
 * verdict is evidence over N sampled runs, never a proof.
 *
 * Nothing about the calls is re-implemented here: `eval-worker.ts` invokes
 * `OpenAIService.summarizeMessages` and `.describeImage`, so prompts, schema,
 * message formatting and token limits come from the app. This file only decides
 * what to run, checks the answers and compares.
 *
 * One worker process per model does every run for that model, and the two
 * workers run concurrently: each keeps its calls sequential, so at most two
 * requests are in flight — same total call count, half the wall time.
 *
 * Costs real tokens. Run from the repository root (Node >= 26):
 *   node .claude/skills/update-openai-pricing/scripts/evaluate-models.ts --help
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, env, stdout } from 'node:process';
import { parseArgs } from 'node:util';

import { paint, requireNode, runCli, setColor } from './cli.ts';
import { checkDescription, isDescriptionClean, type ImageExpectation, type ImageReport } from './image-checks.ts';
import { checkSummary, isClean, type SummaryReport, type SummaryResult } from './summary-checks.ts';

// resolved against this file rather than the cwd, so renaming or moving the
// skill directory cannot silently break the defaults
const DEFAULT_SAMPLES = join(import.meta.dirname, '..', 'fixtures', 'chat-samples.json');
const WORKER = join(import.meta.dirname, 'eval-worker.ts');

const options = {
  baseline: { type: 'string' },
  candidate: { type: 'string' },
  runs: { type: 'string', default: '3' },
  samples: { type: 'string', default: DEFAULT_SAMPLES },
  'skip-images': { type: 'boolean', default: false },
  effort: { type: 'string' },
  'vision-effort': { type: 'string' },
  'baseline-effort': { type: 'string' },
  'baseline-vision-effort': { type: 'string' },
  'candidate-effort': { type: 'string' },
  'candidate-vision-effort': { type: 'string' },
  timeout: { type: 'string', default: '600000' },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  color: { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const USAGE = `summarisation and vision A/B — does the candidate still obey the prompts' hard constraints?

Usage: node .claude/skills/update-openai-pricing/scripts/evaluate-models.ts --baseline <model> --candidate <model>

  --baseline <model>   the model in use today
  --candidate <model>  the model being considered
  --runs <n>           runs per model                  (default: 3, also the most the skill offers;
                       past three the counts mostly re-confirm themselves — point --samples at real
                       chat history instead. Higher values run, but only on an explicit request.)
  --samples <path>     chat samples and images         (default: the bundled adversarial set)
  --skip-images        summarisation only
  --effort <value>     OPENAI_REASONING_EFFORT for both models
  --vision-effort <v>  OPENAI_VISION_REASONING_EFFORT for both models
  --baseline-effort, --baseline-vision-effort, --candidate-effort, --candidate-vision-effort
                       per-model overrides, which is what a fair comparison usually needs:
                       the effort ladders differ between generations, so the same string is
                       not the same setting. The least-reasoning rung is 'minimal' on gpt-5
                       models and 'none' on gpt-5.6 ones; comparing 'minimal' against 'none'
                       is like for like, comparing both at 'low' raises the bar for both.
  --timeout <ms>       per model call, roughly         (default: 600000; a worker gets runs × this)
  --dry-run            print the plan, call nothing
  --json               print the report as JSON
  --no-color           disable coloured output
  -h, --help           show this help

Every check is mechanical; no model judges another.

  summaries  invented ids, one id cited from two sections, two sections saying the same thing,
             events with no date, ids leaked into fullSummary
  images     refusal or silence, meme not named as one, facts from the caption dropped,
             answer longer than the prompt allows, answer not in Ukrainian

The calls go through OpenAIService, so the prompts and schema are the ones the bot ships. Each
model runs in its own worker process with OPENAI_MODEL and OPENAI_VISION_MODEL set, because
ConfigService reads them once at construction.

Exit codes: 0 no regression observed, 1 the candidate broke something the baseline did not, 2 failure.`;

function main(): Promise<number> {
  requireNode();
  const { values } = parseArgs({ args: argv.slice(2), options, allowNegative: true, strict: true });
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return Promise.resolve(0);
  }
  return run(values);
}

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowNegative: true; strict: true }>>['values'];

type Sample = { name: string; provokes: string; messages: Record<string, unknown>[] };
type ImageSample = { name: string; path: string; mediaType?: string; provokes: string; expect: ImageExpectation };
type WorkerRun = {
  summaries: { name: string; result: SummaryResult | null; error: string | null }[];
  images: { name: string; description: string | null; error: string | null }[];
};

type ModelOutcome = {
  summaries: { name: string; run: number; report: SummaryReport | null; error: string | null }[];
  images: { name: string; run: number; report: ImageReport | null; description: string | null; error: string | null }[];
};

async function run(values: Values): Promise<number> {
  setColor(values.color);
  const baseline = values.baseline;
  const candidate = values.candidate;
  if (!baseline || !candidate) throw new Error('Both --baseline and --candidate are required.');

  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer.');

  const fixture = JSON.parse(await readFile(values.samples, 'utf8')) as { samples: Sample[]; images?: ImageSample[] };
  const samples = fixture.samples ?? [];
  const images = values['skip-images'] ? [] : (fixture.images ?? []);
  if (samples.length === 0 && images.length === 0) throw new Error(`${values.samples} declares nothing to run.`);

  if (values['dry-run']) {
    stdout.write(
      [
        `2 workers, one per model, ${runs} runs each`,
        `each run summarises ${samples.length} samples (${samples.map((s) => s.name).join(', ')})`,
        images.length > 0
          ? `and describes ${images.length} image(s): ${images.map((i) => i.name).join(', ')}`
          : 'images skipped',
        `${(samples.length + images.length) * runs * 2} model calls in total, through OpenAIService`,
        // quoted verbatim when offering a cheaper A/B, so the option costs need no arithmetic
        `${(samples.length + images.length) * 2} model calls per run, both models included`,
        'Nothing was called.',
      ].join('\n') + '\n',
    );
    return 0;
  }

  const idsByName = new Map(samples.map((sample) => [sample.name, sample.messages.map((m) => String(m.messageId))]));
  const expectByName = new Map(images.map((image) => [image.name, image.expect ?? {}]));
  const job = {
    runs,
    summaries: samples.map(({ name, messages }) => ({ name, messages })),
    images: images.map(({ name, path, mediaType }) => ({ name, path, mediaType })),
  };

  const collect = async (model: string, side: 'baseline' | 'candidate'): Promise<ModelOutcome> => {
    // the worker runs `runs` sequential passes, so its budget scales with them
    const answer = await callWorker(model, job, Number(values.timeout) * runs, {
      OPENAI_REASONING_EFFORT: values[`${side}-effort`] ?? values.effort,
      OPENAI_VISION_REASONING_EFFORT: values[`${side}-vision-effort`] ?? values['vision-effort'],
    });
    const collected: ModelOutcome = { summaries: [], images: [] };
    answer.forEach((pass, index) => {
      for (const entry of pass.summaries) {
        const ids = idsByName.get(entry.name);
        if (!ids) throw new Error(`the worker returned a summary for an unknown sample: ${entry.name}`);
        collected.summaries.push({
          name: entry.name,
          run: index + 1,
          report: entry.result ? checkSummary(entry.result, ids) : null,
          error: entry.error,
        });
      }
      for (const entry of pass.images) {
        collected.images.push({
          name: entry.name,
          run: index + 1,
          report: entry.description === null ? null : checkDescription(entry.description, expectByName.get(entry.name)),
          description: entry.description,
          error: entry.error,
        });
      }
    });
    return collected;
  };

  // concurrent workers, sequential calls inside each: at most two requests in flight
  const [baselineOutcome, candidateOutcome] = await Promise.all([
    collect(baseline, 'baseline'),
    collect(candidate, 'candidate'),
  ]);
  const outcomes: [string, ModelOutcome][] = [
    [baseline, baselineOutcome],
    [candidate, candidateOutcome],
  ];

  const verdict = compare(baselineOutcome, candidateOutcome);
  if (values.json) {
    stdout.write(`${JSON.stringify({ baseline, candidate, runs, verdict, outcomes }, null, 2)}\n`);
  } else {
    report(baseline, candidate, outcomes, verdict);
  }
  return verdict.regressed ? 1 : 0;
}

/**
 * One worker per model. `tsx` rather than node: the app resolves its own imports
 * with a `.js` extension that exists only after a build, and its entities use
 * decorators, neither of which Node's type stripping handles.
 */
function callWorker(
  model: string,
  job: unknown,
  timeout: number,
  overrides: Record<string, string | undefined> = {},
): Promise<WorkerRun[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', WORKER], {
      env: {
        ...env,
        OPENAI_MODEL: model,
        OPENAI_VISION_MODEL: model,
        // each model runs at its own equivalent effort, or the comparison measures the setting
        ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
      },
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
      // the service logs usage to stdout, so take the last line that parses
      const parsed = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .at(-1);
      if (!parsed) {
        reject(new Error(`worker for ${model} exited ${code} without a result: ${err.slice(-400) || out.slice(-400)}`));
        return;
      }
      resolve((JSON.parse(parsed) as { runs: WorkerRun[] }).runs);
    });
    child.stdin.end(JSON.stringify(job));
  });
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

type Tally = {
  summaryRuns: number;
  summaryClean: number;
  inventedIds: number;
  bleeding: number;
  duplicates: number;
  datelessEvents: number;
  idsInFullSummary: number;
  coverage: number;
  imageRuns: number;
  imageClean: number;
  refusals: number;
  memeMissed: number;
  factsDropped: number;
  tooLong: number;
  notUkrainian: number;
  failed: number;
};

function tally(outcome: ModelOutcome): Tally {
  const summaries = outcome.summaries.filter((entry) => entry.report !== null);
  const sum = (pick: (report: SummaryReport) => number): number =>
    summaries.reduce((total, entry) => total + pick(entry.report!), 0);

  const described = outcome.images.filter((entry) => entry.report !== null);
  const imageSum = (pick: (report: ImageReport) => number): number =>
    described.reduce((total, entry) => total + pick(entry.report!), 0);

  return {
    summaryRuns: outcome.summaries.length,
    summaryClean: summaries.filter((entry) => isClean(entry.report!)).length,
    inventedIds: sum((report) => report.unknownIds.length),
    bleeding: sum((report) => report.bleedingIds.length),
    duplicates: sum((report) => report.duplicateSections.length),
    datelessEvents: sum((report) => report.eventsWithoutDate.length),
    idsInFullSummary: sum((report) => report.idsLeakedIntoFullSummary.length),
    coverage: summaries.length === 0 ? 0 : sum((report) => report.coverage) / summaries.length,
    imageRuns: outcome.images.length,
    imageClean: described.filter((entry) => isDescriptionClean(entry.report!)).length,
    refusals: imageSum((report) => (report.refused || report.empty ? 1 : 0)),
    memeMissed: imageSum((report) => (report.memeMissed ? 1 : 0)),
    factsDropped: imageSum((report) => report.missing.length),
    tooLong: imageSum((report) => (report.tooLong ? 1 : 0)),
    notUkrainian: imageSum((report) => (report.notUkrainian ? 1 : 0)),
    failed:
      outcome.summaries.filter((entry) => entry.error !== null).length +
      outcome.images.filter((entry) => entry.error !== null).length,
  };
}

/** Named halves rather than one list split by index, so a new check cannot land in the wrong table. */
const SUMMARY_TRACKED: readonly (readonly [keyof Tally, string])[] = [
  ['inventedIds', 'invented message ids'],
  ['bleeding', 'topic bleed'],
  ['duplicates', 'duplicate sections'],
  ['datelessEvents', 'dateless events'],
  ['idsInFullSummary', 'ids in fullSummary'],
];

const IMAGE_TRACKED: readonly (readonly [keyof Tally, string])[] = [
  ['refusals', 'image refusals'],
  ['memeMissed', 'meme not named'],
  ['factsDropped', 'caption facts dropped'],
  ['tooLong', 'over-long descriptions'],
  ['notUkrainian', 'not in Ukrainian'],
];

const TRACKED = [...SUMMARY_TRACKED, ...IMAGE_TRACKED];

type Verdict = { regressed: boolean; reasons: string[]; improvements: string[]; baseline: Tally; candidate: Tally };

function compare(baseline: ModelOutcome, candidate: ModelOutcome): Verdict {
  const before = tally(baseline);
  const after = tally(candidate);
  const reasons: string[] = [];

  const improvements: string[] = [];
  for (const [key, label] of TRACKED) {
    if ((after[key] as number) > (before[key] as number)) reasons.push(`${label}: ${before[key]} → ${after[key]}`);
    if ((after[key] as number) < (before[key] as number)) improvements.push(`${label}: ${before[key]} → ${after[key]}`);
  }
  if (after.summaryClean > before.summaryClean) {
    improvements.push(`clean summary runs: ${before.summaryClean} → ${after.summaryClean}`);
  }
  if (after.failed > before.failed) reasons.push(`failed calls: ${before.failed} → ${after.failed}`);
  if (after.coverage < before.coverage - 0.15) {
    reasons.push(`coverage dropped ${(before.coverage * 100).toFixed(0)}% → ${(after.coverage * 100).toFixed(0)}%`);
  }
  return { regressed: reasons.length > 0, reasons, improvements, baseline: before, candidate: after };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(baseline: string, candidate: string, outcomes: [string, ModelOutcome][], verdict: Verdict): void {
  const width = Math.max(baseline.length, candidate.length, 20) + 2;
  const lines = [`${'check'.padEnd(26)}${paint('bold', baseline.padEnd(width))}${paint('bold', candidate)}`];
  const row = (label: string, pick: (tally: Tally) => string): void => {
    lines.push(`${paint('dim', label.padEnd(26))}${pick(verdict.baseline).padEnd(width)}${pick(verdict.candidate)}`);
  };

  row('summary runs', (t) => `${t.summaryClean}/${t.summaryRuns} clean`);
  for (const [key, label] of SUMMARY_TRACKED) row(label, (t) => String(t[key]));
  row('coverage of input', (t) => `${(t.coverage * 100).toFixed(0)}%`);
  if (verdict.baseline.imageRuns + verdict.candidate.imageRuns > 0) {
    row('image runs', (t) => `${t.imageClean}/${t.imageRuns} clean`);
    for (const [key, label] of IMAGE_TRACKED) row(label, (t) => String(t[key]));
  }
  row('failed calls', (t) => String(t.failed));

  for (const [model, outcome] of outcomes) {
    for (const entry of outcome.summaries) {
      if (entry.error) lines.push(paint('red', `${model} ${entry.name} #${entry.run}: ${entry.error}`));
      else if (!isClean(entry.report!)) {
        const found = entry.report!;
        const detail = [
          found.bleedingIds.map((item) => `id ${item.id} in ${item.paths.join(' + ')}`),
          found.duplicateSections.map((item) => `${item.paths.join(' ~ ')} (${item.similarity.toFixed(2)})`),
          found.unknownIds.map((id) => `invented id ${id}`),
          found.eventsWithoutDate.map((event) => `dateless: ${event.slice(0, 45)}`),
          found.idsLeakedIntoFullSummary.map((id) => `id ${id} in fullSummary`),
        ].flat();
        lines.push(paint('yellow', `${model} ${entry.name} #${entry.run}: ${detail.join('; ')}`));
      }
    }
    for (const entry of outcome.images) {
      if (entry.description) lines.push(paint('dim', `${model} ${entry.name} #${entry.run}: ${entry.description}`));
      else if (entry.error) lines.push(paint('red', `${model} ${entry.name} #${entry.run}: ${entry.error}`));
    }
  }

  lines.push('');
  if (verdict.improvements.length > 0) {
    lines.push(paint('green', `${candidate} improved on ${baseline}:`));
    for (const improvement of verdict.improvements) lines.push(`  + ${improvement}`);
    lines.push('');
  }
  if (verdict.regressed) {
    lines.push(paint(['red', 'bold'], `${candidate} broke something ${baseline} did not:`));
    for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
    lines.push(
      paint(
        'dim',
        'Weigh these against the improvements above and against the counts, not just their direction: a metric that moves by one across all runs is within the noise of a sampled model. Raise --runs before treating a small difference as real.',
      ),
    );
  } else {
    lines.push(
      paint('green', `No regression observed: ${candidate} broke nothing that ${baseline} did not.`),
      paint(
        'dim',
        'Evidence from a finite number of sampled runs, not a proof. The image descriptions are printed above because whether they read well is a judgement no check can make.',
      ),
    );
  }
  stdout.write(`${lines.join('\n')}\n`);
}

await runCli(main);
