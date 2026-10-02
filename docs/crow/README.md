# News crow «Кара»

A persona inside the bot's messages: the crow «Кара» (🐦‍⬛) brings news of the categories a chat subscribes
to with `/crow` and keeps coming back to it, less and less often. Each story gets an **arc** of messages,
written once and shared by every chat; each chat gets its own schedule of it.

**Built:** the menu, the scheduler, the posting, and the AI categories — 🤖 AI Enterprise, 🦙 AI Homebrew,
🧑‍💻 Вайбкодинг — end to end, from their sources to the posts, the morning digest of the news that came in
the quiet hours and the goodbye before them, the chat's profile with the personal jabs it feeds, and her
talks: answers to the cats who reply to her or call her, and a word in a talk about her stories. On top of
them: «я ж казала» to a cat who brings news she told and the UPD to a rumor that came true, the Friday
weekly digest with the vote for the week's best news, bets on the stories' dated events, and the
announcements of the streams — State of Play, Nintendo Direct, the labs' launches — with a reminder before
them. The game categories — 🎮 Плойка, ➕ PS Plus with its «прийдуть» and «покинуть» first of all news, 🍄 Нінтендо,
🟩 Бокс with Game Pass, 🖥 Пекарня, 🆓 Халява, 🌴 GTA VI with its countdown, 📅 Реліз-радар with the week's releases on Monday, 🏴‍☠️
Хакерня — from the press, the platforms and the stores, a news gathered from its publishers by meaning and told
once enough of them wrote of it; reminders of the games that come and go; quizzes in the long arcs. Talks and
forwards are heard by meaning too (EmbeddingGemma). GIFs come later.

## Where to read what

| Document | What it covers |
| --- | --- |
| [behavior.md](behavior.md) | What a chat sees: the persona and what she remembers, the posts, the morning digest and the evening goodbye, the profile and the jabs, her talks in the chat, «я ж казала», the weekly digest, the bets, the streams, `/crow` and its settings, «Кш!», the categories |
| [architecture.md](architecture.md) | The schedule in the database, the scheduler and its jobs, dispatch, gaps, the tables |
| [pipeline.md](pipeline.md) | From a source entry to an arc: sources, sorting, stories, facts, the outline, the checks, the roster, the budget, models and costs |

## Code

