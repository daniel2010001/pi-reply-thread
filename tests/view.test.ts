process.env.TZ = "UTC";

import {
	initTheme,
	type KeybindingsManager,
	type Theme,
	type ThemeBg,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RepliesView } from "../extensions/replies-view.ts";
import { buildThreads, type Thread } from "../src/threads.ts";
import { assistant, jobNotice, resetIds, user, workerResult } from "./helpers.ts";

const KEYS: Record<string, string> = {
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
	"tui.select.confirm": "\r",
	"tui.select.cancel": "\x1b",
	"tui.select.pageUp": "\x1b[5~",
	"tui.select.pageDown": "\x1b[6~",
};

const keybindings = { matches: (data: string, action: string) => KEYS[action] === data } as unknown as KeybindingsManager;

let theme: Theme;

beforeAll(async () => {
	initTheme("dark", false);
	const { theme: active } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
	theme = active as Theme;
});

function fg(token: ThemeColor): string {
	return theme.fg(token, "\0").split("\0")[0];
}

function bg(token: ThemeBg): string {
	return theme.bg(token, "\0").split("\0")[0];
}

function view(threads: readonly Thread[], options: { rows?: number; direct?: string } = {}) {
	let closed = false;
	const tui = { terminal: { rows: options.rows ?? 30 }, requestRender: () => {} } as unknown as TUI;
	const direct = options.direct
		? threads.flatMap((thread) => thread.replies).find((reply) => reply.ordinal === options.direct)
		: undefined;
	const component = new RepliesView(tui, theme, keybindings, threads, () => (closed = true), direct);
	return {
		component,
		press: (action: string) => component.handleInput(KEYS[action]),
		lines: (width = 80) => component.render(width),
		text: (width = 80) => component.render(width).map(stripTerminalSequences),
		closed: () => closed,
	};
}

let threads: Thread[];

beforeEach(() => {
	resetIds();
	threads = buildThreads([
		user("buscá si existe algo así"),
		assistant("Encontré dos opciones. ¿Cuál preferís?", { id: "a1b2c3d4" }),
		jobNotice("job-1", "tests"),
		assistant("Tests en verde.", { id: "e5f6a7b8" }),
		user("arreglá el widget"),
		assistant("Listo.", { id: "77aa01bc" }),
		workerResult("gentle-ai-worker", "mvlp-1", "docs"),
		assistant("Docs listas.", { id: "c9d0e1f2" }),
	]);
});

describe("RepliesView list", () => {
	it("draws a rounded frame that fills the width, with the title, counts and key hints", () => {
		for (const width of [80, 40]) {
			const lines = view(threads).text(width);
			expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
			expect(lines[0]).toMatch(/^╭─ Replies ─+ 2 prompts · 4 replies ─╮$/);
			expect(lines.at(-1)).toMatch(/^╰─ ↑↓ move · enter open · esc close ─+╯$/);
			expect(lines.slice(1, -1).every((line) => line.startsWith("│ ") && line.endsWith("│"))).toBe(true);
		}
	});

	it("shows each prompt newest first on the user-message background with its time on the right", () => {
		const { lines, text } = view(threads);
		const rows = text();
		expect(rows[1]).toMatch(/^│ ▌P2  arreglá el widget +12:00 │$/);
		expect(rows[4]).toMatch(/^│ ▌P1  buscá si existe algo así +12:00 │$/);
		expect(lines()[1]).toContain(bg("userMessageBg"));
	});

	it("draws the replies of a prompt as a tree and marks the selected one", () => {
		const { lines, text, press } = view(threads);
		expect(text().slice(2, 4)).toEqual([
			expect.stringMatching(/^│ ›├ P2\.R1  77aa01bc  prompt +│$/),
			expect.stringMatching(/^│  └ P2\.R2  c9d0e1f2  worker: docs +│$/),
		]);
		expect(lines()[2]).toContain(bg("selectedBg"));
		expect(lines()[3]).not.toContain(bg("selectedBg"));
		press("tui.select.down");
		expect(text()[3]).toMatch(/^│ ›└ P2\.R2/);
		expect(lines()[3]).toContain(bg("selectedBg"));
	});

	it("colours each trigger kind with its own theme token", () => {
		const lines = view(threads).lines();
		expect(lines[3]).toContain(`${fg("customMessageLabel")}worker: docs`);
		expect(lines[6]).toContain(`${fg("success")}job: tests`);
		expect(lines[5]).toContain(`${fg("muted")}prompt`);
	});

	it("shows the first open ask of a reply after a warning sign", () => {
		const { lines, text } = view(threads);
		expect(text()[5]).toMatch(/^│  ├ P1\.R1  a1b2c3d4  prompt +⚠ Encontré dos opciones\. ¿Cuál preferís\? +│$/);
		expect(lines()[5]).toContain(`${fg("warning")}⚠`);
	});

	it("turns the right border into a scrollbar only when the rows do not fit", () => {
		const scrollColumn = (lines: string[]) => lines.slice(1, -1).map((line) => [...line].at(-1));
		expect(scrollColumn(view(threads).text()).every((cell) => cell === "│")).toBe(true);
		const small = view(threads, { rows: 9 }).text();
		expect(small).toHaveLength(5);
		expect(scrollColumn(small)).toContain("┃");
	});

	it("closes on esc and opens the selected reply on enter", () => {
		const list = view(threads);
		list.press("tui.select.confirm");
		expect(list.text()[0]).toContain("P2.R1");
		list.press("tui.select.cancel");
		expect(list.text()[0]).toContain("Replies");
		expect(list.closed()).toBe(false);
		list.press("tui.select.cancel");
		expect(list.closed()).toBe(true);
	});

	it("keeps an empty branch inside the frame", () => {
		const lines = view([]).text(50);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toMatch(/^│ No replies on this branch yet\. +│$/);
		expect(lines.every((line) => visibleWidth(line) === 50)).toBe(true);
	});
});

