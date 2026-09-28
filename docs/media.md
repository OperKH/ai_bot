# Media tracking and search

Near-duplicate detection of photos and videos («seen it before» replies), the chat's bayans of the month,
`/ignoremedia`, `/searchmedia` and the history import. Code: [mediaTracker.command.ts](../src/bot/commands/mediaTracker.command.ts),
[ignoremedia.command.ts](../src/bot/commands/ignoremedia.command.ts),
[mediaMatchReplies.ts](../src/bot/commands/mediaMatchReplies.ts), [bayanStats.ts](../src/bot/commands/bayanStats.ts),
[video.service.ts](../src/services/video.service.ts), the CLIP part of [ai.service.ts](../src/services/ai.service.ts)
and [vectorSearch.ts](../src/dataSource/vectorSearch.ts). How the vector queries stay on the index is in
[database.md](database.md#vector-similarity-search).

## Tracking a photo or a video

**A photo:**

1. User sends photo → bot extracts file_id
2. Download photo and generate CLIP embedding
3. Query database for similar embeddings (cosine similarity > threshold), unless the media is on the
   ignore list
4. If matches found, reply with references to similar messages
5. Store embedding in database with `mediaType='photo'` and `frameIndex=0`

Steps 3–5 are `trackMedia`, shared with videos once their embeddings are in hand.

**A video:**

1. User sends video → bot extracts file_id and downloads full video file
2. Extract 4 frames at positions: 10%, 30%, 50%, 70% of video duration (avoids black screens at start/end;
   `VideoService.FRAME_POSITIONS`)
3. Generate CLIP embedding for each frame (`AIService.getFrameEmbeddings`, shared with `/ignoremedia` and the
   history import, so a video gets the same embeddings whichever way it comes in)
4. Query database for similar embeddings across all frames, in one statement grouped by messageId
   (keeping the highest similarity)
5. If matches found, reply with references to similar messages
6. Store all 4 frame embeddings in database with `mediaType='video'` and `frameIndex=0..3`

Why several frames: videos may have black screens or fade-ins at the beginning; sampling 10%, 30%, 50%
and 70% captures the content; the search uses the frame with the highest similarity; and the same
positions every time let a re-uploaded video match.

Videos over 20 MB cannot be downloaded live ([telegram.md](telegram.md#files-the-20-mb-limit)).

## Bayans

A photo or a video that finds earlier copies of itself in the chat is a bayan: the «seen it before» thread
goes out, and the bayan is kept for the month's statistics (`media_repeat`) — who posted it, the earliest copy
found and the latest before it, how many copies the chat had. A match whose every copy turns out deleted is no
bayan, nor is a media on the ignore list. Every media row keeps who posted it and when (`userId`, `sentAt`; a
message on behalf of a channel or a group is theirs); the rows stored before are left without, and the history
import fills both for what it adds.

- **A jubilee.** The 10th, 25th, 50th, 100th, 250th, 500th and 1000th time the chat sees a media, the thread's
  header is «🎉 Ювілейний баян: це вже 10-й раз!» instead of the detective's, each jubilee with its own emoji:
  🎉 10, 🥈 25, 🥇 50, 💯 100, 🏆 250, 👑 500, 🗿 1000.
- **The statistics of the month**, on its last day at 19:42 of the chat's zone (`/timezone`; UTC without it),
  one rich message: «📊 Баяни жовтня», the month's media and the bayans' share, the table of the five
  bayanists — names as text, nobody is pinged — the bayan of the month (the one the chat has seen most times,
  from the third), the oldest (the most messages since its first copy) and the quickest (the fewest since the
  copy before), each with a link to it. The month runs from the moment the previous one's statistics went, so
  the last evening's bayans count in the next month. The chats are checked every minute from the last day of
  a month to the second of the next in UTC, which every zone's end falls into; a chat gets its month once
  (`chat_state.bayanStatsMonth`, marked before the send), up to a day late if the bot was down; a month
  without bayans goes without, and so does one the bot did not watch from its start — the month it came to the
  chat or was deployed in (`chat_state.mediaTrackedSince`, the first media it kept so), so the bot can be
  deployed any day. Messages are counted by their ids: those of a chat run in order.

## Text search

1. User sends `/searchmedia [query]`
2. Translate query to English if needed: a text that does not match an English pattern goes through
   Google Translate, and the translation is what CLIP embeds
3. Generate CLIP text embedding and store it with the query as a `MediaSearch` row; the next pages reuse it
4. Query the database with `findSimilarMedia`, the same statement as the near-duplicates: grouped by
   `messageId`, so a video's frames count as one result, keeping its best frame
5. Order by `similarity DESC, messageId DESC` and page by keyset: the next page is everything after the
   stored cursor.
   - The tiebreak matters: reposts score exactly the same, and without it the page boundaries moved
     between queries.
   - The cursor survives deleted and newly added rows, which offsets did not.
6. Return a page with the "Ще" button attached to its last result

### The "Ще" button

- The button carries only `islm-<id>`: callback data is capped at 64 bytes, too little for the text and a
  cursor.
- The embedding is computed once, when the search is created. Every page is then ranked by the vector the
  cursor belongs to, and "Ще" needs no translation.
- The same query asked again in the chat replaces the earlier search.
- A pressed "Ще" is taken off at once, before the next page goes out; that page carries the new button on
  its last result, so there is never more than one. Only the search's latest button (`buttonMessageId`)
  moves it on: a second tap on the same button is ignored instead of showing an extra page.
- An hourly job removes searches older than 30 days. A search that goes, expired or replaced, has its
  button taken off first. A button that survives (the edit failed) answers that the search has expired,
  and so do buttons from before this table, which carry a JSON payload.

## Deleted messages

A bot is not told when a message is deleted in a group, so its rows stay in `chat_photo_message`. Both
the "seen it before" replies and `/searchmedia` reply to the matched message with
`allow_sending_without_reply`, and `replyToMatch` ([mediaMatchReplies.ts](../src/bot/commands/mediaMatchReplies.ts))
checks the result:

- if the sent reply has no `reply_to_message`, the original is gone;
- the stray reply is deleted, and the message's rows are removed so it is not found again;
- the next match takes its place.

If every match of a "seen it before" thread turns out deleted, the header is removed as well.

## History import and video reindexing

The `/starthistoryimport [days|all]` command uses the telegram library (not grammY). Its import is a
**gap-fill pass**: it walks the chat's media and embeds only messages the DB does not have yet. There is
no cursor like "resume from `max(messageId)`" — live handlers write to the DB regardless of import state,
so after a downtime the newest rows are fresh live messages and the gap sits _below_ them. Skipping by the
set of existing `messageId`s is what makes the pass safe to run at any time.

The argument picks the window: a positive number of days (`/starthistoryimport 60`) or `all` for the whole
history; anything else counts as no argument. Skipped messages cost only the MTProto paging (100 per
request), no download or ML.

| Argument     | Never imported      | Already imported               |
| ------------ | ------------------- | ------------------------------ |
| none/invalid | full import         | "🍧 Нема потреби" + usage hint |
| `60`         | import last 60 days | gap-fill last 60 days          |
| `all`        | full import         | gap-fill whole history         |

**Scenario 1: Initial Import** (`!isMediaImported`) and **Scenario 3: Gap Fill** (`isMediaImported &&
isVideoImportedByFrames`, argument required)

- Load the chat's existing `messageId`s into a `Set`
- Iterate through chat history using `iterMessages()` with `InputMessagesFilterPhotoVideo`, skipping ids in
  the set
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

**Implementation details:**

- Runs in background with `isMediaImporting` flag to prevent concurrent imports
- The reply reports added photos/videos and the chat's total media count (`ImportStats`)
- The `days` window is resolved to a message id via an unfiltered `iterMessages({ limit: 1, offsetDate })`
  and then walked with `offsetId + reverse` — `offsetDate` is not passed to the filtered iterator because
  gramjs maps it to `maxDate` of `messages.Search`, whose meaning under `reverse` is unclear
- Frame extraction uses `VideoService.extractFramesFromBuffer()`
- Old video entries are automatically deleted before saving new ones in `importChatMessages()`
- Both `processVideoFromApi()` and `processPhotoFromApi()` methods handle the respective media types

## Tables

- **ChatPhotoMessage**: media embeddings for the similarity search
  - `chatId`, `messageId`; `mediaType` ('photo' or 'video'); `frameIndex` (0 for photos, 0–3 for video
    frames)
  - `embedding`: 512-dimensional CLIP embedding in a Postgres `vector(512)` column
    - Writes accept a `'[0.1,0.2,...]'` string (the driver passes non-arrays through unchanged)
    - Reads through the **entity** path (`find`/`findOne`) hydrate it to `number[]`, not a string
    - Reads through the **raw** path (`getRawMany`) return the `'[...]'` string as-is
    - **The field has `select: false`**, so queries leave it out unless it is selected explicitly:
      ```typescript
      // find/findOne — the object syntax (TypeORM 1.x removed `select: ['embedding']`, which now throws)
      await repository.findOne({
        select: { embedding: true }, // or { id: true, chatId: true, embedding: true, ... }
        where: { chatId, messageId },
      });

      // QueryBuilder
      await repository
        .createQueryBuilder('msg')
        .addSelect('msg.embedding')
        .where('msg.chatId = :chatId', { chatId })
        .getMany();
      ```
  - `userId`, `sentAt`: who posted it and when; null for the rows stored before they were kept
- **MediaRepeat** (`media_repeat`): a bayan — `messageId`, `authorId` and `authorName` as they were then,
  `mediaType`, `firstMessageId` (the earliest copy found), `previousMessageId` (the latest before it), `copies`
  (how many the chat had), `similarity`, `sentAt`; indexed by `(chatId, sentAt)` for the month's statistics
- **ChatState**: per chat, `isMediaImported` (the initial import is done) and `isVideoImportedByFrames`
  (videos are indexed by frames, not thumbnails); `mediaTrackedSince`, since when it keeps who posted the media
  and when; `bayanStatsMonth`, the last month whose statistics it got
- **IgnoredMedia**: media excluded from duplicate detection via `/ignoremedia`; the same `vector(512)`
  `embedding` column (also `select: false`), matched with the same sphere query
- **MediaSearch**: one `/searchmedia` query per row: its text, the CLIP `embedding` of the text, the keyset
  cursor (`cursorSimilarity`, `cursorMessageId`) and `buttonMessageId`, the reply that carries the live
  "Ще" button

## Settings

`MATCH_IMAGE_THRESHOLD` (0.96) for near-duplicates, `MATCH_TEXT_THRESHOLD` (0.24) for the text search,
`MATCH_IMAGE_COUNT` (3) results per page; `TG_API_ID`, `TG_API_HASH`, `TG_API_SESSION` for the history
import ([configuration.md](configuration.md)).

## Tests

[mediaMatchReplies.ts](../src/bot/commands/mediaMatchReplies.ts) is tested through a port instead of grammY
and TypeORM: the replies to matched media (skipping deleted messages), the `/searchmedia` paging and a press
on "Ще" (`pressMore`: the button goes before the next page, a double tap shows one page), and the jubilee's
header. [bayanStats.ts](../src/bot/commands/bayanStats.ts) is tested the same way: the month's window across the
change of time and without a zone, the figures, the message, a month sent once, and the month the bot began to
watch in skipped. The command supplies the
ports, the tests a fake chat. The SQL is checked by hand on a throwaway database
(`data/media_tools/bayan_stats_check.mts`); the history import (MTProto) is not tested.
