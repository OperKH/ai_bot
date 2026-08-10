/**
 * Pure parsing/rendering core for the OpenAI pricing updater.
 *
 * The pricing page (https://developers.openai.com/api/docs/pricing) is an Astro site.
 * Every table is an `<astro-island>` element whose `props` attribute holds the full
 * dataset serialised in Astro's `[type, value]` hydration format — the server-rendered
 * markup next to it only contains the first few visible rows, so the props are the
 * only complete and stable source on the page.
 *
 * Requires Node >= 26 (executed directly as TypeScript, no build step).
 */

export type ServiceTier = 'standard' | 'batch' | 'flex' | 'fast';
export type ContextTier = 'short' | 'long';

export type ModelPrice = {
  input: number;
  cached: number;
  output: number;
};

export type ExtractedPrice = ModelPrice & {
  /** id of the table spec the row came from — used in conflict messages */
  table: string;
};

export type ExtractOptions = {
  tier?: ServiceTier;
  context?: ContextTier;
};

export type ExtractResult = {
  /** insertion-ordered: page order, first table wins */
  prices: Map<string, ExtractedPrice>;
  warnings: string[];
};

export type Island = {
  component: string;
  props: Record<string, unknown>;
  /** service tier of the switcher panel the island sits in, `null` when it sits outside one */
  tier: ServiceTier | null;
};

export const PRICING_URL = 'https://developers.openai.com/api/docs/pricing';
export const SERVICE_TIERS: readonly ServiceTier[] = ['standard', 'batch', 'flex', 'fast'];
export const CONTEXT_TIERS: readonly ContextTier[] = ['short', 'long'];
/** Where the constant lives today. Declared once so moving it is a one-line change. */
export const DEFAULT_PRICING_FILE = 'src/services/openai.service.ts';
export const DEFAULT_CONSTANT = 'MODEL_PRICING';

// ---------------------------------------------------------------------------
// Astro island decoding
// ---------------------------------------------------------------------------

const ENTITIES: readonly (readonly [string, string])[] = [
  ['&quot;', '"'],
  ['&#34;', '"'],
  ['&#39;', "'"],
  ['&apos;', "'"],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&nbsp;', ' '],
  ['&amp;', '&'], // must stay last: `&amp;lt;` has to decode to `&lt;`, not `<`
];

export function decodeHtmlEntities(value: string): string {
  let out = value;
  for (const [entity, char] of ENTITIES) out = out.replaceAll(entity, char);
  return out.replaceAll(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/**
 * Astro serialises every prop value as a `[type, value]` pair (see astro's
 * `PROP_TYPE`). We only need the two types the pricing tables use:
 *   0 — plain value (primitive, or an object whose own values are pairs)
 *   1 — array of pairs
 * A lone `[0]` means `undefined`. Anything else is surfaced as an error rather
 * than silently mis-decoded, so a format change fails loudly instead of
 * producing wrong prices.
 */
export function decodeAstroValue(node: unknown): unknown {
  if (!Array.isArray(node)) throw new TypeError(`Expected an Astro [type, value] pair, got ${JSON.stringify(node)}`);
  const [type, value] = node as [number, unknown];
  if (node.length === 1) return undefined;
  switch (type) {
    case 0:
      return decodePlain(value);
    case 1:
      return (value as unknown[]).map(decodeAstroValue);
    default:
      throw new TypeError(`Unsupported Astro prop type ${type}`);
  }
}

function decodePlain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeAstroValue);
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, decodeAstroValue(inner)]));
}

const ISLAND_TOKEN_RE = /<astro-island\b([^>]*)>|<\/astro-island>/g;
const COMPONENT_RE = /\bcomponent-export="([^"]*)"/;
const PROPS_RE = /\bprops="([^"]*)"/;
const TIER_MARKER_RE = /data-value="([a-z]+)"/g;
/** the docs use both names for the same tier */
const TIER_ALIASES = new Map<string, ServiceTier>([['priority', 'fast']]);

/**
 * Several tables exist once per service tier, rendered as the panels of a
 * "Standard / Fast mode" switcher, and only the panel wrapper says which tier a
 * table belongs to. The marker is taken from the markup between the previous
 * island and this one, so a table that sits outside any switcher does not
 * accidentally inherit the tier of the section above it.
 */
