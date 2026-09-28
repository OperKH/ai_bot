/**
 * Pure core of the crow's A/B: what a script can check in an arc, the tally
 * per model, the blind files for the judges and the decoding of their verdicts.
 *
 * The bot's own checks — numbers from the facts, the crows, the length, one
 * rewrite — already ran inside `writeArc`, so an arc that failed them is only
 * counted here. What this adds is what the persona asks for and a script can
 * see: swearing, euphemisms, worn-out images, press-release openings. Whether a
 * post is funny or bends a fact only a reader can tell; that is the judges'
 * part, and the verdict weighs it first.
 *
 * Requires Node >= 26 (executed directly as TypeScript, no build step).
 */

export type Side = 'baseline' | 'candidate';
export const SIDES: readonly Side[] = ['baseline', 'candidate'];

export type StoryFixture = {
  name: string;
  /** what the story provokes, for the judges and the report */
  tests: string;
  title: string;
  category: string;
  importance: number;
  isRumor: boolean;
  facts: { id: string; text: string }[];
  recentPosts: string[];
  previousStances: string[];
};

export type CrowFixture = { about?: string; roster: string[]; stories: StoryFixture[] };

export type ArcMessage = {
  kind: string;
  crows: number;
  text: string;
  table?: { header: string[]; rows: string[][] } | null;
  optional?: boolean;
  factIds: string[];
};

/** One arc as the worker returns it: what the bot's `writeArc` produced, or why there is none */
export type ArcRun = {
  story: string;
  run: number;
  /** the outline as the model read it, a line per message */
  outline: string[];
  written: {
    messages: ArcMessage[];
    stance: { subject: string; verdict: string };
    dropped: number[];
    failed: boolean;
    attempts: { costUsd: number; problems: string[] }[];
  } | null;
  ms: number;
  error: string | null;
};

