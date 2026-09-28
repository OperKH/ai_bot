/** The most models a lab's roster entry lists */
const MAX_MODELS = 4;
/** Notes such as «(старший тариф)» are not part of a model's name */
const NOTE = /\([^)]*\)/g;
const VERSION = /\d+(?:\.\d+)*/;

/** The models of a roster entry: names separated by commas, the notes in parentheses kept with them */
const models = (entry: string) =>
  entry
    .split(/,\s*(?![^(]*\))/)
    .map((name) => name.trim())
    .filter(Boolean);

/** A model's line, its name without the version: «Claude Opus 5» and «Claude Opus 5.5» are one line */
export function modelLine(name: string): string {
  return name
    .toLowerCase()
    .replace(NOTE, ' ')
    .replace(new RegExp(VERSION, 'g'), ' ')
    .replace(/[^\p{L}]+/gu, ' ')
    .trim();
}

/** A model's version as numbers, «GPT-6.5 Sol» → [6, 5]; none for a name without digits */
export function modelVersion(name: string): number[] {
  return VERSION.exec(name.replace(NOTE, ' '))?.[0].split('.').map(Number) ?? [];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * A lab's roster entry once its new model is out, or null when the entry
 * already has it or something newer. A newer version of a model's line
 * replaces the older one, a model of a new line goes in front, and the lab's
 * other lines stay: Claude Opus 5.5 does not retire Claude Fable 5.1. The
 * newest come first, and only the first few are kept.
 */
export function mergeRoster(entry: string | null, model: string): string | null {
  const current = entry ? models(entry) : [];
  const line = modelLine(model);
  const sameLine = current.filter((name) => modelLine(name) === line);
  if (sameLine.some((name) => compareVersions(modelVersion(name), modelVersion(model)) >= 0)) return null;
  return [model, ...current.filter((name) => !sameLine.includes(name))].slice(0, MAX_MODELS).join(', ');
}
