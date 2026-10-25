process.env.TZ = "UTC";

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import replyThread from "../extensions/reply-thread.ts";
import { assistant, jobNotice, resetIds, user } from "./helpers.ts";

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

function load() {
	const commands = new Map<string, Command>();
	const shortcuts = new Map<string, Shortcut>();
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerCommand: (name: string, options: Command) => commands.set(name, options),
		registerShortcut: (key: string, options: Shortcut) => shortcuts.set(key, options),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	};
	replyThread(pi as unknown as ExtensionAPI);
	const emit = async (event: string, ctx: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
	};
	return { commands, shortcuts, emit };
}

function fakeCtx(branch: SessionEntry[], mode: "tui" | "print" = "print") {
	const notices: [string, string | undefined][] = [];
	const widgets: [string, unknown, unknown][] = [];
	const customs: unknown[] = [];
	const ctx = {
		mode,
		hasUI: mode === "tui",
		ui: {
			notify: (message: string, type?: string) => notices.push([message, type]),
			setWidget: (key: string, content: unknown, options?: unknown) => widgets.push([key, content, options]),
			custom: async (_factory: unknown, options: unknown) => {
				customs.push(options);
			},
		},
		sessionManager: { getBranch: () => branch },
	};
	return { ctx, notices, widgets, customs };
}

const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

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
			"List the replies of each prompt; /replies <P#.R# | entry ID> opens one in full",
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
		expect(shortcut?.description).toBe("Open the reply index (/replies)");
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

