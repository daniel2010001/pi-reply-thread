# Changelog

## 0.1.0 (unreleased)

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
