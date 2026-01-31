import OpenAI from 'openai';
import { observeOpenAI } from '@langfuse/openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import { ConfigService } from '../config/config.service.js';

export const SummarizationResultSchema = z.object({
  topParticipants: z
    .array(
      z.object({
        name: z.string().describe("ім'я"),
        nickName: z.string().describe('нікнейм'),
        messageCount: z.number(),
        summary: z.string().describe('Короткий опис активності'),
      }),
    )
    .describe('Топ учасників'),
  topics: z
    .array(
      z.object({
        topic: z.string().describe('Назва теми'),
        messageIds: z.array(z.string()).describe('ID повідомлень, що стосуються цієї теми (1-30 найважливіших)'),
      }),
    )
    .describe('Основні неігрові теми обговорення'),
  trends: z
    .array(
      z.object({
        trend: z.string().describe('Опис тренду'),
        messageIds: z.array(z.string()).describe('ID повідомлень з цим трендом (1-3)'),
      }),
    )
    .describe('Актуальні тренди'),
  gaming: z
    .object({
      summary: z.string().describe('Опис ігрової тематики'),
      messageIds: z.array(z.string()).describe('ID повідомлень про ігри (1-10)'),
    })
    .nullable()
    .describe('Ігрова тематика або null'),
  memes: z
    .object({
      summary: z.string().describe('Опис мем-трендів'),
      messageIds: z.array(z.string()).describe('ID повідомлень з мемами (1-10)'),
    })
    .nullable()
    .describe('Мем-тренди або null'),
  events: z
    .array(
      z.object({
        event: z.string().describe('Опис події'),
        messageIds: z.array(z.string()).describe('ID повідомлень про подію (1-3)'),
      }),
    )
    .describe('Заплановані події'),
  fullSummary: z.string().describe('Повний текстовий підсумок'),
});

export type SummarizationResult = z.infer<typeof SummarizationResultSchema>;

export interface ChatMessageForSummary {
  messageId: string;
  userName: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  textContent: string;
  hasPhoto: boolean;
  hasVideo: boolean;
  mediaDescription: string | null;
  createdAt: Date;
}

const SUMMARIZATION_PROMPT = `Ти — асистент для аналізу чат-повідомлень. Проаналізуй історію та створи структурований підсумок СТРОГО відповідно до заданої схеми.

Формат історії повідомлень:
[ID:messageId] [час] [ім'я] нікнейм: текст

ЗАГАЛЬНІ ПРАВИЛА (HARD CONSTRAINTS):
- Всі відповіді українською мовою
- Ігнорувати спам, флуд та однотипні короткі повідомлення без змісту
- messageIds повинні містити ТІЛЬКИ реальні ID з історії чату
- Один і той самий факт або обговорення не може з’являтися у кількох секціях
- Якщо для секції немає релевантного контенту — використовуй null або [] згідно схеми

АНАЛІЗ:
- Виділяти заплановані або анонсовані події та зустрічі
- Ідентифікувати ігрові теми окремо (gaming = null, якщо ігри не обговорювались)
- Аналізувати описи зображень та медіа для виявлення мем-трендів
  (memes = null, якщо мемів не виявлено)
- Топ учасників сортувати за кількістю повідомлень
- events = [] якщо жодних подій не заплановано

━━━━━━━━━━━━━━━━━━━━
FULLSUMMARY (ОКРЕМЕ ПРАВИЛО)
━━━━━━━━━━━━━━━━━━━━
For the field fullSummary (HARD CONSTRAINTS):
- Do NOT mention message IDs, numbers, or references in ANY form
- Do NOT include IDs implicitly or explicitly
- Do NOT use parentheses to reference sources
- Use IDs ONLY for internal reasoning
- fullSummary MUST be a clean, human-readable narrative summary
- fullSummary MUST NOT introduce facts that are absent from other sections

━━━━━━━━━━━━━━━━━━━━
SECTION OWNERSHIP RULES (HARD CONSTRAINTS)
━━━━━━━━━━━━━━━━━━━━

1. EVENTS
- Будь-які заплановані, анонсовані або майбутні зустрічі, сходки чи події
  MUST appear ONLY in the "events" section
- Ігрові зустрічі (gaming meetups, PSP-сходки тощо) ВСЕ ОДНО є подіями
- Події ЗАБОРОНЕНО включати в "gaming" або "topics"
- У fullSummary події можуть бути згадані ЛИШЕ узагальнено, без дублювання деталей

2. GAMING
- "gaming" використовується ВИКЛЮЧНО для:
  ігор, геймплею, релізів, платформ, модів, ігрових новин або медіа
- ЗАБОРОНЕНО включати:
  - зустрічі
  - сходки
  - події
  - дати
  - плани
  - реальні офлайн-активності
- Якщо ігрове обговорення стосується ЛИШЕ події — ВИКЛЮЧИ його з "gaming"

3. TOPICS
- "topics" містить ТІЛЬКИ неігрові теми обговорення
- Якщо тема пов’язана з іграми або ігровою культурою — ЗАБОРОНЕНО включати її в "topics"
- Ігрові обговорення належать ВИКЛЮЧНО до "gaming"

4. NO DUPLICATION RULE
- Один і той самий факт, подія або обговорення
  MUST NOT з’являтися більш ніж в одній секції
- Обери РІВНО одну правильну секцію

5. CONFLICT RESOLUTION (PRIORITY ORDER)
- Якщо контент підходить до кількох секцій, використовуй ТАКИЙ пріоритет:
  EVENTS > GAMING > TOPICS
`;

