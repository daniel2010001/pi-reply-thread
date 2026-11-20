process.env.TZ = "UTC";

import { type ExtensionAPI, initTheme, type KeybindingsManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import replyThread from "../extensions/reply-thread.ts";
import { buildAsks } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { triageRequest } from "../src/triage.ts";
import { askEntry, assistant, customEntry, jobNotice, resetIds, toolCalls, toolResultOf, user } from "./helpers.ts";

// The triage loader draws its key hint with Pi's global theme.
beforeAll(() => initTheme("dark", false));

type Handler = (event: unknown, ctx: unknown) => unknown;
type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[] };

interface Command {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

interface Shortcut {
	description?: string;
	handler: (ctx: unknown) => Promise<void> | void;
}

/** `flag` is what `pi.getFlag("reply-thread-asks")` returns; Pi gives the default when the flag is not passed. */
function load(flag: string | boolean | undefined = "section", options: { reader?: boolean } = {}) {
	const appended: [string, unknown][] = [];
	const reads: unknown[] = [];
	const pings: unknown[] = [];
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const events = {
		emit: (channel: string, data: unknown) => {
			for (const listener of listeners.get(channel) ?? []) listener(data);
		},
		on: (channel: string, listener: (data: unknown) => void) => {
			listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
			return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((other) => other !== listener));
		},
	};
	// A fake pi-reply-reader: it answers each ping at once and records each read.
	if (options.reader) {
		events.on("reply-reader:ping", (data) => {
			pings.push(data);
			events.emit("reply-reader:ready", { v: 1 });
		});
		events.on("reply-reader:read", (data) => reads.push(data));
	} else events.on("reply-reader:read", (data) => reads.push(data));
	const flags = new Map<string, unknown>();
	const commands = new Map<string, Command>();
	const shortcuts = new Map<string, Shortcut>();
	const handlers = new Map<string, Handler[]>();
	const pi = {
		events,
		registerCommand: (name: string, options: Command) => commands.set(name, options),
		registerShortcut: (key: string, options: Shortcut) => shortcuts.set(key, options),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerFlag: (name: string, options: unknown) => flags.set(name, options),
		getFlag: (name: string) => (name === "reply-thread-asks" ? flag : undefined),
		appendEntry: (customType: string, data: unknown) => {
			appended.push([customType, data]);
			branch.push(customEntry(customType, data));
		},
	};
	replyThread(pi as unknown as ExtensionAPI);
	const emit = async (event: string, ctx: unknown, data: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
	};
	const listening = (channel: string) => listeners.get(channel)?.length ?? 0;
	return { commands, shortcuts, emit, appended, flags, reads, pings, listening };
}

const KEYS: Record<string, string> = { "tui.select.confirm": "\r", "tui.select.cancel": "\x1b", "tui.select.down": "\x1b[B" };
const keybindings = { matches: (data: string, action: string) => KEYS[action] === data } as unknown as KeybindingsManager;

interface Overlay {
	handleInput(data: string): void;
	render(width: number): string[];
}

/** What `ctx.getSystemPrompt()` returns: the session's system prompt, which the triage sends unchanged. */
const SESSION_PROMPT = "You are Pi, a coding agent.\n\n# Project context\n\nAGENTS.md rules go here.";

/** What `/replies triage` meets: the session model, the confirm answer, the model reply and keys for the loader. */
interface TriageSetup {
	model?: { provider: string; id: string };
	confirm?: boolean;
	/** The message `streamSimple(...).result()` resolves with; it gets the loader's abort signal. */
	reply?: (signal: AbortSignal) => Promise<unknown>;
	loaderKeys?: string[];
}

/**
 * `keys` are pressed in the first overlay once it opens; `seen` keeps its first frame and, after keys,
 * its last. A later overlay (Pending reopened after a triage) closes after its first frame.
 * A custom without options is the triage loader: it gets `loaderKeys` and resolves only through `done`.
 */
function fakeCtx(
	branch: SessionEntry[],
	mode: "tui" | "print" = "print",
	keys: string[] = [],
	triage: TriageSetup = {},
	/** What `ctx.ui.getEditorText()` returns; without it, the UI has no such function. */
	editor?: string,
) {
	const pastes: string[] = [];
	const seen: string[][] = [];
	const notices: [string, string | undefined][] = [];
	const widgets: [string, unknown, unknown][] = [];
	const customs: unknown[] = [];
	const confirms: [string, string][] = [];
	const calls: [unknown, unknown, { signal?: AbortSignal }][] = [];
	const loaders: string[][] = [];
	let overlays = 0;
	const ctx = {
		mode,
		hasUI: mode === "tui",
		model: triage.model,
		getSystemPrompt: () => SESSION_PROMPT,
		modelRegistry: {
			streamSimple: (model: unknown, context: unknown, options: { signal: AbortSignal }) => {
				calls.push([model, context, options]);
				return { result: () => (triage.reply ?? (async () => ({ stopReason: "stop", content: [] })))(options.signal) };
			},
		},
		ui: {
			notify: (message: string, type?: string) => notices.push([message, type]),
			setWidget: (key: string, content: unknown, options?: unknown) => widgets.push([key, content, options]),
			confirm: async (title: string, message: string) => {
				confirms.push([title, message]);
				return triage.confirm ?? true;
			},
			custom: (factory: unknown, options: unknown) => {
				customs.push(options);
				if (!options) {
					return new Promise((resolve) => {
						const tui = { terminal: { rows: 30 }, requestRender: () => {} };
						const make = factory as (...args: unknown[]) => Overlay & { dispose?(): void };
						const loader = make(tui, fakeTheme, keybindings, (value: unknown) => {
							loader.dispose?.();
							resolve(value);
						});
						loaders.push(loader.render(80).map(stripTerminalSequences));
						for (const key of triage.loaderKeys ?? []) loader.handleInput(KEYS[key] ?? key);
					});
				}
				const pressed = overlays++ ? [] : keys;
				return new Promise((resolve) => {
					const tui = { terminal: { rows: 30 }, requestRender: () => {} };
					const make = factory as (...args: unknown[]) => Overlay;
					const overlay = make(tui, fakeTheme, keybindings, resolve);
					seen.push(overlay.render(80).map(stripTerminalSequences));
					for (const key of pressed) overlay.handleInput(KEYS[key] ?? key);
					if (pressed.length) seen.push(overlay.render(80).map(stripTerminalSequences));
					else resolve(undefined);
				});
			},
			pasteToEditor: (text: string) => pastes.push(text),
			...(editor === undefined ? {} : { getEditorText: () => editor }),
		},
		sessionManager: { getBranch: () => branch },
	};
	return { ctx, notices, widgets, customs, pastes, seen, confirms, calls, loaders };
}

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function widgetText(content: unknown, width = 200): string[] {
	return (content as WidgetFactory)({}, fakeTheme).render(width).map(stripTerminalSequences);
}

let branch: SessionEntry[];

beforeEach(() => {
	resetIds();
	branch = [
		user("buscá si existe algo así"),
		assistant("Encontré dos opciones.", { id: "a1b2c3d4" }),
		jobNotice("job-1", "tests"),
		assistant("Tests en verde.", { id: "e5f6a7b8" }),
	];
});

