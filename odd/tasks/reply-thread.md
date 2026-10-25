# reply-thread — index the replies one prompt produces in a Pi / Gentle Shell session

A Pi package (`pi-reply-thread`) that groups every final assistant reply under the prompt that
started it, labels what triggered each reply (the prompt, a background job, a subagent), gives each
reply an ordered and a unique ID, and keeps the open asks of earlier replies visible.

## Specs

- S1 — Reply index. Owner (verbatim): "quisiera hacer algo así como un "índice" de las respuestas, esto porque veo que a menudo gentle-ai lanza respuestas, pero acto siguiente, como si estuviera esperando alguna otra cosa, responde otra cosa, algo como: promp -> respuesta 1 -> termina algún worker o job -> respuesta 2 -> termina otro job -> respuesta 3, esto puede hacer que el "hilo" de la respuesta se pierda, por ejemplo: la respuesta 3 espera acciones o decisiones de la respeusta 1 o de la 2, entiendes?"
  Approved shape (owner: "me gusta"): one thread per user prompt holding every final reply until the next prompt; each reply shows its trigger (`prompt`, `job: <label>`, `worker: <label>`, other session messages); no extra model call; nothing enters the model context; works after `/resume` because it is rebuilt from the session branch.
- S2 — Two IDs per reply. Owner (verbatim): "promp -> response 1 (algún tipo de identificador, quisas dos, algo como uno ordenado y otro único) -> response 2 -> ..."
  Approved shape: ordered ID `P<prompt>.R<reply>` (for example `P12.R2`); unique ID = the 8-hex Pi session entry ID of that assistant message (for example `a1b2c3d4`).
  ```
  P12  "buscá si existe…"                   12:04
   ├ P12.R1  a1b2c3d4  prompt        ⚠ espera tu decisión
   ├ P12.R2  e5f6a7b8  job: tests
   └ P12.R3  c9d0e1f2  worker: docs
  ```
- S3 — Open asks stay visible. Approved: deterministic detection (no model) of replies that wait on the owner — a question line outside code, a "Needs your decision" result, or the owner's language equivalents; a widget above the editor appears only when the current prompt has 2 or more replies and names the replies still waiting.
- S4 — Reader view. Approved: `/replies` lists the threads; choosing a reply opens it in full in a scrollable viewer; a reply can also be opened directly by either ID. Text only: no audio in this package.
- S5 — Community plugin. Owner (verbatim): "quisiera lo haga para que sea algo así como un plugin de la comunidad de gentle-ai, podemos?" → a standalone Pi package (`pi-package` keyword) that works in plain Pi and inside Gentle Shell. Publishing to npm and the gentle-ai issue happen only with the owner's explicit OK.
- S6 — Separate projects. Owner (verbatim): "quisas separemos los proyectos ya que veo que hacemos muchas cosas en uno solo" → this repository holds the index only; the spoken reader is a separate package (see Log L4).

## Tasks

| ID | Specs | Task | Route | Commit |
|---|---|---|---|---|
| T1 | S5 | [ ] Scaffold: package.json (`pi-package`, peer deps on Pi 1.x), TypeScript, vitest, MIT license, `.gitignore` | inline | — |
| T2 | S1, S2 | [ ] Core: pure `buildThreads(branch)` → threads, `P#.R#` + entry ID, trigger label per reply, tests from real-shaped fixtures | inline, test-first | — |
| T3 | S3 | [ ] Open-ask detection rules + tests (question lines outside code, decision markers; code and quotes ignored) | inline, test-first | — |
| T4 | S4, S2 | [ ] `/replies` command: thread list, full-reply viewer, open by `P#.R#` or entry ID; non-TUI fallback | inline, test-first where pure | — |
| T5 | S3 | [ ] Widget above the editor (≥2 replies on the current prompt, names waiting replies), refreshed on settle and session start | inline | — |
| T6 | S5 | [ ] Load check in plain Pi and in Gentle Shell with a real session | inline + owner look | — |
| T7 | S1-S6 | [ ] README (English), command help, CHANGELOG | inline | — |

## Log

- L1 (2026-10-25, owner, verbatim): "suena interesante, podemos hacerlo? también quisiera hacer algo así como un "índice" de las respuestas, esto porque veo que a menudo gentle-ai lanza respuestas, pero acto siguiente, como si estuviera esperando alguna otra cosa, responde otra cosa, algo como: promp -> respuesta 1 -> termina algún worker o job -> respuesta 2 -> termina otro job -> respuesta 3, esto puede hacer que el "hilo" de la respuesta se pierda, por ejemplo: la respuesta 3 espera acciones o decisiones de la respeusta 1 o de la 2, entiendes? y quisiera lo haga para que sea algo así como un plugin de la comunidad de gentle-ai, podemos? planifiquemos, te perece? busquemos si hay algo así o no entre los plugins de la comunidad"
- L2 (2026-10-25, research): no existing package indexes replies by trigger. Recaps (`@signalridge/pi-session-recap`, `@lazco/pi-recap`, `@fradser/pi-recap`, `@eagle4302/pi-recap`) summarize with an extra model call. Voice exists (`gentle-voice`, `pi-voice`, `pi-talk`, `privateer-speak`); `gentle-voice` narrates through a `voice-ai` model, not a deterministic cleanup. Owner sessions, last 10 days: 703 prompts → 544 with 1 final reply, 80 with 2, 45 with 3+. Triggers are in the session: `custom_message` `gentle-jobs.notice` (`Background job job-1 ("label") exited …`), `gentle-agents.result` (`Subagent <agent> (task <id>, "label") finished.`), `gentle-agents.orchestrator-message` (`Session message from <session> …`). Entry IDs are 8 hex characters.
- L3 (2026-10-25, owner, verbatim): "me gusta, pero algo que quisiera hacer es como esto: promp -> response 1 (algún tipo de identificador, quisas dos, algo como uno ordenado y otro único) -> response 2 -> ... y que el lector NO se ejecute automáticamente, a menos que se lo diga, algo como defautl=false, esto porque puede que los audios se pisen, otra cosa es que quisiera "curar" las respuestas, como las respuestas son en markdown algunas cosas se leen raro, esto ya lo vi, algo como "asterisco asterisco negrilla asterisco asterisco", o también el formato de las tablas: "or col 1 or col 2 or col 3 or", o "guión" o "guión bajo" muchas veces. también está la parte del código: "comilla simpmle" muchas veces, así con las salidas del markdown. desiciones: 1: como digas, podemos hacerlo paso por paso si quieres. 2: si, nuevo proyecto. 3: me gusta, o quisas separemos los proyectos ya que veo que hacemos muchas cosas en uno solo, qué dices?"
- L4 (2026-10-25, decision): two packages. This one (`pi-reply-thread`): index, IDs, widget, text viewer. Next, separate repo: the spoken reader — `autoRead: false` by default, reads only on request (`/read`, `/read P12.R1`), a new reading stops the previous one, deterministic Markdown-to-speech cleanup (bold/italic/headings, tables, bullets, inline code, code blocks, links). Open for that feature: TTS engine (Piper local first) and audio routing, because gsh runs on hs-node over SSH and local playback would sound on the HS speakers. Step by step: the reader starts after this package is done.
- L5 (2026-10-25, owner, verbatim): "ok, hazlo. go" → repo `/home/danielblc/projects/pi-reply-thread` created (`git init -b main`).