// Pricing per 1M tokens (USD) - Standard tier
const MODEL_PRICING: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14.0 },
  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10.0 },
  'gpt-5': { input: 1.25, cached: 0.125, output: 10.0 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-4.1': { input: 2.0, cached: 0.5, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cached: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  o1: { input: 15.0, cached: 7.5, output: 60.0 },
  o3: { input: 2.0, cached: 0.5, output: 8.0 },
  'o3-mini': { input: 1.1, cached: 0.55, output: 4.4 },
  'o4-mini': { input: 1.1, cached: 0.275, output: 4.4 },
  'o1-mini': { input: 1.1, cached: 0.55, output: 4.4 },
};

/**
 * Count message occurrences per userName from formatted messages.
 * Format: [ID:...] [...] [fullName] userName: text
 */
function countMessagesPerUser(formattedMessages: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = formattedMessages.split('\n');

  for (const line of lines) {
    // Pattern: ] userName: - userName is between last ] and :
    const match = line.match(/\] ([^[\]:]+): /);
    if (match) {
      const userName = match[1].trim();
      counts.set(userName, (counts.get(userName) || 0) + 1);
    }
  }

  return counts;
}

export class OpenAIService {
  private static instance: OpenAIService;
  private static readonly LOG_PREFIX = '[OpenAI]';
  private rawClient: OpenAI;
  private configService = ConfigService.getInstance();

  private logUsage(method: string, model: string, usage: OpenAI.CompletionUsage | undefined): void {
    if (!usage) return;
    const pricing = MODEL_PRICING[model] || { input: 0, cached: 0, output: 0 };
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const uncachedTokens = usage.prompt_tokens - cachedTokens;
    const cost =
      (uncachedTokens * pricing.input + cachedTokens * pricing.cached + usage.completion_tokens * pricing.output) /
      1_000_000;

    const cacheInfo = cachedTokens > 0 ? ` (${cachedTokens} cached)` : '';
    console.log(
      `${OpenAIService.LOG_PREFIX} ${method} | model: ${model} | tokens: ${usage.prompt_tokens}${cacheInfo} in / ${usage.completion_tokens} out | cost: $${cost.toFixed(6)}`,
    );
  }

  private getClient(generationName: string): OpenAI {
    return observeOpenAI(this.rawClient, { generationName });
  }

  private constructor() {
    const apiKey = this.configService.get('OPENAI_API_KEY');
    const baseURL = this.configService.get('OPENAI_BASE_URL');

    this.rawClient = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  public static getInstance(): OpenAIService {
    if (!OpenAIService.instance) {
      OpenAIService.instance = new OpenAIService();
    }
    return OpenAIService.instance;
  }

  async summarizeMessages(messages: ChatMessageForSummary[]): Promise<SummarizationResult> {
    const model = this.configService.get('OPENAI_MODEL');

    // Format messages for the prompt
    const formattedMessages = messages
      .map((msg) => {
        const userName = msg.userName || 'Unknown';
        const userFullName = `${msg.userFirstName ?? ''} ${msg.userLastName ?? ''}`.trim() || 'Unknown';
        const time = msg.createdAt.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
        let content = `[ID:${msg.messageId}] [${time}] [${userFullName}] ${userName}: ${msg.textContent}`;
        if (msg.mediaDescription) {
          content += ` [Медіа: ${msg.mediaDescription}]`;
        } else if (msg.hasPhoto) {
          content += ' [Фото]';
        } else if (msg.hasVideo) {
          content += ' [Відео]';
        }
        return content;
      })
      .join('\n');

    const response = await this.getClient('Summarize Messages').chat.completions.parse({
      model,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: SUMMARIZATION_PROMPT },
        { role: 'user', content: `Ось історія чату для аналізу:\n\n${formattedMessages}` },
      ],
      response_format: zodResponseFormat(SummarizationResultSchema, 'chat_summary'),
    });
    this.logUsage('summarizeMessages', model, response.usage);

    const result = response.choices[0].message.parsed;
    if (!result) {
      throw new Error('Failed to parse summarization result');
    }

