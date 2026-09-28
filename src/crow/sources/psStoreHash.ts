import { createHash } from 'node:crypto';
import { BROWSER_HEADERS } from './feed';
import { type Definition, parseDocument, printDocument, sortDocument, spreadsOf, withTypename } from './graphqlDocument';

const FETCH_TIMEOUT_MS = 30_000;
const STORE_ORIGIN = 'https://store.playstation.com';

/**
 * The hash of a persisted query of the PS Store, found as the store's own client finds it
 * (docs/crow/pipeline.md#sources): the API takes only the queries its client knows, by the sha256 of each, and a
 * new deploy of the client brings new ones. The client's bundles carry the queries as `gql` templates with their
 * fragments; the hash is of the document with `__typename` added to every selection and the AST sorted, printed as
 * graphql-js 14 prints it (graphqlDocument.ts). Checked on the store: the result is the hash its client sends.
 */

/** The `gql` templates of a bundle: an array of the template's strings, the first starting a definition */
const TEMPLATE = /[=(]\s*\[\s*("(?:\\n|\s)*(?:query|fragment|mutation)\b(?:[^"\\]|\\.)*")((?:\s*,\s*"(?:[^"\\]|\\.)*")*)\s*\]/g;

/** The named definitions of the bundles' templates: the operations and the fragments they spread */
export function bundleDefinitions(bundles: readonly string[]): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  for (const bundle of bundles) {
    for (const match of bundle.matchAll(TEMPLATE)) {
      const strings = [JSON.parse(match[1]) as string, ...(match[2] ? (JSON.parse(`[${match[2].replace(/^\s*,/, '')}]`) as string[]) : [])];
      let parsed: Definition[];
      try {
        parsed = parseDocument(strings.join('\n'));
      } catch {
        continue;
      }
      for (const definition of parsed) if (definition.name) definitions.set(definition.name, definition);
    }
  }
  return definitions;
}

/** The hash of an operation of the bundles, or null when they have no such operation or miss a fragment of it */
export function queryHash(definitions: ReadonlyMap<string, Definition>, operation: string): string | null {
  const root = definitions.get(operation);
  if (!root) return null;
  const needed: string[] = [];
  const queue = spreadsOf(root.selectionSet);
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (needed.includes(name)) continue;
    const fragment = definitions.get(name);
    if (!fragment) return null;
    needed.push(name);
    queue.push(...spreadsOf(fragment.selectionSet));
  }
  const document = sortDocument(withTypename([root, ...needed.map((name) => definitions.get(name)!)]));
  return createHash('sha256').update(printDocument(document)).digest('hex');
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

/**
 * The current hash of an operation of the store, from the bundles of one of its pages — a few megabytes, read only
 * when the hash kept is no longer taken
 */
export async function fetchQueryHash(pageUrl: string, operation: string): Promise<string> {
  const page = await getText(pageUrl);
  const scripts = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => new URL(match[1], STORE_ORIGIN).toString());
  const bundles: string[] = [];
  for (const script of scripts) bundles.push(await getText(script));
  const hash = queryHash(bundleDefinitions(bundles), operation);
  if (!hash) throw new Error(`The PS Store's bundles have no ${operation} with all its fragments`);
  return hash;
}