// ---------------------------------------------------------------------------
// What a script can see in an arc
// ---------------------------------------------------------------------------

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}'’]+/gu) ?? [];
const EUPHEMISM = /^(блін\p{L}*|бляха\p{L}*|зараз[аиі]|чорт\p{L}*|трясц\p{L}*|дідьк\p{L}*|холер\p{L}*)$/u;
const SWEAR = [/^бля/u, /п[іи]зд/u, /ху[йїєяю]/u, /[єї]б[аеуи]/u, /^срак/u, /^заєб/u];
/** The chat's own words, which the persona asks for about every other post; «бляха» is a euphemism */
export const isSwear = (word: string): boolean => SWEAR.some((re) => re.test(word)) && !EUPHEMISM.test(word);
/** Images the persona prompt names as worn out by repetition */
const CRUTCH = /блискучк|гнізд|пір['’]|миск|прожектор|афіш/gu;
const CAT_OPENING = /^(кот|котик|мурчик|хвостат|киц)/u;
/** A post that opens with a lab or a model reads like a press release */
const NAME_OPENING = /^(openai|anthropic|google|xai|openrouter|deepseek|meta|claude|gpt|gemini|grok)/u;

const body = (text: string): string => text.replace(/^(?:🐦‍⬛\s*)+/u, '').trim();
const firstWords = (text: string, count: number): string => words(body(text)).slice(0, count).join(' ');

export type ArcMetrics = {
  messages: number;
  /** posts with at least one of the chat's swear words */
  swearing: number;
  swearWords: number;
  euphemisms: number;
  crutches: number;
  catOpenings: number;
  nameOpenings: number;
  /** neighbouring posts whose first two words are the same */
  sameStarts: number;
  characters: number;
};

export function arcMetrics(messages: readonly { text: string }[]): ArcMetrics {
  const texts = messages.map((message) => message.text);
  const all = texts.flatMap(words);
  return {
    messages: texts.length,
    swearing: texts.filter((text) => words(text).some(isSwear)).length,
    swearWords: all.filter(isSwear).length,
    euphemisms: all.filter((word) => EUPHEMISM.test(word)).length,
    crutches: texts.reduce((sum, text) => sum + (text.toLowerCase().match(CRUTCH)?.length ?? 0), 0),
    catOpenings: texts.filter((text) => CAT_OPENING.test(firstWords(text, 1))).length,
    nameOpenings: texts.filter((text) => NAME_OPENING.test(firstWords(text, 1))).length,
    sameStarts: texts.filter((text, i) => i > 0 && firstWords(text, 2) === firstWords(texts[i - 1], 2)).length,
    characters: texts.reduce((sum, text) => sum + text.length, 0),
  };
}

// ---------------------------------------------------------------------------
// Tally per model
// ---------------------------------------------------------------------------

export type SideTally = {
  arcs: number;
  /** calls that returned no arc at all: a rejected parameter, a refusal, a timeout */
  errors: number;
  /** arcs whose opening failed the bot's checks even after the rewrite: not posted */
  failed: number;
  rewritten: number;
  /** messages dropped after the rewrite */
  dropped: number;
  planned: number;
  kept: number;
  costUsd: number;
  ms: number;
  metrics: ArcMetrics;
};

export function tallySide(runs: readonly ArcRun[]): SideTally {
  const written = runs.flatMap((run) => (run.written ? [run.written] : []));
  const metrics = written.map((arc) => arcMetrics(arc.messages));
  const sum = (key: keyof ArcMetrics): number => metrics.reduce((total, m) => total + m[key], 0);
  return {
    arcs: runs.length,
    errors: runs.filter((run) => run.written === null).length,
    failed: written.filter((arc) => arc.failed).length,
    rewritten: written.filter((arc) => arc.attempts.length > 1).length,
    dropped: written.reduce((total, arc) => total + arc.dropped.length, 0),
    planned: runs.filter((run) => run.written).reduce((total, run) => total + run.outline.length, 0),
    kept: written.reduce((total, arc) => total + arc.messages.length, 0),
    costUsd: written.reduce((total, arc) => total + arc.attempts.reduce((s, a) => s + a.costUsd, 0), 0),
    ms: runs.reduce((total, run) => total + run.ms, 0),
    metrics: {
      messages: sum('messages'),
      swearing: sum('swearing'),
      swearWords: sum('swearWords'),
      euphemisms: sum('euphemisms'),
      crutches: sum('crutches'),
      catOpenings: sum('catOpenings'),
      nameOpenings: sum('nameOpenings'),
      sameStarts: sum('sameStarts'),
      characters: sum('characters'),
    },
  };
}

/** The mechanical rows of the report, as label and the two values */
export function tallyRows(tallies: Readonly<Record<Side, SideTally>>): [string, string, string][] {
  const row = (label: string, value: (t: SideTally) => string): [string, string, string] => [
    label,
    value(tallies.baseline),
    value(tallies.candidate),
  ];
  const perArc = (t: SideTally, total: number, digits: number) => (t.arcs ? (total / t.arcs).toFixed(digits) : '—');
  return [
    row('arcs written', (t) => `${t.arcs - t.errors}/${t.arcs}`),
    row('opening failed the checks', (t) => String(t.failed)),
    row('rewritten once', (t) => String(t.rewritten)),
    row('messages kept', (t) => `${t.kept}/${t.planned}`),
    row('cost per arc', (t) => `$${perArc(t, t.costUsd, 4)}`),
    row('seconds per arc', (t) => perArc(t, t.ms / 1000, 0)),
    row('posts with swearing', (t) => `${t.metrics.swearing}/${t.metrics.messages}`),
    row('euphemisms instead', (t) => String(t.metrics.euphemisms)),
    row('worn-out images', (t) => String(t.metrics.crutches)),
    row('posts opening with «Коти…»', (t) => String(t.metrics.catOpenings)),
    row('posts opening with a name', (t) => String(t.metrics.nameOpenings)),
    row('neighbours starting alike', (t) => String(t.metrics.sameStarts)),
    row('characters per post', (t) => (t.metrics.messages ? String(Math.round(t.metrics.characters / t.metrics.messages)) : '—')),
  ];
}

// ---------------------------------------------------------------------------
// Blind files
// ---------------------------------------------------------------------------

export type Label = 'A' | 'B';
/** For every item of a blind file, which side each label hides */
export type BlindKey = Record<string, Record<Label, Side>>;

/** A small seeded generator, so the same run always gets the same shuffle */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const itemId = (story: string, run: number): string => `${story}#${run}`;

function renderArc(run: ArcRun | undefined, label: Label): string[] {
  const lines = [`### Arc ${label}`, ''];
  if (!run?.written) return [...lines, `*(no arc: ${run?.error ?? 'missing'})*`, ''];
  const arc = run.written;
  if (arc.failed) lines.push("*(the opening failed the code's checks: this arc would not be posted)*", '');
  const dropped = new Set(arc.dropped);
  let next = 0;
  run.outline.forEach((line, i) => {
    const kind = /\[(\w+)\]/.exec(line)?.[1] ?? 'message';
    lines.push(`**${i + 1} · ${kind}**`, '');
    if (dropped.has(i + 1)) {
      lines.push("*(dropped by the code's checks)*", '');
      return;
    }
    const message = arc.messages[next++];
    if (!message) return;
    lines.push(message.text, '');
    if (message.table) {
      lines.push(
        `| ${message.table.header.join(' | ')} |`,
        `| ${message.table.header.map(() => '---').join(' | ')} |`,
        ...message.table.rows.map((cells) => `| ${cells.join(' | ')} |`),
        '',
      );
    }
  });
  lines.push(`*stance:* ${arc.stance.subject} — ${arc.stance.verdict}`, '');
  return lines;
}

/**
 * One judge's file: every story and run with its two arcs under labels
 * shuffled by `seed`, and what a judge needs to check them — the facts, the
 * competitors, what the crow said before and the outline both arcs follow.
 */
export function blindFile(
  fixture: CrowFixture,
  runs: Readonly<Record<Side, readonly ArcRun[]>>,
  seed: number,
): { markdown: string; key: BlindKey } {
  const random = seeded(seed);
  const key: BlindKey = {};
  const out = [`# The crow's arcs, blind (set ${seed})`, ''];
  let index = 0;
  for (const story of fixture.stories) {
    const runNumbers = [...new Set(SIDES.flatMap((side) => runs[side].filter((r) => r.story === story.name).map((r) => r.run)))];
    for (const runNumber of runNumbers.sort((a, b) => a - b)) {
      const id = itemId(story.name, runNumber);
      const order: Side[] = random() < 0.5 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      key[id] = { A: order[0], B: order[1] };
      const find = (side: Side) => runs[side].find((r) => r.story === story.name && r.run === runNumber);
      const outline = find('baseline')?.outline ?? find('candidate')?.outline ?? [];
      out.push(
        `## ${++index}. ${story.title} — item \`${id}\``,
        '',
        `Importance ${story.importance} of 3. What it tests: ${story.tests}.`,
        '',
        '### Facts — everything the arc may claim',
        '',
        ...story.facts.map((fact) => `- ${fact.id}: ${fact.text}`),
        '',
        '### Competitors it may name (roster)',
        '',
        ...fixture.roster.map((entry) => `- ${entry}`),
        '',
        '### What the crow posted before (recentPosts) and her past verdicts (previousStances)',
        '',
        ...story.recentPosts.map((post) => `- ${post.replaceAll('\n', ' ')}`),
        '',
        ...story.previousStances.map((stance) => `- ${stance}`),
        '',
        "### The outline — the code's, the same for both arcs",
        '',
        ...outline.map((line) => `- ${line}`),
        '',
        ...renderArc(find(order[0]), 'A'),
        ...renderArc(find(order[1]), 'B'),
      );
    }
  }
  return { markdown: out.join('\n'), key };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** What a judge returns for one item */
export type JudgeVerdict = {
  item: string;
  better: Label | 'tie';
  factErrors?: Partial<Record<Label, string[]>>;
  publishable?: Partial<Record<Label, boolean>>;
  notes?: string;
};

export type Decoded = {
  item: string;
  judge: number;
  better: Side | 'tie';
  factErrors: Record<Side, string[]>;
  publishable: Record<Side, boolean>;
};

export function decodeVerdicts(verdicts: readonly JudgeVerdict[], key: BlindKey, judge: number): Decoded[] {
  return verdicts.map((verdict) => {
    const labels = key[verdict.item];
    if (!labels) throw new Error(`judge ${judge} answered for an unknown item: ${verdict.item}`);
    const side = (label: Label): Side => labels[label];
    const bySide = <T>(values: Partial<Record<Label, T>> | undefined, fallback: T): Record<Side, T> => ({
      [side('A')]: values?.A ?? fallback,
      [side('B')]: values?.B ?? fallback,
    }) as Record<Side, T>;
    return {
      item: verdict.item,
      judge,
      better: verdict.better === 'tie' ? 'tie' : side(verdict.better),
      factErrors: bySide(verdict.factErrors, [] as string[]),
      publishable: bySide(verdict.publishable, false),
    };
  });
}

export type CrowVerdict = {
  comparisons: number;
  wins: Record<Side, number>;
  ties: number;
  factErrors: Record<Side, number>;
  publishable: Record<Side, number>;
  degraded: boolean;
  reasons: string[];
};

/**
 * Whether the candidate would make the crow worse. It must not lose the
 * judges — the baseline preferred in more than half of the comparisons —
 * nor bend more facts, give fewer arcs fit to post, or fail the bot's own
 * checks more often. Evidence over a handful of stories, never a proof.
 */
export function crowVerdict(decoded: readonly Decoded[], tallies: Readonly<Record<Side, SideTally>>): CrowVerdict {
  const count = (pick: (d: Decoded) => boolean) => decoded.filter(pick).length;
  const wins = { baseline: count((d) => d.better === 'baseline'), candidate: count((d) => d.better === 'candidate') };
  const factErrors = {
    baseline: decoded.reduce((sum, d) => sum + d.factErrors.baseline.length, 0),
    candidate: decoded.reduce((sum, d) => sum + d.factErrors.candidate.length, 0),
  };
  const publishable = { baseline: count((d) => d.publishable.baseline), candidate: count((d) => d.publishable.candidate) };
  const reasons: string[] = [];
  if (wins.baseline * 2 > decoded.length) {
    reasons.push(`the judges preferred the baseline in ${wins.baseline} of ${decoded.length} comparisons`);
  }
  if (factErrors.candidate > factErrors.baseline) reasons.push(`fact errors: ${factErrors.baseline} → ${factErrors.candidate}`);
  if (publishable.candidate < publishable.baseline) {
    reasons.push(`arcs fit to post as they are: ${publishable.baseline} → ${publishable.candidate}`);
  }
  if (tallies.candidate.failed > tallies.baseline.failed) {
    reasons.push(`openings failing the checks: ${tallies.baseline.failed} → ${tallies.candidate.failed}`);
  }
  if (tallies.candidate.errors > tallies.baseline.errors) {
    reasons.push(`calls with no arc: ${tallies.baseline.errors} → ${tallies.candidate.errors}`);
  }
  return {
    comparisons: decoded.length,
    wins,
    ties: count((d) => d.better === 'tie'),
    factErrors,
    publishable,
    degraded: reasons.length > 0,
    reasons,
  };
}
