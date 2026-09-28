# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Telegram AI bot built with TypeScript that uses machine learning models for content analysis and media tracking. The bot can:

- Track and search media (photos/videos) using CLIP embeddings for semantic similarity search
- Detect duplicate media by comparing image embeddings, with `/ignoremedia` to exclude known repeats, and post
  the chat's bayans of the month — the top bayanists, the bayan of the month — on its last evening
- React to toxic text messages with an emoji (multilingual XLM-R classifier)
- Transcribe voice messages and video notes using Whisper
- Summarize chat activity with `/trends` via OpenAI (photos in the chat are described by a vision model)
- Post news as a persona, the crow «Кара» (🐦‍⬛), in the categories a chat subscribes to with `/crow` — AI and
  games, a game news gathered from its publishers by meaning — and answer in her voice the cats who reply to her,
  call her or talk about her stories; she also runs a weekly digest with a vote, bets on the stories' dated events,
  quizzes, reminders of the games that come and go, countdowns to big releases, her birthday in the chat with
  the year's review, and announces the streams of the chat's categories

Zero-shot classification exists in `AIService` and `ClassifyMessageByLabelsCommand`, but that command is
not registered; the sentiment pipeline is not used by any command.

## Module Documentation

Each module's design, behaviour and pitfalls are documented in `docs/`, not here, so that work on one
module does not load the others. **Before changing a module, read its doc; when a change alters what the
doc describes, update the doc in the same change.** Diagrams in the docs are Mermaid, which GitHub renders.

| Module | Code | Doc |
| --- | --- | --- |
| News crow «Кара»: `/crow`, arcs, AI and game news sources, talks in the chat, the weekly digest, bets, quizzes, streams | `src/crow/`, `crow.command.ts`, the `Crow*` entities | [docs/crow/](docs/crow/README.md) |
| Media: near-duplicates, the bayans of the month, `/ignoremedia`, `/searchmedia`, history import | `mediaTracker.command.ts`, `ignoremedia.command.ts`, `mediaMatchReplies.ts`, `bayanStats.ts`, `video.service.ts`; `ChatPhotoMessage`, `MediaRepeat`, `IgnoredMedia`, `MediaSearch`, `ChatState` | [docs/media.md](docs/media.md) |
| `/trends` | `trends.command.ts`, `trendsMessage.ts`, `trends.service.ts`; `ChatMessage`, `TrendsSummary` | [docs/trends.md](docs/trends.md) |
| Voice transcription | `recognizeSpeech.command.ts`, `transcriptionQueue.ts` | [docs/speech.md](docs/speech.md) |
| `/timezone`: the chat's time zone | `timeZone.command.ts`, `timeZones.ts`; `ChatState.timeZone` | [docs/timezone.md](docs/timezone.md) |
| Local ML models: CLIP, Whisper, toxicity, EmbeddingGemma | `ai.service.ts` | [docs/ai-models.md](docs/ai-models.md) |
| Telegram plumbing: update queue, API guard, errors, shutdown, files, owner alerts, grammY version | `src/bot/`, `app.ts` | [docs/telegram.md](docs/telegram.md) |
| Database, migrations, VectorChord, vector search | `src/dataSource/`, `src/migrations/` | [docs/database.md](docs/database.md) |
| Environment variables | `config.service.ts`, `.env.example` | [docs/configuration.md](docs/configuration.md) |

## Tech Stack

