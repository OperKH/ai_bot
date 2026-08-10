#!/usr/bin/env node
/**
 * Reports cheaper alternatives to the model the bot is configured to use, and
 * repoints every place that names it.
 *
 * Run from the repository root (Node >= 26, TypeScript is executed natively):
 *   node .claude/skills/update-openai-pricing/scripts/switch-model.ts --help
 */

import { parse as parseEnv } from 'dotenv';
import { readFile, writeFile } from 'node:fs/promises';
import { argv, env, stdout } from 'node:process';
import { parseArgs } from 'node:util';

import { assertOneOf, commaList, fetchText, paint, requireNode, runCli, setColor } from './cli.ts';
import {
  CONFIG_LOCATIONS,
  MODEL_VARIABLES,
  EFFORT_FOR,
  cheaperAlternatives,
  currentModels,
  equivalentEffort,
  readModel,
  replaceModel,
  type Alternative,
  type ConfigLocation,
  type LocationReading,
  type EffortVariable,
  type ModelVariable,
} from './model-config.ts';
import {
  MODELS_URL,
  acceptsImages,
  fetchCapabilityBundle,
  readCapabilities,
  supportsStructuredOutputs,
  type ModelCapabilities,
} from './capabilities.ts';
import { DEFAULT_CONSTANT, DEFAULT_PRICING_FILE, findPricingBlock, formatTriple, type ModelPrice } from './pricing.ts';

