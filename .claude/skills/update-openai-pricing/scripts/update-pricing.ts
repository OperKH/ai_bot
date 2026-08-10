#!/usr/bin/env node
/**
 * Refreshes the MODEL_PRICING constant from the official OpenAI pricing page.
 *
 * Run from the repository root (Node >= 26, TypeScript is executed natively):
 *   node .claude/skills/update-openai-pricing/scripts/update-pricing.ts --help
 */

import { readFile, writeFile } from 'node:fs/promises';
import { argv, stdout } from 'node:process';
import { parseArgs } from 'node:util';

import { assertOneOf, commaList, fetchText, paint, requireNode, runCli, setColor } from './cli.ts';
import {
  applyPricingUpdate,
  CONTEXT_TIERS,
  DEFAULT_CONSTANT,
  DEFAULT_PRICING_FILE,
  extractPrices,
  formatTriple,
  PRICING_URL,
  SERVICE_TIERS,
  type ContextTier,
  type ServiceTier,
  type UpdatePlan,
} from './pricing.ts';

const options = {
  url: { type: 'string', default: PRICING_URL },
  html: { type: 'string' },
  file: { type: 'string', default: DEFAULT_PRICING_FILE },
  constant: { type: 'string', default: DEFAULT_CONSTANT },
  tier: { type: 'string', default: 'standard' },
  context: { type: 'string', default: 'short' },
  'add-new': { type: 'boolean', default: false },
  prune: { type: 'boolean', default: false },
  add: { type: 'string', multiple: true },
  remove: { type: 'string', multiple: true },
  check: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  strict: { type: 'boolean', default: false },
  timeout: { type: 'string', default: '20000' },
  color: { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const USAGE = `openai pricing updater — rewrites a MODEL_PRICING constant from ${PRICING_URL}

Usage: node .claude/skills/update-openai-pricing/scripts/update-pricing.ts [options]

  --url <url>        pricing page to read           (default: the official page)
  --html <path>      parse a local HTML file instead of fetching
  --file <path>      TypeScript file to rewrite     (default: ${DEFAULT_PRICING_FILE})
  --constant <name>  constant to rewrite            (default: MODEL_PRICING)
  --tier <tier>      service tier: ${SERVICE_TIERS.join(' | ')}   (default: standard)
  --context <tier>   context window: ${CONTEXT_TIERS.join(' | ')}  (default: short)
  --add <models>     add exactly these models (repeatable, or comma separated)
  --remove <models>  drop exactly these models (repeatable, or comma separated)
  --add-new          add every model the page lists but the file does not have
  --prune            drop every model the page no longer lists
  --check            report only, exit 1 when the file is out of date
  --dry-run          report only, never write, always exit 0
  --json             print the report as JSON
  --strict           treat parser warnings as errors
  --timeout <ms>     network timeout per attempt    (default: 20000)
  --no-color         disable coloured output
  -h, --help         show this help

Exit codes: 0 up to date / written, 1 out of date (--check), 2 failure.`;

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

async function run(values: Values): Promise<number> {
  setColor(values.color);
  const tier = assertOneOf(values.tier, SERVICE_TIERS, 'tier') as ServiceTier;
  const context = assertOneOf(values.context, CONTEXT_TIERS, 'context') as ContextTier;
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`--timeout must be a positive number of milliseconds`);

  const origin = values.html ?? values.url;
  // the page and the target file are independent inputs, so read them together
  const [html, source] = await Promise.all([
    values.html ? readFile(values.html, 'utf8') : fetchText(values.url, timeout),
    readFile(values.file, 'utf8'),
  ]);
  const { prices, warnings } = extractPrices(html, { tier, context });
  if (values.strict && warnings.length > 0) {
    throw new Error(`Parser warnings with --strict:\n${warnings.map((warning) => `  - ${warning}`).join('\n')}`);
  }

  const { source: updated, plan } = applyPricingUpdate(source, prices, {
    constantName: values.constant,
    addNew: values['add-new'],
    prune: values.prune,
    add: commaList(values.add),
    remove: commaList(values.remove),
  });

  const writing = !values.check && !values['dry-run'];
  if (writing && plan.changed) await writeFile(values.file, updated);

  if (values.json) {
    stdout.write(
      `${JSON.stringify({ origin, tier, context, file: values.file, written: writing && plan.changed, warnings, ...plan }, null, 2)}\n`,
    );
  } else {
    report({
      plan,
      warnings,
      origin,
      tier,
      context,
      file: values.file,
      written: writing && plan.changed,
      models: prices.size,
    });
  }

  return values.check && plan.changed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type ReportInput = {
  plan: UpdatePlan;
  warnings: string[];
  origin: string;
  tier: ServiceTier;
  context: ContextTier;
  file: string;
  written: boolean;
  models: number;
};

function report(input: ReportInput): void {
  const { plan } = input;
  const lines: string[] = [
    `${paint('dim', 'source ')}${input.origin} · ${input.tier} tier · ${input.context} context · ${input.models} models on page`,
    `${paint('dim', 'target ')}${input.file}`,
    '',
  ];

  for (const { model, from, to } of plan.updated) {
    lines.push(
      `${paint('yellow', '~')} ${model.padEnd(24)} ${paint('dim', formatTriple(from))} → ${paint('bold', formatTriple(to))}`,
    );
  }
  for (const { model, to } of plan.added) lines.push(`${paint('green', '+')} ${model.padEnd(24)} ${formatTriple(to)}`);
  for (const { model, from } of plan.removed)
    lines.push(`${paint('red', '-')} ${model.padEnd(24)} ${paint('dim', formatTriple(from))}`);

  if (plan.updated.length + plan.added.length + plan.removed.length === 0) {
    lines.push(paint('green', 'Prices are already up to date.'));
  }
  lines.push(
    '',
    `${plan.updated.length} updated · ${plan.added.length} added · ${plan.removed.length} removed · ${plan.unchanged.length} unchanged`,
  );

  if (plan.newOnPage.length > 0 && plan.added.length === 0) {
    lines.push(paint('dim', `not in the file (use --add-new): ${plan.newOnPage.join(', ')}`));
  }
  if (plan.missingOnPage.length > 0 && plan.removed.length === 0) {
    lines.push(paint('dim', `no longer on the page (use --prune): ${plan.missingOnPage.join(', ')}`));
  }
  for (const warning of input.warnings) lines.push(paint('yellow', `warning: ${warning}`));
  lines.push(input.written ? paint('green', `Wrote ${input.file}`) : paint('dim', 'No file was written.'));

  stdout.write(`${lines.join('\n')}\n`);
}

await runCli(main);
