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
│ ▌P12  buscá si existe algo así                                     12:04 │
│ ›├ P12.R1  a1b2c3d4  prompt        ⚠ Encontré dos opciones. ¿Cuál…       │
│  ├ P12.R2  e5f6a7b8  job: tests                                          │
│  └ P12.R3  c9d0e1f2  worker: docs                                        │
│ ▌P11  arreglá el widget                                            11:40 │
│  └ P11.R1  77aa01bc  prompt                                              │
╰─ ↑↓ move · enter open · esc close ───────────────────────────────────────╯
```

- No extra model call. Everything is computed from the session branch.
- Nothing enters the model context.
- Works after `/resume` and on any branch, because the index is rebuilt from the branch every time.

## Install

```sh
pi install git:github.com/<owner>/pi-reply-thread
```

Or try it for one session from a clone:

```sh
pi -e ./extensions/reply-thread.ts
gsh -- -e ./extensions/reply-thread.ts   # Gentle Shell
```

## Use

| Command | What it does |
|---|---|
| `/replies` or `Alt+R` | Opens the overlay on **Pending** while any ask is open, else on **Replies** (the index of the current branch, newest prompt first). `Tab` switches. |
| `/replies pending` | Opens the **Pending** tab, even when nothing waits. |
| `/replies P12.R1` | Opens one reply in full by its ordered ID (case-insensitive). |
| `/replies a1b2c3d4` | Opens one reply in full by its entry ID. |
| `/replies P12.R1.Q2` or `/replies a1b2c3d4.2` | Opens the reply that asks that question. |

In the index, `↑`/`↓` move, `Enter` opens a reply, `Esc` closes. In the reply viewer, `↑`/`↓`
scroll, `PgUp`/`PgDn` or `Space` page, `Home`/`End` jump, and `Esc` or `q` goes back. A reply
opened by ID closes on `Esc`.

Outside the interactive TUI (print or RPC mode), `/replies` and `Alt+R` send the index or the reply as plain
text, and `/replies pending` sends the open asks, one per line (`P12.R1.Q1  a1b2c3d4.1  ¿Cuál preferís?`),
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

### Replies that wait on you

A reply is marked `⚠` when one of its lines asks you something:

- the line ends with `?` (for example `¿Cuál preferís?`), or
- it contains a decision marker: `needs your decision`, `decision needed`, `waiting on you`,
  `waiting for you`, `necesito que decidas`, `necesito tu OK`, `necesito tu decisión`,
  `necesito tu confirmación`. A marker inside double quotes (`"…"`, `“…”`, `«…»`) is only being
  mentioned and does not count.

Code blocks, inline code, blockquotes and table rows are ignored. A heading that ends in `?` (`## Why not a model?`) titles a section and does not count; a decision marker in a heading (`## Needs your decision`) counts only while its section, up to the next heading, has no ask of its own, so a final section that lists the asks yields those asks and not its title. Detection is deterministic: it
can miss an ask phrased without a question mark, and it can flag a rhetorical question.

The reply viewer lists the open asks of a reply above its text.

#### Recommended agent instruction

Asks are easiest to catch when the agent gathers them in one place. Add this to your `AGENTS.md`
(`~/.pi/agent/AGENTS.md` for Pi, `~/.gentle-shell/agent/AGENTS.md` for Gentle Shell). The package
never adds it to the prompt by itself.