    // Fix message counts using actual data from formatted messages
    const messageCounts = countMessagesPerUser(formattedMessages);
    for (const participant of result.topParticipants) {
      const actualCount = messageCounts.get(participant.nickName) || 0;
      if (actualCount !== participant.messageCount) {
        console.log(
          `${OpenAIService.LOG_PREFIX} Fixed messageCount for ${participant.nickName}: ${participant.messageCount} -> ${actualCount}`,
        );
        participant.messageCount = actualCount;
      }
    }

    // Re-sort by actual message count (descending)
    result.topParticipants.sort((a, b) => b.messageCount - a.messageCount);

    return result;
  }

  async aggregateSummarizationResults(results: SummarizationResult[]): Promise<SummarizationResult> {
    const model = this.configService.get('OPENAI_MODEL');

    // Pre-calculate actual message counts by summing from all batch results
    const actualCounts = new Map<string, number>();
    for (const result of results) {
      for (const participant of result.topParticipants) {
        const current = actualCounts.get(participant.nickName) || 0;
        actualCounts.set(participant.nickName, current + participant.messageCount);
      }
    }

    const formattedResults = results
      .map((r, i) => `--- Період ${i + 1} ---\n${JSON.stringify(r, null, 2)}`)
      .join('\n\n');

    const response = await this.getClient('Aggregate Summarization Results').chat.completions.parse({
      model,
      reasoning_effort: 'low',
      messages: [
        {
          role: 'system',
          content: `Ти - асистент для об'єднання структурованих підсумків чату з різних періодів.

ЗАВДАННЯ:
Об'єднай надані JSON-підсумки в один структурований підсумок за тією ж схемою.

ПРАВИЛА ОБ'ЄДНАННЯ:

1. topParticipants:
   - Об'єднай учасників за нікнеймом
   - Підсумуй messageCount для однакових учасників
   - Об'єднай summary для кожного учасника

2. topics:
   - Об'єднай схожі теми в одну
   - Об'єднай messageIds для схожих тем
   - Видали точні дублікати тем

3. trends:
   - Об'єднай схожі тренди
   - Видали застарілі тренди, якщо є новіші на ту ж тему

4. gaming:
   - Якщо декілька періодів мають gaming, об'єднай summary
   - Об'єднай messageIds
   - Якщо всі null, залиш null

5. memes:
   - Якщо декілька періодів мають memes, об'єднай summary
   - Об'єднай messageIds
   - Якщо всі null, залиш null

6. events:
   - Об'єднай всі події, видаляючи дублікати
   - Зберігай messageIds для кожної події

7. fullSummary:
   - Створи новий узагальнений підсумок на основі всіх даних
   - НЕ згадуй ID повідомлень
   - Підсумок має бути зв'язним та читабельним

ВАЖЛИВО:
- Відповідай українською мовою
- Дотримуйся тієї ж схеми, що й вхідні дані
- Не втрачай важливу інформацію при об'єднанні`,
        },
        {
          role: 'user',
          content: `Об'єднай ці підсумки в один:\n\n${formattedResults}`,
        },
      ],
      response_format: zodResponseFormat(SummarizationResultSchema, 'aggregated_summary'),
    });
    this.logUsage('aggregateSummarizationResults', model, response.usage);

    const result = response.choices[0].message.parsed;
    if (!result) {
      throw new Error('Failed to parse aggregated summarization result');
    }

    // Fix message counts using pre-calculated actual sums from batch results
    for (const participant of result.topParticipants) {
      const actualCount = actualCounts.get(participant.nickName) || 0;
      if (actualCount !== participant.messageCount) {
        console.log(
          `${OpenAIService.LOG_PREFIX} Fixed aggregated messageCount for ${participant.nickName}: ${participant.messageCount} -> ${actualCount}`,
        );
        participant.messageCount = actualCount;
      }
    }

    // Re-sort by actual message count (descending)
    result.topParticipants.sort((a, b) => b.messageCount - a.messageCount);

    return result;
  }

  async describeImage(imageUrl: string): Promise<string> {
    const model = this.configService.get('OPENAI_VISION_MODEL');

    const response = await this.getClient('Describe Image').chat.completions.create({
      model,
      reasoning_effort: 'minimal',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Опиши це зображення (1-3 речення) українською мовою без пояснень.
Якщо це мем - вкажи це.
Якщо є текст, то важливого передати його в контексті подій точно та без змін.`,
            },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      max_completion_tokens: this.configService.get('OPENAI_MAX_DESCRIBE_IMAGE_TOKENS'),
    });

    const result = response.choices[0].message.content || '';

    console.log(`${OpenAIService.LOG_PREFIX} describeImage | ${result}`);
    this.logUsage('describeImage', model, response.usage);

    return result;
  }
}