function lastTierMarker(segment: string): ServiceTier | null {
  let tier: ServiceTier | null = null;
  for (const match of segment.matchAll(TIER_MARKER_RE)) {
    const value = TIER_ALIASES.get(match[1]) ?? (match[1] as ServiceTier);
    if (SERVICE_TIERS.includes(value)) tier = value;
  }
  return tier;
}

/** All hydration islands on the page, in document order. */
export function extractIslands(html: string): Island[] {
  const islands: Island[] = [];
  let segmentStart = 0;
  for (const token of html.matchAll(ISLAND_TOKEN_RE)) {
    if (token[1] === undefined) {
      segmentStart = token.index + token[0].length;
      continue;
    }
    const tier = lastTierMarker(html.slice(segmentStart, token.index));
    const attrs = token[1];
    const component = COMPONENT_RE.exec(attrs)?.[1];
    const rawProps = PROPS_RE.exec(attrs)?.[1];
    if (!component || component === 'default' || !rawProps) continue;
    const parsed = JSON.parse(decodeHtmlEntities(rawProps)) as Record<string, unknown>;
    const props = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, decodeAstroValue(value)]));
    islands.push({ component, props, tier });
  }
  return islands;
}

// ---------------------------------------------------------------------------
// Cell / heading helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A cell is a plain string, a `{ __pricingHtml }` blob carrying markup such as
 * `gpt-3.5-turbo<br /><small>Legacy</small>`, or a `{ __pricingTooltipHeading }`
 * wrapper that puts the visible text in `label`.
 */
export function cellText(value: unknown): string {
  if (typeof value === 'string') return stripTags(value);
  if (typeof value === 'number') return String(value);
  if (isRecord(value)) {
    if (typeof value.__pricingHtml === 'string') return stripTags(value.__pricingHtml);
    const tooltip = value.__pricingTooltipHeading;
    if (isRecord(tooltip)) return cellText(tooltip.label);
  }
  return '';
}

