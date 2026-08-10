/**
 * Plumbing shared by the skill's command-line entry points.
 *
 * update-pricing, switch-model and evaluate-models each need the same Node
 * gate, the same colour handling, the same fatal-error footer and the same
 * fetch behaviour. Keeping one copy here means a fix to any of them — a new
 * Node floor, a retry tweak — lands in every script at once instead of in
 * whichever copy someone remembered.
 *
 * Requires Node >= 26 (executed directly as TypeScript, no build step).
 */

import { env, exit, stderr, versions } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { styleText } from 'node:util';

export const REQUIRED_NODE_MAJOR = 26;

export function requireNode(): void {
  const major = Number.parseInt(versions.node, 10);
  if (major < REQUIRED_NODE_MAJOR) {
    throw new Error(
      `Node >= ${REQUIRED_NODE_MAJOR} is required, this is v${versions.node}. Try \`nvm use ${REQUIRED_NODE_MAJOR}\`.`,
    );
  }
}

/** `styleText` already drops colour when stdout is not a TTY; this is the explicit override. */
let colorEnabled = !env.NO_COLOR;

export function setColor(enabled: boolean): void {
  colorEnabled = enabled && !env.NO_COLOR;
}

export const paint = (style: Parameters<typeof styleText>[0], text: string): string =>
  colorEnabled ? styleText(style, text) : text;

/** `--add a --add b` and `--add a,b` are both accepted, so the caller can use whichever is convenient. */
export function commaList(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function assertOneOf(value: string, allowed: readonly string[], name: string): string {
  if (!allowed.includes(value)) throw new Error(`--${name} must be one of: ${allowed.join(', ')} (got "${value}")`);
  return value;
}

export async function fetchText(url: string, timeout: number, attempts = 3): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { accept: 'text/html', 'user-agent': 'openai-pricing-updater' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      if (attempt === attempts)
        throw new Error(`Failed to fetch ${url}: ${(error as Error).message}`, { cause: error });
      await delay(500 * attempt);
    }
  }
}

/** The shared entry-point footer: exit with `main`'s code, or paint the error and exit 2. */
export async function runCli(main: () => Promise<number>): Promise<never> {
  try {
    exit(await main());
  } catch (error) {
    stderr.write(`${paint(['red', 'bold'], 'error:')} ${(error as Error).message}\n`);
    exit(2);
  }
}
