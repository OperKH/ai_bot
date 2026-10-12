/**
 * Answers the crow's A/B talks with one model, through the crow's own code: the
 * call (`CrowLlm.conversation`, so the talk prompt, the request's prompt and the
 * schema are the ones the bot ships), the numbers she may say (`talkNumbers`) and
 * the checks with one rewrite (`writeTalk`). An evaluation that copied any of
 * those would drift the moment someone tuned the real thing.
 *
 * The model and its effort come from the environment (`OPENAI_CROW_TALK_MODEL`,
 * `OPENAI_CROW_TALK_REASONING_EFFORT`), because `ConfigService` reads them once
 * at construction. The talks of a run are answered at once, the runs one after
 * another.
 *
 * Runs under tsx, not node, as crow-worker.ts does, and is left out of the
 * skill's own `tsc` for the same reason.
 *   OPENAI_CROW_TALK_MODEL=... npx tsx crow-talk-worker.ts < job.json > result.json
 */

import { stdin, stdout } from 'node:process';

import { talkNumbers, writeTalk } from '../../../../src/crow/conversation.js';
import { CrowLlm } from '../../../../src/crow/crowLlm.js';
import type { ConversationRequest } from '../../../../src/crow/prompts.js';

type Job = { runs: number; talks: { name: string; request: ConversationRequest }[] };

const readStdin = async (): Promise<string> => {
  let text = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) text += chunk;
  return text;
};

const job = JSON.parse(await readStdin()) as Job;
const llm = new CrowLlm();

const answer = async (talk: Job['talks'][number], run: number) => {
  const started = Date.now();
  try {
    const written = await writeTalk((request) => llm.conversation(request), talk.request, talkNumbers(talk.request));
    const { text, declined, nickname, attempts } = written;
    return { talk: talk.name, run, written: { text, declined, nickname, attempts }, ms: Date.now() - started, error: null };
  } catch (error) {
    return { talk: talk.name, run, written: null, ms: Date.now() - started, error: (error as Error).message };
  }
};

const talks = [];
for (let run = 1; run <= job.runs; run++) {
  talks.push(...(await Promise.all(job.talks.map((talk) => answer(talk, run)))));
}

// the service logs usage to stdout as well, so the result goes on a line of its own
stdout.write(`\n${JSON.stringify({ talks })}\n`);
