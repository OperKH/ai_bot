# The crow in a chat

What a chat sees and can change. How it is scheduled is in [architecture.md](architecture.md); how the
texts are written is in [pipeline.md](pipeline.md).

## The persona

Кара is a brazen, self-assured know-it-all crow in a chat of friends — gamers and IT people. The persona
lives in `PERSONA_PROMPT` ([prompts.ts](../../src/crow/prompts.ts)); the traits that matter when changing it:

- **The joke is how the fact is told, not a tag after it.** At least half the posts open with her reaction
  or a jab, and the fact comes inside or after it. Posts are short: 1–3 sentences.
- **Always on the side of today's hero.** If she praised a competitor before, she switches sides without
  apology; her past verdicts (`stance` of earlier stories) are given to her for that.
- She calls the members cats (коти, котики, мурчики, хвостаті) — friendly teasing, never insults. Rumours
  come from the magpie («сорока на хвості»), whom she does not quite trust.
- **She swears like the chat does:** about every other post has one or two of its words (бля, піздєц,
  охуєнно, заєбісь, хуйня, срака), built into the sentence. The words are listed in the prompt on purpose:
  told only that she may swear, luna wrote none, and then only «блін» and «зараза».
- Facts, numbers, prices and names come only from the story's facts, its title and the roster of
  competitors; no politics, war, religion, nationality or slurs; she never says she is an AI or a bot.
- Everything she writes is in Ukrainian and starts with an emoji, like every message of the bot.
- **She remembers what she said.** An arc, written once for every chat, gets the openings of the latest arcs
  (not to repeat them) and her latest verdicts with how long ago she gave them («5 днів тому»), to switch
  sides knowingly. What she says in one chat outside the arcs, such as the morning digest, gets her latest
  posts in that chat, each with how long ago.
- The arcs are written by `PERSONA_PROMPT` on `OPENAI_CROW_ARC_MODEL`; the rest by `TALK_PROMPT` — the same
  sections of her character, without the structure of an arc — on `OPENAI_CROW_TEXT_MODEL` (sol) what the whole
  chat reads a few times a day — the digests, the goodbye, the jabs, the release radar, the quiz, the reminders,
  the countdown, a bet's outcome, her birthday; sol won the blind A/B of them 23 to 4 —
  and on `OPENAI_CROW_TALK_MODEL` (luna) the rest, her talks first, many a day.

## The posts

- A post is a rich message ([crowMessage.ts](../../src/crow/crowMessage.ts)). The crows in front give its
  weight: 🐦‍⬛🐦‍⬛🐦‍⬛ the news, 🐦‍⬛🐦‍⬛ important, 🐦‍⬛ background.