describe("reply-thread extension", () => {
	it("registers /replies with a description", () => {
		const { commands } = load();
		expect(commands.get("replies")?.description).toBe(
			"List the replies of each prompt and the asks waiting on you; /replies <P#.R#[.Q#] | entry ID[.#]> opens one in full, /replies pending lists the open asks, /replies triage asks the session model to propose answered and repeated asks",
		);
	});

	it("notifies the full reply for /replies P1.R2 outside the TUI", async () => {
		const { commands } = load();
		const { ctx, notices } = fakeCtx(branch);
		await commands.get("replies")!.handler("P1.R2", ctx);
		expect(notices).toEqual([["P1.R2 · e5f6a7b8 · 12:00 · job: tests\n\nTests en verde.", "info"]]);
	});

	it("opens a reply by entry ID outside the TUI", async () => {
		const { commands } = load();
		const { ctx, notices } = fakeCtx(branch);
		await commands.get("replies")!.handler("a1b2c3d4", ctx);
		expect(notices).toEqual([["P1.R1 · a1b2c3d4 · 12:00 · prompt\n\nEncontré dos opciones.", "info"]]);
	});

	it("opens the reply of a question by either question ID", async () => {
		const { commands } = load();
		branch[1] = assistant("¿Cuál preferís?", { id: "a1b2c3d4" });
		for (const id of ["p1.r1.q1", "a1b2c3d4.1"]) {
			const { ctx, notices } = fakeCtx(branch);
			await commands.get("replies")!.handler(id, ctx);
			expect(notices).toEqual([["P1.R1 · a1b2c3d4 · 12:00 · prompt\n\n¿Cuál preferís?", "info"]]);
		}
	});

	it("notifies the plain-text index for /replies outside the TUI", async () => {
		const { commands } = load();
		const { ctx, notices } = fakeCtx(branch);
		await commands.get("replies")!.handler("", ctx);
		expect(notices).toEqual([
			[
				"P1 · 12:00 · buscá si existe algo así\n  P1.R1  a1b2c3d4  prompt\n  P1.R2  e5f6a7b8  job: tests",
				"info",
			],
		]);
	});

	it("reports an unknown ID as an error, in and outside the TUI", async () => {
		const { commands } = load();
		for (const mode of ["print", "tui"] as const) {
			const { ctx, notices } = fakeCtx(branch, mode);
			await commands.get("replies")!.handler("P9.R9", ctx);
			expect(notices).toEqual([['No reply matches "P9.R9". Run /replies to list them.', "error"]]);
		}
	});

	it("sets the widget above the editor on session_start when the latest thread has 2+ replies", async () => {
		const { emit } = load();
		const { ctx, widgets } = fakeCtx(branch, "tui");
		await emit("session_start", ctx);
		expect(widgets).toHaveLength(1);
		const [key, content, options] = widgets[0];
		expect(key).toBe("reply-thread");
		expect(options).toEqual({ placement: "aboveEditor" });
		expect(widgetText(content)).toEqual(["P1 · 2 replies: R1 prompt · R2 job: tests · alt+r"]);
		expect(widgetText(content, 20)).toEqual(["P1 · 2 replies: R..."]);
	});

	it("clears the widget when the latest thread has fewer than 2 replies", async () => {
		const { emit } = load();
		const { ctx, widgets } = fakeCtx(branch, "tui");
		await emit("session_start", ctx);
		branch.push(user("otra cosa"), assistant("Listo.", { id: "f0f0f0f0" }));
		await emit("message_end", ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(widgets.map(([key, content]) => [key, content])).toEqual([
			["reply-thread", expect.any(Function)],
			["reply-thread", undefined],
		]);
	});

	it("refreshes on message_end after Pi stores the message", async () => {
		const { emit } = load();
		const { ctx, widgets } = fakeCtx(branch.slice(0, 2), "tui");
		await emit("session_start", ctx);
		expect(widgets).toEqual([["reply-thread", undefined, { placement: "aboveEditor" }]]);
		const later = fakeCtx(branch, "tui");
		await emit("message_end", later.ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(widgetText(later.widgets.at(-1)?.[1])).toEqual([
			"P1 · 2 replies: R1 prompt · R2 job: tests · alt+r",
		]);
	});

	it("leaves the widget alone outside the TUI", async () => {
		const { emit } = load();
		const { ctx, widgets } = fakeCtx(branch, "print");
		await emit("session_start", ctx);
		await emit("message_end", ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(widgets).toEqual([]);
	});

	it("opens the index on alt+r, as /replies does", async () => {
		const { commands, shortcuts } = load();
		const shortcut = shortcuts.get("alt+r");
		expect(shortcut?.description).toBe("Open the pending asks and the reply index (/replies)");
		const viaKey = fakeCtx(branch, "tui");
		await shortcut!.handler(viaKey.ctx);
		const viaCommand = fakeCtx(branch, "tui");
		await commands.get("replies")!.handler("", viaCommand.ctx);
		expect(viaKey.customs).toEqual([{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } }]);
		expect(viaKey.customs).toEqual(viaCommand.customs);
		expect(viaKey.notices).toEqual([]);
	});

	it("sends the plain-text index on alt+r outside the TUI", async () => {
		const { shortcuts } = load();
		const { ctx, notices } = fakeCtx(branch);
		await shortcuts.get("alt+r")!.handler(ctx);
		expect(notices).toEqual([
			[
				"P1 · 12:00 · buscá si existe algo así\n  P1.R1  a1b2c3d4  prompt\n  P1.R2  e5f6a7b8  job: tests",
				"info",
			],
		]);
	});
});

describe("pending central", () => {
	beforeEach(() => {
		branch[1] = assistant("Encontré dos opciones. ¿Cuál preferís?", { id: "a1b2c3d4" });
	});

	it("opens on Pending on alt+r and /replies while an ask is open, on Replies otherwise", async () => {
		const { commands, shortcuts } = load();
		const viaKey = fakeCtx(branch, "tui");
		await shortcuts.get("alt+r")!.handler(viaKey.ctx);
		const viaCommand = fakeCtx(branch, "tui");
		await commands.get("replies")!.handler("", viaCommand.ctx);
		expect(viaKey.seen[0][0]).toMatch(/^╭─ Pending ─+ 1 open · 0 linked ─╮$/);
		expect(viaCommand.seen).toEqual(viaKey.seen);
		branch.push(user("> P1.R1.Q1: Encontré dos opciones. ¿Cuál preferís?\nLa primera."));
		const answered = fakeCtx(branch, "tui");
		await shortcuts.get("alt+r")!.handler(answered.ctx);
		expect(answered.seen[0][0]).toMatch(/^╭─ Replies /);
	});

	it("pastes the quote into the editor after Enter closes the central", async () => {
		const { commands, appended } = load();
		const { ctx, pastes, notices } = fakeCtx(branch, "tui", ["tui.select.confirm"]);
		await commands.get("replies")!.handler("", ctx);
		expect(pastes).toEqual(["> P1.R1.Q1: Encontré dos opciones. ¿Cuál preferís?\nR: "]);
		expect(appended).toEqual([]);
		expect(notices).toEqual([]);
	});

	it("f writes the format as a reply-thread.format entry and the paste follows it", async () => {
		const { commands, appended } = load();
		const { ctx, pastes } = fakeCtx(branch, "tui", ["f", "tui.select.confirm"]);
		await commands.get("replies")!.handler("", ctx);
		expect(appended).toEqual([["reply-thread.format", { format: "inline" }]]);
		expect(pastes).toEqual(["> P1.R1.Q1: Encontré dos opciones. ¿Cuál preferís? → "]);
		const again = fakeCtx(branch, "tui", ["f", "tui.select.confirm"]);
		await commands.get("replies")!.handler("", again.ctx);
		expect(appended.at(-1)).toEqual(["reply-thread.format", { format: "lines" }]);
		expect(again.pastes).toEqual(["> P1.R1.Q1: Encontré dos opciones. ¿Cuál preferís?\nR: "]);
	});

	it("answers in the latest format on the branch, lines by default", async () => {
		const { commands } = load();
		const answer = async () => {
			const { ctx, pastes } = fakeCtx(branch, "tui", ["tui.select.confirm"]);
			await commands.get("replies")!.handler("", ctx);
			return { paste: pastes[0] };
		};
		expect(await answer()).toEqual({ paste: expect.stringMatching(/\nR: $/) });
		branch.push(customEntry("reply-thread.format", { format: "inline" }));
		expect(await answer()).toEqual({ paste: expect.stringMatching(/ → $/) });
		branch.push(customEntry("reply-thread.format", { format: "lines" }));
		expect((await answer()).paste).toMatch(/\nR: $/);
	});

	it("does not paste when the central closes on Esc", async () => {
		const { commands } = load();
		const { ctx, pastes } = fakeCtx(branch, "tui", ["tui.select.cancel"]);
		await commands.get("replies")!.handler("", ctx);
		expect(pastes).toEqual([]);
	});

	it("writes a dismiss as a reply-thread.ask entry and refreshes the widget", async () => {
		const { commands, appended } = load();
		const { ctx, widgets, seen } = fakeCtx(branch, "tui", ["x", "tui.select.cancel"]);
		await commands.get("replies")!.handler("", ctx);
		expect(seen[0][0]).toMatch(/Pending/);
		expect(appended).toEqual([["reply-thread.ask", { action: "dismiss", ask: "a1b2c3d4.1" }]]);
		expect(widgetText(widgets.at(-1)?.[1])).toEqual(["P1 · 2 replies: R1 prompt · R2 job: tests · alt+r"]);
		const again = fakeCtx(branch, "tui");
		await commands.get("replies")!.handler("", again.ctx);
		expect(again.seen[0][0]).toMatch(/^╭─ Replies /);
	});

	it("Backspace writes the reopen of a dismiss as a reply-thread.ask entry and the widget shows the ask again", async () => {
		const { commands, appended } = load();
		const { ctx, widgets, seen } = fakeCtx(branch, "tui", ["x", "\x7f", "tui.select.cancel"]);
		await commands.get("replies")!.handler("", ctx);
		expect(appended).toEqual([
			["reply-thread.ask", { action: "dismiss", ask: "a1b2c3d4.1" }],
			["reply-thread.ask", { action: "reopen", ask: "a1b2c3d4.1" }],
		]);
		expect(seen.at(-1)?.[0]).toMatch(/^╭─ Pending ─+ 1 open · 0 linked ─╮$/);
		expect(widgetText(widgets.at(-1)?.[1])).toEqual([
			"P1 · 2 replies: R1 prompt ⚠ · R2 job: tests · alt+r",
			"⚠ 1 pending · newest: P1.R1.Q1 Encontré dos opciones. ¿Cuál preferís? · alt+r",
		]);
	});

	it("starts every overlay with nothing to undo", async () => {
		const { commands, appended } = load();
		const first = fakeCtx(branch, "tui", ["x", "tui.select.cancel"]);
		await commands.get("replies")!.handler("", first.ctx);
		const second = fakeCtx(branch, "tui", ["\t", "\t", "\x7f", "tui.select.cancel"]);
		await commands.get("replies")!.handler("", second.ctx);
		expect(second.seen[0][0]).toMatch(/^╭─ Replies /);
		expect(appended).toEqual([["reply-thread.ask", { action: "dismiss", ask: "a1b2c3d4.1" }]]);
	});

	it("r in Answered writes a reopen as a reply-thread.ask entry and the ask is pending again", async () => {
		const { commands, appended } = load();
		branch.push(askEntry({ action: "dismiss", ask: "a1b2c3d4.1" }));
		const { ctx, widgets } = fakeCtx(branch, "tui", ["\t", "r", "tui.select.cancel"]);
		await commands.get("replies")!.handler("", ctx);
		expect(appended).toEqual([["reply-thread.ask", { action: "reopen", ask: "a1b2c3d4.1" }]]);
		expect(widgetText(widgets.at(-1)?.[1])).toContainEqual(
			"⚠ 1 pending · newest: P1.R1.Q1 Encontré dos opciones. ¿Cuál preferís? · alt+r",
		);
		const again = fakeCtx(branch, "tui");
		await commands.get("replies")!.handler("", again.ctx);
		expect(again.seen[0][0]).toMatch(/^╭─ Pending ─+ 1 open · 0 linked ─╮$/);
	});

	it("counts a group of similar asks once in the widget, like the Pending title", async () => {
		const { emit } = load();
		const repeats = [
			user("medí el consumo"),
			assistant("Las mediciones dejaron archivos en /tmp: ¿los borro?", { id: "b1b1b1b1" }),
			user("seguimos"),
			assistant("¿Borro los archivos de las mediciones en /tmp?", { id: "b2b2b2b2" }),
		];
		const { ctx, widgets } = fakeCtx(repeats, "tui");
		await emit("session_start", ctx);
		expect(widgetText(widgets[0][1])).toEqual([
			"⚠ 1 pending · newest: P2.R1.Q1 ¿Borro los archivos de las mediciones en /tmp? · alt+r",
		]);
	});

	it("shows the pending line in the widget, even under a prompt with one reply", async () => {
		const { emit } = load();
		const { ctx, widgets } = fakeCtx(branch, "tui");
		await emit("session_start", ctx);
		expect(widgetText(widgets[0][1])).toEqual([
			"P1 · 2 replies: R1 prompt ⚠ · R2 job: tests · alt+r",
			"⚠ 1 pending · newest: P1.R1.Q1 Encontré dos opciones. ¿Cuál preferís? · alt+r",
		]);
		branch.push(user("otra cosa"), assistant("Listo.", { id: "f0f0f0f0" }));
		const later = fakeCtx(branch, "tui");
		await emit("session_start", later.ctx);
		expect(widgetText(later.widgets[0][1])).toEqual([
			"⚠ 1 pending · newest: P1.R1.Q1 Encontré dos opciones. ¿Cuál preferís? · alt+r",
		]);
	});

	it("notifies the open asks for /replies pending outside the TUI", async () => {
		const { commands } = load();
		const { ctx, notices } = fakeCtx(branch);
		await commands.get("replies")!.handler("pending", ctx);
		expect(notices).toEqual([["P1.R1.Q1  a1b2c3d4.1  Encontré dos opciones. ¿Cuál preferís?", "info"]]);
		branch.push(askEntry({ action: "dismiss", ask: "a1b2c3d4.1" }));
		const none = fakeCtx(branch);
		await commands.get("replies")!.handler("pending", none.ctx);
		expect(none.notices).toEqual([["Nothing waits on you.", "info"]]);
	});

	it("opens /replies pending on the Pending tab in the TUI, even when nothing waits", async () => {
		const { commands } = load();
		branch.push(askEntry({ action: "dismiss", ask: "a1b2c3d4.1" }));
		const { ctx, seen } = fakeCtx(branch, "tui");
		await commands.get("replies")!.handler("pending", ctx);
		expect(seen[0][0]).toMatch(/^╭─ Pending /);
		expect(seen[0][1]).toMatch(/^│ Nothing waits on you\. +│$/);
	});
});

describe("ask mode flag", () => {
	const text = "Should I rebase first?\n\n## Needs your decision\n\n1. Merge now\n2. Tag it";

	beforeEach(() => {
		branch[1] = assistant(text, { id: "a1b2c3d4" });
	});

	it("registers --reply-thread-asks as a string flag that defaults to section", () => {
		const { flags } = load();
		expect(flags.get("reply-thread-asks")).toEqual({
			type: "string",
			default: "section",
			description:
				'Which lines of a reply are asks: "section" (default) tracks only the decision section when a reply has one, "all" tracks every question',
		});
	});

	it("tracks only the decision section by default and every question with all", async () => {
		const section = load();
		const quiet = fakeCtx(branch);
		await section.commands.get("replies")!.handler("pending", quiet.ctx);
		expect(quiet.notices).toEqual([["P1.R1.Q1  a1b2c3d4.1  Merge now\nP1.R1.Q2  a1b2c3d4.2  Tag it", "info"]]);
		const all = load("all");
		const every = fakeCtx(branch);
		await all.commands.get("replies")!.handler("pending", every.ctx);
		expect(every.notices).toEqual([
			[
				"P1.R1.Q1  a1b2c3d4.1  Should I rebase first?\nP1.R1.Q2  a1b2c3d4.2  Merge now\nP1.R1.Q3  a1b2c3d4.3  Tag it",
				"info",
			],
		]);
		const widget = fakeCtx(branch, "tui");
		await all.emit("session_start", widget.ctx);
		expect(widgetText(widget.widgets[0][1])).toEqual([
			"P1 · 2 replies: R1 prompt ⚠ · R2 job: tests · alt+r",
			"⚠ 3 pending · newest: P1.R1.Q3 Tag it · alt+r",
		]);
		expect(widget.notices).toEqual([]);
	});

	it("counts loose N: answers to the decision section as ✦ in the widget, only in section mode", async () => {
		const loose = [user("go"), assistant(text, { id: "a1b2c3d4" }), user("1: yes\n2: later")];
		const section = load();
		const quiet = fakeCtx(loose, "tui");
		await section.emit("session_start", quiet.ctx);
		expect(widgetText(quiet.widgets[0][1])).toEqual(["⚠ 2 pending · ✦ 2 look answered · newest: P1.R1.Q2 Tag it · alt+r"]);
		const all = load("all");
		const every = fakeCtx(loose, "tui");
		await all.emit("session_start", every.ctx);
		expect(widgetText(every.widgets[0][1])).toEqual(["⚠ 3 pending · newest: P1.R1.Q3 Tag it · alt+r"]);
	});

	it("keeps the mode after a central action rebuilds the asks", async () => {
		const { commands, appended } = load("all");
		const { ctx, seen } = fakeCtx(branch, "tui", ["x", "tui.select.cancel"]);
		await commands.get("replies")!.handler("", ctx);
		expect(seen[0][0]).toMatch(/ 3 open · 0 linked ─╮$/);
		expect(seen[1][0]).toMatch(/ 2 open · 0 linked ─╮$/);
		expect(seen[1].join("\n")).toContain("Merge now");
		expect(appended).toEqual([["reply-thread.ask", { action: "dismiss", ask: "a1b2c3d4.1" }]]);
		const after = fakeCtx(branch, "tui");
		await commands.get("replies")!.handler("", after.ctx);
		expect(after.seen[0][0]).toMatch(/ 2 open · 0 linked ─╮$/);
	});

	it("treats any other value as section and warns once per session start, in the TUI only", async () => {
		for (const value of ["every", true]) {
			const { commands, emit } = load(value);
			const tui = fakeCtx(branch, "tui");
			await emit("session_start", tui.ctx);
			await emit("message_end", tui.ctx);
			await new Promise((resolve) => setTimeout(resolve, 10));
			const warning = `Unknown --reply-thread-asks "${value}"; using "section". Use "section" or "all".`;
			expect(tui.notices).toEqual([[warning, "warning"]]);
			await emit("session_start", tui.ctx);
			expect(tui.notices).toEqual([
				[warning, "warning"],
				[warning, "warning"],
			]);
			const print = fakeCtx(branch);
			await emit("session_start", print.ctx);
			await commands.get("replies")!.handler("pending", print.ctx);
			expect(print.notices).toEqual([["P1.R1.Q1  a1b2c3d4.1  Merge now\nP1.R1.Q2  a1b2c3d4.2  Tag it", "info"]]);
		}
	});

	it("uses section without a warning when Pi has no value for the flag", async () => {
		const { commands, emit } = load(undefined);
		const { ctx, notices } = fakeCtx(branch, "tui");
		await emit("session_start", ctx);
		expect(notices).toEqual([]);
		const print = fakeCtx(branch);
		await commands.get("replies")!.handler("pending", print.ctx);
		expect(print.notices).toEqual([["P1.R1.Q1  a1b2c3d4.1  Merge now\nP1.R1.Q2  a1b2c3d4.2  Tag it", "info"]]);
	});
});

describe("citations by text", () => {
	it("closes the ask a quote carries after the decision section renumbered the reply (L41)", async () => {
		branch[1] = assistant(
			"Should I rebase first?\n\n## Needs your decision\n\n1. Merge now?\n2. Tag it?\n3. Do I push the tag?",
			{ id: "a1b2c3d4" },
		);
		// Cited as Q2, the number the push ask had when every question counted.
		branch.push(user("> P1.R1.Q2: Do I push the tag?\nR: yes"));
		const { commands } = load();
		const { ctx, notices } = fakeCtx(branch);
		await commands.get("replies")!.handler("pending", ctx);
		expect(notices).toEqual([["P1.R1.Q1  a1b2c3d4.1  Merge now?\nP1.R1.Q2  a1b2c3d4.2  Tag it?", "info"]]);
	});
});

describe("plain-text index", () => {
	it("shows ⚠ only on replies with an open ask and ✓ on replies whose asks are all closed", async () => {
		branch[1] = assistant("¿Cuál preferís?\n\n¿La subo?", { id: "a1b2c3d4" });
		branch[3] = assistant("Tests en verde. ¿Mergeo?", { id: "e5f6a7b8" });
		branch.push(user("otra cosa"), assistant("Listo.", { id: "f0f0f0f0" }));
		const index = async () => {
			const { commands } = load();
			const { ctx, notices } = fakeCtx(branch);
			await commands.get("replies")!.handler("", ctx);
			return notices;
		};
		const rows = (first: string, second: string) => [
			[
				[
					"P2 · 12:00 · otra cosa",
					"  P2.R1  f0f0f0f0  prompt",
					"P1 · 12:00 · buscá si existe algo así",
					`  P1.R1  a1b2c3d4  prompt${first}`,
					`  P1.R2  e5f6a7b8  job: tests${second}`,
				].join("\n"),
				"info",
			],
		];
		expect(await index()).toEqual(rows("  ⚠", "  ⚠"));
		branch.push(askEntry({ action: "dismiss", ask: "a1b2c3d4.1" }));
		expect(await index()).toEqual(rows("  ⚠", "  ⚠"));
		branch.push(user("> P1.R1.Q2: ¿La subo?\nR: Sí.\n> P1.R2.Q1: ¿Mergeo?\nR: No."));
		expect(await index()).toEqual(rows("  ✓", "  ✓").map(([text, type]) => [`P3 · 12:00 · > P1.R1.Q2: ¿La subo?\n${text}`, type]));
	});
});

describe("/replies triage", () => {
	const MODEL = { provider: "anthropic", id: "claude-test" };
	const reply = (text: string, extra: Record<string, unknown> = {}) => async () => ({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		...extra,
	});
	const ONE = JSON.stringify({ proposals: [{ kind: "answered", ask: "P1.R1.Q1", prompt: "P2", quote: "la primera" }] });

	beforeEach(() => {
		branch[1] = assistant("Encontré dos opciones. ¿Cuál preferís?", { id: "a1b2c3d4" });
		branch.push(user("la primera, dale"));
	});

	/** The request, the one user message it becomes, and the tokens the confirm names for both with the session prompt. */
	const tokens = (entries: SessionEntry[]) => {
		const threads = buildThreads(entries);
		const sent = triageRequest(buildAsks(entries, threads), threads);
		const message = `${sent?.instructions}\n\n${sent?.text}`;
		return { sent, message, about: Math.ceil((SESSION_PROMPT.length + message.length) / 4) };
	};
	const confirmText = (sent: string, about: number) =>
		`Send ${sent} (about ${about} tokens with your session's system prompt) to anthropic/claude-test. The model only proposes; nothing closes until you accept.`;

	it("registers /replies:triage with its description, and it runs the same triage as /replies triage", async () => {
		const { commands } = load();
		expect(commands.get("replies:triage")?.description).toBe(
			"Ask the session model which open asks a later prompt answered or another ask repeats; it only proposes",
		);
		const own = load();
		const viaOwn = fakeCtx(branch, "tui", [], { model: MODEL, confirm: false });
		await own.commands.get("replies:triage")!.handler("", viaOwn.ctx);
		const sub = load();
		const viaSub = fakeCtx(branch, "tui", [], { model: MODEL, confirm: false });
		await sub.commands.get("replies")!.handler("triage", viaSub.ctx);
		expect(viaOwn.confirms).toEqual([["Triage open asks?", confirmText("1 open ask and 1 later prompt", tokens(branch).about)]]);
		expect(viaOwn.confirms).toEqual(viaSub.confirms);
		expect({ own: own.appended, sub: sub.appended, customs: viaOwn.customs }).toEqual({ own: [], sub: [], customs: [] });
		const print = fakeCtx(branch, "print", [], { model: MODEL });
		await load().commands.get("replies:triage")!.handler("", print.ctx);
		expect(print.notices).toEqual([["/replies triage needs the interactive TUI.", "error"]]);
	});

	it("needs the interactive TUI: an error outside it, and nothing else", async () => {
		const { commands, appended } = load();
		const { ctx, notices, confirms, calls, customs } = fakeCtx(branch, "print", [], { model: MODEL, reply: reply(ONE) });
		await commands.get("replies")!.handler("triage", ctx);
		expect(notices).toEqual([["/replies triage needs the interactive TUI.", "error"]]);
		expect({ confirms, calls, customs, appended }).toEqual({ confirms: [], calls: [], customs: [], appended: [] });
	});

	it("says there is nothing to triage without open asks, with no confirm and no model call", async () => {
		const { commands, appended } = load();
		branch.push(askEntry({ action: "dismiss", ask: "a1b2c3d4.1" }));
		const { ctx, notices, confirms, calls } = fakeCtx(branch, "tui", [], { model: MODEL, reply: reply(ONE) });
		await commands.get("replies")!.handler("triage", ctx);
		expect(notices).toEqual([["No open asks to triage.", "info"]]);
		expect({ confirms, calls, appended }).toEqual({ confirms: [], calls: [], appended: [] });
	});

	it("needs a session model: an error without one, and no confirm", async () => {
		const { commands, appended } = load();
		const { ctx, notices, confirms, calls } = fakeCtx(branch, "tui", [], { reply: reply(ONE) });
		await commands.get("replies")!.handler("triage", ctx);
		expect(notices).toEqual([["No model selected; choose one with /model.", "error"]]);
		expect({ confirms, calls, appended }).toEqual({ confirms: [], calls: [], appended: [] });
	});

	it("asks to confirm with the model, the counts and the size, and sends nothing when declined", async () => {
		const { commands, appended } = load();
		const { ctx, notices, confirms, calls, customs } = fakeCtx(branch, "tui", [], { model: MODEL, confirm: false, reply: reply(ONE) });
		await commands.get("replies")!.handler("triage", ctx);
		const { about } = tokens(branch);
		expect(about).toBeGreaterThan(0);
		expect(confirms).toEqual([["Triage open asks?", confirmText("1 open ask and 1 later prompt", about)]]);
		expect({ notices, calls, customs, appended }).toEqual({ notices: [], calls: [], customs: [], appended: [] });
	});

	it("counts asks and prompts in the plural, and 0 later prompts", async () => {
		resetIds();
		const entries = [user("hola"), assistant("¿Arrancamos con T14?\n\n¿Usamos Piper?", { id: "aaaaaaa1" })];
		const { commands } = load();
		const { ctx, confirms } = fakeCtx(entries, "tui", [], { model: MODEL, confirm: false });
		await commands.get("replies")!.handler("triage", ctx);
		expect(confirms[0][1]).toBe(confirmText("2 open asks and 0 later prompts", tokens(entries).about));
	});

	it("sends the system prompt of the last turn, which pi-claude-bridge recorded, not the idle one", async () => {
		const TURN = `${SESSION_PROMPT}\n\n# Added by extensions at before_agent_start`;
		const OLDER = `${SESSION_PROMPT}\n\n# An older turn`;
		const { commands, emit } = load();
		await emit("agent_start", { getSystemPrompt: () => OLDER });
		await emit("turn_start", { getSystemPrompt: () => TURN });
		const triage = fakeCtx(branch, "tui", [], { model: MODEL, confirm: false });
		await commands.get("replies")!.handler("triage", triage.ctx);
		const { message } = tokens(branch);
		const about = Math.ceil((TURN.length + message.length) / 4);
		expect(triage.confirms[0][1]).toBe(confirmText("1 open ask and 1 later prompt", about));
		const sent = fakeCtx(branch, "tui", ["tui.select.cancel"], { model: MODEL, reply: reply(ONE) });
		await commands.get("replies")!.handler("triage", sent.ctx);
		expect(sent.calls[0][1]).toMatchObject({ systemPrompt: TURN });
	});

	it("explains a pi-claude-bridge prompt-capture failure before any turn ran", async () => {
		const failure = "prompt-capture: no capture for this 29212-char system prompt, and it embeds none of the 0 known.";
		const before = fakeCtx(branch, "tui", [], { model: MODEL, reply: reply("", { stopReason: "error", errorMessage: failure }) });
		const { commands, emit, appended } = load();
		await commands.get("replies")!.handler("triage", before.ctx);
		expect(before.notices).toEqual([
			[`Triage failed: ${failure} Send any prompt first so this session records its system prompt, then run the triage again.`, "error"],
		]);
		await emit("turn_start", { getSystemPrompt: () => SESSION_PROMPT });
		const after = fakeCtx(branch, "tui", [], { model: MODEL, reply: reply("", { stopReason: "error", errorMessage: failure }) });
		await commands.get("replies")!.handler("triage", after.ctx);
		expect(after.notices).toEqual([[`Triage failed: ${failure}`, "error"]]);
		expect(appended).toEqual([]);
	});

	it("sends the request to the session model under a loader, stores the proposals, refreshes the widget and opens Pending", async () => {
		const { commands, appended } = load();
		const triage = fakeCtx(branch, "tui", ["tui.select.cancel"], { model: MODEL, reply: reply(ONE) });
		await commands.get("replies")!.handler("TRIAGE", triage.ctx);
		const { sent, message } = tokens(branch);
		// The session's system prompt goes unchanged (pi-claude-bridge accepts only that one); the instructions lead the message.
		expect(message.startsWith(`${sent?.instructions}\n\nOpen questions:\n`)).toBe(true);
		expect(triage.calls).toEqual([
			[
				MODEL,
				{
					systemPrompt: SESSION_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: message }], timestamp: expect.any(Number) }],
				},
				{ signal: expect.any(AbortSignal) },
			],
		]);
		expect(triage.loaders[0].join("\n")).toContain("Triage with anthropic/claude-test… (esc cancels)");
		expect(appended).toEqual([
			[
				"reply-thread.triage",
				{
					model: "anthropic/claude-test",
					proposals: [{ kind: "answered", ask: "a1b2c3d4.1", prompt: "00000006", quote: "la primera" }],
				},
			],
		]);
		expect(triage.notices).toEqual([["Triage: 1 proposal; a accepts and n rejects in Pending.", "info"]]);
		expect(triage.widgets.length).toBeGreaterThan(0);
		expect(triage.customs).toEqual([undefined, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } }]);
		expect(triage.seen[0][0]).toMatch(/^╭─ Pending /);
		expect(triage.seen[0]).toContainEqual(expect.stringMatching(/^│ +✦ answered in P2: "la primera" +│$/));
	});

	it("a in the Pending tab it opens writes the answer, and the count is plural for 2 proposals", async () => {
		resetIds();
		// load() appends to `branch`, so the central rebuilt after the triage sees its proposals.
		branch = [
			user("hola"),
			assistant("¿Arrancamos con T14?\n\n¿Usamos Piper?", { id: "aaaaaaa1" }),
			user("vamos con T14, y Piper me parece bien"),
		];
		const two = JSON.stringify({
			proposals: [
				{ kind: "answered", ask: "P1.R1.Q1", prompt: "P2", quote: "vamos con T14" },
				{ kind: "answered", ask: "P1.R1.Q2", prompt: "P2", quote: "Piper me parece bien" },
			],
		});
		const { commands, appended } = load();
		const { ctx, notices } = fakeCtx(branch, "tui", ["a", "tui.select.cancel"], { model: MODEL, reply: reply(two) });
		await commands.get("replies")!.handler("triage", ctx);
		expect(notices).toEqual([["Triage: 2 proposals; a accepts and n rejects in Pending.", "info"]]);
		expect(appended.slice(1)).toEqual([
			["reply-thread.ask", { action: "answer", ask: "aaaaaaa1.1", prompt: "00000003", text: "vamos con T14" }],
		]);
	});

	it("Esc on the loader cancels: aborts the call, says so, and writes nothing", async () => {
		const { commands, appended } = load();
		let aborted = false;
		const waits = (signal: AbortSignal) =>
			new Promise((resolve) =>
				signal.addEventListener("abort", () => {
					aborted = true;
					resolve({ role: "assistant", content: [], stopReason: "aborted" });
				}),
			);
		const { ctx, notices, customs } = fakeCtx(branch, "tui", [], { model: MODEL, reply: waits, loaderKeys: ["\x1b"] });
		await commands.get("replies")!.handler("triage", ctx);
		expect(aborted).toBe(true);
		expect(notices).toEqual([["Triage cancelled.", "info"]]);
		expect(customs).toEqual([undefined]);
		expect(appended).toEqual([]);
	});

	it("an aborted reply cancels the same way", async () => {
		const { commands, appended } = load();
		const { ctx, notices } = fakeCtx(branch, "tui", [], { model: MODEL, reply: reply(ONE, { stopReason: "aborted" }) });
		await commands.get("replies")!.handler("triage", ctx);
		expect(notices).toEqual([["Triage cancelled.", "info"]]);
		expect(appended).toEqual([]);
	});

	it("reports a failed call, thrown or as an error reply, and writes nothing", async () => {
		const { commands, appended } = load();
		const thrown = fakeCtx(branch, "tui", [], {
			model: MODEL,
			reply: async () => {
				throw new Error("network down");
			},
		});
		await commands.get("replies")!.handler("triage", thrown.ctx);
		expect(thrown.notices).toEqual([["Triage failed: network down", "error"]]);
		const errored = fakeCtx(branch, "tui", [], {
			model: MODEL,
			reply: reply("", { stopReason: "error", errorMessage: "rate limited" }),
		});
		await commands.get("replies")!.handler("triage", errored.ctx);
		expect(errored.notices).toEqual([["Triage failed: rate limited", "error"]]);
		expect(appended).toEqual([]);
		expect([...thrown.customs, ...errored.customs]).toEqual([undefined, undefined]);
	});

	it("says it found nothing when no proposal holds, and writes nothing", async () => {
		const { commands, appended } = load();
		for (const text of ['{"proposals":[]}', "Nothing to propose.", JSON.stringify({ proposals: [{ kind: "answered", ask: "P1.R1.Q1", prompt: "P2", quote: "not in the prompt" }] })]) {
			const { ctx, notices, customs } = fakeCtx(branch, "tui", [], { model: MODEL, reply: reply(text) });
			await commands.get("replies")!.handler("triage", ctx);
			expect(notices).toEqual([["Triage found nothing to propose.", "info"]]);
			expect(customs).toEqual([undefined]);
		}
		expect(appended).toEqual([]);
	});

	it("t in the Pending tab of alt+r closes it, runs the triage and reopens Pending with the proposals", async () => {
		const { shortcuts, appended } = load();
		const { ctx, seen, customs, confirms, calls, notices, pastes } = fakeCtx(branch, "tui", ["t"], { model: MODEL, reply: reply(ONE) });
		await shortcuts.get("alt+r")!.handler(ctx);
		const overlay = { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } };
		expect(customs).toEqual([overlay, undefined, overlay]);
		expect(seen[0][0]).toMatch(/^╭─ Pending /);
		expect(confirms).toEqual([["Triage open asks?", confirmText("1 open ask and 1 later prompt", tokens(branch).about)]]);
		expect(calls).toHaveLength(1);
		expect(calls[0][1]).toMatchObject({ systemPrompt: SESSION_PROMPT });
		expect(appended.map(([type]) => type)).toEqual(["reply-thread.triage"]);
		expect(notices).toEqual([["Triage: 1 proposal; a accepts and n rejects in Pending.", "info"]]);
		expect(seen.at(-1)?.[0]).toMatch(/^╭─ Pending /);
		expect(seen.at(-1)).toContainEqual(expect.stringMatching(/^│ +✦ answered in P2: "la primera" +│$/));
		expect(pastes).toEqual([]);
	});

	it("t that ends declined, failed or empty gives only its notice and does not reopen the central", async () => {
		const cases: [TriageSetup, [string, string][]][] = [
			[{ model: MODEL, confirm: false, reply: reply(ONE) }, []],
			[{ model: MODEL, reply: reply("", { stopReason: "error", errorMessage: "rate limited" }) }, [["Triage failed: rate limited", "error"]]],
			[{ model: MODEL, reply: reply(ONE, { stopReason: "aborted" }) }, [["Triage cancelled.", "info"]]],
			[{ model: MODEL, reply: reply('{"proposals":[]}') }, [["Triage found nothing to propose.", "info"]]],
			[{ reply: reply(ONE) }, [["No model selected; choose one with /model.", "error"]]],
		];
		for (const [setup, expected] of cases) {
			const { commands, appended } = load();
			const { ctx, customs, notices, pastes } = fakeCtx(branch, "tui", ["t"], setup);
			await commands.get("replies")!.handler("", ctx);
			expect(notices).toEqual(expected);
			expect(customs.filter(Boolean)).toHaveLength(1);
			expect({ appended, pastes }).toEqual({ appended: [], pastes: [] });
		}
	});

	it("t in an empty Pending tab closes it and says there is nothing to triage, with no confirm", async () => {
		const { commands, appended } = load();
		branch.push(askEntry({ action: "dismiss", ask: "a1b2c3d4.1" }));
		const { ctx, customs, notices, confirms, calls } = fakeCtx(branch, "tui", ["t"], { model: MODEL, reply: reply(ONE) });
		await commands.get("replies")!.handler("pending", ctx);
		expect(notices).toEqual([["No open asks to triage.", "info"]]);
		expect(customs).toHaveLength(1);
		expect({ confirms, calls, appended }).toEqual({ confirms: [], calls: [], appended: [] });
	});

	it("leaves /replies pending and /replies <id> as they were, with a triage on the branch and no model call", async () => {
		branch.push(
			customEntry("reply-thread.triage", {
				model: "anthropic/claude-test",
				proposals: [{ kind: "answered", ask: "a1b2c3d4.1", prompt: "00000006", quote: "la primera" }],
			}),
		);
		const { commands, appended } = load();
		const pending = fakeCtx(branch, "print", [], { model: MODEL });
		await commands.get("replies")!.handler("pending", pending.ctx);
		expect(pending.notices).toEqual([["P1.R1.Q1  a1b2c3d4.1  Encontré dos opciones. ¿Cuál preferís?", "info"]]);
		const one = fakeCtx(branch, "print", [], { model: MODEL });
		await commands.get("replies")!.handler("P1.R1", one.ctx);
		expect(one.notices).toEqual([["P1.R1 · a1b2c3d4 · 12:00 · prompt\n\nEncontré dos opciones. ¿Cuál preferís?", "info"]]);
		expect([...pending.calls, ...one.calls, ...pending.confirms, ...one.confirms]).toEqual([]);
		expect(appended).toEqual([]);
	});
});