```markdown
## Questions for the user
When a reply needs anything from the user (a decision, a confirmation, an output, an action), end it
with a `## Needs your decision` section: a numbered list, one item per ask, each ending with `?`.
Never leave an ask in the middle of the reply or phrased without `?` ("Avisame cuando…" becomes
"¿Me avisás cuando…?"). Leave the section out when nothing is needed. Choices with fixed options
still go through `ask_user_question` when it is available.
```

## Pending asks

Every ask gets two IDs, like a reply:

- **Ordered**: `P<prompt>.R<reply>.Q<n>`, for example `P12.R1.Q2` is the second ask of `P12.R1`.
- **Unique**: `<reply entry ID>.<n>`, for example `a1b2c3d4.2`.

The **Pending** tab lists the asks still open, grouped under their prompt, newest prompt first:

```
╭─ Pending ────────────────────────────────────────────────────────── 4 open · 0 linked ─╮
│ ▌P2  buscá si existe algo así                                                    12:01 │
│ ›○ P2.R1.Q1  Encontré dos opciones. ¿Cuál preferís?                                    │
│  ○ P2.R2.Q1  ¿Borro las tres ramas viejas?  ≈ P1.R1.Q1                                 │
│ ▌P1  limpiá las ramas viejas                                                     11:47 │
│  ○ P1.R1.Q1  Hay tres ramas viejas. ¿Las borro?                                        │
│  ○ P1.R1.Q2  Necesito tu OK para pushear main.                                         │
╰─ enter answer · s sí · f R: lines · space mark · x dismiss · o open · tab replies · … ─╯
```

| Key | What it does |
|---|---|
| `↑`/`↓`, `PgUp`/`PgDn` | Move. |
| `Space` | Marks or unmarks an ask (`●`; an unmarked ask shows `○`). |
| `Enter` | Answers the marked asks, or the selected one: closes the overlay and pastes a `> P2.R1.Q1: <ask>` quote per ask into the editor, with room for your answer (see below). |
| `s` | The same, with `Sí.` as the answer. |
| `f` | Switches the answer format between `R: lines` and `same line`; the hint shows the current one. |
| `x` | Dismisses the marked asks, or the selected one. |
| `o` | Opens the reply that asks it; `Esc` comes back. |
| `l` / `u` | Links the marked asks (2 or more) as one chain, or the selected ask to its suggested repeat / unlinks the chain. |
| `Tab` | Switches to **Replies**. |
| `Esc` | Closes. |

The pasted text ends where you type, with no trailing newline. In the `R: lines` format (the default)
each quote gets an `R: ` line under it and the asks are apart by an empty line:

```
> P2.R1.Q1: Encontré dos opciones. ¿Cuál preferís?
R: 

> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?
R: Sí.
```

In the `same line` format the answer follows the quote after `→ `, one ask per line:

```
> P2.R1.Q1: Encontré dos opciones. ¿Cuál preferís? → 
> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro? → Sí.
```

The format is stored as a `reply-thread.format` custom entry on the branch; the latest one wins.

An ask closes only explicitly:

- **Answered**: a later prompt of yours cites its ordered or unique ID, which is what the pasted quote
  does. Gentle Agents wake messages do not count.
- **Dismissed** with `x`.

Asks often come back in a later reply. When an open ask looks like an older open one (the same text
after lowercasing and dropping inline code and punctuation, or 60% of their words longer than 3
letters in common), the row suggests it with `≈ <ordered ID>`. Nothing is linked until you press `l`.
To link asks the suggestion missed, mark 2 or more with `Space` and press `l`: each one continues the
next older one, and the marks clear.
Linked asks form a chain, shown once on its newest ask with `↺ <older IDs>`; answering or dismissing
any of them closes the whole chain. `u` unlinks the newest ask from the chain.

When more than 10 prompts have open asks, the older ones fold into an `Older (N)` row; `Enter`
expands it.

Dismiss and link are stored as `reply-thread.ask` custom entries on the session branch (outside the
model context), so they follow `/resume` and branches like everything else.

### Widget

A widget above the editor summarizes the latest prompt while it has two or more replies, and counts
the open asks (a chain counts once) whenever there are any:

```
P12 · 3 replies: R1 prompt ⚠ · R2 job: tests · R3 worker: docs · alt+r
⚠ 4 pending · newest: P12.R1.Q1 Encontré dos opciones. ¿Cuál preferís? · alt+r
```

The summary clears when the next prompt starts; the pending line stays until every ask is answered
or dismissed. `Alt+R` opens the overlay.

## Themes

Every colour comes from the active Pi theme (frame `borderAccent`, prompts `userMessageBg`, selection
`selectedBg`, jobs `success`, workers `customMessageLabel`, asks `warning`, marks `accent`, chains
`muted`, suggested repeats `mdLink`, scrollbar `scrollbarThumb`/`scrollbarTrack`), so the overlay
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

Its Pending tab has two `≈` suggestions to link with `l`, and a `## …?` section title that is not an
ask. Pi appends to the file when you use it, so write a new one for a fresh start.

## License

MIT
