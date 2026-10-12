/**
 * Pure core of the crow's talks A/B: what a script can see in an answer, the
 * tally per model, the blind files for the judges and the verdict. The judges'
 * answers decode as the arcs' do (`decodeVerdicts` in crow-checks.ts).
 *
 * The bot's own checks — numbers from what she was given, the crow, the length,
 * one rewrite — already ran inside `writeTalk`, so an answer that failed them is
 * only counted here. What this adds is what the chat complained of and a script
 * can see: an answer opening with «котику», the magpie as a stock excuse. Whether
 * she was right to speak, understood and on the point only a reader can tell;
 * that is the judges' part, and the verdict weighs it first.
 *
 * Requires Node >= 26 (executed directly as TypeScript, no build step).
 */

import {
  type BlindKey,
  body,
  CAT_OPENING,
  crowVerdict,
  type CrowVerdict,
  type Decoded,
  itemId,
  type Label,
  seeded,
  type Side,
  SIDES,
} from './crow-checks.ts';

type Labelled = { id: string; text: string };

/** The bot's `ConversationRequest` (src/crow/prompts.ts), as the fixture keeps it */
export type TalkRequest = {
  kind: 'reply' | 'chime';
  message: { name: string; text: string };
  thread: string[];
  recentChat: string[];
  stories: { title: string; facts: Labelled[]; details: Labelled[]; planned: Labelled[] }[];
  recentPosts: string[];
  catTopics: string[];
  nickname: string | null;
  chatNicknames: string[];
  maxLength: number;
};

export type TalkFixture = {
  name: string;
  /** what the talk provokes, for the judges and the report */
  tests: string;
  request: TalkRequest;
};

export type CrowTalksFixture = { about?: string; talks: TalkFixture[] };

