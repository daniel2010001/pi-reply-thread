# Changelog

## 0.4.0 (2026-11-20)

- A pasted quote whose answer is empty (`R:` with nothing after it, or nothing after the `→` in the
  same-line format) no longer closes its ask when you send the prompt, neither by its text nor by the
  ID on it; fill in only some of several pasted asks and only those close. Quotes without an `R:`
  line or `→`, and IDs mentioned outside a quote, close as before. In the draft such a quote still
  counts, so a fresh paste keeps its `✎` and is not pasted twice.
- The pause card shows the context the agent wrote with an `ask_user_question` or `ask_user_choice`
  call (the text of that same message) above the question, rendered as Markdown like the reply viewer
  (tables, code, emphasis, lists); on a short screen its rendered lines are cut first,
  down to `… context above the question cut to fit`. Answered rows, the viewer and question IDs do not
  change; other dialogs have no context.
- Answering from the central while the editor already holds text starts the paste on its own
  paragraph (a blank line before it in the `R:` format, a new line in the same-line format), so asks
  pasted one at a time no longer run together after the previous `R: `.
- Draft marks: an open ask your unsent editor text would close (its quote or its ID) shows `✎` in
  Pending, the title adds `· N in draft`, and `Enter`/`y` do not paste it again; when every ask to
  answer is already in the draft, the overlay closes without pasting. The `?` card explains `✎`.
- The overlay reopens where you left it: each tab selects the same ask or reply, or the row that took
  its place after it closed. Kept in memory, forgotten on session start and on reload.
- Loose answers show up: when your prompt answers the previous reply's `## Needs your decision`
  items by number (`1: yes`, `2. later`, `3) no`), each line becomes a `✦ answered in P#: "<text>"`
  proposal on that item's ask, with no model call and nothing written; `a` accepts, `n` rejects,
  `Backspace` undoes, as with triage proposals. `section` mode only; quotes and `R:` lines are not
  read. The widget's pending line adds `✦ N look answered` while N open rows have a proposal.
- Dialogs that pause a turn (`ask_user_question`, `ask_user_choice`) show up as closed asks of the
  reply that ends the turn, numbered after its own asks, with the answer you chose: `↳ chose: …` in
  Answered, `→ chose: …` in the viewer. Reply and existing question IDs do not change.
- Other dialogs shown while a tool runs (a command guard's confirm, a review consent) are recorded as
  `reply-thread.pause` entries (title, tool and, for `bash`, only the program name) and show up the
  same way, closed with the tool's outcome: `ran`, or `stopped: …` when the tool failed.
- `Enter` or `o` on a dialog's ask in Answered opens a pause card: the question, the options with the
  chosen ones marked `✓`, `Chose: …`, the tool, and the reply that ended the turn; `o` there opens
  that reply and `Esc` goes back. Pauses now keep their tool and option labels.

## 0.3.0 (2026-11-17)

- With pi-reply-reader loaded, `s` reads aloud from the overlay: the whole reply in Replies and the
  reply viewer, only the selected ask in Pending and Answered. The overlay stays open; the `s read`
  hint and the `?` lines show only while the reader answers the `reply-reader:ping` on Pi's event bus.
  Install it with `pi install npm:pi-reply-reader`; while a reading plays, the first `Esc` stops it.

## 0.2.0 (2026-10-26)

- `/replies triage` (optional, TUI only): after a confirm that names the model, the number of open
  asks and later prompts and their rough size in tokens, the session model proposes which open asks a
  later prompt already answered and which ones repeat another. `Esc` cancels the call. Only proposals
  that hold up are kept, in a `reply-thread.triage` entry, and Pending opens with a `✦` line under each
  row that has one (`✦ answered in P2: "<quote>"` or `✦ same as P1.R1.Q2  <ask>`, `+N more`).
- Nothing closes or links by itself: `a` accepts the row's first proposal (an answer with the quote, or
  the link `l` writes), `n` rejects it so it does not come back, and `Backspace` undoes both. The `?`
  card lists `a` and `n`.
- The triage also runs as `/replies:triage` (easier to find in the command list) and with `t` in the
  Pending tab, which closes the overlay, runs it and reopens Pending with the proposals; the short
  hints show `t triage` and the `?` card lists it.
- The triage works through `pi-claude-bridge`: it sends your session's system prompt unchanged (the
  bridge rejects any other) and puts its instructions in the message. The confirm's token estimate
  counts that system prompt too (`with your session's system prompt`).
  It is the system prompt of the latest turn (the idle one lacks what extensions add per turn, and the
  bridge refuses it); before any turn since loading, a bridge failure says to send a prompt first.
- `a` on a group row (`≈ N similar`) no longer accepts the proposal for its newest ask only: the first
  `a` opens the group and the hints show `a close all N with this answer · esc cancel`; the second
  closes the whole group with that proposal (an `answered` one closes every ask of the group, a `same`
  one joins the group and the other row in one chain), as one step `Backspace` undoes. `Esc` or any
  other key cancels. On an ask of an opened group or a single row, `a` acts at once as before. The `?`
  card says so.

## 0.1.0 (2026-10-26)

