# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Telegram AI bot built with TypeScript that uses machine learning models for content analysis and media tracking. The bot can:

- Track and search media (photos/videos) using CLIP embeddings for semantic similarity search
- Detect duplicate media by comparing image embeddings
- Perform sentiment and toxicity analysis on text
- Transcribe speech from audio messages using Whisper
- Classify messages using zero-shot classification

## Tech Stack

- **Runtime**: Node.js 24+ with ES Modules
- **Language**: TypeScript with strict mode
- **Bot Framework**: Telegraf 4.x for Telegram bot API
- **Telegram Client**: telegram library for advanced API operations (history import)
- **Database**: PostgreSQL with pgvecto-rs extension for vector similarity search
- **ORM**: TypeORM with entity decorators
- **AI/ML**: @huggingface/transformers (Transformers.js) for running models locally
- **Image Processing**: sharp for image manipulation
- **Video Processing**: fluent-ffmpeg for video frame extraction
- **Translation**: @iamtraction/google-translate for English translation

## Development Commands

```bash
# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Build and run
npm start

# Development with auto-reload
npm run dev

# Clean build artifacts
npm run clean

# Build for release (production)
npm run build:release

# Generate Telegram session string (for history import)
npm run tg:session

# Lint
npm run lint

# Generate TypeORM migration
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
  - `frameIndex`: Frame index (0 for photos, 0-4 for video frames)
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

### ML Model Management

Models are cached locally in `data/models/` (configured via `env.cacheDir`). The AIService lazy-loads models:

- CLIP (Xenova/clip-vit-base-patch16) for image/text embeddings
- DistilBERT for sentiment analysis
- toxic-bert for toxicity detection
- Whisper large-v3-turbo for speech recognition
- mDeBERTa for zero-shot classification

Models are loaded on first use and disposed on shutdown.

## Key Implementation Details

### Vector Similarity Search

The bot uses PostgreSQL's VectorChord extension for efficient vector similarity search:

- Images and text are converted to 512-dimensional CLIP embeddings
- Embeddings are stored as JSON strings in a `vector` column
- Queries use cosine similarity operator `<=>` with configurable thresholds

**Query Optimization Pattern:**

For optimal performance, always use sphere range queries with `<<=>>` operator first, then filter by other conditions (like chatId). This allows the database to use vector indexes efficiently:

```typescript
// Always set vchordrq.probes before vector queries
await this.dataSource.query('SET vchordrq.probes = 10');

// Good: sphere filter first, then filter by chatId in application
const results = await repository
  .createQueryBuilder('msg')
  .select('msg.messageId', 'messageId')
  .addSelect('msg.chatId', 'chatId')
  .addSelect('1 - (embedding <=> :embedding)', 'similarity')
  .where('embedding <<=>> sphere(:embedding::vector, :radius)')
  .orderBy('similarity', 'DESC')
  .setParameters({
    embedding: embeddingString,
    radius: 1 - threshold, // radius = 1 - similarity_threshold
  })
  .getRawMany()
  .then((messages) => messages.filter((m) => m.chatId === String(chatId)));

// Bad: filtering by chatId first prevents index usage
.where('chatId = :chatId')
.andWhere('1 - (embedding <=> :embedding) > :threshold')
```

The sphere operator `<<=>>` checks if embedding is within a sphere of given radius, enabling efficient approximate nearest neighbor search via vchordrq index.

**Important:** Always call `SET vchordrq.probes = 10` before executing vector similarity queries. This configures the number of probes for the vchordrq index, improving search quality.

### Media Tracking Flow

**For Photos:**

1. User sends photo → bot extracts file_id
2. Download photo and generate CLIP embedding
3. Query database for similar embeddings (cosine similarity > threshold)
4. If matches found, reply with references to similar messages
5. Store embedding in database with `mediaType='photo'` and `frameIndex=0`

**For Videos:**

1. User sends video → bot extracts file_id and downloads full video file
2. Extract 5 frames at positions: 10%, 30%, 50%, 70% of video duration (avoids black screens at start/end)
3. Generate CLIP embedding for each frame
4. Query database for similar embeddings across all frames
5. Aggregate results by messageId (keeping highest similarity)
6. If matches found, reply with references to similar messages
7. Store all 5 frame embeddings in database with `mediaType='video'` and `frameIndex=0..4`

**Why Multiple Frames for Videos:**

- Videos may have black screens or fade-ins at the beginning
- Sampling multiple frames (10%, 30%, 50%, 70%) ensures content is captured
- During search, the frame with highest similarity is used
- Consistent frame positions ensure same video can be matched when re-uploaded

### Text Search

1. User sends `/searchmedia [query]`
2. Translate query to English if needed
3. Generate CLIP text embedding
4. Query database for media with similar embeddings (both photos and video frames)
5. Group results by messageId (keeping highest similarity across all frames)
6. Return paginated results with "More" button for additional matches

**Note:** Videos with multiple frames are treated as a single result using the frame with highest similarity to the search query.

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
- For videos: download full video, extract 5 frames, generate embeddings for each
- Scenario 1 additionally sets `isMediaImported=true` and `isVideoImportedByFrames=true`

**Scenario 2: Video Reindexing** (`isMediaImported && !isVideoImportedByFrames`)

- Triggered when videos were previously imported using old method (thumbnails only)
- Iterate through chat history using `InputMessagesFilterVideo` (videos only); the skip set is built from
  `mediaType='video'` rows only, so legacy thumbnail rows do not count and the reindex is resumable
- For each video:
  - Delete old entries (single thumbnail embedding with `mediaType='photo'`)
  - Download full video and extract 5 frames at consistent positions
  - Generate and store 5 new embeddings with `mediaType='video'`
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

All AI models expect English input, so non-English text is automatically translated:

- Check if text matches English regex pattern
- If not, translate using Google Translate API
- Use translated text for embeddings and classification

## Configuration

Environment variables (see [.env.example](.env.example)):

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
- `OPENAI_MODEL`: Model to use (default: gpt-5.6-luna)
- `OPENAI_VISION_MODEL`: Model used for image descriptions (default: gpt-5.6-luna)
- `OPENAI_REASONING_EFFORT`: Effort for summarization and aggregation (default: low)
- `OPENAI_VISION_REASONING_EFFORT`: Effort for image descriptions (default: none)

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

## Database Setup

The project uses PostgreSQL with the pgvecto-rs extension (required for vector operations):

```yaml
# docker-compose.yaml specifies the image
image: tensorchord/pgvecto-rs:pg16-v0.2.0
```

Migrations run automatically on startup due to `migrationsRun: true` in dataSource configuration.

## Module System

This project uses ES Modules (type: "module" in package.json):

- All imports must include `.js` extension (even when importing `.ts` files)
- Use `import.meta.url` instead of `__dirname`
- Top-level await is supported

## ESLint Rules

The project has strict TypeScript linting:

- `@typescript-eslint/no-floating-promises: error` - All promises must be awaited or explicitly marked with eslint-disable comment
- Use `// eslint-disable-next-line @typescript-eslint/no-floating-promises` when intentionally not awaiting (e.g., background tasks)

## Testing

No test framework is currently configured (`npm test` exits with error).

## Additional Context

### Important Rules

- Telegram bot messages must always respond to user in Ukrainian with corresponding emoji before the message
