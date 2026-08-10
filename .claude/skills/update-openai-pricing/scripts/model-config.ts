/**
 * Pure core for pointing the bot at a different OpenAI model.
 *
 * The model id is repeated in several places — the runtime env files, the
 * ConfigService fallback and the docs — so switching it by hand reliably leaves
 * one behind. Every place is declared here once, as a pattern that captures the
 * id, and both reading and rewriting go through that declaration.
 *
 * Requires Node >= 26 (executed directly as TypeScript, no build step).
 */

import type { ModelPrice } from './pricing.ts';

export type ModelVariable = 'OPENAI_MODEL' | 'OPENAI_VISION_MODEL';
export type EffortVariable = 'OPENAI_REASONING_EFFORT' | 'OPENAI_VISION_REASONING_EFFORT';
export type ConfigVariable = ModelVariable | EffortVariable;

export const MODEL_VARIABLES: readonly ModelVariable[] = ['OPENAI_MODEL', 'OPENAI_VISION_MODEL'];

/** The effort that governs each model variable, since the two must move together. */
export const EFFORT_FOR: Readonly<Record<ModelVariable, EffortVariable>> = {
  OPENAI_MODEL: 'OPENAI_REASONING_EFFORT',
  OPENAI_VISION_MODEL: 'OPENAI_VISION_REASONING_EFFORT',
};

/**
 * Reasoning efforts as rungs, cheapest first. `none` and `minimal` are the same
 * rung under two names — gpt-5 models call it `minimal`, gpt-5.6 models call it
 * `none` — which is why a model swap can invalidate the setting even though the
 * intent has not changed.
 */
export const EFFORT_RUNGS: readonly (readonly string[])[] = [
  ['none', 'minimal'],
  ['low'],
  ['medium'],
  ['high'],
  ['xhigh'],
  ['max'],
];

/**
 * Translates an effort onto a model that does not accept it: same rung under a
 * different name where one exists, otherwise the next rung up.
 *
 * Stepping **up** on a tie is deliberate. Too little reasoning is the failure
 * this bot cares about — topics bleeding together in the summary — so when the
 * exact intent cannot be expressed, err towards thinking more and paying more
 * rather than towards a quieter regression.
 */
export function equivalentEffort(current: string, supported: readonly string[]): string | null {
  if (supported.includes(current)) return current;
  const from = EFFORT_RUNGS.findIndex((rung) => rung.includes(current));
  if (from === -1) return null;
  for (const rung of EFFORT_RUNGS.slice(from)) {
    const match = rung.find((alias) => supported.includes(alias));
    if (match) return match;
  }
  return null;
}

export type ConfigLocation = {
  /** path relative to the repository root */
  path: string;
  /** what the file is, for the report */
  label: string;
  /** must capture the model id in a group named `model` */
  pattern: (variable: ConfigVariable) => RegExp;
  /** local-only files are allowed to be absent */
  optional?: boolean;
};

const envPattern = (variable: ConfigVariable): RegExp =>
  new RegExp(String.raw`^${RegExp.escape(variable)}=(?<model>.*)$`, 'm');

export const CONFIG_LOCATIONS: readonly ConfigLocation[] = [
  { path: '.env', label: 'local runtime', optional: true, pattern: envPattern },
  { path: '.env.prod.local', label: 'production runtime', optional: true, pattern: envPattern },
  { path: '.env.example', label: 'env template', pattern: envPattern },
  {
    path: 'src/config/config.service.ts',
    label: 'ConfigService fallback',
    pattern: (variable) =>
      new RegExp(
        String.raw`${RegExp.escape(variable)}:\s*(?:process\.env\.${RegExp.escape(variable)}\s*\|\||reasoningEffort\(process\.env\.${RegExp.escape(variable)},)\s*'(?<model>[^']*)'`,
      ),
  },
  {
    path: 'CLAUDE.md',
    label: 'documented default',
    pattern: (variable) =>
      new RegExp(String.raw`\x60${RegExp.escape(variable)}\x60[^\n]*?default:\s*(?<model>[^)\s]+)`),
  },
];

export type LocationReading = {
  location: ConfigLocation;
  /** null when the file has no line for this variable */
  model: string | null;
};

export function readModel(text: string, location: ConfigLocation, variable: ConfigVariable): string | null {
  const match = location.pattern(variable).exec(text);
  const model = match?.groups?.model?.trim();
  return model ? model : null;
}

/** Replaces only the captured id, so comments and surrounding formatting survive. */
export function replaceModel(
  text: string,
  location: ConfigLocation,
  variable: ConfigVariable,
  value: string,
): { text: string; replaced: boolean } {
  const match = location.pattern(variable).exec(text);
  const found = match?.groups?.model;
  if (!match || found === undefined) return { text, replaced: false };
  const start = match.index + match[0].lastIndexOf(found);
  const next = text.slice(0, start) + value + text.slice(start + found.length);
  return { text: next, replaced: next !== text };
}

/** The single id in use, or every distinct one when the places disagree. */
export function currentModels(readings: readonly LocationReading[]): string[] {
  return [...new Set(readings.map((reading) => reading.model).filter((model) => model !== null))];
}

export type Alternative = {
  model: string;
  price: ModelPrice;
  /** share of the output price saved, 0–1 */
  outputSaving: number;
};

/**
 * Models that cost no more than `current` on input, cached input and output, and
 * strictly less on at least one. Dominance is the only honest test without
 * knowing the workload mix — a model that is cheaper per input token but dearer
 * per output token may well cost more in practice, so it is not offered.
 *
 * Ordered by output price descending: the candidate nearest the current price
 * comes first, because it is the smallest step away from the model in use.
 */
export function cheaperAlternatives(
  prices: ReadonlyMap<string, ModelPrice>,
  current: string,
  among?: readonly string[],
): Alternative[] {
  const reference = prices.get(current);
  if (!reference) return [];
  const pool = among ? new Set(among) : null;

  const alternatives: Alternative[] = [];
  for (const [model, price] of prices) {
    if (model === current || (pool && !pool.has(model))) continue;
    const noWorse =
      price.input <= reference.input && price.cached <= reference.cached && price.output <= reference.output;
    const better = price.input < reference.input || price.cached < reference.cached || price.output < reference.output;
    if (!noWorse || !better) continue;
    alternatives.push({
      model,
      price,
      outputSaving: reference.output === 0 ? 0 : (reference.output - price.output) / reference.output,
    });
  }
  return alternatives.sort((a, b) => b.price.output - a.price.output);
}
