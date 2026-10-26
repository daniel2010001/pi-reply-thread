process.env.TZ = "UTC";

import type { ExtensionAPI, KeybindingsManager, SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import replyThread from "../extensions/reply-thread.ts";
import { askEntry, assistant, customEntry, jobNotice, resetIds, user } from "./helpers.ts";

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
function load(flag: string | boolean | undefined = "section") {
	const appended: [string, unknown][] = [];
	const flags = new Map<string, unknown>();
	const commands = new Map<string, Command>();
	const shortcuts = new Map<string, Shortcut>();
	const handlers = new Map<string, Handler[]>();
	const pi = {
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
	const emit = async (event: string, ctx: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
	};
	return { commands, shortcuts, emit, appended, flags };
}

const KEYS: Record<string, string> = { "tui.select.confirm": "\r", "tui.select.cancel": "\x1b", "tui.select.down": "\x1b[B" };
const keybindings = { matches: (data: string, action: string) => KEYS[action] === data } as unknown as KeybindingsManager;

interface Overlay {
	handleInput(data: string): void;
	render(width: number): string[];
}

/** `keys` are pressed in the overlay once it opens; `seen` keeps its first frame and, after keys, its last. */
function fakeCtx(branch: SessionEntry[], mode: "tui" | "print" = "print", keys: string[] = []) {
	const pastes: string[] = [];
	const seen: string[][] = [];
	const notices: [string, string | undefined][] = [];
	const widgets: [string, unknown, unknown][] = [];
	const customs: unknown[] = [];
	const ctx = {
		mode,
		hasUI: mode === "tui",
		ui: {
			notify: (message: string, type?: string) => notices.push([message, type]),
			setWidget: (key: string, content: unknown, options?: unknown) => widgets.push([key, content, options]),
			custom: (factory: unknown, options: unknown) => {
				customs.push(options);
				return new Promise((resolve) => {
					const tui = { terminal: { rows: 30 }, requestRender: () => {} };
					const make = factory as (...args: unknown[]) => Overlay;
					const overlay = make(tui, fakeTheme, keybindings, resolve);
					seen.push(overlay.render(80).map(stripTerminalSequences));
					for (const key of keys) overlay.handleInput(KEYS[key] ?? key);
					if (keys.length) seen.push(overlay.render(80).map(stripTerminalSequences));
					else resolve(undefined);
				});
			},
			pasteToEditor: (text: string) => pastes.push(text),
		},
		sessionManager: { getBranch: () => branch },
	};
	return { ctx, notices, widgets, customs, pastes, seen };
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
			"List the replies of each prompt and the asks waiting on you; /replies <P#.R#[.Q#] | entry ID[.#]> opens one in full, /replies pending lists the open asks",
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
