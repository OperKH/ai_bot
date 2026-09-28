#!/usr/bin/env node
/**
 * Decodes the judges' verdicts of a crow A/B (`evaluate-crow.ts`) and says
 * whether the candidate would make the crow worse.
 *
 * Reads, from the run's directory, the arcs (`arcs.json`) and each judge's
 * answer (`judge_<n>.json`, written by the judge of `blind_<n>.md`), and the
 * keys from `<dir>-keys`, where the judges could not see them. The verdict rule
 * is `crowVerdict` in crow-checks.ts.
 *
 * Run from the repository root (Node >= 26):
 *   node .claude/skills/update-openai-pricing/scripts/score-crow.ts --out <dir>
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, stdout } from 'node:process';
import { parseArgs } from 'node:util';

import { paint, requireNode, runCli, setColor } from './cli.ts';
import {
  type ArcRun,
  type BlindKey,
  crowVerdict,
  type Decoded,
  decodeVerdicts,
  type JudgeVerdict,
  type Side,
  SIDES,
  tallyRows,
  tallySide,
} from './crow-checks.ts';

const options = {
  out: { type: 'string' },
  keys: { type: 'string' },
  json: { type: 'boolean', default: false },
  color: { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const USAGE = `decode the judges of a crow A/B and give the verdict

Usage: node .claude/skills/update-openai-pricing/scripts/score-crow.ts --out <dir of evaluate-crow>

  --out <dir>    the run's directory: arcs.json and judge_<n>.json
  --keys <dir>   the keys                        (default: <out>-keys)
  --json         print the report as JSON
  --no-color     disable coloured output
  -h, --help     show this help

The candidate counts as worse when the judges preferred the baseline in more than half of the
comparisons, or it bent more facts, gave fewer arcs fit to post as they are, failed the bot's own
checks more often, or returned no arc more often. Writes score.md next to the arcs.

Exit codes: 0 no degradation observed, 1 the candidate made the crow worse, 2 failure.`;

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

async function run(values: Values): Promise<number> {
  setColor(values.color);
  const out = values.out;
  if (!out) throw new Error('--out is required: the directory evaluate-crow.ts wrote.');
  const keys = values.keys ?? `${out}-keys`;
  const { models, arcs } = JSON.parse(await readFile(join(out, 'arcs.json'), 'utf8')) as {
    models: Record<Side, string>;
    arcs: Record<Side, ArcRun[]>;
  };

  const decoded: Decoded[] = [];
  const notes: string[] = [];
  for (let judge = 1; existsSync(join(out, `judge_${judge}.json`)); judge++) {
    const verdicts = JSON.parse(await readFile(join(out, `judge_${judge}.json`), 'utf8')) as JudgeVerdict[];
    const key = JSON.parse(await readFile(join(keys, `key_${judge}.json`), 'utf8')) as BlindKey;
    const mine = decodeVerdicts(verdicts, key, judge);
    decoded.push(...mine);
    verdicts.forEach((verdict, i) => {
      if (verdict.notes) notes.push(`judge ${judge}, ${verdict.item} (better: ${mine[i].better}): ${verdict.notes}`);
    });
  }
  if (decoded.length === 0) throw new Error(`no judge_<n>.json in ${out}: the judges have not answered yet.`);

  const tallies = { baseline: tallySide(arcs.baseline), candidate: tallySide(arcs.candidate) };
  const verdict = crowVerdict(decoded, tallies);
  // Every arc is judged by each judge, so the arcs fit to post are averaged over the judges
  const judgesPerArc = decoded.length / Math.max(1, tallies.baseline.arcs);
  const perGood = (side: Side) => {
    const good = verdict.publishable[side] / judgesPerArc;
    return good > 0 ? `$${(tallies[side].costUsd / good).toFixed(4)}` : '—';
  };

  const summary: [string, string, string][] = [
    ['preferred by the judges', String(verdict.wins.baseline), String(verdict.wins.candidate)],
    ['ties', String(verdict.ties), String(verdict.ties)],
    ['fact errors found', String(verdict.factErrors.baseline), String(verdict.factErrors.candidate)],
    ['arcs fit to post as they are', `${verdict.publishable.baseline}/${decoded.length}`, `${verdict.publishable.candidate}/${decoded.length}`],
    ['cost per arc fit to post', perGood('baseline'), perGood('candidate')],
    ...tallyRows(tallies),
  ];
  const factErrors = decoded.flatMap((d) =>
    SIDES.flatMap((side) => d.factErrors[side].map((error) => `${models[side]}, ${d.item}, judge ${d.judge}: ${error}`)),
  );
  const conclusion = verdict.degraded
    ? `${models.candidate} made the crow worse than ${models.baseline}:`
    : `No degradation observed: ${models.candidate} wrote the crow's arcs at least as well as ${models.baseline}.`;

  await writeFile(
    join(out, 'score.md'),
    [
      `# The crow's A/B: ${models.baseline} (baseline) against ${models.candidate}`,
      '',
      `${verdict.comparisons} comparisons (stories × runs × judges).`,
      '',
      `| | ${models.baseline} | ${models.candidate} |`,
      '| --- | --- | --- |',
      ...summary.map(([label, a, b]) => `| ${label} | ${a} | ${b} |`),
      '',
      `**${conclusion}**`,
      ...verdict.reasons.map((reason) => `- ${reason}`),
      '',
      '## Fact errors',
      '',
      ...(factErrors.length ? factErrors.map((error) => `- ${error}`) : ['None found.']),
      '',
      "## The judges' notes",
      '',
      ...notes.map((note) => `- ${note}`),
      '',
    ].join('\n'),
  );

  if (values.json) {
    stdout.write(`${JSON.stringify({ models, verdict, tallies, factErrors, notes }, null, 2)}\n`);
    return verdict.degraded ? 1 : 0;
  }
  const width = Math.max(models.baseline.length, models.candidate.length, 12) + 2;
  const lines = [`${''.padEnd(30)}${paint('bold', models.baseline.padEnd(width))}${paint('bold', models.candidate)}`];
  for (const [label, a, b] of summary) lines.push(`${paint('dim', label.padEnd(30))}${a.padEnd(width)}${b}`);
  lines.push('', paint(verdict.degraded ? ['red', 'bold'] : 'green', conclusion));
  for (const reason of verdict.reasons) lines.push(`  - ${reason}`);
  if (factErrors.length) lines.push('', 'Fact errors:', ...factErrors.map((error) => `  - ${error}`));
  lines.push(
    '',
    paint('dim', `Evidence over ${verdict.comparisons} comparisons of a handful of stories, not a proof. The judges' notes are in ${join(out, 'score.md')}.`),
  );
  stdout.write(`${lines.join('\n')}\n`);
  return verdict.degraded ? 1 : 0;
}

await runCli(main);