const options = {
  variable: { type: 'string', default: 'OPENAI_MODEL' },
  among: { type: 'string', multiple: true },
  to: { type: 'string' },
  'probe-efforts': { type: 'string' },
  'pricing-file': { type: 'string', default: DEFAULT_PRICING_FILE },
  constant: { type: 'string', default: DEFAULT_CONSTANT },
  compare: { type: 'boolean', default: false },
  'keep-effort': { type: 'boolean', default: false },
  'env-file': { type: 'string', default: '.env' },
  'models-url': { type: 'string', default: MODELS_URL },
  timeout: { type: 'string', default: '30000' },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  color: { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const USAGE = `openai model switcher — reports cheaper models and repoints every place naming the current one

Usage: node .claude/skills/update-openai-pricing/scripts/switch-model.ts [options]

  --variable <name>  ${MODEL_VARIABLES.join(' | ')}   (default: OPENAI_MODEL)
  --among <models>   only consider these as alternatives (repeatable, or comma separated)
  --to <model>       repoint every location at this model
  --probe-efforts <model>
                     only ask the API which reasoning_effort values this model accepts
                     and print them — free, the probe request is rejected before any
                     tokens are generated
  --compare          add a capability table for the current model and each alternative
  --keep-effort      do not touch the reasoning effort when switching model
  --env-file <path>  where OPENAI_API_KEY lives, for the effort probe (default: .env)
  --models-url <url> where the capability data lives    (default: the official models page)
  --timeout <ms>     network timeout per attempt        (default: 30000)
  --pricing-file <p> file holding the pricing constant  (default: ${DEFAULT_PRICING_FILE})
  --constant <name>  pricing constant to read           (default: MODEL_PRICING)
  --dry-run          report what --to would change, without writing
  --json             print the report as JSON
  --no-color         disable coloured output
  -h, --help         show this help

Without --to it only reports. A model is offered as an alternative when it costs no more on
input, cached input and output, and less on at least one — a model that is cheaper per input
token but dearer per output token can still cost more overall, so it is never suggested.

Exit codes: 0 fine, 2 failure.`;

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

  // A bare capability question: which efforts does this model accept? Needs no
  // config files and no pricing, so it answers before any of them are read.
  if (values['probe-efforts'] !== undefined) {
    const model = values['probe-efforts'];
    const { apiKey, baseURL } = await credentialsFor(values['env-file']);
    const accepted = await supportedEfforts(model, apiKey, baseURL, Number(values.timeout));
    if (values.json) stdout.write(`${JSON.stringify({ model, supported: accepted }, null, 2)}\n`);
    else stdout.write(`${model} accepts reasoning_effort: ${accepted.join(', ')}\n`);
    return 0;
  }

  const variable = assertOneOf(values.variable, MODEL_VARIABLES, 'variable') as ModelVariable;

  const prices = readPricing(await readFile(values['pricing-file'], 'utf8'), values.constant);
  const files = new Map<string, string | null>(
    await Promise.all(
      CONFIG_LOCATIONS.map(async (location) => [location.path, await readIfPresent(location)] as const),
    ),
  );

  const readings: LocationReading[] = CONFIG_LOCATIONS.map((location) => {
    const text = files.get(location.path);
    return { location, model: text == null ? null : readModel(text, location, variable) };
  });
  const current = currentModels(readings);
  if (current.length === 0) throw new Error(`No file declares ${variable} — nothing to compare or switch.`);

  const among = commaList(values.among);
  const alternatives =
    current.length === 1 ? cheaperAlternatives(prices, current[0], among.length ? among : undefined) : [];

  const compared: ModelCapabilities[] = [];
  if (values.compare && current.length === 1) {
    const bundle = await fetchCapabilityBundle((url) => fetchText(url, Number(values.timeout)), values['models-url']);
    for (const model of [current[0], ...alternatives.map((alternative) => alternative.model)]) {
      const capabilities = readCapabilities(bundle, model);
      if (capabilities) compared.push(capabilities);
    }
  }

  const target = values.to;
  const changes: { path: string; from: string; to: string }[] = [];
  const efforts: {
    variable: EffortVariable;
    supported: string[];
    changes: { path: string; from: string; to: string }[];
    unresolved: string[];
  } = { variable: EFFORT_FOR[variable], supported: [], changes: [], unresolved: [] };
  if (target !== undefined) {
    if (!prices.has(target)) {
      throw new Error(`${target} is not priced in ${values.constant}; add it before switching to it.`);
    }
    for (const { location, model } of readings) {
      const text = files.get(location.path);
      if (text === undefined || text === null || model === null || model === target) continue;
      const { text: next, replaced } = replaceModel(text, location, variable, target);
      if (!replaced) continue;
      changes.push({ path: location.path, from: model, to: target });
      // keep the in-memory copy current so the effort pass below edits this text, not a stale read
      files.set(location.path, next);
      if (!values['dry-run']) await writeFile(location.path, next);
    }

    // The model and its effort are one setting in two variables: gpt-5 models
    // spell the cheapest rung `minimal`, gpt-5.6 models spell it `none`, and a
    // model handed a rung it lacks fails every call with a 400. So the effort
    // moves with the model unless the caller opted out.
    if (!values['keep-effort']) {
      const { apiKey, baseURL } = await credentialsFor(values['env-file']);
      const accepted = await supportedEfforts(target, apiKey, baseURL, Number(values.timeout));
      efforts.supported = accepted;

      for (const location of CONFIG_LOCATIONS) {
        const text = files.get(location.path);
        if (text === undefined || text === null) continue;
        const currentEffort = readModel(text, location, efforts.variable);
        if (currentEffort === null) continue;
        const wanted = equivalentEffort(currentEffort, accepted);
        if (wanted === null) {
          efforts.unresolved.push(
            `${location.path}: ${target} accepts none of the rungs at or above "${currentEffort}"`,
          );
          continue;
        }
        if (wanted === currentEffort) continue;
        const { text: next, replaced } = replaceModel(text, location, efforts.variable, wanted);
        if (!replaced) continue;
        efforts.changes.push({ path: location.path, from: currentEffort, to: wanted });
        if (!values['dry-run']) await writeFile(location.path, next);
      }
    }
  }

  const written = target !== undefined && !values['dry-run'];
  if (values.json) {
    stdout.write(
      `${JSON.stringify(
        {
          variable,
          current,
          alternatives: alternatives.map((alternative) => ({
            ...alternative,
            outputSaving: Number((alternative.outputSaving * 100).toFixed(1)),
          })),
          locations: readings.map(({ location, model }) => ({
            path: location.path,
            label: location.label,
            model,
            missing: files.get(location.path) === null,
          })),
          changes,
          efforts,
          capabilities: compared,
          written,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    report({ variable, current, alternatives, readings, files, changes, efforts, compared, prices, written });
  }
  return 0;
}

function readPricing(source: string, constantName: string): Map<string, ModelPrice> {
  const { entries } = findPricingBlock(source, constantName);
  if (entries.size === 0) throw new Error(`${constantName} is empty — refresh it with update-pricing.ts first.`);
  return entries;
}

/**
 * Asks the API which reasoning efforts a model accepts, by sending one it cannot
 * accept. The request is rejected during validation, before any tokens are
 * generated, so the answer costs nothing.
 */
async function supportedEfforts(model: string, apiKey: string, baseURL: string, timeout: number): Promise<string[]> {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      reasoning_effort: '__unsupported_probe__',
      messages: [{ role: 'user', content: 'probe' }],
    }),
  });
  const body = (await response.json()) as { error?: { message?: string } };
  const message = body.error?.message ?? '';
  const listed = [...message.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
  const values = listed.filter((value) => value !== '__unsupported_probe__' && value !== 'reasoning_effort');
  if (values.length === 0)
    throw new Error(`could not read the supported efforts for ${model}: ${message.slice(0, 200)}`);
  return values;
}

async function credentialsFor(envFile: string): Promise<{ apiKey: string; baseURL: string }> {
  // dotenv's parser rather than a regex, so quoting and comments behave exactly
  // as they do when the app itself loads the same file
  const parsed = parseEnv(await readFile(envFile, 'utf8').catch(() => ''));
  const apiKey = env.OPENAI_API_KEY || parsed.OPENAI_API_KEY || '';
  const baseURL = env.OPENAI_BASE_URL || parsed.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  if (!apiKey) throw new Error(`No OPENAI_API_KEY in the environment or in ${envFile}; cannot probe efforts.`);
  return { apiKey, baseURL };
}

async function readIfPresent(location: ConfigLocation): Promise<string | null> {
  try {
    return await readFile(location.path, 'utf8');
  } catch (error) {
    if (location.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type ReportInput = {
  variable: ModelVariable;
  current: string[];
  alternatives: Alternative[];
  readings: LocationReading[];
  files: Map<string, string | null>;
  changes: { path: string; from: string; to: string }[];
  efforts: {
    variable: EffortVariable;
    supported: string[];
    changes: { path: string; from: string; to: string }[];
    unresolved: string[];
  };
  compared: ModelCapabilities[];
  prices: ReadonlyMap<string, ModelPrice>;
  written: boolean;
};

const yesNo = (value: boolean | null): string => (value === null ? '?' : value ? 'yes' : 'no');

const tokens = (value: number | null): string => {
  if (value === null) return '?';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  return `${Math.round(value / 1000)}K`;
};

/**
 * What this bot needs from a model, so the table answers "would the swap break
 * something" rather than only "is it cheaper".
 *
 * `describeImage` sends an image, and the trends summariser sends a Zod schema
 * and relies on the model thinking before it answers so that topics do not bleed
 * into one another. A model missing any of the three cannot take the job.
 */
const SCENARIOS: readonly { label: string; needs: (capabilities: ModelCapabilities) => boolean }[] = [
  { label: 'describes images', needs: acceptsImages },
  { label: 'obeys a schema', needs: supportsStructuredOutputs },
  { label: 'reasons first', needs: (capabilities) => capabilities.reasoningTokens === true },
];

function capabilityTable(input: ReportInput): string[] {
  const models = input.compared;
  if (models.length < 2) return [];

  const columns = models.map((model) => model.model);
  const rows: [string, (capabilities: ModelCapabilities) => string][] = [
    ['tier', (c) => c.displayName ?? c.model],
    ['kind', (c) => c.kind ?? '?'],
    ['performance 1-5', (c) => (c.performance === null ? '?' : String(c.performance))],
    ['latency 1-5 (5=fast)', (c) => (c.latency === null ? '?' : String(c.latency))],
    ['context window', (c) => tokens(c.contextWindow)],
    ['max output', (c) => tokens(c.maxOutputTokens)],
    ['snapshot', (c) => (c.deprecated === true ? `${c.snapshot ?? '?'} (deprecated)` : (c.snapshot ?? '?'))],
    ['price in/cache/out', (c) => priceOf(input.prices, c.model)],
  ];
  for (const scenario of SCENARIOS) rows.push([scenario.label, (c) => yesNo(scenario.needs(c))]);

  // widen to the widest cell, not just the header, or long values run together
  const label = Math.max(...rows.map(([text]) => text.length)) + 2;
  const width =
    Math.max(
      ...columns.map((name) => name.length),
      ...rows.flatMap(([, cell]) => models.map((model) => cell(model).length)),
    ) + 2;

  const lines = [`${''.padEnd(label)}${columns.map((name) => paint('bold', name.padEnd(width))).join('')}`];
  for (const [text, cell] of rows) {
    lines.push(`${paint('dim', text.padEnd(label))}${models.map((model) => cell(model).padEnd(width)).join('')}`);
  }

  const blockers = models.filter((model) => SCENARIOS.some((scenario) => !scenario.needs(model)));
  for (const model of blockers) {
    const missing = SCENARIOS.filter((scenario) => !scenario.needs(model)).map((scenario) => scenario.label);
    lines.push(paint('yellow', `${model.model} cannot: ${missing.join(', ')}`));
  }
  for (const model of models) {
    if (model.description) lines.push(paint('dim', `${model.model}: ${model.description}`));
  }
  return ['', ...lines];
}

const priceOf = (prices: ReadonlyMap<string, ModelPrice>, model: string): string => {
  const price = prices.get(model);
  return price ? formatTriple(price) : '?';
};

function report(input: ReportInput): void {
  const lines: string[] = [
    `${paint('dim', input.variable)} is ${input.current.map((m) => paint('bold', m)).join(' / ')}`,
  ];
  if (input.current.length > 1) {
    lines.push(paint('yellow', 'The places disagree — reconcile them before comparing prices.'));
  }
  lines.push('');

  for (const { location, model } of input.readings) {
    const missing = input.files.get(location.path) === null;
    const state = missing ? paint('dim', 'file absent') : (model ?? paint('yellow', 'not declared'));
    lines.push(`  ${location.path.padEnd(30)} ${state}   ${paint('dim', location.label)}`);
  }
  lines.push('');

  if (input.alternatives.length === 0) {
    lines.push('No cheaper alternative is priced in the constant.');
  } else {
    lines.push(`Cheaper alternatives ${paint('dim', '(input/cached/output per 1M)')}:`);
    for (const alternative of input.alternatives) {
      const saving = `−${(alternative.outputSaving * 100).toFixed(0)}% output`;
      lines.push(
        `  ${paint('green', alternative.model.padEnd(24))} ${formatTriple(alternative.price)}   ${paint('dim', saving)}`,
      );
    }
  }

  lines.push(...capabilityTable(input));

  if (input.changes.length > 0) {
    lines.push('', input.written ? 'Repointed:' : 'Would repoint:');
    for (const change of input.changes)
      lines.push(`  ${change.path.padEnd(30)} ${change.from} → ${paint('bold', change.to)}`);
  }

  if (input.efforts.supported.length > 0) {
    lines.push(
      '',
      paint('dim', `${input.efforts.variable} accepted by the target: ${input.efforts.supported.join(', ')}`),
    );
    for (const change of input.efforts.changes)
      lines.push(
        `  ${change.path.padEnd(30)} ${change.from} → ${paint('bold', change.to)}   ${paint('dim', 'effort')}`,
      );
    if (input.efforts.changes.length === 0 && input.efforts.unresolved.length === 0) {
      lines.push(paint('dim', '  the configured effort is already valid for it'));
    }
    for (const problem of input.efforts.unresolved) lines.push(paint('yellow', `  ${problem}`));
  }
  stdout.write(`${lines.join('\n')}\n`);
}

await runCli(main);