/** One answer as the worker returns it: what the bot's `writeTalk` produced, or why there is none */
export type TalkRun = {
  talk: string;
  run: number;
  written: {
    /** null when she keeps quiet: she chose to, or the text failed the checks after the rewrite */
    text: string | null;
    declined: boolean;
    nickname: string | null;
    attempts: { costUsd: number; problems: string[] }[];
  } | null;
  ms: number;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Tally per model
// ---------------------------------------------------------------------------

/** The magpie as an excuse for what she does not know: «сорока ще не принесла» */
const MAGPIE = /сорок/u;

export type TalkTally = {
  talks: number;
  /** calls that returned nothing at all: a rejected parameter, a refusal, a timeout */
  errors: number;
  spoke: number;
  /** she chose to keep quiet */
  declined: number;
  /** her text failed the bot's checks even after the rewrite: nothing posted */
  failed: number;
  rewritten: number;
  catOpenings: number;
  magpie: number;
  nicknames: number;
  characters: number;
  costUsd: number;
  ms: number;
};

export function tallyTalks(runs: readonly TalkRun[]): TalkTally {
  const written = runs.flatMap((run) => (run.written ? [run.written] : []));
  const texts = written.flatMap((answer) => (answer.text === null ? [] : [answer.text]));
  return {
    talks: runs.length,
    errors: runs.filter((run) => run.written === null).length,
    spoke: texts.length,
    declined: written.filter((answer) => answer.declined).length,
    failed: written.filter((answer) => answer.text === null && !answer.declined).length,
    rewritten: written.filter((answer) => answer.attempts.length > 1).length,
    // An answer opening with how she calls any cat — what a cat asked her to stop
    catOpenings: texts.filter((text) => CAT_OPENING.test(body(text).toLowerCase())).length,
    magpie: texts.filter((text) => MAGPIE.test(body(text).toLowerCase())).length,
    nicknames: written.filter((answer) => answer.nickname !== null).length,
    characters: texts.reduce((sum, text) => sum + text.length, 0),
    costUsd: written.reduce((sum, answer) => sum + answer.attempts.reduce((s, a) => s + a.costUsd, 0), 0),
    ms: runs.reduce((sum, run) => sum + run.ms, 0),
  };
}

/** The mechanical rows of the report, as label and the two values */
export function talkRows(tallies: Readonly<Record<Side, TalkTally>>): [string, string, string][] {
  const row = (label: string, value: (t: TalkTally) => string): [string, string, string] => [
    label,
    value(tallies.baseline),
    value(tallies.candidate),
  ];
  const per = (total: number, count: number, digits: number) => (count ? (total / count).toFixed(digits) : '—');
  return [
    row('answers returned', (t) => `${t.talks - t.errors}/${t.talks}`),
    row('spoke', (t) => String(t.spoke)),
    row('kept quiet', (t) => String(t.declined)),
    row('failed the checks', (t) => String(t.failed)),
    row('rewritten once', (t) => String(t.rewritten)),
    row('opening with «котику»', (t) => String(t.catOpenings)),
    row('the magpie as an excuse', (t) => String(t.magpie)),
    row('nicknames given', (t) => String(t.nicknames)),
    row('characters per answer', (t) => per(t.characters, t.spoke, 0)),
    row('cost per talk', (t) => `$${per(t.costUsd, t.talks, 5)}`),
    row('seconds per talk', (t) => per(t.ms / 1000, t.talks, 1)),
  ];
}

// ---------------------------------------------------------------------------
// Blind files
// ---------------------------------------------------------------------------

function renderAnswer(run: TalkRun | undefined, label: Label): string[] {
  const lines = [`### Answer ${label}`, ''];
  if (!run?.written) return [...lines, `*(no answer: ${run?.error ?? 'missing'})*`, ''];
  const answer = run.written;
  if (answer.text !== null) return [...lines, answer.text, ''];
  if (answer.declined) return [...lines, '*(she keeps quiet)*', ''];
  const problems = answer.attempts.at(-1)?.problems.join('; ') ?? '';
  return [...lines, `*(her text failed the code's checks — ${problems}: nothing would be posted)*`, ''];
}

const quoted = (lines: readonly string[]) =>
  lines.length ? lines.map((line) => `> ${line.replaceAll('\n', ' ')}`) : ['*(none)*'];

/**
 * One judge's file: every talk and run with its two answers under labels
 * shuffled by `seed`, and what a judge needs to weigh them — the cat's message
 * and what it answers, the chat before it, the stories she may speak of with
 * their facts and her store, and what she said lately.
 */
export function blindTalksFile(
  fixture: CrowTalksFixture,
  runs: Readonly<Record<Side, readonly TalkRun[]>>,
  seed: number,
): { markdown: string; key: BlindKey } {
  const random = seeded(seed);
  const key: BlindKey = {};
  const out = [`# The crow's talks, blind (set ${seed})`, ''];
  let index = 0;
  for (const talk of fixture.talks) {
    const request = talk.request;
    const how =
      request.kind === 'reply'
        ? 'replies to her post or calls her — she answers unless it was not for her'
        : 'nobody called her: the chat speaks near a story she brought — she joins only with something new and to the point';
    const runNumbers = [
      ...new Set(SIDES.flatMap((side) => runs[side].filter((r) => r.talk === talk.name).map((r) => r.run))),
    ];
    for (const runNumber of runNumbers.sort((a, b) => a - b)) {
      const id = itemId(talk.name, runNumber);
      const order: Side[] = random() < 0.5 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      key[id] = { A: order[0], B: order[1] };
      const find = (side: Side) => runs[side].find((r) => r.talk === talk.name && r.run === runNumber);
      out.push(
        `## ${++index}. ${talk.tests} — item \`${id}\``,
        '',
        `**${request.message.name}** ${how}:`,
        '',
        ...quoted([request.message.text]),
        '',
        '### What the message answers',
        '',
        ...quoted(request.thread),
        '',
        '### The chat before it',
        '',
        ...quoted(request.recentChat),
        '',
        '### The stories she may speak of — everything she may claim of the news',
        '',
        ...(request.stories.length
          ? request.stories.flatMap((story) => [
              `**${story.title}**`,
              '',
              ...story.facts.map((fact) => `- ${fact.id}: ${fact.text}`),
              ...story.details.map((detail) => `- ${detail.id} (her store, not told yet): ${detail.text}`),
              ...story.planned.map(
                (post) => `- ${post.id} (her post still waiting): ${post.text.replaceAll('\n', ' ')}`,
              ),
              '',
            ])
          : ['*(none)*', '']),
        '### What she said in the chat lately',
        '',
        ...quoted(request.recentPosts),
        '',
        ...(request.chatNicknames.length
          ? ['### How she calls the other cats', '', ...request.chatNicknames.map((line) => `- ${line}`), '']
          : []),
        ...renderAnswer(find(order[0]), 'A'),
        ...renderAnswer(find(order[1]), 'B'),
      );
    }
  }
  return { markdown: out.join('\n'), key };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** Whether the candidate would make her talks worse: the arcs' rule (`crowVerdict`), said of the answers */
export const talkVerdict = (decoded: readonly Decoded[], tallies: Readonly<Record<Side, TalkTally>>): CrowVerdict =>
  crowVerdict(decoded, tallies, {
    fit: 'answers fit for the chat',
    failed: 'answers failing the checks',
    empty: 'calls with no answer',
  });
