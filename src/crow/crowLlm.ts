import type { z } from 'zod';
import { ConfigService } from '../config/config.service';
import { OpenAIService } from '../services/openai.service';
import {
  type ArcRequest,
  type BetOutcomeRequest,
  type BirthdayRequest,
  birthdayPrompt,
  betOutcomePrompt,
  type BetRequest,
  betPrompt,
  type BetResult,
  BetSchema,
  RESOLVE_BET_PROMPT,
  type ResolveBetRequest,
  resolveBetPrompt,
  type ResolveBetResult,
  ResolveBetSchema,
  type ArcResult,
  arcPrompt,
  ArcSchema,
  type ConversationRequest,
  type CountdownRequest,
  countdownPrompt,
  type ConversationResult,
  conversationPrompt,
  ConversationSchema,
  FACTS_PROMPT,
  FactsSchema,
  gameSortPrompt,
  GameSortSchema,
  type GameSortResult,
  MATCH_STORY_PROMPT,
  MatchStorySchema,
  type MatchStoryResult,
  type GoodbyeRequest,
  goodbyePrompt,
  type JabRequest,
  type JabResult,
  jabPrompt,
  JabSchema,
  type MorningRequest,
  morningPrompt,
  PERSONA_PROMPT,
  PROFILE_PROMPT,
  type RadarRequest,
  radarPrompt,
  RELEASES_PROMPT,
  type ReleasesResult,
  ReleasesSchema,
  type QuizRequest,
  quizPrompt,
  type QuizResult,
  QuizSchema,
  type ReminderRequest,
  reminderPrompt,
  type ProfileResult,
  ProfileSchema,
  type RumorUpdateRequest,
  rumorUpdatePrompt,
  SNIPPETS_PROMPT,
  type SnippetsResult,
  SnippetsSchema,
  SORT_PROMPT,
  SortSchema,
  type SortResult,
  STREAM_PROMPT,
  type StreamResult,
  StreamSchema,
  type StreamTextsRequest,
  streamTextsPrompt,
  type StreamTextsResult,
  StreamTextsSchema,
  TALK_PROMPT,
  type TalkResult,
  TalkSchema,
  type ToldRequest,
  toldPrompt,
  type ToldResult,
  ToldSchema,
  type WeeklyRequest,
  weeklyPrompt,
  type WeeklyResult,
  WeeklySchema,
} from './prompts';

/** An entry of a source, as the sorting model reads it */
export interface SortableItem {
  index: number;
  source: string;
  official: boolean;
  title: string;
  summary: string;
  url: string | null;
}

/** An entry as a sorting model reads it */
const sortableLine = (item: SortableItem) =>
  `[#${item.index}] джерело: ${item.source}${item.official ? ' (офіційне)' : ''}\n` +
  `заголовок: ${item.title}\n` +
  (item.url ? `url: ${item.url}\n` : '') +
  (item.summary ? `текст: ${item.summary}` : '');

export interface Priced<T> {
  result: T;
  costUsd: number;
}

/** The model and the reasoning effort of each kind of call, by their keys in the config */
const TIERS = {
  crow: ['OPENAI_CROW_MODEL', 'OPENAI_CROW_REASONING_EFFORT'],
  arc: ['OPENAI_CROW_ARC_MODEL', 'OPENAI_CROW_ARC_REASONING_EFFORT'],
  talk: ['OPENAI_CROW_TALK_MODEL', 'OPENAI_CROW_TALK_REASONING_EFFORT'],
  text: ['OPENAI_CROW_TEXT_MODEL', 'OPENAI_CROW_TEXT_REASONING_EFFORT'],
} as const;

/** A call as `OpenAIService.parse` takes it, but for the model, which its tier gives */
interface Call<T> {
  name: string;
  schemaName: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
}

/**
 * The crow's calls to the language model (see the config): sorting, facts and her
 * store for talks on `gpt-6-luna`, the arcs on `gpt-6.1-sol`; what the whole chat reads
 * of her outside the arcs — the digests, the goodbye, the jabs, the release radar, the
 * quiz, the reminders, the countdown, a bet's outcome, her birthday — on the text model,
 * `gpt-6.1-sol`, a few calls a day, which won the blind A/B; and the rest of what she says,
 * her talks first, many a day, on the talk model, `gpt-6-luna`.
 */
export class CrowLlm {
  private readonly openai = OpenAIService.getInstance();
  private readonly config = ConfigService.getInstance();

  private call<T>(tier: keyof typeof TIERS, call: Call<T>): Promise<Priced<T>> {
    const [model, effort] = TIERS[tier];
    return this.openai.parse({ ...call, model: this.config.get(model), reasoningEffort: this.config.get(effort) });
  }

