# pi-reply-thread

Keep track of the replies one prompt produces in a [Pi](https://github.com/earendil-works/pi) or
Gentle Shell session.

An agent often answers a prompt more than once: it replies, a background job or a subagent finishes,
it replies again, another job finishes, a third reply arrives. By the third reply, the question the
first one asked you has scrolled away. `pi-reply-thread` groups every reply under the prompt that
started it, says what triggered each one, and gathers the questions still waiting on you in one
place, where you answer them by pasting a quote.

```
╭─ Replies ──────────────────────────────────────── 3 prompts · 6 replies ─╮
│ ▌P12  look for something like this                                 12:04 │
│ ›├ P12.R1  a1b2c3d4  prompt        ⚠ I found two options. Which one…     │
│  ├ P12.R2  e5f6a7b8  job: tests                                          │
│  └ P12.R3  c9d0e1f2  worker: docs                                        │
│ ▌P11  clean up the old branches                                    11:40 │
│  └ P11.R1  77aa01bc  prompt        ✓                                     │
╰─ ↑↓ move · enter open · esc close ───────────────────────────────────────╯
```

- No extra model call. Everything is computed from the session branch.
- Nothing enters the model context.
- Works after `/resume` and on any branch, because the index is rebuilt from the branch every time.

Which questions count as asks? See [How asks are found](#how-asks-are-found): when a reply has a
`## Needs your decision` section, only that section counts by default.

## Install

```sh
pi install git:github.com/daniel2010001/pi-reply-thread
```

Or try it for one session from a clone:

```sh
pi -e ./extensions/reply-thread.ts
gsh -- -e ./extensions/reply-thread.ts   # Gentle Shell
```

## Use

| Command | What it does |
|---|---|
| `/replies` or `Alt+R` | Opens the overlay on **Pending** while any ask is open, else on **Replies** (the index of the current branch, newest prompt first). `Tab` cycles Pending → Replies → Answered. |
| `/replies pending` | Opens the **Pending** tab, even when nothing waits. |
| `/replies P12.R1` | Opens one reply in full by its ordered ID (case-insensitive). |
| `/replies a1b2c3d4` | Opens one reply in full by its entry ID. |
| `/replies P12.R1.Q2` or `/replies a1b2c3d4.2` | Opens the reply that asks that question. |

In the index, `↑`/`↓` move, `Enter` opens a reply, `Esc` closes. In the reply viewer, `↑`/`↓`
scroll, `PgUp`/`PgDn` or `Space` page, `Home`/`End` jump, and `Esc` or `q` goes back. A reply
opened by ID closes on `Esc`. In any tab, `?` shows a card with every key; `?` or `Esc` hides it.
Its last line names the ask mode in use (`Asks: decision section only` or `Asks: every question`).

Outside the interactive TUI (print or RPC mode), `/replies` and `Alt+R` send the index or the reply as plain
text (the index marks a reply `⚠` while it has an open ask and `✓` once all its asks are closed), and `/replies pending` sends the open asks, one per line (`P12.R1.Q1  a1b2c3d4.1  Which one do you prefer?`),
or `Nothing waits on you.`

### Reply IDs

Every reply has two IDs:

- **Ordered**: `P<prompt>.R<reply>`, for example `P12.R2` is the second reply to the twelfth
  prompt on the branch.
- **Unique**: the 8-character Pi session entry ID of the reply, for example `e5f6a7b8`.

### Triggers

Each reply shows what arrived since the previous one:

| Label | Meaning |
|---|---|
| `prompt` | Your prompt. |
| `job: <label>` | A background job finished (`bash_background`). |
| `monitor: <label>` | A monitor job reported or timed out. |
| `worker: <label>` | A subagent finished. |
| `session: <id>` | A message from another session. |
| `follow-up` | Nothing new arrived; the agent kept going. |

Gentle Agents wakes the session with a system-generated user message after a job or subagent ends.
That message is not counted as a prompt, so those replies stay under the prompt that started them.

## How asks are found

An **ask** is a line of a reply that waits on you. Which lines count depends on one thing: does the
reply have a **decision section**? That is a heading with a decision marker, such as
`## Needs your decision`, with at least one ask under it (up to the next heading).

| The reply | Default (`section`) | With `--reply-thread-asks all` |
|---|---|---|
| has a decision section | **Only that section**: each top-level list item, even without `?`, and each other line in it that ends with `?`. Questions elsewhere in the reply are not tracked. | Every question in the reply, plus the section's top-level items. |
| has no decision section | Every line that ends with `?` or holds a decision marker. | The same. |

For example, this reply:

```markdown
Tests are green. Should I also bump the version?

## Needs your decision

1. Merge `feat/x` into main?
2. Keep the old name
   - with a squash
```

- By default it has 2 asks, numbered like the items: `Q1` Merge `feat/x` into main?, `Q2` Keep the
  old name. The nested `with a squash` is part of item 2, not an ask.
- With `all` it has 3: the first line, `Tests are green. Should I also bump the version?`, becomes `Q1`,
  and the items become `Q2` and `Q3`.

### Why doesn't a question in the middle of a reply show up?

Because that reply has a decision section, and by default only the decision section counts: it is
where the agent says what it needs from you, and it keeps `Q1`, `Q2`… equal to the item numbers.
The reply viewer says when this happens, under the asks: `1 more question outside the decision
section is not tracked (--reply-thread-asks all tracks them).`

To track every question, start the session with the flag:

```sh
pi --reply-thread-asks all
gsh -- --reply-thread-asks all   # Gentle Shell
```

The values are `section` (the default) and `all`; any other value works as `section` and shows a
warning when the session starts.

### Detection details

- **Questions**: a line that ends with `?` (for example `Which one do you prefer?` or `¿Cuál preferís?`).
- **Decision markers**: `needs your decision`, `decision needed`, `waiting on you`, `waiting for you`,
  and the Spanish `necesito que decidas`, `necesito tu OK`, `necesito tu decisión`,
  `necesito tu confirmación`. A line with a marker is an ask; a marker inside double quotes (`"…"`,
  `“…”`, `«…»`) is only being mentioned and does not count.
- **Items**: a top-level list item (bullet or numbered, indented at most 3 spaces) in a section headed
  by a marker is an ask even without `?`. A nested item (indented 4 or more spaces, or under another
  item) is an ask only when it ends with `?`, and never in the default mode when the reply has a
  decision section.
- **Headings**: a heading that ends in `?` (`## Why not a model?`) titles a section and does not count.
  A marker heading counts only while its section has no ask of its own, so a decision section yields
  its asks and not its title.
- Code blocks, inline code, blockquotes and table rows are ignored.

Detection is deterministic: it can miss an ask phrased without a question mark outside a decision
section, and it can flag a rhetorical question.

In the index, a reply shows `⚠` and its first ask while any of its asks is still open, and `✓` once
all of them are answered or dismissed. The reply viewer lists the open asks under `⚠ Waits on you`
above the text, and the closed ones under `✓ Answered`, each with the prompt that answered it
(`→ P13`) or `dismissed`.

### Recommended agent instruction

Asks are easiest to catch when the agent gathers them in one place. Add this to your `AGENTS.md`
(`~/.pi/agent/AGENTS.md` for Pi, `~/.gentle-shell/agent/AGENTS.md` for Gentle Shell). The package
never adds it to the prompt by itself. Every item of the final section is an ask, and its `?` ends
the item, so any context goes before the question.

```markdown
## Questions for the user
When a reply needs anything from the user (a decision, a confirmation, an output, an action), end it
with a `## Needs your decision` section: a numbered list, one item per ask. Each item is one
question that ends with `?`: put any context before the question, never after it. One decision
per item: split "Do we do A and B?" into two items. Never leave an ask in the middle of the reply
or phrased without `?` ("Let me know when it is done" becomes "Can you tell me when it is done?").
Before writing the section, review the asks of your earlier replies in this conversation: drop the
ones the user already answered, even without quoting them, and repeat a still-open one word for
word instead of rewording it. Leave the section out when nothing is needed. Choices with fixed
options still go through `ask_user_question` when it is available.
```

## Pending asks

Every ask gets two IDs, like a reply:

- **Ordered**: `P<prompt>.R<reply>.Q<n>`, for example `P12.R1.Q2` is the second ask of `P12.R1`.
- **Unique**: `<reply entry ID>.<n>`, for example `a1b2c3d4.2`.

The **Pending** tab lists the asks still open, grouped under their prompt, newest prompt first. Asks
that look alike show as one row, on the newest of them (see [Repeated asks](#repeated-asks)):

```
╭─ Pending ────────────────────────────────────────────────────────── 3 open · 0 linked ─╮
│ ▌P2  look for something like this                                                12:01 │
│ ›○ P2.R1.Q1  I found two options. Which one do you prefer?                             │
│  ○ P2.R2.Q1  Should I delete the three old branches?  ≈ 1 similar                      │
│ ▌P1  clean up the old branches                                                   11:47 │
│  ○ P1.R1.Q2  Needs your decision: push to main.                                        │
╰─ enter answer · y yes · f format · ? help · esc close ─────────────────────────────────╯
```

| Key | What it does |
|---|---|
| `↑`/`↓`, `PgUp`/`PgDn` | Move. |
| `Space` | Marks or unmarks an ask (`●`; an unmarked ask shows `○`). |
| `Enter` | Answers the marked asks, or the selected one: closes the overlay and pastes a `> P2.R1.Q1: <ask>` quote per ask into the editor, with room for your answer (see below). |
| `y` | The same, with `Yes.` as the answer. |
| `f` | Switches the answer format between `R: lines` and `same line`; the `?` card shows the current one. |
| `x` | Dismisses the marked asks, or the selected one. |
| `o` | Opens the reply that asks it; `Esc` comes back. |
| `→` / `←` | Expands a row with `≈ N similar` to show its similar asks under it / collapses it again. |
| `l` / `u` | Links the marked asks (2 or more) as one chain, or the selected row and its similar asks to the oldest of them / unlinks the chain. |
| `Backspace` (`⌫`) | Undoes the last `x`, `l` or `u` (see [Undo](#undo)). |
| `Tab` | Goes to the next tab: Pending → Replies → Answered → Pending. |
| `?` | Shows a card with every key of each tab; `?` or `Esc` hides it. |
| `Esc` | Closes. |

The hint line names only `enter`, `y`, `f`, `?` and `esc`; the `?` card lists the rest.

The pasted text ends where you type, with no trailing newline. In the `R: lines` format (the default)
each quote gets an `R: ` line under it and the asks are apart by an empty line:

```
> P2.R1.Q1: I found two options. Which one do you prefer?
R: 

> P1.R1.Q1: There are three old branches. Should I delete them?
R: Yes.
```

In the `same line` format the answer follows the quote after `→ `, one ask per line:

```
> P2.R1.Q1: I found two options. Which one do you prefer? → 
> P1.R1.Q1: There are three old branches. Should I delete them? → Yes.
```

The format is stored as a `reply-thread.format` custom entry on the branch; the latest one wins.

An ask closes only explicitly:

- **Answered**: a later prompt of yours quotes it or cites its ordered or unique ID, which is what the
  pasted quote does. Gentle Agents wake messages do not count.
- **Dismissed** with `x`.

### Undo

A dismiss, link or unlink you did by mistake is one key away. `Backspace` (`⌫`), in the Pending and
Answered tabs, undoes the last action written since the overlay opened: a dismiss is reopened, a link
unlinked, an unlink linked again, and `r` (see [Answered asks](#answered-asks)) dismissed again. Press
it again to undo the action before that, newest first. One key is one step: `x` on several marked
asks, `l` on a group and `l` on marked asks each undo as a whole. `f` is not an action and is not
undone; with nothing left to undo, `Backspace` does nothing.

Undo never deletes: it writes the opposite `reply-thread.ask` entry, so the branch keeps both. The
steps last while the overlay is open; a new overlay starts with none, and `r` reopens an ask closed
earlier. (`Ctrl+Z` would be the usual key, but Pi uses it to suspend the app on Linux.)

A quote line, `> <ID>: <text>`, closes the ask whose text it carries: the open ask with the same text
(compared as for [repeated asks](#repeated-asks), case and punctuation aside), the one the ID names
when it has that text, else the newest one before your prompt. So a quote still closes the right ask
when its ID has changed since you copied it, for example after a reply was renumbered by its decision
section. In the `same line` format the text ends at the `→` before your answer. A quote with nothing
after the colon, or with a text no ask has, closes the ask its ID names; an ID outside a quote does
too.

### Repeated asks

Asks often come back in a later reply. Two open asks look alike when they have the same text after
lowercasing and dropping inline code and punctuation, or 60% of their words longer than 3 letters in
common. Asks that look alike, directly or through another one, form a **group**: the Pending tab shows
it as one row, on its newest ask, with `≈ N similar` for the N older ones, and counts it once in the
title. A linked chain joins a group by the text of its newest ask.

```
│ ›○ P4.R1.Q1  Should I delete the old branches?  ≈ 2 similar                            │
```

`→` expands the row: its similar asks show under it, newest first, as dimmed `≈` rows that you answer,
mark (`●`) and dismiss like any ask. `←` collapses it again.

```
│  ○ P4.R1.Q1  Should I delete the old branches?  ≈ 2 similar                            │
│ ›  ≈ P2.R1.Q1  Should I delete the three old branches?                                 │
│    ≈ P1.R1.Q1  There are three old branches. Should I delete them?                     │
```

**A group row answers only its newest ask.** A group is a display fold, never a link: it only tells
you the asks look alike, and closing an ask stays explicit. So answering or dismissing the row closes
its newest ask, and the next newest takes the row. To close the whole group at once, use one of two
ways:

- **`l`, then answer**: press `l` on the row (or one of its expanded asks) to link the group: every
  other ask continues the oldest one and the row becomes a chain, which closes as a whole.
- **`→`, then answer each**: expand the row and answer or dismiss its asks one by one.

The `?` card says the same under the group keys. To link asks that do not look alike, mark 2 or more
with `Space` and press `l`: each one continues the next older one, and the marks clear.

Linked asks form a chain, shown once on its newest ask with `↺ <older IDs>`; answering or dismissing
any of them closes the whole chain. `u` unlinks the newest ask from the chain.

#### Looks answered: `✓?`

An open ask that looks like an older ask you already answered or dismissed shows `✓? like <ID>`, dimmed, naming the newest such closed ask. A group row shows it when
any of its asks, hidden ones too, looks answered; an expanded ask shows its own. It comes after `↺`
and `≈ N similar`, joined by ` · `, and stays whole while the ask text is cut:

```
│ ›○ P4.R1.Q1  Should I delete the old branches?  ≈ 1 similar · ✓? like P2.R1.Q1             │
```

It uses a looser test than repeats: the asks share at least 40% of their words (longer than 3
letters), where a group needs 60%. An agent that asks again after you answered usually rewords more,
and a wrong hint costs little because it never folds or closes anything.

It is only a hint: nothing closes by itself. Answer the ask again, or press `x` to dismiss it.

When more than 10 prompts have open asks, the older ones fold into an `Older (N)` row; `Enter`
expands it.

Dismiss, reopen and link are stored as `reply-thread.ask` custom entries on the session branch (outside the
model context), so they follow `/resume` and branches like everything else.

### Answered asks

The **Answered** tab lists the closed asks, grouped under the prompt of their reply, newest prompt
first. Under each ask, `↳` names the prompt that answered it and the answer it gave, or `✕ dismissed`
says you dismissed it. A closed chain shows once, on its newest ask, with `↺ <older IDs>`. `↑`/`↓`
move and `Enter` or `o` opens the reply.

`r` reopens the selected ask, answered or dismissed, and every ask of a closed chain: it writes a
`reopen` entry for each, and the ask goes back to Pending, with `⚠` on its reply again. `Backspace`
undoes `r` by dismissing the asks it reopened, so an ask first closed by an answer shows as dismissed
then; either way it is closed again.

```
╭─ Answered ──────────────────────────────────────────────────── 1 answered · 1 dismissed ─╮
│ ▌P1  clean up the old branches                                                     12:00 │
│ ›✓ P1.R1.Q1  There are three old branches. Should I delete them?                         │
│    ↳ P3  Yes, all three.                                                                 │
│  ✓ P1.R1.Q2  Needs your decision: push to main.                                          │
│    ✕ dismissed                                                                           │
╰─ ↑↓ move · enter open · esc close ───────────────────────────────────────────────────────╯
```

The answer is read from the quote that closed the ask: the `R:` line under it, the text after `→` on
the quote line, or the first line after it that is not a quote. A prompt that cites the ID without a
quote, or has nothing after the quote, answers with its first line.

### Widget

A widget above the editor summarizes the latest prompt while it has two or more replies, with `⚠`
on each reply that still has an open ask, and counts the open asks like the Pending title (a chain or a group of repeats counts once) whenever
there are any:

```
P12 · 3 replies: R1 prompt ⚠ · R2 job: tests · R3 worker: docs · alt+r
⚠ 4 pending · newest: P12.R1.Q1 I found two options. Which one do you prefer? · alt+r
```

The summary clears when the next prompt starts; the pending line stays until every ask is answered
or dismissed. `Alt+R` opens the overlay.

## Themes

Every colour comes from the active Pi theme (frame `borderAccent`, prompts `userMessageBg`, selection
`selectedBg`, jobs and closed asks `success`, workers `customMessageLabel`, asks `warning`, marks `accent`, chains
`muted`, similar asks and `✓?` `muted`, scrollbar `scrollbarThumb`/`scrollbarTrack`), so the overlay
follows your theme, including Gentle Shell's.

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
```

To try the central without a real session, write a demo session with repeated asks and open it:

```sh
pnpm demo                      # prints the file it wrote and the command to open it
pi --session <file> -e ./extensions/reply-thread.ts
```

The session is in English: three prompts, a reply woken by a background job notice, and a
`## Why did it take so long?` section title that is not an ask. Its Pending tab has two rows with
`≈ 1 similar` to expand with `→` and link with `l`. Pi appends to the file when you use it, so write a new one for a fresh start.

## License

MIT