| File | What it does |
| --- | --- |
| [crow.command.ts](../../src/bot/commands/crow.command.ts) | `/crow`, the buttons, sending the posts and polls, hearing the chat's messages and votes, the owner's word on a bet; wires up the scheduler, the jobs and the talks |
| [store.ts](../../src/crow/store.ts) | `CrowStore`: every read and write of the crow's tables; keeps the arc chains consistent in transactions |
| [scheduler.ts](../../src/crow/scheduler.ts) | `CrowScheduler`: the 30-second tick, the jobs' queue, recovery after a crash |
| [dispatch.ts](../../src/crow/dispatch.ts) | Which post of a chat goes now: limits, priorities, expiry; what each kind of post is to the queue (`POST_KINDS`) |
| [cadence.ts](../../src/crow/cadence.ts) | Boldness levels, the gaps of an arc, which messages a chat gets |
| [planning.ts](../../src/crow/planning.ts) | A chat's posts of an arc; when the next post's turn comes |
| [categories.ts](../../src/crow/categories.ts) | The categories, their menu buttons, how many posts a story gets |
| [chatClock.ts](../../src/crow/chatClock.ts) | Quiet hours and "today" in the chat's zone, with `Temporal` |
| [crowMenu.ts](../../src/crow/crowMenu.ts) | The menu's text, buttons, callback data and toasts |
| [crowMessage.ts](../../src/crow/crowMessage.ts) | Posts as rich messages: the text, the picture or a list's gallery (`slideshow`), the table, the link |
| [jobs.ts](../../src/crow/jobs.ts) | The job contract: when a job runs, skips or waits; the job that gives each chat one try at its moment |
| [pipeline.ts](../../src/crow/pipeline.ts) | The source jobs and the `pipeline` job: sort, gather into stories, write, plan |
| [sources/](../../src/crow/sources/) | The sources, the parsing of feeds and sitemaps, and of the JSON and Markdown ones ([parsers.ts](../../src/crow/sources/parsers.ts)) |
| [stories.ts](../../src/crow/stories.ts), [modelKey.ts](../../src/crow/modelKey.ts) | When a story is written — an AI one by its vendor, a game one by its publishers; topic keys |
| [crowLlm.ts](../../src/crow/crowLlm.ts), [prompts.ts](../../src/crow/prompts.ts) | The LLM calls, their prompts and schemas; the persona of the arcs and the shorter one of the rest, from shared sections |
| [morning.ts](../../src/crow/morning.ts) | The morning digest: when a chat's morning comes, which news it tells, its checks, the `morning` job |
| [evening.ts](../../src/crow/evening.ts) | The evening goodbye: when a chat's evening comes, whether the day was worth one, its checks, the `evening` job |
| [profile.ts](../../src/crow/profile.ts) | The chat's profile and the `profile` job, the crow's introduction, the personal jabs of an arc |
| [conversation.ts](../../src/crow/conversation.ts) | The talks: which messages are for her, the aliases with typos, the limits and the thread, the gate and the answer and their checks |
| [embeddings.ts](../../src/crow/embeddings.ts) | EmbeddingGemma's port and thresholds, and what is embedded of a message, a post and an entry |
| [clustering.ts](../../src/crow/clustering.ts) | Which game story an entry belongs to: the link, the headline, the meaning |
| [quiz.ts](../../src/crow/quiz.ts), [deadlines.ts](../../src/crow/deadlines.ts) | A mega story's quiz, its checks and its place in a chain; the reminder of a story's games that come or go, its checks and its time |
| [birthday.ts](../../src/crow/birthday.ts) | Her birthday in a chat: its day in the chat's zone, her year counted, the cats' awards, the post, the `birthday` job |
| [countdowns.ts](../../src/crow/countdowns.ts) | The countdowns to big releases (`COUNTDOWNS`): the Fibonacci marks and their slots in the chat's zone, the line under the arcs, the posts' checks, the `countdowns` job |
| [releases.ts](../../src/crow/releases.ts) | The release radar: the week's roundups, its rows and its table, her word and its checks, the `releases` job |
| [sources/gameSources.ts](../../src/crow/sources/gameSources.ts), [freebies.ts](../../src/crow/sources/freebies.ts), [psPlus.ts](../../src/crow/sources/psPlus.ts), [gamePass.ts](../../src/crow/sources/gamePass.ts) | The game sources and their publishers; Epic's and GamerPower's giveaways; the PlayStation Blog's PS Plus with its games and the games leaving the Ukrainian store's catalog; Game Pass's lists |
| [sources/nintendoStore.ts](../../src/crow/sources/nintendoStore.ts) | The week's Switch 2 and Switch games from Nintendo's European store, for the release radar |
| [sources/psStoreHash.ts](../../src/crow/sources/psStoreHash.ts), [graphqlDocument.ts](../../src/crow/sources/graphqlDocument.ts) | The hash of the PS Store's persisted query, found in its script bundles; the GraphQL parser and graphql-js 14's printing it takes |
| [toldYou.ts](../../src/crow/toldYou.ts) | «Я ж казала»: the links compared, the story a forward or a link brings back, its checks; the UPD to a rumor that came true |
| [weekly.ts](../../src/crow/weekly.ts) | The weekly digest: its Friday evening, the week's shiniest news, the winner's checks, the table and the vote, the `weekly` job |
| [bets.ts](../../src/crow/bets.ts) | The bets: the proposal's checks, the times and the poll, the place in a chain, the outcome and its table, the `bets` job |
| [events.ts](../../src/crow/events.ts), [sources/streamSources.ts](../../src/crow/sources/streamSources.ts) | The streams: their sources and YouTube's schedule, the start of an announcement in its zone, the reminder by day or by night, the texts, moving and calling off, the `streams` job |
| [words.ts](../../src/crow/words.ts) | Ukrainian counts, «how long ago», the days and dates in words; `clip`, a text's cut that keeps an emoji whole, for every text cut for a model, for Telegram or for the database |
| [arcWriter.ts](../../src/crow/arcWriter.ts) | Writing an arc: the request with its outline, the checks, one rewrite — shared by the pipeline and the skill's A/B |
| [arcOutline.ts](../../src/crow/arcOutline.ts), [arcValidation.ts](../../src/crow/arcValidation.ts) | The shape of an arc; the checks of her texts, and the one rewrite every text gets (`writeChecked`) |
| [roster.ts](../../src/crow/roster.ts), [budget.ts](../../src/crow/budget.ts), [images.ts](../../src/crow/images.ts) | The labs' current models; the daily budget; story pictures |
| `src/entity/Crow*.entity.ts` | The tables ([architecture.md](architecture.md#tables)) |

## Settings

| Variable | Default | What |
| --- | --- | --- |
| `OPENAI_CROW_MODEL`, `OPENAI_CROW_REASONING_EFFORT` | `gpt-6-luna`, `low` | Sorting the AI and the game news, whether a doubtful entry tells a game story's news, extracting facts, the chat's profile, the crow's store for talks, the week's releases, how a bet ended, the start of a stream in an announcement |
| `OPENAI_CROW_ARC_MODEL`, `OPENAI_CROW_ARC_REASONING_EFFORT` | `gpt-6.1-sol`, `medium` | Writing the arcs; why sol — [pipeline.md](pipeline.md#models-and-costs) |
| `OPENAI_CROW_TALK_MODEL`, `OPENAI_CROW_TALK_REASONING_EFFORT` | `gpt-6-luna`, `low` | What the crow says outside the arcs many times a day: her talks, «я ж казала» and the UPD, the bets, the streams |
| `OPENAI_CROW_TEXT_MODEL`, `OPENAI_CROW_TEXT_REASONING_EFFORT` | `gpt-6.1-sol`, `low` | What the whole chat reads of her outside the arcs, a few calls a day: the morning and weekly digests, the evening goodbye, the jabs, the release radar, the quizzes, the reminders, the countdowns, a bet's outcome, her birthday word |
| `CROW_TALK_THRESHOLD`, `CROW_FORWARD_THRESHOLD` | 0.35, 0.78 | EmbeddingGemma's similarity from which a talk goes to the gate and a forward brings back a story ([configuration.md](../configuration.md#the-crows-embeddings)) |
| `YOUTUBE_API_KEY` | unset — no YouTube | The YouTube Data API, for the start of the streams on the channels ([behavior.md](behavior.md#streams)) |
| `OPENAI_CROW_DAILY_BUDGET_USD` | 1 | No new arcs past this spending of the pipeline in a UTC day |
| `TG_OWNER_ID` | unset — nobody | Who hears of a spent budget or an empty balance, and who says how an unclear bet ended |

## Testing and checks

Unit tests cover the crow's decisions, as pure functions next to the code: the gaps of an arc (with a
seeded generator), which messages a chat gets, quiet hours across the change to winter time, which post
goes next and within which limits, where «Кш!» is — taken over, left, taken off by the goodbye, and the sending
that moves it on a fake store — the rich posts, the menu and its callback data, when a job runs, the
parsing of feeds and sitemaps and of the JSON and Markdown sources (trimmed real ones), which failure is a source down for a while and which is OpenAI's, the batches of the sorting after a failed one, a sure match by meaning only of the same hero, an exclusive category taking a news whole, topic keys, when a story is written, the outline and
the checks of an arc, the roster update, the daily budget; when a chat's morning comes (across midnight and
the change of time), which news a digest tells, its checks and its one rewrite, the `morning` job on a fake
store; when a chat's evening comes, the goodbye's checks, the `evening` job — whether a day was worth a
goodbye, one an evening, and after a downtime; the goodbye last and silent, past the limits; Ukrainian counts
and «how long ago», a text's cut that keeps an emoji whole; what the profile reads and keeps, the jabs' checks and their one
rewrite, where a jab goes in a chain, whom the jabs may aim at, the `profile` job and the introduction; in a
talk, which messages are for her, calling her by name, the aliases with endings and typos, the limits and the
end of a thread, the gate and the answer with its checks and rewrite, and the conversation on a fake store —
an answer, a call, a chime-in telling a post ahead of its turn, a cat who opted out, the quiet hours; a talk and a
forward heard by meaning — above and below the threshold, too few words, with the message a reply answers, a
post by its facts and the facts' vectors kept by story;
the game news — which game story an entry belongs to, when a game story is written and how big, the filters of the
game sources, Epic's and GamerPower's giveaways, PS Plus's days and the games leaving it (through a stubbed
`fetch`, a stale hash found again in the bundles), the PS Store's hash itself — the query and its fragments from
the bundles, printed as graphql-js 14 does, against its known hash — the games of a list and their gallery and
table, Game Pass's lists, the quizzes and the reminders with their checks, the countdowns — the marks and the
last day's two slots across the change of time, the line under the arcs, the job — the size of the opening, her
birthday — its day and the 29th of February, the year's figures and rows, the awards and who gets none, the post,
the word's rewrite, the job once a year — the release radar — its Monday, its rows, its word and its
job, the platforms of the roundups a release cites added to its row, Nintendo's store read with the roundups, one game for its Switch and Switch 2 versions, the week without it
when the store fails; the
placeholders of a post's text and how the memory reads them; «я ж казала» — the links compared, the story a
forward or a link brings back, the faster channel, once per story, the gap — and the UPD's checks; the weekly
digest's Friday evening across the change of time, the ranking, the winner's checks, the table, the vote and
the job; the bets — the day named by a fact, the times in the chat's zone, the poll, the place in a chain, the
outcome's table and the streaks under it — from three in a row, broken from five, hers too — the job with a sure, a
cancelled and an unclear outcome, the owner's word and the owner's
silence; the streams — the start of an announcement in its zone and summer time, the moments, the reminder by
day and by night, the texts and their plain fallback, YouTube's answers, the job planning, polling a channel
through a stubbed `fetch`, and a stream that moved.

The store's SQL and the pipeline with the real LLM are checked by hand on the dev database, the morning
digest's SQL — merging, sending, going stale, failing, a crash while sending — the profile's — the
introduction once, opting out mid-chain, the jabs off — the talks' — a reply found by its message, the
material of a story, a post told ahead of its turn, a chime-in sent at once — and slices 5–8's — «я ж
казала» once per story, a rumor confirmed and its UPD, the week's stories and the vote under the digest, a
bet sent as a poll with its votes, settled and told, the smartest cat, a stream found by two sources, sent
and reminded of, the cleanup — and slice 9's, with the real EmbeddingGemma — the vectors kept, what the chat has
not heard found closest first, a forward of the story against other news — and the game news' — three publishers'
entries gathered by meaning, a quiz sent as a quiz poll, a reminder sent after its news and dropped for a chat that
never heard it, GTA VI's line and a countdown — and the birthday's — the day of her first post, her year in a
chat with a merged opening, a cat who opted out and a year's cleanup — on a throwaway one. A live run sorted and gathered a day's real feeds
and wrote a game arc on sol (`data/crow_ab/scripts/games_live_check.mts`). A new model
for the arcs is checked with the crow's blind A/B in the `update-openai-pricing` skill
([pipeline.md](pipeline.md#models-and-costs)).

In Telegram: open `/crow` in a test group and subscribe to a category; the tools of `data/crow_tools/` replay a
story or an entry of the dev database into it (`replay_story.mts`, `replay_entry.mts`), so a real arc comes through
the usual queue without waiting for news.
