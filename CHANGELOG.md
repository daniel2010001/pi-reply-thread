# Changelog

## 0.1.0 (unreleased)

- Group every final reply of a session branch under the prompt that started it, with an ordered ID
  (`P12.R2`) and a unique ID (the session entry ID).
- Label what triggered each reply: the prompt, a background job, a monitor, a subagent or another
  session. Gentle Agents wake messages are not counted as prompts.
- Mark the replies that wait on you: lines that end with `?` and decision markers, outside code,
  quotes and tables.
- `/replies` opens a themed index of the branch and a full-reply viewer; `/replies <P#.R# | entry ID>`
  opens one reply directly. Plain-text output outside the TUI.
- A widget above the editor summarizes the latest prompt while it has two or more replies.