  /**
   * A text of hers the checks may send back (`Write Crow …`), in her voice for the talks unless said otherwise; its
   * rewrite is traced apart (`Rewrite Crow …`), so the rewrites can be counted
   */
  private written<T>(
    tier: keyof typeof TIERS,
    what: string,
    request: { corrections?: string[] },
    call: Omit<Call<T>, 'name' | 'system'> & { system?: string },
  ): Promise<Priced<T>> {
    const name = `${request.corrections?.length ? 'Rewrite' : 'Write'} Crow ${what}`;
    return this.call(tier, { system: TALK_PROMPT, ...call, name });
  }

  /** Sorts a batch of entries: relevant or not, which category, which story */
  sort(items: SortableItem[]): Promise<Priced<SortResult>> {
    return this.call('crow', {
      name: 'Sort Crow News',
      schemaName: 'crow_sort',
      system: SORT_PROMPT,
      user: items.map(sortableLine).join('\n\n'),
      schema: SortSchema,
    });
  }

  /** Sorts a batch of entries of the game sources: relevant or not, which categories, what happened, how big */
  sortGames(items: SortableItem[], gta6Released: boolean): Promise<Priced<GameSortResult>> {
    return this.call('crow', {
      name: 'Sort Crow Game News',
      schemaName: 'crow_game_sort',
      system: gameSortPrompt(gta6Released),
      user: items.map(sortableLine).join('\n\n'),
      schema: GameSortSchema,
    });
  }

  /**
   * Whether each entry tells the same game news as the story its meaning comes close to: the entry, and the
   * story's title and headlines
   */
  matchStories(pairs: { index: number; entry: string; story: string }[]): Promise<Priced<MatchStoryResult>> {
    return this.call('crow', {
      name: 'Match Crow Story',
      schemaName: 'crow_match_story',
      system: MATCH_STORY_PROMPT,
      user: pairs.map((pair) => `[#${pair.index}]\nзапис: ${pair.entry}\nісторія: ${pair.story}`).join('\n\n'),
      schema: MatchStorySchema,
    });
  }

  /** The facts of one story, from what its sources say; `today`, «28 вересня 2026», tells a release that came from one still ahead */
  async facts(title: string, materials: string, today: string): Promise<Priced<string[]>> {
    const { result, costUsd } = await this.call('crow', {
      name: 'Extract Crow Facts',
      schemaName: 'crow_facts',
      system: FACTS_PROMPT,
      user: `Сьогодні: ${today}\n\nНовина: ${title}\n\nМатеріали:\n\n${materials}`,
      schema: FactsSchema,
    });
    return { result: result.facts, costUsd };
  }

  /** What the sources say of a story beyond the facts of its arc, and how the cats may call its heroes */
  snippets(title: string, facts: { id: string; text: string }[], materials: string): Promise<Priced<SnippetsResult>> {
    return this.call('crow', {
      name: 'Extract Crow Snippets',
      schemaName: 'crow_snippets',
      system: SNIPPETS_PROMPT,
      user: `Новина: ${title}\n\nФакти арки:\n${facts.map((f) => `${f.id}: ${f.text}`).join('\n')}\n\nМатеріали:\n\n${materials}`,
      schema: SnippetsSchema,
    });
  }

  /** Whether the crow answers a message in a talk, and how; replies and chime-ins are traced apart */
  conversation(request: ConversationRequest): Promise<Priced<ConversationResult>> {
    return this.written('talk', request.kind === 'reply' ? 'Reply' : 'Chime-In', request, {
      schemaName: 'crow_conversation',
      user: conversationPrompt(request),
      schema: ConversationSchema,
    });
  }

  /** Her «я ж казала» to a cat who brought news she told the chat before */
  told(request: ToldRequest): Promise<Priced<ToldResult>> {
    return this.written('talk', 'Told You', request, {
      schemaName: 'crow_told',
      user: toldPrompt(request),
      schema: ToldSchema,
    });
  }

  /** Her UPD once the vendor confirmed a rumor of hers, written once for every chat */
  rumorUpdate(request: RumorUpdateRequest): Promise<Priced<TalkResult>> {
    return this.written('talk', 'Rumor Update', request, {
      schemaName: 'crow_rumor_update',
      user: rumorUpdatePrompt(request),
      schema: TalkSchema,
    });
  }

  /** The arc of a story, in the crow's voice */
  arc(request: ArcRequest): Promise<Priced<ArcResult>> {
    return this.written('arc', 'Arc', request, {
      schemaName: 'crow_arc',
      system: PERSONA_PROMPT,
      user: arcPrompt(request),
      schema: ArcSchema,
    });
  }

  /** A chat's morning digest */
  morning(request: MorningRequest): Promise<Priced<TalkResult>> {
    return this.written('text', 'Morning Digest', request, {
      schemaName: 'crow_morning',
      user: morningPrompt(request),
      schema: TalkSchema,
    });
  }

  /** The model's part of a chat's weekly digest: a word about the week and its winner */
  weekly(request: WeeklyRequest): Promise<Priced<WeeklyResult>> {
    return this.written('text', 'Weekly Digest', request, {
      schemaName: 'crow_weekly',
      user: weeklyPrompt(request),
      schema: WeeklySchema,
    });
  }