- The first post of an arc brings the story's picture — a store's list brings a gallery of its games instead
  ([below](#game-news)) — and ends with where to read it in full, «🔗 Детальніше:
  anthropic.com»: the story's first official page, or its first source when none is official — a model known
  only from OpenRouter. The later ones reply to it without a link, so an arc reads as a thread.
- The only markup in a text is `**bold**` for the names of games, models and products, `==marked==` (the client's
  highlight colour) for prices, dates and percentages, and `• ` list lines — so a cat scrolling past catches what a
  post is about (`EMPHASIS_RULES`, one rule for every prompt); a poll takes none, and the code takes it off its
  question and options. A message may carry a table of 2–4 columns.
  `` `code` `` spans, which the facts keep from the sources and the models copy, show as code.
  `{when:<id>}` becomes a `date_time` element, which every reader sees in their own zone. Model text is
  never passed as rich Markdown, where `$2 / $10` would turn into a formula.
- Which posts ring: a restrained crow rings only for the news of mega stories, a bold one for the news of
  every story, a pestering one for every post. The rest go silently.
- «🔇 Кш!» is under the chat's latest post only: every new post takes the button over from the one before
  (the crow's introduction, her evening goodbye, her answer to a cat who called her and the polls — a bet, a
  quiz — have none, and leave it where it was). The first cat to press it gets a warning;
  a second cat within the hour — a third when she is pestering — under the same post or a newer one sends the
  crow away for an hour, and she says so under the post: «Двоє котів проти однієї ворони — сміливо…», or
  «Троє котів… це вже зграя… Полетіла на годину». A cat pressing twice counts once; while she keeps quiet
  anyway, more cats only hear so.

## The morning digest

The news of the quiet hours does not pile up for the morning. When a chat's quiet hours end, the openings of
two or more stories that came during the night go out as **one post**: a greeting, a line per story, and a
promise of the details during the day, under a collage of their pictures (up to four), and a link to each
story named by its hero: «🔗 Детальніше: Claude Opus 5.5 · Gemini 3.8 Live». The rest of each arc
follows through the day as before, as replies to the digest. One story alone goes as usual; a digest tells at
most six, the most important first, and the others go one by one after it.

- It is written 15 minutes before the quiet hours end, in the chat's zone, so it waits for their end like any
  post; after a downtime, until 2 hours after the end. Writing it is `OPENAI_CROW_TEXT_MODEL`'s
  (`Write Crow Morning Digest`, ≈ $0.008 on sol), with the crow's last 10 posts in the chat, so it does not
  greet the same way twice.
- It is checked as an arc is: a line per story, every number from those stories' facts, no time of day in
  digits, 1500 characters at most; a failing digest is rewritten once with the problems listed. One that still
  fails is dropped, and the news goes one by one — one try a morning.
- It counts as one post in the hourly and daily limits, and rings as the news of its most important story
  would.
- A digest nobody could hear within 12 hours — the crow kept quiet all day — is dropped, and so are the arcs
  of its news.

## The evening goodbye

The crow says goodbye once a day in each chat with quiet hours: «Все, коти…» — a threat to come back, maybe
the day's hero in a word or a promise to change her mind, never a new fact ([evening.ts](../../src/crow/evening.ts)).
No arc ends with a farewell of its own: an arc's last gap is the longest, and it mostly ran out in the night,
so the goodbye came at ten in the morning.

- It goes **20 minutes before the chat's quiet hours**, in its zone, and only after a day with two posts of
  the crow at least; after it the crow keeps quiet till the quiet hours begin — the rest of the arcs goes on
  in the morning. A goodbye that cannot go before the quiet hours begin is dropped.
- It is written 15 minutes before it is due (`OPENAI_CROW_TEXT_MODEL`, `Write Crow Goodbye`, ≈ $0.006 on
  sol) from what the crow said in the chat that day, her verdicts on the day's heroes, the stories she has
  more to say about tomorrow and her last goodbyes, not to repeat them. Checked as an arc message is, up to
  400 characters, rewritten once; one that still fails means no goodbye that evening.
- It rings for nobody, carries no «Кш!», and neither the hourly nor the daily limit counts or stops it — a
  goodbye matters most on the busiest day. A chat without quiet hours has no evening, and no goodbye.

## The chat profile and the jabs

The crow knows who in the chat sits on what, and jabs the cats by name when a story touches their topics
([profile.ts](../../src/crow/profile.ts)).

- **The profile** is built by `OPENAI_CROW_MODEL` (`Build Crow Chat Profile`, ≈ $0.001–0.006 a build) from the
  chat's messages of the last 30 days, once a week — the `profile` job looks every hour — and needs at least 50
  messages: the chat's interests, its running jokes (what comes back on different days: the messages go in by
  days), and for each cat up to five topics. Nothing passing is written into the prompt to keep it out: the
  window slides and the profile is rebuilt, so a joke the chat has forgotten goes by itself. **Games and tech only**: platforms, games, tools, models, sides taken in arguments. Health, money,
  family, where one lives, work, politics and war are out, listed in the prompt at length; the code keeps
  only cats the messages came from.
- **Before her first jab** the crow tells the chat that she reads it — «Я читаю ваш чат… Не хочеш, щоб я тебе
  чіпала, — /crow і «🙅 Не чіпай мене»» — as a post of its own (`intro`, without «Кш!»), once per chat, when
  the first profile is built. `/start` says it too. The chat's members must know (concept, section 14; the
  Gemma licence of the embeddings later asks the same).
- **The jabs** are written per chat after the story's arc (`OPENAI_CROW_TEXT_MODEL`, `Write Crow Jabs`,
  ≈ $0.006 on sol): a line at a cat whose topics the story touches, with `{cat}` where the name goes — or
  none, if the story touches nobody. Checked as an arc message is, plus the name exactly once and a cat that
  is in the profile; rewritten once, then dropped. A jab joins the chat's chain of the arc after its second
  post, a second one halfway through the rest; it is optional, so a chat over its daily limit loses it
  first. An arc of fewer than three posts gets none.
- **How many, and whether they ping:** restrained — one jab, the name only; bold — one, mentioned; pestering
  — two, mentioned. A mention is by username, or by id for a cat without one.
