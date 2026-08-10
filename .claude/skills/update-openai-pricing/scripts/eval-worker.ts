/**
 * Runs one model through the bot's own OpenAIService and prints what it returned.
 *
 * Nothing here re-implements the bot. It calls `summarizeMessages` and
 * `describeImage`, so the prompt, the schema, the message formatting, the
 * reasoning effort and the token limits are exactly the ones production uses —
 * an evaluation that copied any of those would drift the moment someone tuned
 * the real thing.
 *
 * The model comes from the environment because `ConfigService` snapshots it at
 * construction, so the orchestrator runs one worker per model — every run for
 * that model happens here, sequentially, in this single process rather than
 * paying the tsx boot once per run.
 *
 * Runs under tsx, not node: the app's modules import each other with a `.js`
 * extension that only exists after a build, and its entities use decorators.
 *   OPENAI_MODEL=... npx tsx eval-worker.ts   < job.json > result.json
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';

import { OpenAIService, type ChatMessageForSummary } from '../../../../src/services/openai.service.js';

type SummaryJob = { name: string; messages: (Omit<ChatMessageForSummary, 'createdAt'> & { createdAt: string })[] };
type ImageJob = { name: string; path: string; mediaType?: string };
type Job = { runs?: number; summaries?: SummaryJob[]; images?: ImageJob[] };
type RunResult = {
  summaries: { name: string; result: unknown; error: string | null }[];
  images: { name: string; description: string | null; error: string | null }[];
};

const readStdin = async (): Promise<string> => {
  let text = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) text += chunk;
  return text;
};

const job = JSON.parse(await readStdin()) as Job;
const service = OpenAIService.getInstance();

const runs: RunResult[] = [];
for (let attempt = 1; attempt <= (job.runs ?? 1); attempt++) {
  const run: RunResult = { summaries: [], images: [] };

  for (const entry of job.summaries ?? []) {
    try {
      const messages: ChatMessageForSummary[] = entry.messages.map((message) => ({
        ...message,
        createdAt: new Date(message.createdAt),
      }));
      run.summaries.push({ name: entry.name, result: await service.summarizeMessages(messages), error: null });
    } catch (error) {
      run.summaries.push({ name: entry.name, result: null, error: (error as Error).message });
    }
  }

  for (const entry of job.images ?? []) {
    try {
      const bytes = await readFile(entry.path);
      const dataUrl = `data:${entry.mediaType ?? 'image/png'};base64,${bytes.toString('base64')}`;
      run.images.push({ name: entry.name, description: await service.describeImage(dataUrl), error: null });
    } catch (error) {
      run.images.push({ name: entry.name, description: null, error: (error as Error).message });
    }
  }

  runs.push(run);
}

stdout.write(JSON.stringify({ runs }));
