# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Telegram AI bot built with TypeScript that uses machine learning models for content analysis and media tracking. The bot can:

- Track and search media (photos/videos) using CLIP embeddings for semantic similarity search
- Detect duplicate media by comparing image embeddings, with `/ignoremedia` to exclude known repeats
- React to toxic text messages with an emoji (multilingual XLM-R classifier)
- Transcribe voice messages and video notes using Whisper
- Summarize chat activity with `/trends` via OpenAI (photos in the chat are described by a vision model)

Zero-shot classification exists in `AIService` and `ClassifyMessageByLabelsCommand`, but that command is
not registered; the sentiment pipeline is not used by any command.

## Tech Stack

- **Runtime**: Node.js 26+ with ES Modules; `tsx` runs TypeScript directly in development
- **Language**: TypeScript 6 with strict mode
- **Bot Framework**: Telegraf 4.16 for Telegram Bot API
- **Telegram Client**: telegram library (gramjs, MTProto user session) for history import
- **Database**: PostgreSQL with the VectorChord extension (`vchordrq` index) for vector similarity search
- **ORM**: TypeORM 1.x with entity decorators
- **AI/ML**: @huggingface/transformers (Transformers.js) for running models locally
- **LLM**: OpenAI SDK, traced through Langfuse
- **Image Processing**: sharp (not a direct dependency — it comes in with `@huggingface/transformers`)
- **Video Processing**: fluent-ffmpeg for video frame extraction
- **Translation**: @iamtraction/google-translate for English translation (CLIP text search only)

**Telegraf is unmaintained**: the last release (4.16.3) is from February 2024 and its bundled types stop at
Bot API 7.1. Newer Bot API methods and fields still work through `callApi`, but without types. grammY is
the natural replacement if the framework is ever migrated.

## Development Commands

```bash
# Install dependencies
npm install

# Run from sources via tsx (no build step)
npm start

# Development with auto-reload (tsx watch)
npm run dev

# Build TypeScript to dist/ (tsc + tsc-alias)
npm run build

# Build for release (production; used by the Dockerfile, which runs `node dist/app.js`)
npm run build:release

# Clean build artifacts
npm run clean

# Type-check without emitting
npm run typecheck

# Unit tests (node:test via tsx)
npm test

# Lint
npm run lint

# Generate Telegram session string (for history import)
npm run tg:session

# Generate TypeORM migration (reads the compiled data source, so run `npm run build` first)
npx typeorm migration:generate ./src/migrations/MigrationName -d ./dist/dataSource/dataSource.js

# Run migrations (happens automatically on app start via migrationsRun: true)
```

## Architecture

### Command Pattern

The bot uses a command-based architecture where each feature is implemented as a `Command` subclass:

- All commands extend the abstract [Command](src/bot/commands/command.class.ts) class
- Commands are registered in [app.ts](src/app.ts) via `bot.registerCommands()`
- Each command implements `handle()` for setup and `dispose()` for cleanup
- Commands have access to `bot`, `dataSource`, and `configService`
- Registered: `StartCommand`, `MediaTrackerCommand` (`/searchmedia`, `/starthistoryimport`),
  `IgnoreMediaCommand`, `ClassifyMessageCommand` (toxicity reactions), `RecognizeSpeechCommand`,
  `TrendsCommand`. `ClockCommand` and `ClassifyMessageByLabelsCommand` exist but are not registered

### Update Queue and Telegram API Guard

Both live in [bot.class.ts](src/bot/bot.class.ts):

- **Update queue**: Telegraf handles a whole `getUpdates` batch (up to 100 updates) through `Promise.all`,
  so after downtime the backlog would mean dozens of concurrent Whisper/CLIP runs and a burst of replies.
  The first middleware gates every update through a `Semaphore` ([semaphore.utils.ts](src/utils/semaphore.utils.ts))
  sized by `TG_UPDATE_CONCURRENCY` (default 1 = strictly sequential). Background work started from a
  handler without `await` (e.g. `/starthistoryimport`) releases its slot immediately.
