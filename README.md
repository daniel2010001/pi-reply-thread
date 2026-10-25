# pi-reply-thread

Keep track of the replies one prompt produces in a [Pi](https://github.com/earendil-works/pi) or
Gentle Shell session.

An agent often answers a prompt more than once: it replies, a background job or a subagent finishes,
it replies again, another job finishes, a third reply arrives. By the third reply, the question the
first one asked you has scrolled away. `pi-reply-thread` groups every reply under the prompt that
started it, says what triggered each one, and keeps the replies that still wait on you in view.

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
| `/replies` | Opens the index of the current branch, newest prompt first. |
| `/replies P12.R1` | Opens one reply in full by its ordered ID (case-insensitive). |
| `/replies a1b2c3d4` | Opens one reply in full by its entry ID. |

In the index, `↑`/`↓` move, `Enter` opens a reply, `Esc` closes. In the reply viewer, `↑`/`↓`
scroll, `PgUp`/`PgDn` or `Space` page, `Home`/`End` jump, and `Esc` or `q` goes back. A reply
opened by ID closes on `Esc`.

Outside the interactive TUI (print or RPC mode), `/replies` sends the index or the reply as plain
text.

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
  `necesito tu confirmación`.

Code blocks, inline code, blockquotes and table rows are ignored. Detection is deterministic: it
can miss an ask phrased without a question mark, and it can flag a rhetorical question.

The reply viewer lists the open asks of a reply above its text.

### Widget

While the latest prompt has two or more replies, a widget above the editor summarizes them and names
the ones waiting on you:

```
P12 · 3 replies: R1 prompt ⚠ · R2 job: tests · R3 worker: docs · /replies
⚠ P12.R1 waits on you: Encontré dos opciones. ¿Cuál preferís?
```

It clears when the next prompt starts.

## Themes

Every colour comes from the active Pi theme (frame `borderAccent`, prompts `userMessageBg`, selection
`selectedBg`, jobs `success`, workers `customMessageLabel`, asks `warning`, scrollbar
`scrollbarThumb`/`scrollbarTrack`), so the index follows your theme, including Gentle Shell's.

## Develop

```sh
pnpm install
pnpm test
pnpm typecheck
```

## License

MIT
