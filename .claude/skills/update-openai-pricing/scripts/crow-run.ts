/**
 * What the crow's two A/Bs — the arcs (evaluate-crow.ts) and the talks
 * (evaluate-crow-talks.ts) — share beyond their pure checks: a worker per model
 * under tsx, and the judges' answers read back with the keys they could not see.
 *
 * Requires Node >= 26 (executed directly as TypeScript, no build step).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from 'node:process';

import { type BlindKey, type Decoded, decodeVerdicts, type JudgeVerdict } from './crow-checks.ts';

/**
 * One worker per model, under tsx: the app's modules need it. `vars` point the worker at the model, since
 * `ConfigService` reads them once at construction; the result is the worker's last line of `{"<field>": […]}`,
 * because the bot's service logs usage to stdout as well.
 */
export function callWorker<T>(
  worker: string,
  vars: Record<string, string>,
  job: unknown,
  timeout: number,
  field: string,
): Promise<T[]> {
  const what = Object.values(vars)[0];
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', worker], { env: { ...env, ...vars }, stdio: ['pipe', 'pipe', 'pipe'] });
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
        .filter((line) => line.startsWith(`{"${field}"`))
        .at(-1);
      if (!parsed) {
        reject(new Error(`worker for ${what} exited ${code} without a result: ${err.slice(-400) || out.slice(-400)}`));
        return;
      }
      resolve((JSON.parse(parsed) as Record<string, T[]>)[field]);
    });
    child.stdin.end(JSON.stringify(job));
  });
}

/** Every judge's answer (`judge_<n>.json` in `out`) decoded with its key from `keys`, and their notes */
export async function readJudges(out: string, keys: string): Promise<{ decoded: Decoded[]; notes: string[] }> {
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
  return { decoded, notes };
}
