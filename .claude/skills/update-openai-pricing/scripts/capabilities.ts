/**
 * Model capabilities, read from the docs site's own data bundle.
 *
 * The pricing page knows prices and nothing else, so it cannot answer the only
 * questions that matter when swapping the model this bot runs on: can it still
 * describe an image, and does it still reason before answering. That data lives
 * in the JavaScript bundle behind <https://developers.openai.com/api/docs/models>,
 * which carries a spec per model — modalities, supported features, context
 * window, a performance and latency rating, and whether it emits reasoning
 * tokens.
 *
 * The bundle is minified and its filename is content-hashed, so it is reached in
 * two hops from the models page and read with targeted patterns rather than
 * parsed as JavaScript. Every field is optional: a missing one is reported as
 * unknown instead of guessed.
 *
 * Requires Node >= 26 (executed directly as TypeScript, no build step).
 */

export const MODELS_URL = 'https://developers.openai.com/api/docs/models';

export type ModelCapabilities = {
  model: string;
  /** dated build the alias currently points at, where the spec actually lives */
  snapshot: string | null;
  /** the docs mark the snapshot, not the alias, as deprecated */
  deprecated: boolean | null;
  displayName: string | null;
  tagline: string | null;
  description: string | null;
  /** the docs' own classification, e.g. `reasoning` or `chat` */
  kind: string | null;
  /** the docs' 1–5 ratings; higher performance is better, higher latency is slower */
  performance: number | null;
  latency: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedFeatures: string[];
  supportedEndpoints: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoningTokens: boolean | null;
};

const EMPTY: Omit<ModelCapabilities, 'model'> = {
  snapshot: null,
  deprecated: null,
  displayName: null,
  tagline: null,
  description: null,
  kind: null,
  performance: null,
  latency: null,
  inputModalities: [],
  outputModalities: [],
  supportedFeatures: [],
  supportedEndpoints: [],
  contextWindow: null,
  maxOutputTokens: null,
  reasoningTokens: null,
};

const quoted = (list: string | undefined): string[] =>
  list === undefined ? [] : [...list.matchAll(/"([^"]*)"/g)].map((match) => match[1]);

const numeric = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Walks out to the object literal around `at` by counting braces backwards to
 * its `{` and forwards to the matching `}`.
 */
function enclosingObject(source: string, at: number): string | null {
  let start = -1;
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (source[i] === '}') depth++;
    else if (source[i] === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;

  depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

/**
 * A model is described by more than one object in the bundle. The prose — name,
 * tagline, description — hangs off the alias, while the technical spec hangs off
 * the dated snapshot the alias points at: `gpt-5-mini`'s modalities live under
 * `gpt-5-mini-2025-08-07`. So the alias is read first for `current_snapshot`,
 * then the snapshot is read for the rest. Later objects only fill gaps.
 */
export function readCapabilities(bundle: string, model: string): ModelCapabilities | null {
  const capabilities: ModelCapabilities = { model, ...EMPTY };
  let found = false;

  const absorb = (id: string): void => {
    const anchor = new RegExp(String.raw`name:"${RegExp.escape(id)}",slug:"${RegExp.escape(id)}"`, 'g');
    for (const match of bundle.matchAll(anchor)) {
      const block = enclosingObject(bundle, match.index);
      if (block === null) continue;
      found = true;
      merge(capabilities, block);
    }
  };

  absorb(model);
  if (capabilities.snapshot !== null && capabilities.snapshot !== model) absorb(capabilities.snapshot);
  return found ? capabilities : null;
}

function merge(capabilities: ModelCapabilities, block: string): void {
  capabilities.snapshot ??= /current_snapshot:"([^"]*)"/.exec(block)?.[1] ?? null;
  if (capabilities.deprecated === null) {
    const deprecated = /[,{]deprecated:(!0|!1|true|false)/.exec(block)?.[1];
    if (deprecated !== undefined) capabilities.deprecated = deprecated === '!0' || deprecated === 'true';
  }
  capabilities.displayName ??= /display_name:"([^"]*)"/.exec(block)?.[1] ?? null;
  capabilities.tagline ??= /tagline:"([^"]*)"/.exec(block)?.[1] ?? null;
  capabilities.description ??=
    /description:`([^`]*)`/.exec(block)?.[1]?.replaceAll(/\s+/g, ' ').trim() ??
    /description:"([^"]*)"/.exec(block)?.[1] ??
    null;
  capabilities.kind ??= /[,{]type:"([^"]*)"/.exec(block)?.[1] ?? null;
  capabilities.performance ??= numeric(/[,{]performance:(\d+)/.exec(block)?.[1]);
  capabilities.latency ??= numeric(/[,{]latency:(\d+)/.exec(block)?.[1]);
  capabilities.contextWindow ??= numeric(/context_window:([\d.e+]+)/.exec(block)?.[1]);
  capabilities.maxOutputTokens ??= numeric(/max_output_tokens:([\d.e+]+)/.exec(block)?.[1]);

  const modalities = /modalities:\{input:\[([^\]]*)\],output:\[([^\]]*)\]\}/.exec(block);
  if (modalities && capabilities.inputModalities.length === 0) {
    capabilities.inputModalities = quoted(modalities[1]);
    capabilities.outputModalities = quoted(modalities[2]);
  }
  if (capabilities.supportedFeatures.length === 0) {
    capabilities.supportedFeatures = quoted(/supported_features:\[([^\]]*)\]/.exec(block)?.[1]);
  }
  if (capabilities.supportedEndpoints.length === 0) {
    capabilities.supportedEndpoints = quoted(/supported_endpoints:\[([^\]]*)\]/.exec(block)?.[1]);
  }
  if (capabilities.reasoningTokens === null) {
    const reasoning = /reasoning_tokens:(!0|!1|true|false)/.exec(block)?.[1];
    if (reasoning !== undefined) capabilities.reasoningTokens = reasoning === '!0' || reasoning === 'true';
  }
}

/** Whether the model can be handed an image, which the image-description flow depends on. */
export const acceptsImages = (capabilities: ModelCapabilities): boolean =>
  capabilities.inputModalities.includes('image') || capabilities.supportedFeatures.includes('image_input');

/** Whether the model can be pinned to a schema, which the summarisation flow depends on. */
export const supportsStructuredOutputs = (capabilities: ModelCapabilities): boolean =>
  capabilities.supportedFeatures.includes('structured_outputs');

/**
 * Locates and downloads the bundle. The models page loads a `ModelOverview`
 * island whose script imports the data module beside it; both filenames carry a
 * content hash, so neither can be hard-coded.
 */
export async function fetchCapabilityBundle(
  fetchText: (url: string) => Promise<string>,
  modelsUrl: string = MODELS_URL,
): Promise<string> {
  const page = await fetchText(modelsUrl);
  const overview = /\/_astro\/ModelOverview[^"']*\.js/.exec(page)?.[0];
  if (!overview) throw new Error(`No ModelOverview script on ${modelsUrl} — the models page changed.`);

  const origin = new URL(modelsUrl).origin;
  const script = await fetchText(`${origin}${overview}`);
  const data = /["'](?:\.\/)?(models-page-data[^"']*\.js)["']/.exec(script)?.[1];
  if (!data) throw new Error('ModelOverview no longer imports models-page-data — the models page changed.');

  return fetchText(`${origin}/_astro/${data}`);
}