- «🙅 Не чіпай мене» is each cat's own, whatever the admin lock: the cat leaves the profile at once, their
  messages are not read for it any more, and the jabs planned at them are called off. «🎯 Підколки: вимк.» for
  the whole chat forgets the profile and calls off every planned jab.

## Talking in the chat

The crow reads the chat and talks in it ([conversation.ts](../../src/crow/conversation.ts)): in a chat
subscribed to something, outside its quiet hours and while nobody sent her away — neither «Заткнись» nor
«Кш!» holds. She does not hear commands, bots or what a bot posted; a forwarded post is no talk, she only
says «я ж казала» to it ([below](#i-told-you-so)).

- **Answers.** A cat who replies to a post of hers, or calls her — «ворона» in any case, «Каро», @the bot,
  or «Кара,» opening a message — gets an answer: a reply to their message, silent and without «Кш!», of
  1–3 short sentences in her voice that mirror the cat's tone. She keeps quiet when the message was not for
  her (the word in another sense) or is a bare reaction — «ок», «ахах», emoji. At most three talks begun with
  one cat in ten minutes — a call, or a reply to a post of her arc — and twelve answers in the chat in an hour.
  A thread of her answers ends after four exchanges with «🐦‍⬛ Все, я полетіла, у мене справи.», and she keeps
  quiet in it after that; its answers are no talks begun, or a quick cat's thread broke off silently at the
  third answer, before she could fly off.
- **Chiming in.** When a cat writes about a story she brought the chat in the last 48 hours — named by its
  aliases: its hero's name and how the chat may call it, with endings and typos («опуса», «anthropik») —
  and she still has something to tell of it, she may join uncalled: a detail of her store, or a post of the
  arc still waiting in the queue, said now. Only with something new for this very message: «the same
  topic» is no reason, and the model says whether there is one. A chime-in carries «Кш!», keeps the gap
  after her last post as any post does, and comes at most 2 / 4 / 6 times an hour by boldness.
- **By meaning.** A message that names none of her stories — «5.5 реально швидше пише чи це маркетинг» — is
  heard by its meaning ([embeddings.ts](../../src/crow/embeddings.ts), EmbeddingGemma,
  [ai-models.md](../ai-models.md#embeddinggemma)): its vector, with the message it replies to if it is a reply,
  against those of what she may still say of the chat's stories — the details of her store and the waiting
  posts of their arcs, each post by the facts it tells, dry: her posts speak the chat's slang, and on the chat's
  real messages their own texts came close to any chatter (71% of the messages within 0.25, against 30% for the
  facts). A story with one of them at `CROW_TALK_THRESHOLD` (0.35) or closer goes to the model, which decides as it
  does for a story named; the details and posts closest to the message come first in its request, named or not. At
  0.35, 2% of the chat's messages of four words or more reach the model (8% at 0.30), and the talks of her news met in the
  measurement scored 0.36 and up. A message of fewer than four words is not looked for this way: «шо на обід»
  scored 0.28. Every score is logged with the threshold — «Talk of Олег in chat …, by meaning, threshold 0.35: story
  12 0.41 → the gate», or «— below it» — to calibrate the threshold on the chat's own talk; the model's word
  follows in the next line.
- **Her store** (`Extract Crow Snippets`, `OPENAI_CROW_MODEL`): after a story's arc is written, 6–12
  details of its sources the arc did not tell, dry like the facts, and the aliases of its heroes. A detail
  told in a chat is not offered there again; a post of the arc told in a talk leaves the queue
  (`consumed`), and the arc goes on without it. A story whose store failed is still named by its hero.
- **The answer** is one call of the talk model (`Write Crow Reply`, `Write Crow Chime-In`): the cat's
  message and what it answers, the chat's last ten messages, the stories with their facts, details and
  waiting posts, what she said in the chat lately, and the cat's topics from the profile. Back come
  whether she speaks, the text, the details and posts it told, and the cat's tone (only logged for now:
  the GIFs come later). Checked as an arc message is — every number from what she was given, no time of
  day in digits, no forbidden topics, up to 400 characters — rewritten once, then dropped. The daily
  budget does not count the talks: their own limits hold them.
- «🙅 Не чіпай мене» keeps her out of that cat's talk: she answers them when they call her, but does not
  chime in on them, and their messages are left out of what the model reads.

## I told you so

«Я ж казала» ([toldYou.ts](../../src/crow/toldYou.ts)) — the crow reminds the chat that she brought the news
first.

- **A cat brings news she told.** A forwarded post, or a message with a link, about a story whose news she
  brought the chat in the last 30 days: a link to one of the story's sources settles it (the links are
  compared without `www.`, trackers or a trailing slash; a front page names no news), otherwise the story's
  aliases name it — in the text or in the words of a link — and the model says whether it is the same news:
  a new detail or other news of the same hero is not. A forward that neither does is compared by meaning with the
  facts of the stories she told, each story by its closest fact: one at `CROW_FORWARD_THRESHOLD` (0.78) or closer
  goes to the model the same way, and the scores are logged with the threshold. On the chat's real forwards the
  forward of her news scored 0.83 and every other at most 0.64; against the headlines it was 0.64 too. She answers the cat's
  message: «🐦‍⬛ …я про це каркала
  ще 3 години тому 💬…» — the moment is a `date_time` of her first post of it, so every reader sees it their
  way, and 💬 links to that post (in a supergroup). If the forwarded original came out before her post, she
  does not brag: the channel was faster this time, and she owns it in character.
- Once per story in a chat. Uncalled, like a chime-in: after the gap since her last post, within her chime-ins
  of the hour, with «Кш!», never to a cat who pressed «🙅 Не чіпай мене». `Write Crow Told You` on
  `OPENAI_CROW_TALK_MODEL` (≈ $0.0002), checked as an arc message is — the moment once, every number from the
  story — up to 300 characters, rewritten once.
- **A rumor comes true.** A story written as a rumor of the magpie's gets an entry of its vendor's own within
  its topic's 72 hours: the pipeline reads the vendor's page for facts, which join the story's, and writes
  one UPD for every chat that heard the rumor — «Сорока, виявляється, не брехала. Але першою сказала я» with
  the one or two facts the rumor did not have — as a reply to its news, with the link to the vendor's page.
  `Write Crow Rumor Update` (≈ $0.0005, paid by the pipeline's budget). It counts in the chat's limits and
  rings as news does; it waits 12 hours at most for a chat that keeps the crow quiet.

## The weekly digest

On **Friday at 18:00** in each chat's zone ([weekly.ts](../../src/crow/weekly.ts)); after a downtime until
21:00, then the week goes without. One post, «🗞 Воронячий дайджест тижня»:

- the crow's word about the week and **the winner of the week** — a company, a model or a game of the week's
  news, «🏆 Переможець тижня — **Claude Opus 5.5**: …» — which the model picks by the news and by what the
  cats talked about (`Write Crow Weekly Digest`, the text model, ≈ $0.008); checked as an arc message is, the winner one of
  the week's news; when it still fails, a plain word goes instead and no winner;
- how the last vote went, «🗳 Минулого разу ви обрали: **…** — 4 голоси», from `stopPoll` of the last vote;
- the smartest cat of the month by the bets, «🧠 Найрозумніший кіт місяця — Олег: 3 з 4 ставок»;
- a table of the week's shiniest news, five at most — the news, the day in words («у вівторок», not a
  `date_time`: to a day the zone hardly matters), the cats' replies to her posts of it (💬) — each name a
  link to her post that brought it. Ranked by importance, a reply counting half a point, ten at most.

Under it, a separate **anonymous poll** for the best news of the week, an option per story, named by its hero —
with the day where two share a name, and a number where they share the day too; the next digest stops it and
tells the result. Only the stories that went out in this chat count, and a week without them
has no digest. It is not news: the limits neither count nor stop it; it rings as news does and waits until
midnight.

## Birthday

A year after her first post in a chat, and every year after, the crow has her birthday there
([birthday.ts](../../src/crow/birthday.ts)) — the year's review, as the services make one: on the day of her first
post (`crow_chat.firstPostAt`; the 28th of February for one born on the 29th), at 12:34 of the chat's zone, one post.

- **«🎂 1 рік у цьому чаті»** and her word on the year (`Write Crow Birthday`, the text model, one call a year,
  ≈ $0.006): one or two of its figures played up, no cat named, every number from the figures; a word failing its
  checks after the rewrite gives way to a plain one.
- **The cats' awards**, each cat mentioned as in the jabs — by name only when she is restrained: 🗣 the one she
  talked to most (her replies, chime-ins and «я ж казала» to them), 🔇 the one who pressed «Кш!» most, 🎯 her
  favourite target of the jabs, 🔮 the best bettor of three bets or more. A cat who asked «🙅 Не чіпай мене» gets
  none, and nor does one gone from the chat: the names are Telegram's of the day.
- **📰 The news of the year** — the story the cats replied to most, a link to her post of it — and **🗳** the
  weekly vote's winner with the most votes.
- **The table of her year** («Мій рік»): the news she brought, the 🐦‍⬛ in front of her posts, her hero — the hero
  of the most stories, two or more — the busiest month, the rumors and how many came true, «я ж казала», the bets
  and how many she guessed, the streams, the quizzes; a row that would be nought is left out, eight at most.

The year is the twelve months before the moment, in the chat's zone; the crow's posts, stories and polls are kept
400 days for it. A year she brought the chat no news goes without. It is not news: the limits neither count nor
stop it; it rings, carries no «Кш!» — a birthday is no news to shoo away — and waits twelve hours.

## Bets

A bet on a dated event of a story ([bets.ts](../../src/crow/bets.ts)): «🐦‍⬛ Чи вийде GTA VI 19 листопада?».

- **Proposed once per story**, after its arc, by the talk model (`Write Crow Bet`, ≈ $0.0004, or ≈ $0.0001
  for «none», which most stories get): a question, 2–4 options in her voice, the option she bets on herself —
  on the hero's side — and the day. The code keeps it only if the day is 2 to 92 days ahead and a fact of the
  story names it («19 листопада», or the month of a deadline at its end), so nothing is made up. A rumor gets
  no bet.
- **In the chat's chain of the arc**, after its first three posts, if the chat has no bet going and had fewer
  than two in the week; checked again before it goes. A **non-anonymous poll** in the arc's thread, with the
  crow's pick in its description; the cats' votes come as `poll_answer` and are kept. Betting closes when the
  day begins in the chat's zone — Telegram closes a poll of up to 30 days by itself, the crow stops a longer
  one.
- **The outcome**, at noon of the day after: `OPENAI_CROW_MODEL` reads the news of the bet's categories since
  the bet (`Resolve Crow Bet`, ≈ $0.0001) and says the option that came true, a cancelled event, or that it
  cannot tell. Sure — the crow tells it as a reply to the poll, praising the winners and teasing the rest,
  «я ж казала ще тиждень тому» when she guessed (`Write Crow Bet Outcome`, the text model, ≈ $0.006), with a table of who
  bet on what: each cat mentioned as the jabs are — by name only when she is restrained — and the cats who
  opted out left out. A cancelled event calls the bet off with a jab at the culprit. Unclear — the owner is
  asked in the private chat, with an option each and «🚫 Скасувати ставку»; a week without an answer, or no
  owner, calls it off in a word of her own.
- **Streaks**, under a sure outcome, by the code: a cat who has guessed three bets or more in a row, counting this
  one — «🔥 Макс: 3 ставки поспіль у яблучко.» — or whose streak of five or more this one broke — «💔 Олег: серія з 5
  вгаданих обірвалася.» — mentioned as in the table; and the crow's own the same way, «🔥 А я вгадала 3 поспіль.». A
  bet called off, or one a cat did not place, neither counts nor breaks a streak.

## Streams

The crow announces the streams of the chat's categories ([events.ts](../../src/crow/events.ts)): State of
Play, Nintendo Direct, the labs' launches.

- **Where from** ([streamSources.ts](../../src/crow/sources/streamSources.ts)): the YouTube channels of
  PlayStation, Nintendo of America, Xbox, OpenAI, Google and Anthropic — a new video goes to the YouTube Data API
  once, and an upcoming live stream (not the premiere of a recorded video) with a show's name gives its
  `scheduledStartTime`; and the organizers' own announcements — the PS Blog's State of Play feed, Xbox Wire's
  Showcase feed, the page Nintendo points at its current Direct — whose time and zone the model reads (`Extract Crow Stream`,
  ≈ $0.0001), turned into a moment with the zone's summer time. Two sources of one show — one category,
  starts within 3 hours — are one stream, and YouTube's start wins. Without `YOUTUBE_API_KEY` only the
  announcements work: the channels are read through the API.
- **The posts**, a week ahead at most: the announcement — the day and time as a `date_time` with how far off,
  «четвер, 10 вересня, 16:00 (через 2 дні)», and «📺 Дивитися:» — goes at the chat's next turn, no later than
  45 minutes before the start; the reminder, half an hour before, as a reply to it. A stream in the chat's
  quiet hours is reminded of in the evening, an hour before they begin, ahead of the goodbye: «поки ви
  спатимете, о 03:00…». The texts are written once for every chat (`Write Crow Stream`, ≈ $0.0003), plain
  ones when the model's fail. Neither is news: the limits neither count nor stop them.
- **Moved or called off:** YouTube's schedule is checked again every 6 hours, every 20 minutes in the last
  two. A moved start edits the announcements sent already and moves the reminders; a stream gone from
  YouTube calls its posts off, and its announcements say «❌ UPD: ефір скасували».

## Game news

The game categories hear the press, the platforms' own channels and the stores' lists
([pipeline.md](pipeline.md#game-stories)). A game news is one story however many publishers wrote of it, and it
reaches the chats once enough of them did — three for a platform, two for GTA VI and the freebies — so the chat
hears what the press is talking about, not every post of one site; five publishers within three hours make it a
mega news. A platform's own post of a notable news and a store's own list go at once. Its arc has no comparison
with a competitor: the roster is the labs' models.

- **PS Plus: «прийдуть» and «покинуть» are two stories.** The announcement of the monthly games (🎮 Плойка and
  🆓 Халява) or of the catalog (🎮 Плойка) on the PlayStation Blog is one; its games come to the Ukrainian store on
  the first or the third Tuesday of their month. The games leaving the Extra and Deluxe catalog are another, from the
  Ukrainian store's own list, with the day they leave on.
- **A store's list is shown whole.** The opening of a list — the monthly games, the catalog, the games leaving
  PS Plus, Game Pass's batch, Epic's giveaway — carries a table of every game of it, «Гра | Платформи», and a
  gallery of their pictures, a slide a game with its name (a `slideshow` of up to 30), in place of the story's one
  picture: the arc's text may name only the biggest games. A giveaway's games — Epic's, GamerPower's — are links to
  their store pages, with a «Ціна» column: the price before struck out, the one now in bold, «~~459 ₴~~ **0 ₴**»
  (Epic's in hryvnias, GamerPower's worth in dollars); a game that is free anyway has the link and no price.
- **Reminders.** A story of games that come or go gets one more post, a reply to its news in the chat, at its
  moment: «вже можна забирати» the day the games of PS Plus come; the last day of a giveaway, 24 hours before it
  ends; the last days of a game leaving PS Plus, three days before. Where it ends, it says how long is left as a
  `date_time`, and it links where to take the games. Written once for every chat (`Write Crow Reminder`), it
  rings, is outside the limits, and goes only to a chat that heard the story; one due during the quiet hours
  waits for their end until its games are gone.
- **The freebies:** the Epic Games Store's giveaway of the week — its games, their prices in the Ukrainian store,
  the next week's games — GamerPower's giveaways of the stores the chat uses, worth ten dollars or more, the
  monthly games of PS Plus Essential and the games new to Game Pass.
- **🟩 Бокс** hears Pure Xbox, Xbox Wire and Game Pass's own lists: the games new to it (🟩 Бокс and 🆓 Халява)
  and those leaving it soon are a story each, the batch of games that came or go together; **🖥 Пекарня** — PC
  Gamer, Rock Paper Shotgun and Steam's own news: its sales and fests, Steam Deck, Steam Machine, Steam Frame,
  Deadlock, Half-Life; **🏴‍☠️ Хакерня** — GBAtemp, Time Extension and the scene, where one publisher is enough,
  since the press seldom writes of a jailbreak or an emulator: console hacks, homebrew, emulators, leaks of code
  and firmware — never a link to piracy. r/GamingLeaksAndRumours brings the magpie's rumors to every category:
  Reddit is one publisher, so a leak reaches a chat once the press takes it up.
- **📅 Реліз-радар** — a delay or a date of a notable game is a post of its own, from two publishers; the week's
  releases come on Monday ([below](#the-release-radar)).
- **GTA VI** until its release on 19.11: every post of its arcs ends with «⏳ До релізу — 52 дні», and its
  countdown goes to every chat that hears it ([below](#countdowns)). From the release on, the hunters' finds of its
  mysteries on Reddit are told once the press confirms them.

## Countdowns

A big release gets a countdown ([countdowns.ts](../../src/crow/countdowns.ts)): a post of its own in every chat of
its categories on the Fibonacci days before it — 55, 34, 21, 13, 8, 5, 3 and 2 days, one post each, at 11:11 of
the chat's zone — and two on the last day, since the series has 1 twice: at 11:11 and at 19:37. A post is planned an
hour before its minute, so it goes at the minute, not at the job's half-hourly turn, unless the quiet hours or the
gap after her last post hold it; a bot that was down plans only the latest slot whose time came. The days are counted
to the release's calendar day in the chat's zone (`/timezone`, UTC without it). A post is not the bare number but
a fresh fact of the game's news of the last two weeks (`Write Crow Countdown`, the text model), written once for
every chat and checked: the number of days in it (on the last day it may say «завтра»), every other number from its facts, 400 characters at most, one
rewrite. It is outside the limits; a chat that was quiet at the hour gets it once it is not, the same day. The
posts of the arcs of the countdown's categories end with how long is left, «⏳ До релізу — 52 дні», until the day.

A countdown is an entry of `COUNTDOWNS`, not code: the game as the posts name it, its day, the categories that
hear it, the stories its posts take facts from (a category and, for a game with no category of its own, a pattern
of its title) and whether the arcs carry the line. A mark already past when the entry comes is skipped.

## The release radar

On Monday, from 11:00 of the chat's zone, a chat that hears 📅 Реліз-радар gets the week's notable releases
([releases.ts](../../src/crow/releases.ts)): «📅 Реліз-радар тижня», her word on the biggest of them, and a table —
«Гра | Де | Коли», a game a row, «вт, 29 вересня», eight at most. The model reads them from the roundups of the
week published before it — Xbox Wire's «Next Week on XBOX» whole, with every game and its day, and the leads of
Push Square's and Pure Xbox's weekly guides, whose pages the bot cannot read (`Extract Crow Releases`,
`OPENAI_CROW_MODEL`); each roundup is labelled with its platforms, so a game of several is shown on all. A day
the roundups do not name is not guessed, and a release outside the week is left out. Her word (`Write Crow
Release Radar`, the text model) holds to the table's numbers, or a plain one goes instead. One post a week for
every chat, prepared once; a week without roundups goes without. It is not news: the limits neither count nor
stop it.

## Quizzes

A mega story that is not a rumor gets a quiz on the facts of its opening, which every chat hears first: a
question after her 🐦‍⬛ (the code puts it there, as before a bet's), three or four answers of one form, one right,
and the crow's word shown after an answer — «🐦‍⬛ 20%, котику. Я казала це двічі.» (`Write Crow Quiz`, the text
model, checked: the question, the right answer and her word hold to the facts, the wrong ones may not). It goes as
an anonymous quiz poll with its options shuffled, in the arc's thread, in the second half of a chain of five posts
or more, never last; it counts in the limits as the arc does and is optional, so a chat over its daily limit loses
it first.

## `/crow`

`/crow` answers with an **ephemeral** menu: only the caller sees it, and the buttons edit it with
`editEphemeralMessageText`. If Telegram refuses the ephemeral message, a regular one goes to the chat. In a
private chat the crow answers that she only caws in groups.

A cat has one menu open in a chat (`OpenMenus`): calling `/crow` again deletes the previous one, or at least
takes its buttons off, since it would go on showing the settings as they were. A button of a replaced menu
answers «Це меню застаріло — відкрий свіже: /crow». The open menus are kept in memory; after a restart the
first menu pressed becomes the open one.

| Button | What it does |
| --- | --- |
| ✅ / ⬜ category | Subscribes the chat to a category. **Without subscriptions the crow is silent** in the chat |
| 😈 Наглість | Steps through the boldness levels below. The button, on a row of its own, shows the level in crows: «😈 Наглість: 🐦‍⬛🐦‍⬛ Нагла» |
| 🌙 Тиша | Switches the quiet hours between 23:00–10:00 (the default) and off. The button, on a row of its own, names the zone they are counted in: «🌙 Тиша: 23:00–10:00 Київ», or «… UTC» |
| 🕰 Задати часовий пояс | Shown while the quiet hours are on and the chat has no zone: posts the [`/timezone`](../timezone.md) picker into the chat |
| 🔇 Заткнись на 3 год / 🔊 Досить мовчати | Snoozes the crow for 3 hours, or ends the snooze |
| 🎯 Підколки: увімк. / вимк. | The jabs for the whole chat; off, the profile is forgotten |
| 🙅 Не чіпай мене / 🙋 Можна мене чіпати | The caller's own: the crow neither reads them for the profile nor names them. Not stopped by the admin lock |
| 🔒 / 🔓 Тільки адміни | Shown to admins only: after it only admins change the settings |

Admin status comes from `getChatMember` and is trusted for 5 minutes. Each button answers with a toast in
the crow's voice.

**Quiet hours and "today" are counted in the chat's time zone**, which the chat sets with the separate
command [`/timezone`](../timezone.md). The bot does not guess where a chat lives: until the zone is set,
they are counted in **UTC**. The menu then says so, the quiet hours button reads «🌙 Тиша: 23:00–10:00
UTC», and «🕰 Задати часовий пояс» posts the command's region picker into the chat; if that fails, the
toast tells the cat to run `/timezone`. Once the zone is set, the button names its city instead
(«🌙 Тиша: 23:00–10:00 Київ»; a zone with no button of `/timezone` shows the last part of its name).

### Boldness

| Level | Posts per story | Posts per hour | Posts per day | Rings for | «Кш!» takes |
| --- | --- | --- | --- | --- | --- |
| 🐦‍⬛ Стримана (restrained) | ×0.5 | 3 | 12 | the news of mega stories | 2 cats |
| 🐦‍⬛🐦‍⬛ Нагла (bold, the default) | ×1 | 6 | 24 | the news of every story | 2 cats |
| 🐦‍⬛🐦‍⬛🐦‍⬛ Заєбуча (pestering) | ×1.5 | 8 | 36 | every post | 3 cats |

Over the hourly limit only the news of a mega story gets through; over the daily limit the optional posts
are dropped and only the core of mega stories goes on. At least 5 minutes, plus up to 3 at random, pass
between any two posts in a chat.

## Categories

The posts a story gets at «Нагла», by its importance (3 — mega, 2 — notable, 1 — a trifle), and the time
the arc is spread over. A chat never gets more than the category's maximum, whatever its boldness.

| Category | Menu caption | Importance 3 | Importance 2 | Importance 1 | Max |
| --- | --- | --- | --- | --- | --- |
| 🤖 AI Enterprise | флагманські моделі | 12 over 30 h, 3 of them in the first 20 min | 6 over 12 h, 2 in 15 min | 2 over 4 h | 16 |
| 🦙 AI Homebrew | відкриті моделі | 3 over 8 h | 2 over 4 h | 1 | 3 |
| 🧑‍💻 Вайбкодинг | Claude Code, Codex, Cursor | 2 over 6 h | 2 over 4 h | 1 | 2 |
| 🎮 Плойка | PlayStation і PS Plus | 4 over 8 h, 2 in 15 min | 2 over 4 h | 1 | 6 |
| 🍄 Нінтендо | Nintendo і Switch 2 | 4 over 8 h, 2 in 15 min | 2 over 4 h | 1 | 6 |
| 🆓 Халява | безкоштовні ігри | 2 over 48 h | 2 over 48 h | 1 | 2 |
| 🌴 GTA VI | відлік до 19.11, from the release — таємниці та пасхалки | 6 over 12 h, 2 in 15 min | 3 over 6 h | 1 | 8 |
| 🟩 Бокс | Xbox і Game Pass | 4 over 8 h, 2 in 15 min | 2 over 4 h | 1 | 6 |
| 🖥 Пекарня | ПК і Steam | 4 over 8 h, 2 in 15 min | 2 over 4 h | 1 | 6 |
| 📅 Реліз-радар | релізи тижня й переноси | 1 | 1 | 1 | 1 |
| 🏴‍☠️ Хакерня | взломи, емулятори, хоумбрю | 2 over 6 h | 1 | 1 | 2 |

Every category has its sources ([pipeline.md](pipeline.md#sources)). A story that belongs to several categories
is heard with the cadence of the subscribed category that allows the most posts. An open model or a release of a coding tool is worth a post or two, not a day of pestering: the
maximum of AI Homebrew and Вайбкодинг holds at any boldness.

## What the crow never does

- Changes member tags, forum topics, the chat's title or settings: the admin owns them.
- Reacts to its own messages: the toxicity reactions and the crow are one bot.
- Writes in a chat that has not subscribed to anything.
- Answers a command or a bot, or talks about a forwarded post — to one, she only says «я ж казала»; talks in
  the quiet hours, under «Заткнись» or after «Кш!».
- Names a cat who pressed «🙅 Не чіпай мене» — in jabs, «я ж казала», bets and the smartest cat alike — or keeps
  anything but games and tech in a profile.

**The owner** (`TG_OWNER_ID`) hears, in the private chat with the bot — never in a group — and at most
once a day, when the crow's daily budget (a UTC day) is spent — what was spent, the stories waiting, the posts still planned — with
«🔄 Скинути бюджет» and «▶️ Запустити конвеєр» under it; and when OpenAI's balance is empty, with
«▶️ Запустити конвеєр» for after the top-up ([pipeline.md](pipeline.md#budget-and-pictures)).