- Group every final reply of a session branch under the prompt that started it, with an ordered ID
  (`P12.R2`) and a unique ID (the session entry ID).
- Label what triggered each reply: the prompt, a background job, a monitor, a subagent or another
  session. Gentle Agents wake messages are not counted as prompts.
- Mark the replies that wait on you: lines that end with `?` and decision markers, outside code,
  quotes and tables. A marker inside double quotes is only mentioned and does not count, a heading
  that ends in `?` is a section title, and so is a marker heading (`## Needs your decision`) with
  asks under it. Every top-level list item of a marker section is an ask, even without `?`; nested
  items are not.
- `/replies` opens a themed index of the branch and a full-reply viewer; `/replies <P#.R# | entry ID>`
  opens one reply directly; `Alt+R` opens the index without typing. Plain-text output outside the TUI.
- A widget above the editor summarizes the latest prompt while it has two or more replies, and counts
  the open asks with the newest one (`⚠ N pending · newest: <ID> <ask> · alt+r`).
- Pending central: every ask has an ordered ID (`P12.R1.Q2`) and a unique ID (`a1b2c3d4.2`);
  `/replies` and `Alt+R` open on a **Pending** tab while any ask is open (`Tab` switches to the
  index). `Enter` pastes `> <ID>: <ask>` quotes to answer the marked or selected asks, with an
  `R: ` line under each (`R: lines`, the default) or `→ ` on the quote line (`same line`); `f`
  switches the format and the latest choice on the branch wins. `y` answers `Yes.`, `x` dismisses, `o` opens the reply, `l`/`u` link and unlink; `l` with 2 or more
  marked asks links them as one chain. An ask
  closes only when a later prompt cites its ID or it is dismissed; linked asks close together.
  Prompts beyond the 10 newest fold into `Older (N)`. `/replies pending` lists the open asks as
  plain text, and `/replies <question ID>` opens the reply that asks it.
- `⚠` marks a reply, in the index (the plain-text one too), the viewer and the widget, only while one of its asks is open; a
  reply whose asks are all answered or dismissed shows `✓`, and the viewer lists its closed asks
  under `✓ Answered` with `→ P13` or `dismissed`.
- An **Answered** tab (`Tab` cycles Pending → Replies → Answered) lists the closed asks with the
  prompt that answered each one and its answer (the `R:` line, the text after `→`, or the first line
  after the quote), or `✕ dismissed`.
- The Pending hints are short (`enter answer · y yes · f format · ? help · esc close`); `?` shows a
  card with every key.
- English everywhere: the yes key is `y` and pastes `Yes.`.
- README: a recommended `AGENTS.md` instruction that gathers the agent's asks in a final `## Needs your decision` section, one numbered ask per item, each ending with `?`.
- Ask modes: by default (`section`), a reply with a decision section (`## Needs your decision` with
  asks under it) asks only that section's top-level items and questions, so `Q#` matches the item
  number; `--reply-thread-asks all` (`gsh -- --reply-thread-asks all`) also tracks every question
  elsewhere in the reply. An unknown value works as `section` with a warning. The reply viewer notes
  the questions it leaves untracked, and the `?` card names the mode. README: "How asks are found".
- Repeat groups: open asks that look alike (the same text, or 60% of their longer words in common,
  directly or through another ask) show as one Pending row on the newest with `≈ N similar`, counted
  once in the title. `→` expands the older ones under it, to answer, mark or dismiss one by one, and
  `←` collapses them. `l` on the row links every other ask of the group to the oldest one, so it
  becomes one chain. Nothing closes by itself.
- A quote closes the ask whose text it carries (the open one its ID names when that one has the text,
  else the newest), even when its ID now names another ask, as after a decision section renumbered a
  reply; the Answered tab reads the answer from that quote. A quote without text, or with a text no
  ask has, and an ID outside a quote close by ID as before.
- The widget's pending count matches the Pending title: a group of repeats counts once.
- A group row answers only its newest ask (a group is a display fold, never a link); press `l` first
  to close the whole group together, or `→` and answer each. The `?` card and README say so.
- Looks answered: an open Pending row like an older answered or dismissed ask (a hidden ask of its
  group too) shows `✓? like <ID>` with the newest such ask, after `↺` and `≈ N similar`. Nothing
  closes by itself; answer it or press `x`. The `?` card explains it.
- The demo session (`pnpm demo`) is in English, with the same two repeat groups, job notice and
  `## …?` section title.
- `✓?` uses a looser similarity (40% shared words) than repeat groups (60%).
- The recommended agent instruction asks the agent to review its earlier asks before writing the decision section: drop answered ones and repeat open ones word for word.
- Undo: `Backspace` in the Pending and Answered tabs undoes the last `x`, `l`, `u` or `r` written
  since the overlay opened, newest first, one key per step (a group or marked `l` undoes as a whole).
  It writes the opposite entry (`reopen`, `unlink`, `link`, `dismiss`) and never deletes; `f` is not
  undone. `r` in the Answered tab reopens the selected ask, every member of a closed chain, and it
  returns to Pending. The `?` card lists both keys.
- README: "When is it a bug?" lists the failures to report and what works as designed.