- **`callApi` wrapper**: every outgoing call (`ctx.reply`, `ctx.react`, `getFileLink`, …) goes through
  `Telegram.callApi`, which is wrapped once at startup. On 429 it sleeps for Telegram's `retry_after`
  and retries (up to 5 times); the sleep holds the caller's semaphore slot, so the whole queue pauses.
  It also counts calls per method and logs `Telegram API: N calls/min (...)` every minute while the bot
  is doing anything.

### Bot API File Size Limit

Live handlers download media through `getFileLink` (media tracking, `/ignoremedia`, speech recognition,
image descriptions for trends). The cloud Bot API only serves files up to **20 MB**, so larger videos
cannot be processed live and the handler fails into `bot.catch`. History import is not affected: it
downloads through gramjs (MTProto), which has no such limit. Running a local `telegram-bot-api` server
with `--local` would lift the limit to 2 GB without changing the framework.

### Singleton Services

Core services use the singleton pattern:

- **AIService** ([ai.service.ts](src/services/ai.service.ts)): Manages ML model pipelines and embeddings
- **VideoService** ([video.service.ts](src/services/video.service.ts)): Handles video frame extraction using ffmpeg
- **ConfigService** ([config.service.ts](src/config/config.service.ts)): Centralizes environment configuration
- **OpenAIService** ([openai.service.ts](src/services/openai.service.ts)): OpenAI API with Langfuse tracing and token cost logging
- **TrendsService** ([trends.service.ts](src/services/trends.service.ts)): Chat summarization and trends analysis using OpenAI
- **FileService** ([file.service.ts](src/services/file.service.ts)): Handles file operations

### Tracing Module

The tracing module ([tracing.ts](src/tracing.ts)) initializes OpenTelemetry with Langfuse for LLM observability:

- **Must be imported first** in [app.ts](src/app.ts) before any other imports
- Uses `LangfuseSpanProcessor` from `@langfuse/otel` to send spans to Langfuse
- Exports `shutdownTracing()` for graceful shutdown (flushes pending spans)
- Gets credentials from `ConfigService` (not direct `process.env`)

### ConfigService Usage

**IMPORTANT**: Always use `ConfigService` to access environment variables. Never use `process.env` directly.

```typescript
import { ConfigService } from './config/config.service.js';

const configService = ConfigService.getInstance();
const apiKey = configService.get('OPENAI_API_KEY');
```

When adding new environment variables:

1. Add to `ConfigService.config` object in [config.service.ts](src/config/config.service.ts)
2. Add example value to [.env.example](.env.example)

### Observability (Langfuse)

The project uses Langfuse for LLM observability via OpenTelemetry:

- **Tracing initialization**: [tracing.ts](src/tracing.ts) - must be imported first in app.ts
- **OpenAI wrapper**: Uses `observeOpenAI()` from `@langfuse/openai` to auto-trace all OpenAI calls
- **Console logging**: OpenAI calls log token usage and cost to console

Required environment variables:

- `LANGFUSE_PUBLIC_KEY`: Langfuse public key
- `LANGFUSE_SECRET_KEY`: Langfuse secret key
- `LANGFUSE_BASE_URL`: Langfuse API URL (default: https://cloud.langfuse.com)

### Database Entities

TypeORM entities with decorators:

- **ChatPhotoMessage**: Stores media embeddings with vector column for similarity search
  - `chatId`: Chat identifier
  - `messageId`: Message identifier
  - `mediaType`: Type of media ('photo' or 'video')
  - `frameIndex`: Frame index (0 for photos, 0-3 for video frames)
  - `embedding`: 512-dimensional CLIP embedding in a Postgres `vector(512)` column
    - Writes accept a `'[0.1,0.2,...]'` string (the driver passes non-arrays through unchanged)
    - Reads through the **entity** path (`find`/`findOne`) hydrate it to `number[]`, not a string
    - Reads through the **raw** path (`getRawMany`) return the `'[...]'` string as-is
    - **IMPORTANT**: The `embedding` field has `select: false` in the entity definition, meaning it's NOT included by default in queries
    - To retrieve embeddings, you must explicitly select them:
      ```typescript
      // Using find/findOne — object syntax is required (TypeORM 1.x removed
      // the string-array form `select: ['embedding']`, which now throws)
      await repository.findOne({
        select: { embedding: true }, // or { id: true, chatId: true, embedding: true, ... }
        where: { chatId, messageId },
      });

      // Using QueryBuilder
      await repository
        .createQueryBuilder('msg')
        .addSelect('msg.embedding')
        .where('msg.chatId = :chatId', { chatId })
        .getMany();
      ```
- **ChatState**: Tracks per-chat state
  - `chatId`: Chat identifier
  - `isMediaImported`: Whether initial media import is complete
  - `isVideoImportedByFrames`: Whether videos are indexed using multi-frame extraction
- **IgnoredMedia**: Media excluded from duplicate detection via `/ignoremedia`; same `vector(512)`
  `embedding` column (also `select: false`) matched with the sphere query below
- **ChatMessage**: Text messages, voice transcriptions and image descriptions (`mediaDescription`)
  collected as input for `/trends`
- **TrendsSummary**: Generated trend summaries per chat and period (`summary`, `resultJson`). Trends
  and `ChatMessage` rows older than 30 days are removed by a periodic cleanup in `TrendsService`
- **MediaSearch**: One `/searchmedia` query per row: its text, the CLIP `embedding` of the text, the keyset
  cursor (`cursorSimilarity`, `cursorMessageId`) and `buttonMessageId`, the reply that carries the live
  "Ще" button.
  - The "Ще" button carries only `islm-<id>`: callback data is capped at 64 bytes, too little for the
    text and a cursor.
  - The embedding is computed once, when the search is created. Every page is then ranked by the vector
    the cursor belongs to, and "Ще" needs no translation.
  - The same query asked again in the chat replaces the earlier search.
  - An hourly job removes searches older than 30 days. A search that goes, expired or replaced, has its
    button taken off first. A button that survives (the edit failed) answers that the search has expired,
    and so do buttons from before this table, which carry a JSON payload.

### ML Model Management

Models are cached locally in `data/models/` (configured via `env.cacheDir`). The AIService lazy-loads models:

- CLIP (Xenova/clip-vit-base-patch16) for image/text embeddings
- DistilBERT for sentiment analysis
- OperKH/twitter-xlmr-toxicity-classifier-ONNX for toxicity detection
- Whisper large-v3-turbo for speech recognition
- mDeBERTa for zero-shot classification

Models are loaded on first use and disposed on shutdown.

## Key Implementation Details

### Vector Similarity Search

The bot uses PostgreSQL's VectorChord extension for efficient vector similarity search:

- Images and text are converted to 512-dimensional CLIP embeddings
- Embeddings are stored in a `vector(512)` column and written as `'[...]'` strings
- Queries use cosine similarity operator `<=>` with configurable thresholds

**Every sphere query goes through [vectorSearch.ts](src/dataSource/vectorSearch.ts).**
`findSimilarMedia` (a chat's media: near-duplicates of a photo or of a video's frames, and the text search)
and `findIgnoredMedia` (the ignore list) run inside `withVectorIndex`. A new vector query goes into that file.
The sphere operator `<<=>>` (within a radius, `1 - threshold`) is what the vchordrq index answers, and
two things keep the planner on it:

- **`SET LOCAL enable_seqscan = off`.** `<<=>>` has no selectivity estimate, so the planner assumes any
  sphere holds half the table. The vectors are stored in TOAST (about 490 MB) and leave the heap at 16 MB,
  so a sequential scan then looks cheaper than the index. The choice flips with the statistics: on the
  production copy the same near-duplicate lookup went through the index right after a migration and
  became a sequential scan after the next autoanalyze. `SET LOCAL` holds for the transaction's one
  connection and resets at commit.
- **The chat filter on top of a `MATERIALIZED` CTE.** The sphere scan runs alone in the CTE; the `chatId`
  filter, the grouping by message and the ordering apply on top of it. With `chatId` in the same WHERE
  the planner takes the chatId B-tree, which it can estimate, and computes the distance for every row of
  the chat. The two indexes cannot be combined either: vchordrq has no bitmap scan.

Measured on the production copy (185k rows, one chat holding nearly all of them):

| Query                      | Sequential scan (planner's choice) | Through `vectorSearch.ts` |
| -------------------------- | ---------------------------------- | ------------------------- |
| Near-duplicate of a photo  | 227 ms                             | 0.3 ms                    |
| `chatId` in the same WHERE | 226 ms (chatId B-tree)             | —                         |
| Text search page           | 425 ms                             | 80–150 ms                 |

Letting the index sort (`ORDER BY embedding <=> q LIMIT n`) also keeps it on the index, but it reranks
every candidate of the probed partitions: 25 ms for a near-duplicate.

**Search parameters live on the index, never in a `SET`.** `probes` (how many of the index's `lists`
partitions a query scans) is an index storage parameter since VectorChord 1.1: `WITH (..., probes =
'93')` at creation, `ALTER INDEX ... SET (probes = '...')` to tune it without a rebuild. Do not
`SET vchordrq.probes` from code:

- a `SET` through `dataSource.query` lands on one pooled connection, and the query after it may run on
  another;
- the GUC also overrides every other vchordrq index the connection touches. An index built with
  `lists = []` fails outright under it (`need 0 probes, but 1 probes provided`).

#### Vector index layout

The layout follows the table's size, after VectorChord's guidance (`indexOptions` in the migration
`UpdateVectorChord`):

- **Below 100k rows: no partitions** (`lists = []`). Every vector is checked, so nothing is missed.
  Partitions on a small table lose matches: on the dev database (169 rows) `lists = [400]` found half of
  the exact near-duplicates, and some photos did not even find themselves.
- **From 100k rows: about rows / 500 partitions, `probes` a quarter of them.** Production has
  `lists = [370]`, `probes = '93'`. One `probes` serves both kinds of query, so no code needs a `SET`.

Measured on the production copy (185k rows; the text search at threshold 0.225, recall of the exact top
30 over five queries):

| Layout                      | Near-duplicate | Text search page | Text recall |
| --------------------------- | -------------- | ---------------- | ----------- |
| `lists = [400]`, probes 10  | 0.4 ms         | 15 ms            | 20–57%      |
| `lists = [400]`, probes 100 | 2.3 ms         | 160 ms           | 67–93%      |
| `lists = [400]`, probes 400 | 5.9 ms         | 550 ms           | 100%        |
| `lists = []`                | 5.1 ms         | 420 ms           | 100%        |

Near-duplicates were all found in every layout.

An index is sized for the rows it was built on, and the table keeps growing. At startup
[vectorExtensions.ts](src/dataSource/vectorExtensions.ts) warns when an index's partitions no longer fit
(none on a table past 100k rows, or off by more than twice). A new vector index follows the same rule.
To rebuild one, in a migration:

```sql
DROP INDEX chat_photo_message_embedding_idx;
VACUUM chat_photo_message;  -- VectorChord #470: a build over dead tuples fails
CREATE INDEX chat_photo_message_embedding_idx ON chat_photo_message
  USING vchordrq (embedding vector_cosine_ops) WITH (options = $$
    residual_quantization = true
    [build.internal]
    lists = [<rows / 500>]
    spherical_centroids = true
    build_threads = 4
    sampling_factor = 256
  $$, probes = '<lists / 4>');
ANALYZE chat_photo_message;  -- the build overwrites the table's row estimate
```

`ANALYZE` after the build matters: a vchordrq build leaves the table's row estimate wrong (4500 for 185k
rows, 0 for 15), and the planner goes by it until the next autoanalyze.

### Media Tracking Flow

**For Photos:**

1. User sends photo → bot extracts file_id
2. Download photo and generate CLIP embedding
3. Query database for similar embeddings (cosine similarity > threshold), unless the media is on the
   ignore list
4. If matches found, reply with references to similar messages
5. Store embedding in database with `mediaType='photo'` and `frameIndex=0`

Steps 3–5 are `trackMedia`, shared with videos once their embeddings are in hand.

**For Videos:**

1. User sends video → bot extracts file_id and downloads full video file
2. Extract 4 frames at positions: 10%, 30%, 50%, 70% of video duration (avoids black screens at start/end;
   `VideoService.FRAME_POSITIONS`)
3. Generate CLIP embedding for each frame (`AIService.getFrameEmbeddings`, shared with `/ignoremedia` and the
   history import, so a video gets the same embeddings whichever way it comes in)
4. Query database for similar embeddings across all frames, in one statement grouped by messageId
   (keeping the highest similarity)
5. If matches found, reply with references to similar messages
6. Store all 4 frame embeddings in database with `mediaType='video'` and `frameIndex=0..3`

**Why Multiple Frames for Videos:**

- Videos may have black screens or fade-ins at the beginning
- Sampling multiple frames (10%, 30%, 50%, 70%) ensures content is captured
- During search, the frame with highest similarity is used
- Consistent frame positions ensure same video can be matched when re-uploaded

### Text Search

1. User sends `/searchmedia [query]`
2. Translate query to English if needed
3. Generate CLIP text embedding and store it with the query as a `MediaSearch` row; the next pages reuse it
4. Query the database with `findSimilarMedia`, the same statement as the near-duplicates (see above):
   grouped by `messageId`, so a video's frames count as one result, keeping its best frame
5. Order by `similarity DESC, messageId DESC` and page by keyset: the next page is everything after the
   stored cursor.
   - The tiebreak matters: reposts score exactly the same, and without it the page boundaries moved
     between queries.
   - The cursor survives deleted and newly added rows, which offsets did not.
6. Return a page with the "Ще" button attached to its last result

### Deleted Messages

A bot is not told when a message is deleted in a group, so its rows stay in `chat_photo_message`. Both
the "seen it before" replies and `/searchmedia` reply to the matched message with
`allow_sending_without_reply`, and `replyToMatch` ([mediaMatchReplies.ts](src/bot/commands/mediaMatchReplies.ts))
checks the result:

- if the sent reply has no `reply_to_message`, the original is gone;
- the stray reply is deleted, and the message's rows are removed so it is not found again;
- the next match takes its place.

If every match of a "seen it before" thread turns out deleted, the header is removed as well.

### History Import and Video Reindexing

The `/starthistoryimport [days|all]` command uses the telegram library (not Telegraf). Its import is a
**gap-fill pass**: it walks the chat's media and embeds only messages the DB does not have yet. There
is no cursor like "resume from `max(messageId)`" — live handlers write to the DB regardless of import
state, so after a downtime the newest rows are fresh live messages and the gap sits _below_ them.
Skipping by the set of existing `messageId`s is what makes the pass safe to run at any time.

The argument picks the window: a positive number of days (`/starthistoryimport 60`) or `all` for the
whole history; anything else counts as no argument. Skipped messages cost only the MTProto paging
(100 per request), no download or ML.

| Argument     | Never imported      | Already imported               |
| ------------ | ------------------- | ------------------------------ |
| none/invalid | full import         | "🍧 Нема потреби" + usage hint |
| `60`         | import last 60 days | gap-fill last 60 days          |
| `all`        | full import         | gap-fill whole history         |

**Scenario 1: Initial Import** (`!isMediaImported`) and **Scenario 3: Gap Fill** (`isMediaImported && isVideoImportedByFrames`, argument required)

- Load the chat's existing `messageId`s into a `Set`
- Iterate through chat history using `iterMessages()` with `InputMessagesFilterPhotoVideo`, skipping ids in the set
- For photos: download and generate single CLIP embedding
- For videos: download full video, extract 4 frames, generate embeddings for each
- Scenario 1 additionally sets `isMediaImported=true` and `isVideoImportedByFrames=true`

**Scenario 2: Video Reindexing** (`isMediaImported && !isVideoImportedByFrames`)

- Triggered when videos were previously imported using old method (thumbnails only)
- Iterate through chat history using `InputMessagesFilterVideo` (videos only); the skip set is built from
  `mediaType='video'` rows only, so legacy thumbnail rows do not count and the reindex is resumable
- For each video:
  - Delete old entries (single thumbnail embedding with `mediaType='photo'`)
  - Download full video and extract 4 frames at consistent positions
  - Generate and store 4 new embeddings with `mediaType='video'`
- Set `isVideoImportedByFrames=true`

**Implementation Details:**

- Runs in background with `isMediaImporting` flag to prevent concurrent imports
- The reply reports added photos/videos and the chat's total media count (`ImportStats`)
- The `days` window is resolved to a message id via an unfiltered `iterMessages({ limit: 1, offsetDate })`
  and then walked with `offsetId + reverse` — `offsetDate` is not passed to the filtered iterator
  because gramjs maps it to `maxDate` of `messages.Search`, whose meaning under `reverse` is unclear
- Frame extraction uses `VideoService.extractFramesFromBuffer()`
- Old video entries are automatically deleted before saving new ones in `importChatMessages()`
- Both `processVideoFromApi()` and `processPhotoFromApi()` methods handle the respective media types

### Translation Strategy

- Check if text matches English regex pattern
- If not, translate using Google Translate API
- Use translated text for the CLIP text embedding

## Configuration

Environment variables (see [.env.example](.env.example)). `ConfigService` loads `.env.local` over `.env`:
the first file to set a variable wins, and a variable already set in the environment wins over both.
`.env.local` is gitignored and holds what differs on this machine, such as `DB_PORT` of a local database.

- `TG_TOKEN`: Telegram bot token from BotFather
- `TG_API_ID`, `TG_API_HASH`, `TG_API_SESSION`: Telegram client credentials for history import
- `TG_UPDATE_CONCURRENCY`: How many incoming updates are handled at once (default 1). ML inference is
  CPU-bound, so raising it mostly trades memory for little throughput; keep it at 1–2 unless the box is
  large
- `DB_*`: PostgreSQL connection settings
- `MATCH_TEXT_THRESHOLD`: Cosine similarity threshold for text search (default 0.24)
- `MATCH_IMAGE_THRESHOLD`: Threshold for image similarity (default 0.96)
- `MATCH_IMAGE_COUNT`: Number of results to return per page (default 3)
- `OPENAI_API_KEY`: OpenAI API key
- `OPENAI_BASE_URL`: Optional custom OpenAI API base URL
- `OPENAI_MODEL`: Model to use (default: gpt-6-luna)
- `OPENAI_VISION_MODEL`: Model used for image descriptions (default: gpt-6-luna)
- `OPENAI_REASONING_EFFORT`: Effort for summarization and aggregation (default: low)
- `OPENAI_VISION_REASONING_EFFORT`: Effort for image descriptions (default: none)
- `OPENAI_MAX_DESCRIBE_IMAGE_TOKENS`: Output token cap for image descriptions (default 3000)

**Models disagree on which reasoning efforts they accept, so these must be changed together with
the model.** The ladders differ by generation:

| Family                      | Accepted values                          |
| --------------------------- | ---------------------------------------- |
| gpt-5 (`gpt-5-mini`, …)     | `minimal`, `low`, `medium`, `high`       |
| gpt-5.6 (`gpt-5.6-luna`, …) | `none`, `low`, `medium`, `high`, `xhigh` |

The least-reasoning rung is `minimal` on one and `none` on the other — they are the equivalent
setting under different names, which matters when comparing models or porting a config. Sending a
rung a model does not have fails the call with a 400; it does not degrade gracefully. List a
model's set for free by sending a deliberately invalid value: the API answers with the valid
options and rejects the request before generating anything. An unknown value in the env is refused
by `ConfigService` with a warning and the default is used instead.

- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`: Langfuse observability
- `LANGFUSE_TRACING_ENVIRONMENT`: Optional environment label for Langfuse traces

## Database Setup

The project uses PostgreSQL with the VectorChord extension (required for vector operations and the
`vchordrq` index):

```yaml
# docker-compose.yaml specifies the image
image: tensorchord/vchord-postgres:pg16-v1.1.1
```

Migrations run automatically on startup due to `migrationsRun: true` in dataSource configuration.
`migrationsTransactionMode` is `each`: every migration runs in its own transaction, and a migration may
set `transaction = false` (needed for `VACUUM`). The default `all` mode rejects any migration that sets
`transaction`.

**Upgrading VectorChord or pgvector.** The image ships the extension library, but the SQL objects that
`CREATE EXTENSION` made stay at their old version until `ALTER EXTENSION ... UPDATE`. vchordrq indexes
also carry an on-disk format number: an index built by an older format group is unreadable after the
upgrade, and every search, insert and VACUUM on it fails with `bad version number`.

- Bump the image tag and add a migration in the same commit. See
  [1790280230614-UpdateVectorChord.ts](src/migrations/1790280230614-UpdateVectorChord.ts): check the
  image's version, drop the vchordrq indexes, `VACUUM`, `ALTER EXTENSION ... UPDATE`, build the indexes
  again (sized as in "Vector index layout") and `ANALYZE`.
- `VACUUM` before the rebuild works around VectorChord #470: a build over dead tuples fails with
  `missing chunk for toast value`.
- There is no in-place downgrade; going back means restoring a backup.
- At startup [vectorExtensions.ts](src/dataSource/vectorExtensions.ts) warns when an installed version
  differs from the image's, and reports vchordrq indexes that cannot be read. It only logs, and the bot
  starts without waiting for it.

The first migration used to create pgvecto.rs (`vectors`, the original engine), which the VectorChord
images do not ship. It now creates pgvector's `vector` instead, so a fresh database can be built from
migrations alone.

## Module System

This project uses ES Modules (type: "module" in package.json):

- `moduleResolution` is `Bundler`, so relative imports may omit the extension; `tsx` resolves them in
  development and `tsc-alias` (`resolveFullPaths`) appends `.js` in the build. Most files import
  without an extension, some with `.js` — both work
- There is no `__dirname`; derive it with `dirname(fileURLToPath(import.meta.url))`
- Top-level await is supported

## ESLint Rules

The project has strict TypeScript linting:

- `@typescript-eslint/no-floating-promises: error` - All promises must be awaited or explicitly marked with eslint-disable comment
- Use `// eslint-disable-next-line @typescript-eslint/no-floating-promises` when intentionally not awaiting (e.g., background tasks)

## Testing

Unit tests use Node's built-in `node:test` runner through `tsx`, so there is no extra dependency:
`npm test` runs `node --import tsx --test 'src/**/*.test.ts'`.

- Tests sit next to the code as `*.test.ts` and use `node:assert/strict`.
- `tsconfig.json` includes them, so `npm run typecheck` and `npm run lint` check them.
- They are kept out of the release build and the image: `tsconfig.release.json` excludes them, and so
  does `.dockerignore`.
- ESLint's `no-floating-promises` treats the `node:test` calls (`describe`, `it`, …) as safe; they
  return promises that the runner awaits itself.

What is covered is logic that must survive a framework change (the planned grammY migration), tested
through a port instead of Telegraf and TypeORM. For example,
[mediaMatchReplies.ts](src/bot/commands/mediaMatchReplies.ts) holds the replies to matched media
(skipping deleted messages) and the `/searchmedia` paging. The command only supplies a
`MatchReplyPort`, and the tests supply a fake chat. SQL and index behaviour need a real
Postgres/VectorChord and are not unit-tested.

## Additional Context

### Important Rules

- Telegram bot messages must always respond to user in Ukrainian with corresponding emoji before the message
