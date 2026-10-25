# Changelog

## 0.1.0 (unreleased)

- Group every final reply of a session branch under the prompt that started it, with an ordered ID
  (`P12.R2`) and a unique ID (the session entry ID).
- Label what triggered each reply: the prompt, a background job, a monitor, a subagent or another
  session. Gentle Agents wake messages are not counted as prompts.
- Mark the replies that wait on you: lines that end with `?` and decision markers, outside code,
  quotes and tables. A marker inside double quotes is only mentioned and does not count.
- `/replies` opens a themed index of the branch and a full-reply viewer; `/replies <P#.R# | entry ID>`
  opens one reply directly; `Alt+R` opens the index without typing. Plain-text output outside the TUI.
- A widget above the editor summarizes the latest prompt while it has two or more replies, and counts
  the open asks with the newest one (`⚠ N pending · newest: <ID> <ask> · alt+r`).
- Pending central: every ask has an ordered ID (`P12.R1.Q2`) and a unique ID (`a1b2c3d4.2`);
  `/replies` and `Alt+R` open on a **Pending** tab while any ask is open (`Tab` switches to the
  index). `Enter` pastes `> <ID>: <ask>` quotes to answer the marked or selected asks, `s` adds
  `Sí.`, `x` dismisses, `o` opens the reply, `l`/`u` link and unlink a suggested repeat. An ask
  closes only when a later prompt cites its ID or it is dismissed; linked asks close together.
  Prompts beyond the 10 newest fold into `Older (N)`. `/replies pending` lists the open asks as
  plain text, and `/replies <question ID>` opens the reply that asks it.