  /** A bet on a story's dated event, or none */
  bet(request: BetRequest): Promise<Priced<BetResult>> {
    return this.written('talk', 'Bet', request, {
      schemaName: 'crow_bet',
      user: betPrompt(request),
      schema: BetSchema,
    });
  }

  /** How a bet ended, from the news of its categories: a dry check */
  resolveBet(request: ResolveBetRequest): Promise<Priced<ResolveBetResult>> {
    return this.call('crow', {
      name: 'Resolve Crow Bet',
      schemaName: 'crow_resolve_bet',
      system: RESOLVE_BET_PROMPT,
      user: resolveBetPrompt(request),
      schema: ResolveBetSchema,
    });
  }

  /** Her word on how a bet ended */
  betOutcome(request: BetOutcomeRequest): Promise<Priced<TalkResult>> {
    return this.written('text', 'Bet Outcome', request, {
      schemaName: 'crow_bet_outcome',
      user: betOutcomePrompt(request),
      schema: TalkSchema,
    });
  }

  /** The start of a stream an organizer's text announces, if it does */
  stream(published: Date, text: string): Promise<Priced<StreamResult>> {
    return this.call('crow', {
      name: 'Extract Crow Stream',
      schemaName: 'crow_stream',
      system: STREAM_PROMPT,
      user: `Опубліковано: ${published.toISOString().slice(0, 10)}

${text}`,
      schema: StreamSchema,
    });
  }

  /** The crow's words about a stream, for every chat */
  streamTexts(request: StreamTextsRequest): Promise<Priced<StreamTextsResult>> {
    return this.written('talk', 'Stream', request, {
      schemaName: 'crow_stream_texts',
      user: streamTextsPrompt(request),
      schema: StreamTextsSchema,
    });
  }

  /** A quiz on a story the chat heard, or none when its facts make no good one */
  quiz(request: QuizRequest): Promise<Priced<QuizResult>> {
    return this.written('text', 'Quiz', request, {
      schemaName: 'crow_quiz',
      user: quizPrompt(request),
      schema: QuizSchema,
    });
  }

  /** The crow's reminder of a story's moment: its games are there to take, or run out soon */
  reminder(request: ReminderRequest): Promise<Priced<TalkResult>> {
    return this.written('text', 'Reminder', request, {
      schemaName: 'crow_reminder',
      user: reminderPrompt(request),
      schema: TalkSchema,
    });
  }

  /** A post of a countdown's mark */
  countdown(request: CountdownRequest): Promise<Priced<TalkResult>> {
    return this.written('text', 'Countdown', request, {
      schemaName: 'crow_countdown',
      user: countdownPrompt(request),
      schema: TalkSchema,
    });
  }

  /** The crow's word on her birthday in a chat */
  birthday(request: BirthdayRequest): Promise<Priced<TalkResult>> {
    return this.written('text', 'Birthday', request, {
      schemaName: 'crow_birthday',
      user: birthdayPrompt(request),
      schema: TalkSchema,
    });
  }

  /** The notable releases of a week, from the roundups of the press and the platforms */
  async releases(week: string, materials: string): Promise<Priced<ReleasesResult['releases']>> {
    const { result, costUsd } = await this.call('crow', {
      name: 'Extract Crow Releases',
      schemaName: 'crow_releases',
      system: RELEASES_PROMPT,
      user: `Тиждень: ${week}\n\nМатеріали:\n\n${materials}`,
      schema: ReleasesSchema,
    });
    return { result: result.releases, costUsd };
  }

  /** The crow's word over the week's table of releases */
  radar(request: RadarRequest): Promise<Priced<TalkResult>> {
    return this.written('text', 'Release Radar', request, {
      schemaName: 'crow_radar',
      user: radarPrompt(request),
      schema: TalkSchema,
    });
  }

  /** A chat's profile from its messages, one line each: `[id] name: text` */
  profile(messages: string): Promise<Priced<ProfileResult>> {
    return this.call('crow', {
      name: 'Build Crow Chat Profile',
      schemaName: 'crow_profile',
      system: PROFILE_PROMPT,
      user: messages,
      schema: ProfileSchema,
    });
  }

  /** The personal jabs of a chat's arc */
  jabs(request: JabRequest): Promise<Priced<JabResult>> {
    return this.written('text', 'Jabs', request, {
      schemaName: 'crow_jabs',
      user: jabPrompt(request),
      schema: JabSchema,
    });
  }

  /** A chat's goodbye at the end of its day */
  goodbye(request: GoodbyeRequest): Promise<Priced<TalkResult>> {
    return this.written('text', 'Goodbye', request, {
      schemaName: 'crow_goodbye',
      user: goodbyePrompt(request),
      schema: TalkSchema,
    });
  }
}