- **Runtime**: Node.js 26+ with ES Modules; `tsx` runs TypeScript directly in development
- **Language**: TypeScript 6 with strict mode
- **Bot Framework**: grammY 1.46 for Telegram Bot API, with the `runner`, `auto-retry`,
  `transformer-throttler` and `files` plugins. Pinned to `~1.46.0`: read [docs/telegram.md](docs/telegram.md#grammy-version)
  before upgrading
- **Telegram Client**: telegram library (gramjs, MTProto user session) for history import
- **Database**: PostgreSQL with the VectorChord extension (`vchordrq` index) for vector similarity search
- **ORM**: TypeORM 1.x with entity decorators
- **AI/ML**: @huggingface/transformers (Transformers.js) for running models locally: CLIP, Whisper, the toxicity
  classifier and EmbeddingGemma (the crow's text embeddings, `halfvec`)
- **LLM**: OpenAI SDK, traced through Langfuse
- **Image Processing**: sharp (not a direct dependency — it comes in with `@huggingface/transformers`)
- **Video Processing**: fluent-ffmpeg for video frame extraction
- **Translation**: @iamtraction/google-translate for English translation (CLIP text search only)
- **XML**: @rgrove/parse-xml (no dependencies) for the crow's RSS/Atom feeds and sitemaps

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
- Each command implements `handle()` for setup; `dispose()` for cleanup is optional (most hold nothing to
  release, and the shared AI models are released in [app.ts](src/app.ts))
- Commands have access to `bot`, `dataSource`, and `configService`
- Registered: `StartCommand`, `MediaTrackerCommand` (`/searchmedia`, `/starthistoryimport`),
  `IgnoreMediaCommand`, `ClassifyMessageCommand` (toxicity reactions), `RecognizeSpeechCommand`,
  `TrendsCommand`, `TimeZoneCommand` (`/timezone`), `CrowCommand` (`/crow`). `ClockCommand` and
  `ClassifyMessageByLabelsCommand` exist but are not registered

### Telegram Essentials

What every command relies on; the detail is in [docs/telegram.md](docs/telegram.md).

- Updates of one chat run in order, and only `TG_UPDATE_CONCURRENCY` updates run at once (default 1).
- Long work — LLM calls, ML over many items — goes to a `BackgroundQueue` owned by the command, which frees
  the update's slot. The command closes the queue in `dispose()`, so the shutdown waits for the job in
  progress.
- Sending is paced to Telegram's limits by the throttler, and a 429 is retried after `retry_after`, so the
  code makes no pauses between replies. Nothing else is retried: a send that failed on the network may
  still have been delivered.
- Media is downloaded only through `downloadTelegramFile`, since a file link carries the bot token; the
  cloud Bot API serves files up to 20 MB.
- `bot.catch` logs a failed update and apologises in the chat only for commands and button presses.
- Trouble only the owner can fix — an empty OpenAI balance, the crow's spent budget — goes to `TG_OWNER_ID`
  through `OwnerAlerts`, at most once a day per kind ([docs/telegram.md](docs/telegram.md#owner-alerts)).
- A chat's time zone is `ChatState.timeZone`, set with `/timezone`; a feature that needs it falls back to
  UTC rather than guessing ([docs/timezone.md](docs/timezone.md)).
- Helpers live next to their users in `src/bot/` (`telegramFiles.ts`, `telegramLinks.ts`,
  `backgroundQueue.ts`), not in a global `src/utils`.

### Singleton Services

Core services use the singleton pattern:

- **AIService** ([ai.service.ts](src/services/ai.service.ts)): Manages ML model pipelines and embeddings
- **VideoService** ([video.service.ts](src/services/video.service.ts)): Handles video frame extraction using ffmpeg
- **ConfigService** ([config.service.ts](src/config/config.service.ts)): Centralizes environment configuration
- **OpenAIService** ([openai.service.ts](src/services/openai.service.ts)): OpenAI API with Langfuse tracing and token cost logging
- **TrendsService** ([trends.service.ts](src/services/trends.service.ts)): Chat summarization and trends analysis using OpenAI
- **FileService** ([file.service.ts](src/services/file.service.ts)): Handles file operations

### Tracing and Observability (Langfuse)

- The tracing module ([tracing.ts](src/tracing.ts)) initializes OpenTelemetry with `LangfuseSpanProcessor`
  from `@langfuse/otel`. **It must be imported first** in [app.ts](src/app.ts), before any other import.
- It exports `shutdownTracing()` for graceful shutdown (flushes pending spans) and gets its credentials
  from `ConfigService`, not `process.env`.
- OpenAI calls go through `observeOpenAI()` from `@langfuse/openai`, so each is traced, and log their token
  usage and cost to the console; `OpenAIService.parse` also returns the cost.
- Every call goes through `OpenAIService.call`, the only way to the client, which awaits it through `watch`:
  an empty balance (429 `insufficient_quota`, `isQuotaError`) is told to the `onQuotaExhausted` listeners — the
  owner alert — and rethrown, so a caller fails as before.
- **A kind of call has its own generation name, a verb phrase in Title Case:** `Summarize Messages`,
  `Aggregate Summarization Results`, `Describe Image` (trends); `Sort Crow News`, `Extract Crow Facts`,
  `Write Crow Arc`, `Rewrite Crow Arc`, `Write Crow Morning Digest`, `Rewrite Crow Morning Digest`,
  `Write Crow Goodbye`, `Rewrite Crow Goodbye`, `Build Crow Chat Profile`, `Write Crow Jabs`, `Rewrite Crow
  Jabs`, `Extract Crow Snippets`, `Write Crow Reply`, `Rewrite Crow Reply`, `Write Crow Chime-In`,
  `Rewrite Crow Chime-In`, `Write Crow Told You`, `Rewrite Crow Told You`, `Write Crow Rumor Update`,
  `Rewrite Crow Rumor Update`, `Write Crow Weekly Digest`, `Rewrite Crow Weekly Digest`, `Write Crow Bet`,
  `Rewrite Crow Bet`, `Resolve Crow Bet`, `Write Crow Bet Outcome`, `Rewrite Crow Bet Outcome`, `Extract Crow
  Stream`, `Write Crow Stream`, `Rewrite Crow Stream`, `Sort Crow Game News`, `Match Crow Story`, `Write Crow Quiz`,
  `Rewrite Crow Quiz`, `Write Crow Reminder`, `Rewrite Crow Reminder`, `Write Crow Countdown`, `Rewrite Crow
  Countdown`, `Extract Crow Releases`, `Write Crow Release Radar`, `Rewrite Crow Release Radar`, `Write Crow Birthday`,
  `Rewrite Crow Birthday` (the crow). A new
  call gets a new name in the same style.
  `LANGFUSE_TRACING_ENVIRONMENT` keeps local runs apart from production.
- Log lines of a module start with its tag in brackets — `[OpenAI]`, `[Trends]`, `[Crow]` — and name a chat
  by `getLinkChatId`; failures go to `console.error` with the error, recoverable trouble to `console.warn`.

### ConfigService Usage

**IMPORTANT**: Always use `ConfigService` to access environment variables. Never use `process.env` directly.

```typescript
import { ConfigService } from './config/config.service.js';

const configService = ConfigService.getInstance();
const apiKey = configService.get('OPENAI_API_KEY');
```

When adding new environment variables:

1. Add to `ConfigService.config` object in [config.service.ts](src/config/config.service.ts), without a comment
2. Add example value to [.env.example](.env.example)
3. Describe it in [docs/configuration.md](docs/configuration.md). An OpenAI setting takes the `OPENAI_`
   prefix, and a model variable comes with its own `…_REASONING_EFFORT`

### Database

- PostgreSQL with VectorChord, entities through TypeORM 1.x decorators. Details, the VectorChord upgrade
  procedure and the vector index layout: [docs/database.md](docs/database.md).
- **Date columns are `timestamptz`, never `timestamp`**: a `timestamp` column mixes the bot's time zone
  with the database's, and time windows silently find nothing.
- No foreign keys anywhere in the schema; the owning module's code keeps the rows consistent.
- Migrations run on startup, each in its own transaction (`migrationsTransactionMode: 'each'`, so a
  migration may set `transaction = false` for `VACUUM`).
- TypeORM 1.x takes `select` as an object (`select: { embedding: true }`); the string-array form throws.
- **Every vector (sphere) query goes through [vectorSearch.ts](src/dataSource/vectorSearch.ts)**; read
  [docs/database.md](docs/database.md#vector-similarity-search) before touching vector queries or indexes.

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
- Logic that should not depend on the framework is kept in modules next to the command and tested through
  a port instead of grammY and TypeORM; the command supplies the ports, the tests a fake.
- What each module's tests cover is in its doc. SQL and index behaviour need a real Postgres/VectorChord
  and are not unit-tested; neither is the history import, which needs MTProto.

## Additional Context

### Important Rules

- Telegram bot messages must always respond to user in Ukrainian with corresponding emoji before the message