describe("reading aloud with pi-reply-reader", () => {
	const hint = (lines: string[]) => lines.at(-1) ?? "";

	it("s on the Replies tab reads the selected reply and keeps the overlay open", async () => {
		const { shortcuts, reads, pings, appended, listening } = load("section", { reader: true });
		const { ctx, seen, pastes, notices } = fakeCtx(branch, "tui", ["s"]);
		void shortcuts.get("alt+r")!.handler(ctx);
		expect(pings).toEqual([{ v: 1 }]);
		expect(reads).toEqual([{ v: 1, id: "P1.R1", text: "Encontré dos opciones." }]);
		expect(seen[1]).toEqual(seen[0]);
		expect(hint(seen[0])).toContain("s read");
		expect({ pastes, notices, appended }).toEqual({ pastes: [], notices: [], appended: [] });
		expect(listening("reply-reader:ready")).toBe(0);
	});

	it("s in the reply viewer reads the open reply", async () => {
		const { shortcuts, reads } = load("section", { reader: true });
		const { ctx, seen } = fakeCtx(branch, "tui", ["tui.select.confirm", "s"]);
		void shortcuts.get("alt+r")!.handler(ctx);
		expect(seen[1][0]).toMatch(/^╭─ P1\.R1 /);
		expect(reads).toEqual([{ v: 1, id: "P1.R1", text: "Encontré dos opciones." }]);
		expect(hint(seen[1])).toContain("s read");
	});

	it("s in Pending reads only the selected ask, in Answered the selected closed ask", async () => {
		branch[1] = assistant("Encontré dos opciones. ¿Cuál preferís?", { id: "a1b2c3d4" });
		const pending = load("section", { reader: true });
		const open = fakeCtx(branch, "tui", ["s"]);
		void pending.shortcuts.get("alt+r")!.handler(open.ctx);
		expect(open.seen[0][0]).toMatch(/^╭─ Pending /);
		expect(pending.reads).toEqual([{ v: 1, id: "P1.R1.Q1", text: "Encontré dos opciones. ¿Cuál preferís?" }]);
		expect(hint(open.seen[0])).toContain("s read");
		expect({ pastes: open.pastes, appended: pending.appended }).toEqual({ pastes: [], appended: [] });
		branch.push(user("> P1.R1.Q1: Encontré dos opciones. ¿Cuál preferís?\nLa primera."));
		const answered = load("section", { reader: true });
		const closed = fakeCtx(branch, "tui", ["\t", "s"]);
		void answered.shortcuts.get("alt+r")!.handler(closed.ctx);
		expect(closed.seen[1][0]).toMatch(/^╭─ Answered /);
		expect(answered.reads).toEqual([{ v: 1, id: "P1.R1.Q1", text: "Encontré dos opciones. ¿Cuál preferís?" }]);
	});

	it("without pi-reply-reader, s does nothing and no hint shows", async () => {
		branch[1] = assistant("Encontré dos opciones. ¿Cuál preferís?", { id: "a1b2c3d4" });
		const { shortcuts, reads, listening } = load();
		const { ctx, seen } = fakeCtx(branch, "tui", ["s", "?"]);
		void shortcuts.get("alt+r")!.handler(ctx);
		expect(reads).toEqual([]);
		expect(hint(seen[0])).not.toContain("s read");
		expect(seen[1].join("\n")).not.toContain("(pi-reply-reader)");
		expect(listening("reply-reader:ready")).toBe(0);
	});

	it("the help lists s when pi-reply-reader is there", async () => {
		branch[1] = assistant("Encontré dos opciones. ¿Cuál preferís?", { id: "a1b2c3d4" });
		const { shortcuts } = load("section", { reader: true });
		const { ctx, seen } = fakeCtx(branch, "tui", ["?"]);
		void shortcuts.get("alt+r")!.handler(ctx);
		expect(seen[1].join("\n")).toContain("(pi-reply-reader)");
	});
});