describe("RepliesView viewer", () => {
	it("frames the reply under a card with its IDs, time, trigger, prompt and open asks", () => {
		const { lines, text } = view(threads, { direct: "P1.R1" });
		const rows = text();
		expect(rows.every((line) => visibleWidth(line) === 80)).toBe(true);
		expect(rows[0]).toMatch(/^╭─ P1\.R1 ─+ a1b2c3d4 · 12:00 · prompt ─╮$/);
		expect(rows[1]).toMatch(/^│ ▌ buscá si existe algo así +│$/);
		expect(rows[2]).toMatch(/^│ ⚠ Waits on you +│$/);
		expect(rows[3]).toMatch(/^│   • Encontré dos opciones\. ¿Cuál preferís\? +│$/);
		expect(rows[4]).toMatch(/^├─+┤$/);
		expect(rows[5]).toMatch(/^│ Encontré dos opciones\. ¿Cuál preferís\? +│$/);
		expect(rows.at(-1)).toMatch(/^╰─ ↑↓ scroll · pgup\/pgdn page · esc close ─+╯$/);
		expect(lines()[1]).toContain(bg("userMessageBg"));
		expect(lines()[2]).toContain(fg("warning"));
	});

	it("leaves out the open asks section for a reply that waits on nothing", () => {
		const rows = view(threads, { direct: "P1.R2" }).text();
		expect(rows[0]).toMatch(/ e5f6a7b8 · 12:00 · job: tests ─╮$/);
		expect(rows[2]).toMatch(/^├─+┤$/);
		expect(rows[3]).toMatch(/^│ Tests en verde\. +│$/);
	});

	it("shows the scroll position and a scrollbar for a reply longer than the screen", () => {
		resetIds();
		const long = buildThreads([
			user("dame una lista larga"),
			assistant(Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n\n")),
		]);
		const reader = view(long, { rows: 20, direct: "P1.R1" });
		const first = reader.text();
		expect(first.at(-1)).toMatch(/esc close · 1-12\/79 ─+╯$/);
		expect(first.slice(3, -1).map((line) => [...line].at(-1))).toContain("┃");
		expect(first.slice(3, -1).every((line) => [...line].at(-2) === " ")).toBe(true);
		reader.press("tui.select.pageDown");
		expect(reader.text().at(-1)).toMatch(/ · 12-23\/79 ─+╯$/);
	});

	it("goes back to the list on esc when opened from it", () => {
		const list = view(threads);
		list.press("tui.select.confirm");
		expect(list.text().at(-1)).toContain("esc back");
	});
});

describe("RepliesView on any screen", () => {
	const longReply = (asks = 0) => {
		resetIds();
		const questions = Array.from({ length: asks }, (_, index) => `¿Pregunta ${index + 1}?`);
		const lines = Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`);
		return buildThreads([user("dame una lista larga"), assistant([...questions, ...lines].join("\n\n"))]);
	};

	it("stays within Pi's overlay cap of 90% of a tall screen and keeps the bottom border", () => {
		for (const rows of [41, 50, 80]) {
			const reader = view(longReply(), { rows, direct: "P1.R1" }).text();
			expect(reader.length).toBe(Math.floor(rows * 0.9));
			expect(reader.at(-1)).toMatch(/^╰─ .* ─+╯$/);
			const many = buildThreads(
				Array.from({ length: 40 }, (_, index) => [user(`prompt ${index}`), assistant(`reply ${index}`)]).flat(),
			);
			const list = view(many, { rows }).text();
			expect(list.length).toBe(Math.floor(rows * 0.9));
			expect(list.at(-1)).toMatch(/^╰─ .* ─+╯$/);
		}
	});

	it("caps the open asks so the reply keeps room on a short screen", () => {
		const rows = view(longReply(7), { rows: 14, direct: "P1.R1" }).text();
		expect(rows).toHaveLength(10);
		expect(rows.slice(1, 5)).toEqual([
			expect.stringMatching(/^│ ▌ dame una lista larga +│$/),
			expect.stringMatching(/^│ ⚠ Waits on you +│$/),
			expect.stringMatching(/^│   • ¿Pregunta 1\? +│$/),
			expect.stringMatching(/^│   … 6 more in the reply +│$/),
		]);
		expect(rows[5]).toMatch(/^├─+┤$/);
		expect(rows.slice(6, -1)).toHaveLength(3);
		expect(rows.at(-1)).toMatch(/^╰─ .* ─+╯$/);
	});

	it("shows every open ask when they fit", () => {
		const rows = view(longReply(7), { rows: 30, direct: "P1.R1" }).text();
		expect(rows.filter((line) => line.includes("• ¿Pregunta"))).toHaveLength(7);
		expect(rows.some((line) => line.includes("more in the reply"))).toBe(false);
	});

	it("never grows past a tiny screen", () => {
		for (const rows of [8, 10, 12]) {
			const cap = rows - 4;
			const reader = view(longReply(7), { rows, direct: "P1.R1" }).text();
			expect(reader.length).toBeLessThanOrEqual(cap);
			expect(reader.at(-1)).toMatch(/^╰─/);
			const list = view(threads, { rows }).text();
			expect(list.length).toBeLessThanOrEqual(cap);
			expect(list.at(-1)).toMatch(/^╰─/);
		}
	});
});

