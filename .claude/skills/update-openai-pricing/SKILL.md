---
name: update-openai-pricing
description: Refresh the MODEL_PRICING constant in src/services/openai.service.ts from the official OpenAI pricing page. Use when token costs look wrong or stale, when a new model must be priced, or when asked to update/check OpenAI prices.
model: haiku
effort: low
allowed-tools: Bash, Read, Grep, AskUserQuestion
argument-hint: '[--check] [--tier <tier>]'
---

# Update OpenAI model pricing

`MODEL_PRICING` in [src/services/openai.service.ts](../../../src/services/openai.service.ts) drives the token cost
logged for every OpenAI call. Refresh it by running the bundled script and walking the user through the decisions it
surfaces.

**Run every command yourself.** The user answers questions and nothing else — never print a command for them to paste,
never ask them to switch Node versions, and never hand-type a price into the file. The script is the only thing that
writes to the constant.

## Step 1 — resolve Node

The script needs Node >= 26. Check `node -v`; when it is older, prefix every later command with nvm instead of asking
the user to switch:

```bash
bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm exec --silent 26 node <args>'
```

If no Node 26 is available at all, say so and stop — that is a machine setup problem, not a pricing decision.

## Step 2 — inspect before writing

```bash
node .claude/skills/update-openai-pricing/scripts/update-pricing.ts --dry-run --json
```

The JSON gives everything needed to drive the conversation:

| Field           | Meaning                                                |
| --------------- | ------------------------------------------------------ |
| `updated`       | tracked models whose price moved — `{model, from, to}` |
| `newOnPage`     | priced on the page, absent from the constant           |
| `missingOnPage` | in the constant, no longer priced on the page          |
| `warnings`      | parser complaints — see "When to stop"                 |
| `changed`       | whether writing would alter the file at all            |

## Step 3 — stop if the parser complained

A non-empty `warnings` means the page's structure moved and the numbers cannot be trusted. Report the warning verbatim,
explain that it needs a fix in `scripts/pricing.ts`, and stop. Do not write the file and do not ask the user to choose
anything — there is nothing safe to choose between yet.

## Step 4 — ask, in one round

Price corrections to models already in the constant need no permission: that is the job. What does need a decision is
which models the bot should track at all.

Raise **one** `AskUserQuestion` call covering both lists, so the user answers once. Ask in the language the user is
writing in.

**When `newOnPage` is non-empty** — one question, `multiSelect: true`. The list is often long (the page prices models
back to `davinci-002`), and only 4 options fit, so group them and put the exact model ids in each option's
`description`:

- newest generation first (highest version numbers)
- then variants of families the constant already tracks
- then everything else, labelled as legacy
- always include a "don't add anything" option

State the total count in the question text so the grouping is not mistaken for the whole list. Anything not covered by
the options can still be typed into "Other".

**When `missingOnPage` is non-empty** — one question, single select, options "remove" and "keep". Explain the trade-off
in the descriptions: removing loses the ability to price historical calls to that model, keeping means the price is
frozen at whatever was last published and will silently drift.

Skip a question entirely when its list is empty. When both lists are empty, ask nothing.

## Step 5 — apply the model selection

Pass the exact selection; the flags take repeated values or a comma separated list. Never widen the user's choice to
`--add-new` or `--prune` on your own.

```bash
node .claude/skills/update-openai-pricing/scripts/update-pricing.ts --add gpt-5.6-sol,gpt-5.6-luna --remove o1-mini
```

Adding a model the page does not price fails loudly, so a typo from "Other" surfaces instead of silently doing nothing.
With no answer to act on and only price changes pending, run the script with no flags.

Placement is handled for you: an added model is filed by the rank the docs give it, so a new generation lands at the
top of the constant and an older model slots in beside its own generation. Each family is then ordered dearest first,
which is why `gpt-5-pro` sits above `gpt-5`, `gpt-5-mini` and `gpt-5-nano` even though the docs list it after them.
Nothing else is resorted, so a run that only refreshes prices touches only the numbers.

**If the run added anything, the next step is 6, not 7.** The `+` lines in the script's own report are
the trigger; step 7 is the last thing done either way, so reaching it is not a sign the work is over.

## Step 6 — compare the added models against the current one (required whenever step 5 added anything)

Not optional when models were added, and skipped entirely when none were. A new generation is often
cheaper than the one the bot runs on, and that is worth surfacing — but only against what was just
added, or the question turns into a standing nag to downgrade to a nano model.

```bash
node .claude/skills/update-openai-pricing/scripts/switch-model.ts --among <the models just added> --compare
```

`alternatives` lists only models that cost no more than the current one on input, cached input
and output. When it is empty, say nothing and move on.

**Show the table before asking.** `--compare` pulls each model's spec from the docs site and
prints the current model beside every candidate, so the choice is made on capability rather than
on price alone. Paste that table into the reply as-is, then add a sentence of your own reading of
it. What to look at, in this bot's terms:

| Row                   | Why it matters here                                                               |
| --------------------- | --------------------------------------------------------------------------------- |
| `describes images`    | `describeImage` sends an image; a text-only model breaks trends media analysis    |
| `obeys a schema`      | summarisation is pinned to a Zod schema through `zodResponseFormat`               |
| `reasons first`       | without reasoning tokens, topics bleed into one another in the summary            |
| `performance`, `tier` | the docs' own rating and where the model sits in its family                       |
| `context window`      | the summariser feeds up to 1000 messages in one request                           |
| `snapshot`            | a `(deprecated)` snapshot behind a current-looking alias is worth saying out loud |

The last lines of the table are each model's own description, which is often the only place that
says a model "roughly corresponds to the nano tier" — a real quality signal the ratings hide.

A candidate that answers `no` to any of the first three rows must not be offered as a swap at
all; report it as ruled out and why.

### Let the user decide how far to check it

The table rules candidates **out**; it cannot rule one **in**. Ratings tie (`gpt-5-mini` and
`gpt-5.6-luna` are both `3`) while the prose says one is a tier below, and nothing in the data
speaks to whether a model still keeps topics apart on this chat's material. Only running the real
prompts shows that — and it spends the user's own tokens, so whether it happens is the user's call,
not yours. Never start an A/B unasked.

Price it first, so the question can quote a number rather than a shrug:

```bash
node .claude/skills/update-openai-pricing/scripts/evaluate-models.ts \
  --baseline <current> --candidate <model> --runs 3 --dry-run
```

Then raise **one** `AskUserQuestion`. When more than one candidate survived, ask both questions in
the same call, so the user still answers once:

**Which model** — one option per candidate, up to three, in the order given: the list starts with
the smallest step down from the current price, which is the safest swap. Put the price, the saving
and the one capability difference that matters in each `description`, e.g. `0.2/0.02/1.2 per 1M,
−40% output, but a tier below`. Always include a "keep `<current model>`" option.

**How far to check it** — exactly these three, in this order:

| Option                        | What it buys                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| A/B over 3 runs _(recommend)_ | quote the call count from `--dry-run`; enough that a single break reads as noise        |
| A/B over 1 run                | a third of the cost, and catches outright breakage only — rejected parameters, refusals |
| Switch without testing        | price and the capability table only; nothing about output quality gets measured         |

**Three runs per model is the most this skill ever proposes.** The cost is
`(samples + images) × runs × 2` real calls, and past three the extra runs mostly re-confirm what
the first three already showed — a fourth run buys less than pointing `--samples` at real chat
history would. The user can still type a larger number into "Other"; run exactly what they typed,
but never put it in the options yourself.

With a single candidate, ask only the second question and name the model in its text. "Other" is
always there, so the user can also answer something none of the options cover — take that answer
literally rather than mapping it back onto the nearest option.

### Running the A/B, once the user asked for it

```bash
node .claude/skills/update-openai-pricing/scripts/evaluate-models.ts \
  --baseline <current> --candidate <model> --runs <what the user chose>
```

It sends the bot's own `SUMMARIZATION_PROMPT` and schema through both models on chat samples
built to provoke the prompt's hard constraints, then counts what each one broke — invented
message ids, one id cited from two sections, two sections saying the same thing, dateless events,
ids leaked into `fullSummary`. Every check is mechanical; no model judges another. It exits 1 when
the candidate broke something the baseline did not.

Watch for `failed calls` separately from the quality rows: a candidate can reject a parameter
rather than answer worse. `reasoning_effort` is the one that bites, and it is now set per use from
`OPENAI_REASONING_EFFORT` and `OPENAI_VISION_REASONING_EFFORT`.

**The effort ladders differ between generations, so the same string is not the same setting.**
gpt-5 models accept `minimal | low | medium | high`; gpt-5.6 accepts `none | low | medium | high |
xhigh`. The least-reasoning rung is therefore `minimal` on one and `none` on the other, and a model
handed a rung it does not have fails every call with a 400 — it does not fall back.

So run each side on its own equivalent rung rather than on a shared string, or the comparison
measures the setting instead of the model:

```bash
node .claude/skills/update-openai-pricing/scripts/evaluate-models.ts \
  --baseline gpt-5-mini --candidate gpt-5.6-luna \
  --baseline-vision-effort minimal --candidate-vision-effort none
```

List a model's supported values for free with the switcher's probe — it sends a deliberately
invalid value, and the API answers with the valid set and rejects the request before generating
anything:

```bash
node .claude/skills/update-openai-pricing/scripts/switch-model.ts --probe-efforts <model>
```

Run that before proposing a switch, and quote the rung the candidate would need in the question.

### Reporting the A/B, and asking once more

Report the outcome as evidence over N sampled runs, never as a guarantee — say so in those words.
Read the verdict's improvements and regressions **together**: a count that moves by one across
three runs is within a sampled model's noise, while a count that collapses from two dozen to zero
is not, and the script says as much under the table.

Paste the printed image descriptions, not only the counts. The checks are mechanical and therefore
blind to whether a description is _true_ — a model that names the wrong country still passes every
one of them. Reading them is the part only a person can do, so give them the text.

