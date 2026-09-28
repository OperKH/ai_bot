# `/trends`

A summary of what the chat talked about over a period, by OpenAI. Code:
[trends.command.ts](../src/bot/commands/trends.command.ts) (collects the messages, the period picker, the
report), [trendsMessage.ts](../src/bot/commands/trendsMessage.ts) (the report as a rich message),
[trends.service.ts](../src/services/trends.service.ts) (the analysis) and the summarization prompts in
[openai.service.ts](../src/services/openai.service.ts).

## The report

The report is one rich message (Bot API rich messages, typed in grammY 1.46), built from blocks by
`trendsMessage.ts`:

- The period picker itself becomes the report: `editMessageText` with a rich message turns the plain
  message into it, so no second message goes out.
- The text goes into the blocks as data, so nothing is escaped, and a rich message holds 32768 characters
  and 500 blocks, so the report is never split.
- Event dates stay text, as the model writes them, not `date_time` elements: turning "18:00" into an
  instant needs the author's time zone, which a bot is not told (and one chat's members may live in
  different zones), and adding such a date to the calendar puts the whole report into the description.
- `TrendsService` only returns data (`null` for a period without messages); every message, the "nothing
  found" and error ones included, comes from the command, which then offers the periods again.
- An analysis takes tens of seconds of LLM calls, so it runs in the command's `BackgroundQueue`; at
  shutdown a queued analysis turns back into the period picker ([telegram.md](telegram.md#stop)).

## Input

`ChatMessage` rows: text messages, voice transcriptions and image descriptions (`mediaDescription`).
Photos are described by `OPENAI_VISION_MODEL` (effort `OPENAI_VISION_REASONING_EFFORT`, output capped by
`OPENAI_MAX_DESCRIBE_IMAGE_TOKENS`); the summary uses `OPENAI_MODEL` with `OPENAI_REASONING_EFFORT`. In
Langfuse the calls are `Describe Image`, `Summarize Messages` and, when a long period is summarized in
batches, `Aggregate Summarization Results` for the merge.

## Tables

- **ChatMessage**: the collected messages
- **TrendsSummary**: generated summaries per chat and period (`summary`, `resultJson`)

A daily cleanup in `TrendsService` removes `ChatMessage` rows older than 90 days — far more than `/trends`
reads, kept for later analysis; the crow's chat profile reads the last 30 of them — and summaries older than
30 days.

## Changing the model

The `update-openai-pricing` skill A/Bs a candidate model on the bot's own summarization prompt
(`evaluate-models.ts`) before switching `OPENAI_MODEL`.

## Tests

[trendsMessage.test.ts](../src/bot/commands/trendsMessage.test.ts): the model text goes in unescaped, empty
sections are left out, each point links to its messages.
