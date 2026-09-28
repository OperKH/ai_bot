# Configuration

Environment variables, read only through `ConfigService` ([config.service.ts](../src/config/config.service.ts));
examples in [.env.example](../.env.example). `ConfigService` loads `.env.local` over `.env`: the first file
to set a variable wins, and a variable already set in the environment wins over both. `.env.local` is
gitignored and holds what differs on this machine, such as `DB_PORT` of a local database.

A new variable gets an entry in `ConfigService` (without a comment — its purpose goes here), a line in
`.env.example` and a line below. Model and reasoning-effort defaults are written as `(default: …)`: the
`update-openai-pricing` skill reads and rewrites them in this file.

## Telegram

- `TG_TOKEN`: Telegram bot token from BotFather
- `TG_API_ID`, `TG_API_HASH`, `TG_API_SESSION`: Telegram client credentials for the history import
  (`npm run tg:session` makes the session string)
- `TG_UPDATE_CONCURRENCY`: How many incoming updates are handled at once (default 1). Updates of one chat
  always run in order, so a value above 1 only helps when several chats are active. ML inference is
  CPU-bound, so raising it mostly trades memory for little throughput; keep it at 1–2 unless the box is
  large ([telegram.md](telegram.md#update-queue))
- `TG_OWNER_ID`: The bot owner's Telegram user id: the owner's alerts — an empty OpenAI balance, the crow's
  spent budget ([telegram.md](telegram.md#owner-alerts)) — and the owner's word on a bet the news leaves unclear.
  Unset — nobody: the bot warns at start and the alerts go only to the log. Anything but digits
  (a @username) is refused with a warning. The owner must have started a private chat with the bot

## Database and media

- `DB_*`: PostgreSQL connection settings
- `MATCH_TEXT_THRESHOLD`: Cosine similarity threshold for text search (default 0.24)
- `MATCH_IMAGE_THRESHOLD`: Threshold for image similarity (default 0.96)
- `MATCH_IMAGE_COUNT`: Number of results to return per page (default 3)

## The crow's embeddings

EmbeddingGemma's similarities from which the crow acts ([crow/behavior.md](crow/behavior.md#talking-in-the-chat));
every score she compares is logged with the threshold, «Talk of … by meaning, threshold 0.35: story 12 0.41 → the
gate», so the values can be tuned on the chat's own messages:

- `CROW_TALK_THRESHOLD`: A message that names none of her stories goes to the model when it is this close to what
  she may still say of one (default 0.35); the model still decides whether she speaks
- `CROW_FORWARD_THRESHOLD`: A forwarded post that names none of her stories brings back one she told when it is
  this close to one of its facts (default 0.78); the model still says whether it is the same news

## OpenAI

- `OPENAI_API_KEY`: OpenAI API key
- `OPENAI_BASE_URL`: Optional custom OpenAI API base URL
- `OPENAI_MODEL`: Model to use (default: gpt-6-luna)
- `OPENAI_VISION_MODEL`: Model used for image descriptions (default: gpt-6-luna)
- `OPENAI_REASONING_EFFORT`: Effort for summarization and aggregation (default: low)
- `OPENAI_VISION_REASONING_EFFORT`: Effort for image descriptions (default: none)
- `OPENAI_MAX_DESCRIBE_IMAGE_TOKENS`: Output token cap for image descriptions (default 3000)
- `OPENAI_CROW_MODEL`: The crow's model for sorting news and extracting facts (default: gpt-6-luna), and
  for the chat's profile, her store for talks, whether a doubtful entry tells a game story's news, the week's
  releases, how a bet ended and the start of a stream in an announcement
- `OPENAI_CROW_REASONING_EFFORT`: Effort for sorting news and extracting facts (default: low)
- `OPENAI_CROW_ARC_MODEL`: The crow's model for writing arcs (default: gpt-6-sol) — chosen by a blind A/B,
  see [crow/pipeline.md](crow/pipeline.md#models-and-costs)
- `OPENAI_CROW_ARC_REASONING_EFFORT`: Effort for writing arcs (default: medium)
- `OPENAI_CROW_TALK_MODEL`: The crow's model for the rest outside the arcs (default: gpt-6-luna), many calls a
  day: her talks in the chat and «я ж казала», the UPD to a rumor, the bets and the streams
- `OPENAI_CROW_TALK_REASONING_EFFORT`: Effort for the talk model (default: low)
- `OPENAI_CROW_TEXT_MODEL`: The crow's model for what the whole chat reads (default: gpt-6-sol), a few calls a
  day: the morning and weekly digests, the evening goodbye, the personal jabs, the release radar, the quizzes,
  the reminders of the games that come and go, GTA VI's countdown, a bet's outcome and her birthday word; sol
  won the blind A/B of them against luna, at twenty times the price
- `OPENAI_CROW_TEXT_REASONING_EFFORT`: Effort for the text model (default: low; medium was no better)
- `OPENAI_CROW_DAILY_BUDGET_USD`: No new arcs once the calls of the crow's pipeline cost this much in a UTC day
  (default 1)

**Models disagree on which reasoning efforts they accept, so each effort must be changed together with
its model.** The ladders differ by generation:

| Family                      | Accepted values                          |
| --------------------------- | ---------------------------------------- |
| gpt-5 (`gpt-5-mini`, …)     | `minimal`, `low`, `medium`, `high`       |
| gpt-5.6 (`gpt-5.6-luna`, …) | `none`, `low`, `medium`, `high`, `xhigh` |

The least-reasoning rung is `minimal` on one and `none` on the other — they are the equivalent setting
under different names, which matters when comparing models or porting a config. Sending a rung a model
does not have fails the call with a 400; it does not degrade gracefully. List a model's set for free by
sending a deliberately invalid value: the API answers with the valid options and rejects the request before
generating anything. An unknown value in the env is refused by `ConfigService` with a warning and the
default is used instead.

## YouTube

- `YOUTUBE_API_KEY`: A key of the YouTube Data API v3, through which the crow reads the channels whose streams
  she announces ([crow/behavior.md](crow/behavior.md#streams); the quota it takes is in
  [crow/pipeline.md](crow/pipeline.md#sources)). Unset — the channels are not polled, and only the organizers'
  own announcements are read

## Langfuse

- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`: Langfuse keys
- `LANGFUSE_BASE_URL`: Langfuse API URL (default: https://cloud.langfuse.com)
- `LANGFUSE_TRACING_ENVIRONMENT`: Optional environment label for Langfuse traces