Then raise a final `AskUserQuestion`: switch to the tested model, or keep `<current model>`. If the
user wants a firmer answer than N runs gave, offer `--samples` pointing at an export of real chat
history — more material beats more runs, and the three-run ceiling stands.

Never claim the cheaper model is equivalent. The data covers price, modalities, ratings and
limits — and the A/B covers a handful of sampled runs on fixture material, not answer quality on
this chat's real traffic.

Apply the answer with the same script, which repoints every place that names the model — the two
runtime env files, the env template, the `ConfigService` fallback and the documented default:

```bash
node .claude/skills/update-openai-pricing/scripts/switch-model.ts --to <model>
```

Run it with `--dry-run` first if the report showed the locations disagreeing about the current
model; reconcile that before switching.

**The effort moves with the model, automatically.** After repointing, the script probes the target
for its accepted `reasoning_effort` values — free, by sending a deliberately invalid one — and
rewrites the paired variable in every location if the configured rung does not exist there.
`minimal → none` is a rename, not a change of setting: the two are the same rung under different
generations' names. Where no alias exists the script steps **up** a rung rather than down, because
too little reasoning is exactly the failure this bot has (topics bleeding together), and a quiet
degradation is worse than a slightly dearer call. Report every effort line it rewrote alongside the
model lines. `--keep-effort` leaves the variable alone if the user wants to tune it by hand.

`OPENAI_VISION_MODEL` is a **separate** variable that also defaults to the same model. Never
switch it as part of this flow: image description needs a multimodal model, and nothing on the
pricing page says which models qualify. Mention that it stayed as it was, and switch it only if
the user asks (`--variable OPENAI_VISION_MODEL`).

## Step 7 — verify and report

Run this last, after step 6 has been done or established as not applying. Writing the file is not the
end of the run — a successful write plus a clean lint is the easiest place to stop one step early.

```bash
npm run lint && npm run typecheck
```

Report the price moves as `model: old → new`, then what was added and removed, then whether lint and typecheck passed.
If nothing changed at all, say exactly that in one line.

## When to stop instead of pushing through

- **The fetch fails** after the script's own retries, or the URL returns something other than the pricing page.
- **The report looks implausible** — every model moving at once, prices shifting by orders of magnitude, or the model
  count collapsing. Show it and let the user judge.
- **The user wants another service tier written into the constant.** `MODEL_PRICING` documents itself as standard tier;
  changing that means changing the comment and the cost calculation that consumes it.

## Reference — how the numbers are found

The source is <https://developers.openai.com/api/docs/pricing>. The page is server-rendered but only ships the first few
rows of each table as HTML; the complete dataset lives in the `props` attribute of each `<astro-island>` element,
serialised in Astro's `[type, value]` hydration format. The script decodes those props, so it needs no browser and
survives visual redesigns.

Only tables pricing **text tokens per 1M** are read:

| Table                                                    | Supplies                                               |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `TextTokenPricingTables` (per service tier)              | the main model list, `gpt-5.6-*` down to `babbage-002` |
| `GroupedPricingTable` with Short/Long context headings   | the "Cyber models" section                             |
| `GroupedPricingTable` with `Category` + `Model` headings | `gpt-5.3-chat-latest`, `gpt-5.3-codex`, …              |

Image, audio, video, tool and fine-tuning tables use the same components with different headings, so they never match.
Rows lacking both an input and an output price (embeddings, moderation) and groups the page hides are dropped.

### Short context vs long context

The page splits by context window two different ways, and `--context` (default `short`) selects which side is used:

1. **By column** — the Cyber models table repeats every price column under a `Short context` / `Long context` heading
   group, spelled out in the data as `Short context input` / `Long context input`. Headings are matched after stripping
   that prefix.
2. **By row** — elsewhere the window is part of the model name, `gpt-5.4-pro (<272K context length)`. The suffix is
   parsed off and the bare id becomes the key.

The main text-token table is a third case: its data holds **short-context prices only**, because the long-context
figures on the page are derived at render time and never appear in the data. Its rows therefore count as short-context
unless their name says otherwise.

### Service tiers

`--tier` selects `standard` (default), `batch`, `flex` or `fast`. Some tables state their tier in their own data; others
exist once per tier as panels of a Standard/Fast switcher, where only the panel wrapper (`data-value="fast"`) says
which is which. A table outside any switcher is standard tier.

## Maintaining the script

Only relevant when a warning says the parser drifted, or when adding a table.

```bash
node --test .claude/skills/update-openai-pricing/scripts/pricing.test.ts
npx tsc --noEmit -p .claude/skills/update-openai-pricing/scripts
```

`scripts/pricing.ts` is pure — parsing plus source rewriting; `scripts/update-pricing.ts` adds arguments, fetching, file
I/O and the report. Tests run against [fixtures/pricing-page.html](fixtures/pricing-page.html), a trimmed real snapshot
whose island tags are verbatim, so they exercise the true serialisation format. That file's header explains how to
refresh it. Note that fixing the parser needs a file-editing tool this skill does not carry: hand it back as a separate
task rather than trying to patch it from here.