describe("reply-thread extension: dialogs while a tool runs", () => {
	const start = (toolCallId: string, toolName: string, args: unknown = {}) => ({ toolCallId, toolName, args });

	it("records a confirm during bash with its title, the tool and the program name only", async () => {
		const { emit, appended } = load();
		const { ctx } = fakeCtx(branch, "tui");
		await emit("tool_execution_start", ctx, start("call-b", "bash", { command: "  git push origin main --tags" }));
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Run a guarded command?" });
		expect(appended).toStrictEqual([
			[
				"reply-thread.pause",
				{ toolCallId: "call-b", toolName: "bash", kind: "confirm", title: "Run a guarded command?", program: "git" },
			],
		]);
	});

	it("records a dialog during another tool without a program, and without a title when it has none", async () => {
		const { emit, appended } = load();
		const { ctx } = fakeCtx(branch, "tui");
		await emit("tool_execution_start", ctx, start("call-w", "write", { path: "a.ts", command: "nope" }));
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "select" });
		expect(appended).toStrictEqual([["reply-thread.pause", { toolCallId: "call-w", toolName: "write", kind: "select" }]]);
	});

	it("takes the newest tool still running that is not an ask tool", async () => {
		const { emit, appended } = load();
		const { ctx } = fakeCtx(branch, "tui");
		await emit("tool_execution_start", ctx, start("call-1", "bash", { command: "ls -la" }));
		await emit("tool_execution_start", ctx, start("call-2", "edit", {}));
		await emit("tool_execution_start", ctx, start("call-3", "ask_user_question", { questions: [] }));
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "custom", title: "Review consent" });
		await emit("tool_execution_end", ctx, { toolCallId: "call-2", toolName: "edit", isError: false });
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Again?" });
		expect(appended).toStrictEqual([
			["reply-thread.pause", { toolCallId: "call-2", toolName: "edit", kind: "custom", title: "Review consent" }],
			["reply-thread.pause", { toolCallId: "call-1", toolName: "bash", kind: "confirm", title: "Again?", program: "ls" }],
		]);
	});

	it("ignores a dialog of an ask tool, a dialog with no tool running and one after its tool ended", async () => {
		const { emit, appended } = load();
		const { ctx } = fakeCtx(branch, "tui");
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Triage open asks?" });
		await emit("tool_execution_start", ctx, start("call-q", "ask_user_question", { questions: [] }));
		await emit("tool_execution_start", ctx, start("call-c", "ask_user_choice", { question: "x" }));
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "custom" });
		await emit("tool_execution_start", ctx, start("call-b", "bash", { command: "make clean" }));
		await emit("tool_execution_end", ctx, { toolCallId: "call-b", toolName: "bash", isError: false });
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Later" });
		expect(appended).toEqual([]);
	});

	it("leaves out the program when the bash command is not a string or is blank", async () => {
		const { emit, appended } = load();
		const { ctx } = fakeCtx(branch, "tui");
		await emit("tool_execution_start", ctx, start("call-b", "bash", { command: 42 }));
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Run?" });
		await emit("tool_execution_end", ctx, { toolCallId: "call-b", toolName: "bash", isError: false });
		await emit("tool_execution_start", ctx, start("call-c", "bash", { command: "   " }));
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Run?" });
		expect(appended).toStrictEqual([
			["reply-thread.pause", { toolCallId: "call-b", toolName: "bash", kind: "confirm", title: "Run?" }],
			["reply-thread.pause", { toolCallId: "call-c", toolName: "bash", kind: "confirm", title: "Run?" }],
		]);
	});

	it("skips leading NAME=value assignments: the program is the command, never a variable's value", async () => {
		const { emit, appended } = load();
		const { ctx } = fakeCtx(branch, "tui");
		await emit("tool_execution_start", ctx, start("call-b", "bash", { command: "FOO=bar BAZ='q' make build" }));
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Run?" });
		await emit("tool_execution_end", ctx, { toolCallId: "call-b", toolName: "bash", isError: false });
		await emit("tool_execution_start", ctx, start("call-c", "bash", { command: "FOO=bar" }));
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Run?" });
		expect(appended).toStrictEqual([
			["reply-thread.pause", { toolCallId: "call-b", toolName: "bash", kind: "confirm", title: "Run?", program: "make" }],
			["reply-thread.pause", { toolCallId: "call-c", toolName: "bash", kind: "confirm", title: "Run?" }],
		]);
	});

	it("names the program like pi-reply-reader: quoted assignments, a bare sudo or env and the folder are skipped", async () => {
		const { emit, appended } = load();
		const { ctx } = fakeCtx(branch, "tui");
		const commands = [
			"FOO=1 sudo /usr/bin/git push",
			"sudo -u x cmd",
			`A="one two" B='x y' env C=3 ./run.sh --all`,
			"env -i ls",
			"sudo",
		];
		for (const [index, command] of commands.entries()) {
			await emit("tool_execution_start", ctx, start(`call-${index}`, "bash", { command }));
			await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Run?" });
			await emit("tool_execution_end", ctx, { toolCallId: `call-${index}`, toolName: "bash", isError: false });
		}
		expect(appended.map(([, data]) => (data as { program?: string }).program)).toEqual(["git", "sudo", "run.sh", "env", "sudo"]);
	});

	it("closes the recorded dialog with the tool's outcome in the reply that ends the turn", async () => {
		const { emit } = load();
		branch.push(user("pusheá"), toolCalls([{ id: "call-b", name: "bash", arguments: { command: "git push" } }]));
		const { ctx } = fakeCtx(branch, "tui");
		await emit("tool_execution_start", ctx, start("call-b", "bash", { command: "git push" }));
		await emit("ui_prompt_start", ctx, { reason: "ui_prompt", kind: "confirm", title: "Allow git push?" });
		await emit("tool_execution_end", ctx, { toolCallId: "call-b", toolName: "bash", isError: false });
		branch.push(toolResultOf("call-b", "bash", "Everything up-to-date"), assistant("Pusheado.", { id: "f1f1f1f1" }));
		expect(buildThreads(branch).at(-1)?.replies[0].pauses).toEqual([
			{ text: "Allow git push? [bash: git]", answer: "ran", tool: "bash", program: "git" },
		]);
	});
});

