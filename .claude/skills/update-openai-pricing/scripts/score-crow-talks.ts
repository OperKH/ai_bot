#!/usr/bin/env node
/**
 * Decodes the judges' verdicts of the crow's talks A/B (`evaluate-crow-talks.ts`)
 * and says whether the candidate would make her talks worse.
 *
 * Reads, from the run's directory, the answers (`talks.json`) and each judge's
 * answer (`judge_<n>.json`, written by the judge of `blind_<n>.md`), and the
 * keys from `<dir>-keys`, where the judges could not see them. The verdict rule
 * is `talkVerdict` in crow-talk-checks.ts.
 *
 * Run from the repository root (Node >= 26):
 *   node .claude/skills/update-openai-pricing/scripts/score-crow-talks.ts --out <dir>
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argv, stdout } from 'node:process';
import { parseArgs } from 'node:util';

import { paint, requireNode, runCli, setColor } from './cli.ts';
import { type Side, sideNames, SIDES } from './crow-checks.ts';
import { readJudges } from './crow-run.ts';
import { talkRows, type TalkRun, talkVerdict, tallyTalks } from './crow-talk-checks.ts';

const options = {
  out: { type: 'string' },
  keys: { type: 'string' },
  json: { type: 'boolean', default: false },
  color: { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const USAGE = `decode the judges of the crow's talks A/B and give the verdict

Usage: node .claude/skills/update-openai-pricing/scripts/score-crow-talks.ts --out <dir of evaluate-crow-talks>

  --out <dir>    the run's directory: talks.json and judge_<n>.json
  --keys <dir>   the keys                        (default: <out>-keys)
  --json         print the report as JSON
  --no-color     disable coloured output
  -h, --help     show this help

The candidate counts as worse when the judges preferred the baseline in more than half of the
comparisons, or it bent more facts, gave fewer answers fit for the chat, failed the bot's own
checks more often, or returned no answer more often. Writes score.md next to the answers.

Exit codes: 0 no degradation observed, 1 the candidate made her talks worse, 2 failure.`;

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
  if (!out) throw new Error('--out is required: the directory evaluate-crow-talks.ts wrote.');
  const saved = JSON.parse(await readFile(join(out, 'talks.json'), 'utf8')) as {
    models: Record<Side, string>;
    efforts: Record<Side, string>;
    talks: Record<Side, TalkRun[]>;
  };
  const { talks } = saved;
  const models = sideNames(saved.models, saved.efforts);
  const { decoded, notes } = await readJudges(out, values.keys ?? `${out}-keys`);

  const tallies = { baseline: tallyTalks(talks.baseline), candidate: tallyTalks(talks.candidate) };
  const verdict = talkVerdict(decoded, tallies);
  const summary: [string, string, string][] = [
    ['preferred by the judges', String(verdict.wins.baseline), String(verdict.wins.candidate)],
    ['ties', String(verdict.ties), String(verdict.ties)],
    ['fact errors found', String(verdict.factErrors.baseline), String(verdict.factErrors.candidate)],
    ['answers fit for the chat', `${verdict.publishable.baseline}/${decoded.length}`, `${verdict.publishable.candidate}/${decoded.length}`],
    ...talkRows(tallies),
  ];
  const factErrors = decoded.flatMap((d) =>
    SIDES.flatMap((side) => d.factErrors[side].map((error) => `${models[side]}, ${d.item}, judge ${d.judge}: ${error}`)),
  );
  const conclusion = verdict.degraded
    ? `${models.candidate} made her talks worse than ${models.baseline}:`
    : `No degradation observed: ${models.candidate} answered the cats at least as well as ${models.baseline}.`;

  await writeFile(
    join(out, 'score.md'),
    [
      `# The crow's talks A/B: ${models.baseline} (baseline) against ${models.candidate}`,
      '',
      `${verdict.comparisons} comparisons (talks × runs × judges).`,
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
    paint('dim', `Evidence over ${verdict.comparisons} comparisons of a handful of talks, not a proof. The judges' notes are in ${join(out, 'score.md')}.`),
  );
  stdout.write(`${lines.join('\n')}\n`);
  return verdict.degraded ? 1 : 0;
}

await runCli(main);