function stripTags(value: string): string {
  return value
    .replaceAll(/<br\s*\/?>/gi, ' ')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * `null`/`'-'`/`''` mean "not offered" and yield `null`; `Free` is a real price of 0.
 * Numbers may arrive as numbers or as `$1.25` strings depending on the table.
 */
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = stripTags(value);
  if (text === '' || text === '-' || text === '—' || text === 'N/A') return null;
  if (text.toLowerCase() === 'free') return 0;
  const numeric = Number(text.replaceAll(/[$,\s]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

const CONTEXT_NOTE_RE = /^(?<base>.+?)\s*\((?<note>[^()]*context[^()]*)\)$/i;

/**
 * Some rows encode the context window in the model name itself, e.g.
 * `gpt-5.4-pro (<272K context length)`. Returns the bare model id plus the
 * context tier the row belongs to (`null` when the row applies to both).
 */
export function normalizeModelName(raw: unknown): { model: string; context: ContextTier | null } | null {
  const text = cellText(raw);
  if (text === '') return null;
  const match = CONTEXT_NOTE_RE.exec(text);
  if (!match?.groups) return { model: text, context: null };
  const note = match.groups.note;
  const context: ContextTier | null = /[<≤]|less|below|up to/i.test(note)
    ? 'short'
    : /[>≥]|more|above|over/i.test(note)
      ? 'long'
      : null;
  return { model: match.groups.base.trim(), context };
}

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

type Role = 'model' | 'input' | 'cached' | 'output';

const ROLE_BY_HEADING = new Map<string, Role>([
  ['model', 'model'],
  ['input', 'input'],
  ['cached input', 'cached'],
  ['output', 'output'],
]);

type ColumnPlan = {
  width: number;
  model: number;
  input: number;
  cached: number | null;
  output: number;
};

/**
 * Maps the table headings onto the four columns we care about.
 *
 * The "Cyber models" table repeats every price column twice under a
 * `Short context` / `Long context` heading group, which the flat `headings`
 * array spells out as `Short context input` / `Long context input`. Stripping
 * that prefix and keeping only the requested context is what selects one half
 * of such a table; tables without the prefix are context-agnostic.
 */
export function planColumns(headings: readonly unknown[], context: ContextTier): ColumnPlan | null {
  const found = new Map<Role, number>();
  headings.forEach((heading, index) => {
    const text = cellText(heading).toLowerCase();
    const prefix = /^(short|long) context /.exec(text);
    if (prefix && prefix[1] !== context) return;
    const role = ROLE_BY_HEADING.get(prefix ? text.slice(prefix[0].length) : text);
    if (role && !found.has(role)) found.set(role, index);
  });
  const input = found.get('input');
  const output = found.get('output');
  if (input === undefined || output === undefined) return null;
  return {
    width: headings.length,
    model: found.get('model') ?? 0,
    input,
    cached: found.get('cached') ?? null,
    output,
  };
}

/**
 * Older models predate cache-write pricing, so their rows simply omit that cell
 * (`['gpt-5.2', 1.75, 0.175, 14]` against a five-column header). The columns
 * that are always present sit at the front, so leading columns are anchored to
 * the start of the row and everything past `Cached input` is anchored to its
 * end. Rows that are longer than the header, or short by more than the number
 * of optional columns, are rejected by the caller.
 */
function cellAt(row: readonly unknown[], plan: ColumnPlan, index: number): unknown {
  const delta = plan.width - row.length;
  if (delta <= 0) return row[index];
  const pivot = plan.cached ?? plan.input;
  return index <= pivot ? row[index] : row[index - delta];
}

// ---------------------------------------------------------------------------
// Table specs
// ---------------------------------------------------------------------------

type TableSpec = {
  id: string;
  component: string;
  /** Headings are hard-coded only where the component does not ship them in props. */
  headings?: readonly string[];
  /** Context tier that rows of this table belong to unless their name says otherwise. */
  defaultContext?: ContextTier;
  accepts(island: Island, options: Required<ExtractOptions>): boolean;
};

/** Tables outside a switcher exist only in the standard tier. */
const islandTier = (island: Island): ServiceTier => island.tier ?? 'standard';

/**
 * Only tables that price text tokens per 1M are listed here. Image, audio,
 * video, tool and fine-tuning tables use the same components but different
 * headings ("Modality", "Size", "Training", ...), so they never match.
 */
const TABLE_SPECS: readonly TableSpec[] = [
  {
    id: 'text-tokens',
    component: 'TextTokenPricingTables',
    // This component renders its own header, so the column order has to live here.
    // Its props carry short-context prices only — the long-context figures the page
    // displays are derived from them at render time and never appear in the data.
    headings: ['Model', 'Input', 'Cached input', 'Cache writes', 'Output'],
    defaultContext: 'short',
    // this component states its own tier, so the surrounding panel is redundant
    accepts: (island, options) => island.props.tier === options.tier,
  },
  {
    id: 'context-split',
    component: 'GroupedPricingTable',
    accepts: (island, options) =>
      islandTier(island) === options.tier &&
      headingTexts(island).some((heading) => /^(short|long) context /.test(heading)),
  },
  {
    id: 'category-models',
    component: 'GroupedPricingTable',
    accepts: (island, options) => {
      const headings = headingTexts(island);
      return islandTier(island) === options.tier && headings[0] === 'category' && headings[1] === 'model';
    },
  },
];

function headingTexts(island: Island): string[] {
  const headings = island.props.headings;
  return Array.isArray(headings) ? headings.map((heading) => cellText(heading).toLowerCase()) : [];
}

/** Grouped tables keep the group label out of the row, so put it back in front. */
function tableRows(props: Record<string, unknown>): unknown[][] {
  const hidden = new Set((Array.isArray(props.hiddenModels) ? props.hiddenModels : []).map((name) => cellText(name)));
  const rows: unknown[][] = [];
  if (Array.isArray(props.groups)) {
    for (const group of props.groups) {
      if (!isRecord(group) || !Array.isArray(group.rows)) continue;
      const label = cellText(group.model);
      if (hidden.has(label)) continue;
      for (const row of group.rows) if (Array.isArray(row)) rows.push([label, ...row]);
    }
  } else if (Array.isArray(props.rows)) {
    for (const row of props.rows) {
      if (!Array.isArray(row)) continue;
      if (hidden.has(cellText(row[0]))) continue;
      rows.push(row);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Reads every text-token price on the page for one service tier and one context tier.
 *
 * Models are keyed by their bare id; the first table that prices a model wins and any
 * later table that disagrees raises a warning. That cross-check is deliberate: the
 * "Cyber models" table repeats the newest models with headings the page ships itself,
 * so it validates the hard-coded headings of the main text-token table.
 */
export function extractPrices(html: string, options: ExtractOptions = {}): ExtractResult {
  const resolved: Required<ExtractOptions> = { tier: options.tier ?? 'standard', context: options.context ?? 'short' };
  const prices = new Map<string, ExtractedPrice>();
  const warnings: string[] = [];
  const islands = extractIslands(html);
  if (islands.length === 0) warnings.push('No <astro-island> elements found — the page layout changed.');

  for (const island of islands) {
    const spec = TABLE_SPECS.find(
      (candidate) => candidate.component === island.component && candidate.accepts(island, resolved),
    );
    if (!spec) continue;

    const headings = spec.headings ?? (Array.isArray(island.props.headings) ? island.props.headings : []);
    const plan = planColumns(headings, resolved.context);
    if (!plan) {
      warnings.push(`Table "${spec.id}" has no ${resolved.context}-context Input/Output columns — skipped.`);
      continue;
    }

    for (const row of tableRows(island.props)) {
      if (row.length > plan.width || plan.width - row.length > 2) continue;
      const name = normalizeModelName(cellAt(row, plan, plan.model));
      if (!name) continue;
      // A row belongs to the context tier its own name declares; when the name is
      // silent it falls back to the tier the table implies (the text token table
      // ships short-context numbers) and otherwise applies to every tier.
      const rowContext = name.context ?? spec.defaultContext ?? resolved.context;
      if (rowContext !== resolved.context) continue;

      const input = parseAmount(cellAt(row, plan, plan.input));
      const output = parseAmount(cellAt(row, plan, plan.output));
      // A row without both an input and an output price is not a chat model
      // (embeddings, moderation, retired models) — never a partially parsed one.
      if (input === null || output === null) continue;
      const cached = plan.cached === null ? null : parseAmount(cellAt(row, plan, plan.cached));

      const entry: ExtractedPrice = { table: spec.id, input, cached: cached ?? 0, output };
      const existing = prices.get(name.model);
      if (!existing) {
        prices.set(name.model, entry);
      } else if (
        existing.input !== entry.input ||
        existing.cached !== entry.cached ||
        existing.output !== entry.output
      ) {
        warnings.push(
          `Conflicting prices for ${name.model}: ${spec.id} says ${formatTriple(entry)} but ` +
            `${existing.table} says ${formatTriple(existing)} — column mapping may have drifted.`,
        );
      }
    }
  }

  if (prices.size === 0) warnings.push(`No ${resolved.tier}-tier text token prices found on the page.`);
  return { prices, warnings };
}

/** One price as `input/cached/output`, in the same style {@link renderEntries} writes. */
export const formatTriple = (price: ModelPrice): string =>
  `${formatPrice(price.input)}/${formatPrice(price.cached)}/${formatPrice(price.output)}`;

// ---------------------------------------------------------------------------
// Source file rewriting
// ---------------------------------------------------------------------------

export type PricingBlock = {
  /** whole `const NAME... = { ... };` statement */
  text: string;
  /** the declaration up to and including the brace that opens the object literal */
  header: string;
  start: number;
  end: number;
  indent: string;
  entries: Map<string, ModelPrice>;
};

const ENTRY_RE =
  /^\s*(?:'(?<quoted>[^']+)'|"(?<dquoted>[^"]+)"|(?<bare>[A-Za-z_$][\w$]*))\s*:\s*\{\s*input:\s*(?<input>-?[\d.]+)\s*,\s*cached:\s*(?<cached>-?[\d.]+)\s*,\s*output:\s*(?<output>-?[\d.]+)\s*,?\s*\}\s*,?\s*$/;

/** Locates the pricing constant and parses the entries already written in it. */
export function findPricingBlock(source: string, constantName = 'MODEL_PRICING'): PricingBlock {
  const anchor = new RegExp(String.raw`^(?<indent>[ \t]*)(?:export\s+)?const\s+${constantName}\b[^=]*=\s*\{`, 'm').exec(
    source,
  );
  if (!anchor) throw new Error(`Could not find \`const ${constantName} = {\` in the target file.`);

  const braceStart = source.indexOf('{', anchor.index + anchor[0].length - 1);
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < source.length; i++) {
    const char = source[i];
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      braceEnd = i;
      break;
    }
  }
  if (braceEnd === -1) throw new Error(`\`${constantName}\` is not closed — refusing to rewrite the file.`);

  const semicolon = source.indexOf(';', braceEnd);
  const end = semicolon === -1 ? braceEnd + 1 : semicolon + 1;
  const entries = new Map<string, ModelPrice>();
  for (const line of source.slice(braceStart + 1, braceEnd).split('\n')) {
    const match = ENTRY_RE.exec(line);
    if (!match?.groups) continue;
    const { quoted, dquoted, bare, input, cached, output } = match.groups;
    entries.set(quoted ?? dquoted ?? bare, { input: Number(input), cached: Number(cached), output: Number(output) });
  }

  return {
    text: source.slice(anchor.index, end),
    // sliced by position, not by searching for `{`: the type annotation
    // (`Record<string, { input: number ... }>`) contains braces of its own
    header: source.slice(anchor.index, braceStart + 1),
    start: anchor.index,
    end,
    indent: anchor.groups?.indent ?? '',
    entries,
  };
}

/** Mirrors the existing style: `0` stays bare, whole numbers keep one decimal. */
export function formatPrice(value: number): string {
  if (value === 0) return '0';
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function renderEntries(entries: ReadonlyMap<string, ModelPrice>, indent: string): string {
  const lines: string[] = [];
  for (const [model, price] of entries) {
    const key = IDENTIFIER_RE.test(model) ? model : `'${model}'`;
    lines.push(
      `${indent}  ${key}: { input: ${formatPrice(price.input)}, cached: ${formatPrice(price.cached)}, output: ${formatPrice(price.output)} },`,
    );
  }
  return lines.join('\n');
}

export type UpdateOptions = {
  constantName?: string;
  /** add every model present on the page but missing from the file */
  addNew?: boolean;
  /** drop every model the page no longer lists */
  prune?: boolean;
  /** add exactly these models; each must be priced on the page */
  add?: readonly string[];
  /** drop exactly these models, whether or not the page still lists them */
  remove?: readonly string[];
};

export type UpdatePlan = {
  added: { model: string; to: ModelPrice }[];
  updated: { model: string; from: ModelPrice; to: ModelPrice }[];
  removed: { model: string; from: ModelPrice }[];
  unchanged: string[];
  /** in the file, absent from the page (kept unless `prune`) */
  missingOnPage: string[];
  /** on the page, absent from the file (added only with `addNew`) */
  newOnPage: string[];
  changed: boolean;
};

export type UpdateResult = {
  source: string;
  plan: UpdatePlan;
};

const samePrice = (a: ModelPrice, b: ModelPrice): boolean =>
  a.input === b.input && a.cached === b.cached && a.output === b.output;

/**
 * `gpt-5`, `gpt-5-pro` and `gpt-5-nano` are one family; `gpt-4o` is not part of
 * `gpt-4`. The key is the version at the head of the id, so every variant suffix
 * the docs use — `-pro`, `-mini`, `-nano`, `-chat-latest`, the `gpt-5.6` code
 * names — collapses onto it. An id with no version to key on is its own family.
 */
const FAMILY_RE = /^(gpt-\d+(?:\.\d+)?o?|o\d+)(?=$|-)/;

export function modelFamily(model: string): string {
  return FAMILY_RE.exec(model)?.[1] ?? model;
}

const dearestFirst = (a: ModelPrice, b: ModelPrice): number =>
  b.output - a.output || b.input - a.input || b.cached - a.cached;

/**
 * Sorts each **contiguous** run of one family so the dearest variant leads it:
 * `gpt-5-pro` belongs above `gpt-5`, `gpt-5-mini` and `gpt-5-nano` rather than
 * wherever the docs happened to list it.
 *
 * Only runs are sorted, never every member of a family wherever it sits. A
 * family can legitimately appear twice — `gpt-5.6-cyber` is priced in its own
 * table, far below `gpt-5.6-sol` — and hoisting the stray entry up to its
 * relatives would move an unrelated part of the file. Sorting is stable, so
 * equally priced variants keep the order they already had.
 */
function orderFamilies(keys: readonly string[], priceOf: (model: string) => ModelPrice | undefined): string[] {
  const ordered: string[] = [];
  let run: string[] = [];

  const flush = (): void => {
    ordered.push(
      ...run.toSorted((a, b) => {
        const left = priceOf(a);
        const right = priceOf(b);
        return left && right ? dearestFirst(left, right) : 0;
      }),
    );
    run = [];
  };

  for (const key of keys) {
    if (run.length > 0 && modelFamily(run[0]) !== modelFamily(key)) flush();
    run.push(key);
  }
  flush();
  return ordered;
}

/**
 * Places a new model beside the relatives it already has, falling back to the
 * rank the page gives it when the family is new to the constant.
 *
 * Family wins over page rank because the page ranks by table position, and a
 * variant can be priced in a table of its own far below its own generation —
 * `gpt-5.6-cyber` sits ~30 rows under `gpt-5.6-sol`. Ranking it purely by the
 * page would file the dearest `gpt-5.6` model below the `o3` entries and strand
 * it as a run of one, where {@link orderFamilies} deliberately never hoists it.
 * Joining the existing run instead lets that sort put it at the family's head.
 *
 * With no run to join, anchoring to the last higher-ranked entry rather than the
 * first lower-ranked one matters because the constant is not sorted by page rank
 * — it mixes models from the main table with `-chat-latest` and `-codex` entries
 * the page lists in a separate table further down. Models the page no longer
 * prices have no rank at all and are never anchors, so they never move.
 */
function insertionIndex(keys: readonly string[], model: string, pageRank: ReadonlyMap<string, number>): number {
  // Join the first contiguous run of the same family; orderFamilies sorts it after.
  const family = modelFamily(model);
  const start = keys.findIndex((key) => modelFamily(key) === family);
  if (start !== -1) {
    let end = start;
    while (end + 1 < keys.length && modelFamily(keys[end + 1]) === family) end += 1;
    return end + 1;
  }

  const rank = pageRank.get(model) ?? Infinity;
  let at = 0;
  keys.forEach((key, index) => {
    const other = pageRank.get(key);
    if (other !== undefined && other < rank) at = index + 1;
  });
  return at;
}

/**
 * Rewrites the constant in place. New models are woven in by page rank, and each
 * family is then ordered dearest first; nothing else is resorted, so a run that
 * only refreshes numbers produces a diff of just those numbers. Both rules are
 * order-stable, so running the tool twice is a no-op.
 */
export function applyPricingUpdate(
  source: string,
  pageEntries: ReadonlyMap<string, ModelPrice>,
  options: UpdateOptions = {},
): UpdateResult {
  const block = findPricingBlock(source, options.constantName ?? 'MODEL_PRICING');
  const current = block.entries;

  const add = new Set(options.add ?? []);
  const remove = new Set(options.remove ?? []);
  const unknown = [...add].filter((model) => !pageEntries.has(model));
  if (unknown.length > 0) {
    throw new Error(`Cannot add ${unknown.join(', ')}: the page does not price ${unknown.length > 1 ? 'them' : 'it'}.`);
  }

  const keys: string[] = [];
  for (const model of current.keys()) {
    if (remove.has(model)) continue;
    if (options.prune && !pageEntries.has(model)) continue;
    keys.push(model);
  }
  const pageRank = new Map([...pageEntries.keys()].map((model, index) => [model, index]));
  for (const model of pageEntries.keys()) {
    if (current.has(model) || remove.has(model)) continue;
    if (!options.addNew && !add.has(model)) continue;
    keys.splice(insertionIndex(keys, model, pageRank), 0, model);
  }

  const next = new Map<string, ModelPrice>();
  const plan: UpdatePlan = {
    added: [],
    updated: [],
    removed: [],
    unchanged: [],
    missingOnPage: [...current.keys()].filter((model) => !pageEntries.has(model)),
    newOnPage: [...pageEntries.keys()].filter((model) => !current.has(model)),
    changed: false,
  };

  for (const model of orderFamilies(keys, (key) => pageEntries.get(key) ?? current.get(key))) {
    const fromPage = pageEntries.get(model);
    const existing = current.get(model);
    const price = fromPage ?? existing;
    if (!price) continue;
    next.set(model, { input: price.input, cached: price.cached, output: price.output });
    if (!existing) plan.added.push({ model, to: price });
    else if (fromPage && !samePrice(existing, fromPage)) plan.updated.push({ model, from: existing, to: fromPage });
    else plan.unchanged.push(model);
  }
  for (const [model, price] of current) {
    if (!next.has(model)) plan.removed.push({ model, from: price });
  }

  const rendered = `${block.header}\n${renderEntries(next, block.indent)}\n${block.indent}};`;
  const updatedSource = source.slice(0, block.start) + rendered + source.slice(block.end);
  plan.changed = updatedSource !== source;
  return { source: updatedSource, plan };
}