describe("draft and remembered place", () => {
	beforeEach(() => {
		branch = [
			user("revisá el paquete"),
			assistant("Listo.\n\n¿Borro la rama vieja?\n\n¿Publico la versión nueva?\n\n¿Actualizo el README del paquete?", {
				id: "a1b2c3d4",
			}),
		];
	});

	/** The ordinal on the selected row of a frame, `›` in front of it. */
	const selected = (frame: string[] | undefined) => frame?.map((line) => /^│ ›. (P\S+)/.exec(line)?.[1]).find(Boolean);

	it("opens Pending on the first row and Enter pastes it, without a draft or a remembered place", async () => {
		const { shortcuts } = load();
		const { ctx, seen, pastes } = fakeCtx(branch, "tui", ["tui.select.confirm"], {}, "");
		await shortcuts.get("alt+r")!.handler(ctx);
		expect(seen[0][0]).toMatch(/^╭─ Pending ─+ 3 open · 0 linked ─╮$/);
		expect(selected(seen[0])).toBe("P1.R1.Q1");
		expect(pastes).toEqual(["> P1.R1.Q1: ¿Borro la rama vieja?\nR: "]);
	});

	it("reopens on the remembered ask, then on the same row after that ask closes", async () => {
		const { shortcuts } = load();
		const first = fakeCtx(branch, "tui", ["tui.select.down", "tui.select.cancel"]);
		await shortcuts.get("alt+r")!.handler(first.ctx);
		const again = fakeCtx(branch, "tui");
		await shortcuts.get("alt+r")!.handler(again.ctx);
		expect(selected(again.seen[0])).toBe("P1.R1.Q2");
		branch.push(user("> P1.R1.Q2: ¿Publico la versión nueva?\nR: sí"));
		const after = fakeCtx(branch, "tui");
		await shortcuts.get("alt+r")!.handler(after.ctx);
		expect(selected(after.seen[0])).toBe("P1.R1.Q3");
	});

	it("forgets the place on session_start", async () => {
		const { shortcuts, emit } = load();
		const first = fakeCtx(branch, "tui", ["tui.select.down", "tui.select.down", "tui.select.cancel"]);
		await shortcuts.get("alt+r")!.handler(first.ctx);
		await emit("session_start", first.ctx);
		const again = fakeCtx(branch, "tui");
		await shortcuts.get("alt+r")!.handler(again.ctx);
		expect(selected(again.seen[0])).toBe("P1.R1.Q1");
	});

	it("reads the draft from the editor on each open: ✎ on its asks, and Enter does not paste them again", async () => {
		const { commands } = load();
		const draft = "> P1.R1.Q1: ¿Borro la rama vieja?\nR: sí";
		const { ctx, seen, pastes } = fakeCtx(branch, "tui", ["tui.select.confirm"], {}, draft);
		await commands.get("replies")!.handler("", ctx);
		expect(seen[0][0]).toMatch(/^╭─ Pending ─+ 3 open · 0 linked · 1 in draft ─╮$/);
		expect(seen[0][2]).toMatch(/^│ ›✎ P1\.R1\.Q1 /);
		expect(seen[0][3]).toMatch(/^│  ○ P1\.R1\.Q2 /);
		expect(pastes).toEqual([]);
		const later = fakeCtx(branch, "tui", [], {}, "");
		await commands.get("replies")!.handler("", later.ctx);
		expect(later.seen[0][0]).toMatch(/ 3 open · 0 linked ─╮$/);
	});
});
