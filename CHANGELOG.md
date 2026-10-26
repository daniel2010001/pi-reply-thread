# Changelog

## 0.1.0 (unreleased)

- Group every final reply of a session branch under the prompt that started it, with an ordered ID
  (`P12.R2`) and a unique ID (the session entry ID).
- Label what triggered each reply: the prompt, a background job, a monitor, a subagent or another
  session. Gentle Agents wake messages are not counted as prompts.
- Mark the replies that wait on you: lines that end with `?` and decision markers, outside code,
  quotes and tables. A marker inside double quotes is only mentioned and does not count, a heading
  that ends in `?` is a section title, and so is a marker heading (`## Needs your decision`) with
  asks under it.
- `/replies` opens a themed index of the branch and a full-reply viewer; `/replies <P#.R# | entry ID>`
  opens one reply directly; `Alt+R` opens the index without typing. Plain-text output outside the TUI.
- A widget above the editor summarizes the latest prompt while it has two or more replies, and counts
  the open asks with the newest one (`⚠ N pending · newest: <ID> <ask> · alt+r`).
- Pending central: every ask has an ordered ID (`P12.R1.Q2`) and a unique ID (`a1b2c3d4.2`);
  `/replies` and `Alt+R` open on a **Pending** tab while any ask is open (`Tab` switches to the
  index). `Enter` pastes `> <ID>: <ask>` quotes to answer the marked or selected asks, with an
  `R: ` line under each (`R: lines`, the default) or `→ ` on the quote line (`same line`); `f`
  switches the format and the latest choice on the branch wins. `s` answers `Sí.`, `x` dismisses, `o` opens the reply, `l`/`u` link and unlink a suggested repeat; `l` with 2 or more
  marked asks links them as one chain. An ask
  closes only when a later prompt cites its ID or it is dismissed; linked asks close together.
  Prompts beyond the 10 newest fold into `Older (N)`. `/replies pending` lists the open asks as
  plain text, and `/replies <question ID>` opens the reply that asks it.
- README: a recommended `AGENTS.md` instruction that gathers the agent's asks in a final `## Needs your decision` section.
