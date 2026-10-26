process.env.TZ = "UTC";

import {
	initTheme,
	type KeybindingsManager,
	type SessionEntry,
	type Theme,
	type ThemeBg,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RepliesView } from "../extensions/replies-view.ts";
import type { AskMode } from "../src/asks.ts";
import type { AnswerFormat } from "../src/format.ts";
import { type AskAction, buildAsks } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { askEntry, assistant, resetIds, user } from "./helpers.ts";

const KEYS: Record<string, string> = {
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
	"tui.select.confirm": "\r",
	"tui.select.cancel": "\x1b",
	"tui.select.pageUp": "\x1b[5~",
	"tui.select.pageDown": "\x1b[6~",
};

const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

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

/** The central over a branch; `act` appends the entry as Pi would and rebuilds from the branch. */
function central(
	entries: SessionEntry[],
	options: { rows?: number; tab?: "pending" | "replies"; format?: AnswerFormat; mode?: AskMode } = {},
) {
	let closed: { paste?: string } | undefined;
	const actions: AskAction[] = [];
	const formats: AnswerFormat[] = [];
	const tui = { terminal: { rows: options.rows ?? 30 }, requestRender: () => {} } as unknown as TUI;
	const act = (action: AskAction) => {
		actions.push(action);
		entries.push(askEntry(action as unknown as Record<string, string>));
		return buildAsks(entries, buildThreads(entries, mode));
	};
	const mode = options.mode ?? "section";
	const threads = buildThreads(entries, mode);
	const component = new RepliesView(
		tui,
		theme,
		keybindings,
		threads,
		(paste?: string) => (closed = { paste }),
		undefined,
		{
			...buildAsks(entries, threads),
			act,
			tab: options.tab,
			format: options.format ?? "lines",
			setFormat: (format) => formats.push(format),
			mode,
		},
	);
	const key = (data: string) => component.handleInput(KEYS[data] ?? data);
	return {
		component,
		key,
		keys: (...data: string[]) => data.forEach(key),
		lines: (width = 80) => component.render(width),
		text: (width = 80) => component.render(width).map(stripTerminalSequences),
		closed: () => closed,
		actions,
		formats,
	};
}

let branch: SessionEntry[];

beforeEach(() => {
	resetIds();
	branch = [
		user("limpiá la rama"),
		assistant("Hay tres ramas viejas. ¿Las borro?\n\nNecesito tu OK para pushear.", { id: "a1b2c3d4" }),
		user("seguí"),
		assistant("Listo.", { id: "e5f6a7b8" }),
		user("revisá los tests"),
		assistant("Tests en verde.\n\n¿Borro las tres ramas viejas?", { id: "c9d0e1f2" }),
	];
});

describe("Pending tab", () => {
	it("opens on Pending when an ask is open, with the counts in the title, and Tab switches", () => {
		const view = central(branch);
		for (const width of [80, 40]) {
			const lines = view.text(width);
			expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
		}
		const rows = view.text(120);
		// P3.R1.Q1 repeats P1.R1.Q1, and a repeat group counts once.
		expect(rows[0]).toMatch(/^╭─ Pending ─+ 2 open · 0 linked ─╮$/);
		expect(rows.at(-1)).toMatch(
			/^╰─ enter answer · y yes · f format · \? help · esc close ─+╯$/,
		);
		view.key("\t");
		expect(view.text()[0]).toMatch(/^╭─ Replies ─+ 3 prompts · 3 replies ─╮$/);
		expect(view.text().at(-1)).toMatch(/^╰─ ↑↓ move · enter open · esc close ─+╯$/);
		view.key("\t");
		expect(view.text()[0]).toMatch(/^╭─ Answered /);
		view.key("\t");
		expect(view.text()[0]).toMatch(/^╭─ Pending /);
	});

	it("opens on Replies when nothing is open", () => {
		const view = central([user("hola"), assistant("Listo.")]);
		expect(view.text()[0]).toMatch(/^╭─ Replies /);
		view.keys("\t", "\t");
		expect(view.text()).toEqual([
			expect.stringMatching(/^╭─ Pending ─+╮$/),
			expect.stringMatching(/^│ Nothing waits on you\. +│$/),
			expect.stringMatching(/^╰─ tab replies · esc close ─+╯$/),
		]);
	});

	it("groups the open asks under their prompt, newest prompt first, a repeat folded into the newer row with ≈", () => {
		const { lines, text } = central(branch);
		expect(text().slice(1, 5)).toEqual([
			expect.stringMatching(/^│ ▌P3  revisá los tests +12:00 │$/),
			expect.stringMatching(/^│ ›○ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?  ≈ 1 similar +│$/),
			expect.stringMatching(/^│ ▌P1  limpiá la rama +12:00 │$/),
			expect.stringMatching(/^│  ○ P1\.R1\.Q2  Necesito tu OK para pushear\. +│$/),
		]);
		expect(lines()[1]).toContain(bg("userMessageBg"));
		expect(lines()[2]).toContain(bg("selectedBg"));
		expect(lines()[2]).toContain(`${fg("muted")}  ≈ 1 similar`);
		expect(lines()[2]).toContain(`${fg("muted")}○`);
		expect(lines()[4]).not.toContain(bg("selectedBg"));
	});

	it("cuts a long ask before the chain or suggestion so the suffix stays visible", () => {
		resetIds();
		const long = central([
			user("a"),
			assistant("¿Los borro?", { id: "aaaaaaa1" }),
			user("b"),
			assistant(`¿Los borro? ${"palabra ".repeat(20)}¿Los borro?`, { id: "aaaaaaa2" }),
			askEntry({ action: "link", ask: "aaaaaaa2.1", continues: "aaaaaaa1.1" }),
		]);
		const row = long.text(60)[2];
		expect(visibleWidth(row)).toBe(60);
		expect(row).toMatch(/^│ ›○ P2\.R1\.Q1  ¿Los borro\? palabra.*…  ↺ P1\.R1\.Q1 │$/);
		expect(long.lines(60)[2]).toContain(`${fg("muted")}  ↺ P1.R1.Q1`);
	});
});

describe("answering from the central", () => {
	it("Enter closes and pastes the selected ask as a quote with an R: line under it", () => {
		const view = central(branch);
		view.key("tui.select.confirm");
		expect(view.closed()).toEqual({ paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas?\nR: " });
	});

	it("space marks asks with ● and Enter pastes every marked ask in list order", () => {
		const view = central(branch);
		view.keys(" ", "tui.select.down", "tui.select.down", " ");
		expect(view.text()[2]).toMatch(/^│  ● P3\.R1\.Q1/);
		expect(view.lines()[2]).toContain(`${fg("accent")}●`);
		view.keys("tui.select.up", " ", " ", "tui.select.confirm");
		expect(view.closed()).toEqual({
			paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas?\nR: \n\n> P1.R1.Q2: Necesito tu OK para pushear.\nR: ",
		});
	});

	it("y pastes the same quotes with R: Yes. under each one", () => {
		const view = central(branch);
		view.keys(" ", "tui.select.down", " ", "y");
		expect(view.closed()).toEqual({
			paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas?\nR: Yes.\n\n> P1.R1.Q2: Necesito tu OK para pushear.\nR: Yes.",
		});
	});

	it("s no longer answers, marks or acts on anything", () => {
		const view = central(branch);
		const before = view.text(100);
		view.key("s");
		expect(view.closed()).toBeUndefined();
		expect(view.actions).toEqual([]);
		expect(view.formats).toEqual([]);
		expect(view.text(100)).toEqual(before);
	});

	it("f toggles the answer format, saves each choice, and the help names the current one", () => {
		const view = central(branch);
		const format = () => {
			view.key("?");
			const line = view.text(120).find((row) => /│ +f /.test(row));
			view.key("?");
			return line;
		};
		expect(format()).toContain("now R: lines");
		view.key("f");
		expect(view.formats).toEqual(["inline"]);
		expect(format()).toContain("now same line");
		expect(view.closed()).toBeUndefined();
		view.key("f");
		expect(view.formats).toEqual(["inline", "lines"]);
		expect(format()).toContain("now R: lines");
		view.key("f");
		view.keys(" ", "tui.select.down", " ", "tui.select.confirm");
		expect(view.closed()).toEqual({
			paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas? → \n> P1.R1.Q2: Necesito tu OK para pushear. → ",
		});
	});

	it("answers in the format it opens with, and y adds → Yes. on the same line", () => {
		const view = central(branch, { format: "inline" });
		view.key("?");
		expect(view.text(120)).toContainEqual(expect.stringContaining("now same line"));
		view.key("?");
		view.keys(" ", "tui.select.down", " ", "y");
		expect(view.closed()).toEqual({
			paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas? → Yes.\n> P1.R1.Q2: Necesito tu OK para pushear. → Yes.",
		});
		expect(view.formats).toEqual([]);
	});

	it("shows the short hints whole from 60 columns, whatever the selected ask allows, and cuts them below", () => {
		const view = central(branch);
		expect(view.text(60).at(-1)).toBe("╰─ enter answer · y yes · f format · ? help · esc close ───╯");
		expect(view.text(80).at(-1)).toBe(`╰─ enter answer · y yes · f format · ? help · esc close ${"─".repeat(23)}╯`);
		view.keys(" ", "tui.select.down", " ");
		expect(view.text(80).at(-1)).toBe(`╰─ enter answer · y yes · f format · ? help · esc close ${"─".repeat(23)}╯`);
		expect(view.text(40).at(-1)).toBe("╰─ enter answer · y yes · f format ·… ─╯");
	});

	it("o opens the reply of the ask and Esc goes back to Pending", () => {
		const view = central(branch);
		view.keys("tui.select.down", "o");
		expect(view.text()[0]).toMatch(/^╭─ P1\.R1 ─+ a1b2c3d4 /);
		view.key("tui.select.cancel");
		expect(view.text()[0]).toMatch(/^╭─ Pending /);
		expect(view.closed()).toBeUndefined();
		view.key("tui.select.cancel");
		expect(view.closed()).toEqual({ paste: undefined });
	});
});

describe("dismissing and linking", () => {
	it("x dismisses the selected ask, or every marked one, and the list follows the branch", () => {
		const view = central(branch);
		view.key("x");
		expect(view.actions).toEqual([{ action: "dismiss", ask: "c9d0e1f2.1" }]);
		expect(view.text(100)[0]).toMatch(/ 2 open · 0 linked ─╮$/);
		view.keys(" ", "tui.select.down", " ", "x");
		expect(view.actions.slice(1)).toEqual([
			{ action: "dismiss", ask: "a1b2c3d4.1" },
			{ action: "dismiss", ask: "a1b2c3d4.2" },
		]);
		expect(view.text()[1]).toMatch(/^│ Nothing waits on you\. +│$/);
		expect(view.closed()).toBeUndefined();
	});

	it("l links the suggested repeat, the chain shows once with ↺, and u unlinks it", () => {
		const view = central(branch);
		view.key("l");
		expect(view.actions).toEqual([{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }]);
		const rows = view.text(100);
		expect(rows[0]).toMatch(/ 2 open · 1 linked ─╮$/);
		expect(rows.slice(1, 5)).toEqual([
			expect.stringMatching(/^│ ▌P3  revisá los tests +12:00 │$/),
			expect.stringMatching(/^│ ›○ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?  ↺ P1\.R1\.Q1 +│$/),
			expect.stringMatching(/^│ ▌P1  limpiá la rama +12:00 │$/),
			expect.stringMatching(/^│  ○ P1\.R1\.Q2  Necesito tu OK para pushear\. +│$/),
		]);
		view.key("u");
		expect(view.actions.at(-1)).toEqual({ action: "unlink", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" });
		expect(view.text(100)[0]).toMatch(/ 2 open · 0 linked ─╮$/);
		expect(view.text(100)[2]).toMatch(/  ≈ 1 similar +│$/);
	});

	it("l with 3 marked links them as one chain, newest continues the next older, and clears the marks", () => {
		const view = central(branch);
		view.keys(RIGHT, " ", "tui.select.down", " ", "tui.select.down", " ");
		view.key("l");
		expect(view.actions).toEqual([
			{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.2" },
			{ action: "link", ask: "a1b2c3d4.2", continues: "a1b2c3d4.1" },
		]);
		const rows = view.text(100);
		expect(rows[0]).toMatch(/ 1 open · 1 linked ─╮$/);
		expect(rows[2]).toMatch(/^│ ›○ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?  ↺ P1\.R1\.Q1, P1\.R1\.Q2 +│$/);
		expect(rows.some((line) => line.includes("●"))).toBe(false);
		view.key("tui.select.confirm");
		expect(view.closed()).toEqual({ paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas?\nR: " });
	});

	it("l with 2 marked links them even when they are not similar", () => {
		const view = central(branch);
		view.keys(RIGHT, "tui.select.down", "tui.select.down");
		view.keys(" ", "tui.select.up", " ");
		view.key("l");
		expect(view.actions).toEqual([{ action: "link", ask: "a1b2c3d4.2", continues: "a1b2c3d4.1" }]);
		const rows = view.text(100);
		expect(rows[0]).toMatch(/ 2 open · 1 linked ─╮$/);
		// The chain reads as its newest ask, which is not like P3.R1.Q1, so P3.R1.Q1 stands alone.
		expect(rows.slice(1, 5)).toEqual([
			expect.stringMatching(/^│ ▌P3  revisá los tests +12:00 │$/),
			expect.stringMatching(/^│  ○ P3\.R1\.Q1  ¿Borro las tres ramas viejas\? +│$/),
			expect.stringMatching(/^│ ▌P1  limpiá la rama +12:00 │$/),
			expect.stringMatching(/^│ ›○ P1\.R1\.Q2  Necesito tu OK para pushear\.  ↺ P1\.R1\.Q1 +│$/),
		]);
		expect(rows.some((line) => line.includes("●"))).toBe(false);
	});

	it("l with 1 marked still links the selected row's similar ask and keeps the mark", () => {
		const view = central(branch);
		view.keys("tui.select.down", "tui.select.down", " ", "tui.select.up", "tui.select.up", "l");
		expect(view.actions).toEqual([{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }]);
		expect(view.text(100)[4]).toMatch(/^│  ● P1\.R1\.Q2/);
	});

	it("l with a marked chain joins all its asks into the new chain, oldest last", () => {
		branch.push(askEntry({ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }));
		const view = central(branch);
		view.keys(" ", "tui.select.down", " ", "l");
		expect(view.actions).toEqual([
			{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.2" },
			{ action: "link", ask: "a1b2c3d4.2", continues: "a1b2c3d4.1" },
		]);
		expect(view.text(100)[2]).toMatch(/  ↺ P1\.R1\.Q1, P1\.R1\.Q2 +│$/);
	});

	it("l and u do nothing on an ask without similar asks or a chain", () => {
		const view = central(branch);
		view.keys("tui.select.down", "tui.select.down", "l", "u");
		expect(view.actions).toEqual([]);
	});
});

describe("repeat groups", () => {
	/** A copy of `branch` with a third repeat of the old-branches ask. */
	const repeats = () => [...branch, user("y ahora"), assistant("¿Borro las ramas viejas?", { id: "d0d0d0d4" })];

	it("shows three similar asks as one row on the newest with ≈ 2 similar, muted, counted once, and a lone ask without a count", () => {
		const view = central(repeats());
		const rows = view.text(100);
		expect(rows[0]).toMatch(/^╭─ Pending ─+ 2 open · 0 linked ─╮$/);
		expect(rows.slice(1, -1)).toEqual([
			expect.stringMatching(/^│ ▌P4  y ahora +12:00 │$/),
			expect.stringMatching(/^│ ›○ P4\.R1\.Q1  ¿Borro las ramas viejas\?  ≈ 2 similar +│$/),
			expect.stringMatching(/^│ ▌P1  limpiá la rama +12:00 │$/),
			expect.stringMatching(/^│  ○ P1\.R1\.Q2  Necesito tu OK para pushear\. +│$/),
		]);
		expect(view.lines(100)[2]).toContain(`${fg("muted")}  ≈ 2 similar`);
		expect(rows[4]).not.toContain("≈");
	});

	it("→ expands the older members as indented muted ≈ rows, newest first, and ← collapses from either row", () => {
		const view = central(repeats());
		view.key(RIGHT);
		const rows = view.text(100);
		expect(rows.slice(1, -1)).toEqual([
			expect.stringMatching(/^│ ▌P4  y ahora +12:00 │$/),
			expect.stringMatching(/^│ ›○ P4\.R1\.Q1  ¿Borro las ramas viejas\?  ≈ 2 similar +│$/),
			expect.stringMatching(/^│ {4}≈ P3\.R1\.Q1  ¿Borro las tres ramas viejas\? +│$/),
			expect.stringMatching(/^│ {4}≈ P1\.R1\.Q1  Hay tres ramas viejas\. ¿Las borro\? +│$/),
			expect.stringMatching(/^│ ▌P1  limpiá la rama +12:00 │$/),
			expect.stringMatching(/^│  ○ P1\.R1\.Q2  Necesito tu OK para pushear\. +│$/),
		]);
		const member = view.lines(100)[3];
		expect(member).toContain(`${fg("muted")}≈`);
		expect(member).toContain(`${fg("muted")}P3.R1.Q1`);
		view.keys("tui.select.down", "tui.select.down");
		expect(view.text(100)[4]).toMatch(/^│ › {2}≈ P1\.R1\.Q1/);
		expect(view.lines(100)[4]).toContain(bg("selectedBg"));
		view.key(LEFT);
		expect(view.text(100).slice(2, 4)).toEqual([
			expect.stringMatching(/^│ ›○ P4\.R1\.Q1 .*≈ 2 similar +│$/),
			expect.stringMatching(/^│ ▌P1 /),
		]);
		view.keys(RIGHT, LEFT);
		expect(view.text(100)[3]).toMatch(/^│ ▌P1 /);
		expect(view.actions).toEqual([]);
		expect(view.closed()).toBeUndefined();
	});

	it("→ and ← do nothing on a lone ask", () => {
		const view = central(repeats());
		view.key("tui.select.down");
		const before = view.text(100);
		view.keys(RIGHT, LEFT);
		expect(view.text(100)).toEqual(before);
	});

	it("answers, marks and dismisses an expanded member like any ask", () => {
		const answer = central(repeats());
		answer.keys(RIGHT, "tui.select.down", "tui.select.confirm");
		expect(answer.closed()).toEqual({ paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas?\nR: " });

		const mark = central(repeats());
		mark.keys(RIGHT, "tui.select.down", "tui.select.down", " ");
		expect(mark.text(100)[4]).toMatch(/^│ › {2}● P1\.R1\.Q1/);
		expect(mark.lines(100)[4]).toContain(`${fg("accent")}●`);
		// The mark stays on a collapsed member, and the answer lists it in list order.
		mark.keys(LEFT, " ", "y");
		expect(mark.closed()).toEqual({
			paste: "> P4.R1.Q1: ¿Borro las ramas viejas?\nR: Yes.\n\n> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?\nR: Yes.",
		});

		const dismiss = central(repeats());
		dismiss.keys(RIGHT, "tui.select.down", "x");
		expect(dismiss.actions).toEqual([{ action: "dismiss", ask: "c9d0e1f2.1" }]);
		const rows = dismiss.text(100);
		expect(rows[0]).toMatch(/ 2 open · 0 linked ─╮$/);
		expect(rows.slice(2, 4)).toEqual([
			expect.stringMatching(/^│ {2}○ P4\.R1\.Q1  ¿Borro las ramas viejas\?  ≈ 1 similar +│$/),
			expect.stringMatching(/^│ › {2}≈ P1\.R1\.Q1  Hay tres ramas viejas\. ¿Las borro\? +│$/),
		]);
	});

	it("closes nothing by itself: dismissing the group row leaves its members open, as the next row", () => {
		const view = central(repeats());
		view.key("x");
		expect(view.actions).toEqual([{ action: "dismiss", ask: "d0d0d0d4.1" }]);
		const rows = view.text(100);
		expect(rows[0]).toMatch(/ 2 open · 0 linked ─╮$/);
		expect(rows[2]).toMatch(/^│ ›○ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?  ≈ 1 similar +│$/);
	});

	it("l on the group row links each other member to the oldest one, and the row becomes a chain row with ↺", () => {
		const view = central(repeats());
		view.key("l");
		expect(view.actions).toEqual([
			{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" },
			{ action: "link", ask: "d0d0d0d4.1", continues: "a1b2c3d4.1" },
		]);
		const rows = view.text(100);
		expect(rows[0]).toMatch(/ 2 open · 1 linked ─╮$/);
		expect(rows[2]).toMatch(/^│ ›○ P4\.R1\.Q1  ¿Borro las ramas viejas\?  ↺ P1\.R1\.Q1, P3\.R1\.Q1 +│$/);
		expect(rows.some((line) => line.includes("≈"))).toBe(false);
		view.key("u");
		expect(view.actions.at(-1)).toEqual({ action: "unlink", ask: "d0d0d0d4.1", continues: "a1b2c3d4.1" });
	});

	it("l on an expanded member links its whole group the same way", () => {
		const view = central(repeats());
		view.keys(RIGHT, "tui.select.down", "l");
		expect(view.actions).toEqual([
			{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" },
			{ action: "link", ask: "d0d0d0d4.1", continues: "a1b2c3d4.1" },
		]);
	});

	it("l keeps a chain marked by hand as it was built, a path, even when its asks are similar", () => {
		const view = central(repeats());
		view.keys(RIGHT, " ", "tui.select.down", " ", "tui.select.down", " ", "l");
		expect(view.actions).toEqual([
			{ action: "link", ask: "d0d0d0d4.1", continues: "c9d0e1f2.1" },
			{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" },
		]);
		expect(view.text(100)[2]).toMatch(/^│ .○ P4\.R1\.Q1  ¿Borro las ramas viejas\?  ↺ P1\.R1\.Q1, P3\.R1\.Q1 +│$/);
	});

	it("fits the overlay cap on 8, 24 and 50 rows at exact widths with a group expanded", () => {
		const many = () => {
			resetIds();
			return Array.from({ length: 30 }, (_, index) => [
				user(`prompt ${index + 1}`),
				assistant(`¿Primera tema${index + 1}?\n\n¿Borro las ramas viejas?`),
			]).flat();
		};
		for (const rows of [8, 24, 50]) {
			const cap = Math.min(rows - 4, Math.floor(rows * 0.9));
			for (const width of [24, 80, 140]) {
				const view = central(many(), { rows });
				for (const press of ["", "tui.select.down", RIGHT, "tui.select.pageDown", "tui.select.pageDown", "tui.select.pageUp", LEFT]) {
					if (press) view.key(press);
					const lines = view.text(width);
					expect(lines.length).toBeLessThanOrEqual(cap);
					expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
					expect(lines.at(-1)).toMatch(/^╰─/);
					expect(lines.slice(1, -1).some((line) => line.includes("›"))).toBe(true);
				}
				const expanded = central(many(), { rows: 50 });
				expanded.keys("tui.select.down", RIGHT);
				expect(expanded.text(140).filter((line) => /│ {4}≈ P\d+\.R1\.Q2/.test(line)).length).toBeGreaterThan(0);
			}
		}
	});
});

describe("folding", () => {
	const prompts = (count: number) => {
		resetIds();
		return Array.from({ length: count }, (_, index) => [
			user(`prompt ${index + 1}`),
			// A word of its own per ask, so no two of them are similar.
			assistant(`¿Pregunta ${index + 1} de ${count} tema${index + 1}?`),
		]).flat();
	};

	it("keeps 10 prompts with open asks unfolded", () => {
		const rows = central(prompts(10), { rows: 50 }).text();
		expect(rows.some((line) => line.includes("Older"))).toBe(false);
		expect(rows.filter((line) => line.includes("○"))).toHaveLength(10);
	});

	it("folds the prompts older than the 10 newest into one Older (N) row that Enter expands", () => {
		const view = central(prompts(13), { rows: 50 });
		const rows = view.text();
		expect(rows.filter((line) => line.includes("○"))).toHaveLength(10);
		expect(rows.at(-2)).toMatch(/^│  ▸ Older \(3\) +│$/);
		expect(view.lines().at(-2)).toContain(fg("muted"));
		view.keys("tui.select.pageDown", "tui.select.pageDown");
		expect(view.text().at(-2)).toMatch(/^│ ›▸ Older \(3\) +│$/);
		view.key("tui.select.confirm");
		expect(view.closed()).toBeUndefined();
		const expanded = view.text();
		expect(expanded.some((line) => line.includes("Older"))).toBe(false);
		expect(expanded.filter((line) => line.includes("○"))).toHaveLength(13);
		expect(expanded).toContainEqual(expect.stringMatching(/^│ ›○ P3\.R1\.Q1/));
	});
});

describe("Pending on any screen", () => {
	const many = () => {
		resetIds();
		return Array.from({ length: 30 }, (_, index) => [
			user(`prompt ${index + 1}`),
			assistant(`¿Primera tema${index + 1}?\n\n¿Segunda tema${index + 1}?`),
		]).flat();
	};

	it("stays inside the overlay cap on 8, 24 and 50 rows and fills each width exactly", () => {
		for (const rows of [8, 24, 50]) {
			const cap = Math.min(rows - 4, Math.floor(rows * 0.9));
			for (const width of [24, 80, 140]) {
				const view = central(many(), { rows });
				for (const press of ["", "tui.select.pageDown", "tui.select.pageDown", "tui.select.confirm", "tui.select.pageDown"]) {
					if (press) view.key(press);
					const lines = view.text(width);
					expect(lines.length).toBeLessThanOrEqual(cap);
					expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
					expect(lines.at(-1)).toMatch(/^╰─/);
				}
			}
		}
	});
});

describe("Replies tab follows the open asks", () => {
	it("shows ✓ and no ask text for a reply whose asks are all closed, ⚠ with the first open one otherwise", () => {
		branch.push(askEntry({ action: "dismiss", ask: "c9d0e1f2.1" }), user("> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?\nR: sí"));
		const view = central(branch, { tab: "replies" });
		const rows = view.text(100);
		expect(rows).toContainEqual(expect.stringMatching(/^│ .└ P3\.R1  c9d0e1f2  prompt +✓ +│$/));
		expect(rows).toContainEqual(expect.stringMatching(/^│ .└ P1\.R1  a1b2c3d4  prompt +⚠ Necesito tu OK para pushear\. +│$/));
		const done = view.lines(100).find((line) => line.includes("c9d0e1f2")) as string;
		expect(done).toContain(`${fg("success")}✓`);
		expect(done).not.toContain(fg("warning"));
	});

	it("counts a chain member as open while its chain is, and closes them together", () => {
		branch.push(
			askEntry({ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }),
			askEntry({ action: "dismiss", ask: "a1b2c3d4.2" }),
		);
		const open = central(branch, { tab: "replies" }).text(100);
		expect(open).toContainEqual(expect.stringMatching(/P1\.R1  a1b2c3d4  prompt +⚠ Hay tres ramas viejas\. ¿Las borro\? +│$/));
		branch.push(user("> P3.R1.Q1: ¿Borro las tres ramas viejas?\nR: no"));
		const closed = central(branch, { tab: "replies" }).text(100);
		expect(closed).toContainEqual(expect.stringMatching(/P1\.R1  a1b2c3d4  prompt +✓ +│$/));
		expect(closed).toContainEqual(expect.stringMatching(/P3\.R1  c9d0e1f2  prompt +✓ +│$/));
	});

	it("follows a dismiss made in the Pending tab", () => {
		const view = central(branch);
		view.keys("x", "\t");
		expect(view.text(100)).toContainEqual(expect.stringMatching(/P3\.R1  c9d0e1f2  prompt +✓ +│$/));
	});
});

describe("viewer header follows the open asks", () => {
	const reader = (entries: SessionEntry[]) => {
		const view = central(entries, { tab: "replies" });
		const index = view.text(100).findIndex((line) => line.includes("a1b2c3d4"));
		const steps = view.text(100).slice(0, index).filter((line) => /[├└] P/.test(line)).length;
		for (let step = 0; step < steps; step += 1) view.key("tui.select.down");
		view.key("tui.select.confirm");
		return view;
	};

	it("lists only the open asks under ⚠ Waits on you and the closed ones under ✓ Answered", () => {
		branch.push(user("> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?\nR: sí"));
		const view = reader(branch);
		const rows = view.text(100);
		expect(rows[0]).toMatch(/^╭─ P1\.R1 /);
		expect(rows.slice(2, 6)).toEqual([
			expect.stringMatching(/^│ ⚠ Waits on you +│$/),
			expect.stringMatching(/^│ {3}• Necesito tu OK para pushear\. +│$/),
			expect.stringMatching(/^│ ✓ Answered +│$/),
			expect.stringMatching(/^│ {3}• Hay tres ramas viejas\. ¿Las borro\?  → P4 +│$/),
		]);
		expect(rows[6]).toMatch(/^├─+┤$/);
		expect(view.lines(100)[4]).toContain(fg("muted"));
	});

	it("shows dismissed asks as dismissed and leaves out ⚠ when every ask is closed", () => {
		branch.push(
			askEntry({ action: "dismiss", ask: "a1b2c3d4.2" }),
			user("> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?\nR: sí"),
		);
		const rows = reader(branch).text(100);
		expect(rows.some((line) => line.includes("Waits on you"))).toBe(false);
		expect(rows.slice(2, 5)).toEqual([
			expect.stringMatching(/^│ ✓ Answered +│$/),
			expect.stringMatching(/^│ {3}• Hay tres ramas viejas\. ¿Las borro\?  → P4 +│$/),
			expect.stringMatching(/^│ {3}• Necesito tu OK para pushear\.  dismissed +│$/),
		]);
	});

	it("caps both lists on a short screen and keeps the frame inside the overlay cap", () => {
		resetIds();
		const asks = Array.from({ length: 6 }, (_, index) => `¿Pregunta ${index + 1}?`);
		const body = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`);
		const entries = [user("dame"), assistant([...asks, ...body].join("\n\n"), { id: "a1b2c3d4" })];
		entries.push(...[1, 2, 3].map((n) => askEntry({ action: "dismiss", ask: `a1b2c3d4.${n}` })));
		for (const rows of [8, 12, 14, 24]) {
			const cap = Math.min(rows - 4, Math.floor(rows * 0.9));
			const view = central([...entries], { rows, tab: "replies" });
			view.keys("tui.select.confirm");
			const shown = view.text(60);
			expect(shown.length).toBeLessThanOrEqual(cap);
			expect(shown.every((line) => visibleWidth(line) === 60)).toBe(true);
			expect(shown.at(-1)).toMatch(/^╰─/);
		}
		const roomy = central([...entries], { rows: 30, tab: "replies" });
		roomy.keys("tui.select.confirm");
		const text = roomy.text(60);
		expect(text.filter((line) => line.includes("dismissed"))).toHaveLength(3);
		expect(text.filter((line) => /• ¿Pregunta [456]\?/.test(line))).toHaveLength(3);
	});
});

describe("Answered tab", () => {
	const answered = () => {
		branch.push(
			askEntry({ action: "dismiss", ask: "a1b2c3d4.2" }),
			user("> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?\nR: sí, las tres\n\n> P3.R1.Q1: ¿Borro las tres ramas viejas?\nR: "),
		);
		const view = central(branch, { tab: "replies" });
		view.key("\t");
		return view;
	};

	it("cycles Pending → Replies → Answered → Pending with Tab", () => {
		const view = central(branch);
		const titles = [view.text()[0]];
		for (let press = 0; press < 3; press += 1) {
			view.key("\t");
			titles.push(view.text()[0]);
		}
		expect(titles.map((title) => /^╭─ (\w+)/.exec(title)?.[1])).toEqual(["Pending", "Replies", "Answered", "Pending"]);
	});

	it("groups the closed asks under their prompt, newest first, with the prompt that answered and its answer", () => {
		const view = answered();
		const rows = view.text(100);
		expect(rows[0]).toMatch(/^╭─ Answered ─+ 2 answered · 1 dismissed ─╮$/);
		expect(rows.slice(1, 9)).toEqual([
			expect.stringMatching(/^│ ▌P3  revisá los tests +12:00 │$/),
			expect.stringMatching(/^│ ›✓ P3\.R1\.Q1  ¿Borro las tres ramas viejas\? +│$/),
			expect.stringMatching(/^│ {4}↳ P4 +│$/),
			expect.stringMatching(/^│ ▌P1  limpiá la rama +12:00 │$/),
			expect.stringMatching(/^│  ✓ P1\.R1\.Q1  Hay tres ramas viejas\. ¿Las borro\? +│$/),
			expect.stringMatching(/^│ {4}↳ P4  sí, las tres +│$/),
			expect.stringMatching(/^│  ✓ P1\.R1\.Q2  Necesito tu OK para pushear\. +│$/),
			expect.stringMatching(/^│ {4}✕ dismissed +│$/),
		]);
		expect(rows.at(-1)).toMatch(/^╰─ ↑↓ move · enter open · esc close ─+╯$/);
		const lines = view.lines(100);
		expect(lines[2]).toContain(`${fg("success")}✓`);
		expect(lines[2]).toContain(bg("selectedBg"));
		expect(lines[6]).toContain(fg("muted"));
		expect(lines[8]).toContain(fg("dim"));
	});

	it("reads the answer from a quote that closed an ask by its text, under an ID that now names another ask", () => {
		branch.push(user("> P1.R1.Q2: Hay tres ramas viejas. ¿Las borro?\nR: sí, las tres"));
		const view = central(branch, { tab: "replies" });
		view.key("\t");
		const rows = view.text(100);
		expect(rows[0]).toMatch(/ 1 answered · 0 dismissed ─╮$/);
		expect(rows.slice(1, 4)).toEqual([
			expect.stringMatching(/^│ ▌P1  limpiá la rama +12:00 │$/),
			expect.stringMatching(/^│ ›✓ P1\.R1\.Q1  Hay tres ramas viejas\. ¿Las borro\? +│$/),
			expect.stringMatching(/^│ {4}↳ P4  sí, las tres +│$/),
		]);
	});

	it("moves over the asks only, and Enter or o opens the reply, Esc coming back", () => {
		const view = answered();
		view.key("tui.select.down");
		expect(view.text(100)[5]).toMatch(/^│ ›✓ P1\.R1\.Q1/);
		view.key("tui.select.confirm");
		expect(view.text(100)[0]).toMatch(/^╭─ P1\.R1 ─+ a1b2c3d4 /);
		view.key("tui.select.cancel");
		expect(view.text(100)[0]).toMatch(/^╭─ Answered /);
		view.keys("tui.select.down", "tui.select.down", "o");
		expect(view.text(100)[0]).toMatch(/^╭─ P1\.R1 /);
		view.key("tui.select.cancel");
		view.key("tui.select.cancel");
		expect(view.closed()).toEqual({ paste: undefined });
	});

	it("shows a closed chain once, on its newest member, with ↺ and the older members", () => {
		branch.push(
			askEntry({ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }),
			user("> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?\nR: no"),
		);
		const view = central(branch, { tab: "replies" });
		view.key("\t");
		const rows = view.text(100);
		expect(rows[0]).toMatch(/ 1 answered · 0 dismissed ─╮$/);
		expect(rows.filter((line) => line.includes("✓"))).toEqual([
			expect.stringMatching(/^│ ›✓ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?  ↺ P1\.R1\.Q1 +│$/),
		]);
		expect(rows[3]).toMatch(/^│ {4}↳ P4  no +│$/);
	});

	it("is empty-safe: a frame with Nothing answered yet., where Enter and o do nothing", () => {
		const view = central(branch, { tab: "replies" });
		view.key("\t");
		expect(view.text(60)).toEqual([
			expect.stringMatching(/^╭─ Answered ─+╮$/),
			expect.stringMatching(/^│ Nothing answered yet\. +│$/),
			expect.stringMatching(/^╰─ esc close ─+╯$/),
		]);
		view.keys("tui.select.confirm", "o");
		expect(view.text(60)[0]).toMatch(/^╭─ Answered /);
		expect(view.closed()).toBeUndefined();
	});

	it("stays inside the overlay cap on 8, 24 and 50 rows and fills each width exactly", () => {
		const many = () => {
			resetIds();
			const entries = Array.from({ length: 30 }, (_, index) => [
				user(`prompt ${index + 1}`),
				assistant(`¿Primera ${index + 1}?\n\n¿Segunda ${index + 1}?`, { id: `b${index.toString(16).padStart(7, "0")}` }),
			]).flat();
			for (let index = 0; index < 30; index += 1) {
				entries.push(askEntry({ action: "dismiss", ask: `b${index.toString(16).padStart(7, "0")}.1` }));
			}
			entries.push(user(Array.from({ length: 30 }, (_, index) => `> P${index + 1}.R1.Q2: x\nR: ${"ok ".repeat(40)}`).join("\n\n")));
			return entries;
		};
		for (const rows of [8, 24, 50]) {
			const cap = Math.min(rows - 4, Math.floor(rows * 0.9));
			for (const width of [24, 80, 140]) {
				const view = central(many(), { rows, tab: "replies" });
				view.key("\t");
				for (const press of ["", "tui.select.pageDown", "tui.select.down", "tui.select.pageDown", "tui.select.pageUp"]) {
					if (press) view.key(press);
					const lines = view.text(width);
					expect(lines[0]).toMatch(/^╭─ Answered/);
					expect(lines.length).toBeLessThanOrEqual(cap);
					expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
					expect(lines.at(-1)).toMatch(/^╰─/);
					expect(lines.slice(1, -1).some((line) => line.includes("›"))).toBe(true);
				}
			}
		}
	});
});

describe("key help", () => {
	const KEYS_LISTED = ["↑↓", "pgup/pgdn", "enter", "y", "f", "space", "x", "→", "←", "l", "u", "o", "tab", "?", "esc", "home/end", "q"];

	it("? opens a card that lists every key, one per line, and ? or Esc closes it", () => {
		const view = central(branch, { rows: 60 });
		view.key("?");
		const rows = view.text(100);
		expect(rows[0]).toMatch(/^╭─ Keys ─+╮$/);
		expect(rows.at(-1)).toMatch(/^╰─ ↑↓ scroll · \?\/esc back ─+╯$/);
		expect(rows.every((line) => visibleWidth(line) === 100)).toBe(true);
		const keys = rows.slice(1, -1).flatMap((line) => /^│ {3}(\S+(?:, \S+)?) {2,}\S/.exec(line)?.[1].split(", ") ?? []);
		for (const key of KEYS_LISTED) expect(keys).toContain(key);
		expect(rows).toContainEqual(expect.stringMatching(/^│ {3}→, ← +expand or collapse the similar asks \(≈\) of a row +│$/));
		expect(rows).toContainEqual(expect.stringMatching(/^│ {3}l +link the marked asks, or a row's similar asks to the oldest one +│$/));
		expect(keys).not.toContain("s");
		expect(rows).toContainEqual(expect.stringMatching(/^│ {3}y +answer Yes\. +│$/));
		for (const section of ["Pending", "Replies", "Answered", "Every tab", "Reply viewer"]) {
			expect(rows).toContainEqual(expect.stringMatching(new RegExp(`^│ ${section} +│$`)));
		}
		expect(view.lines(100).find((line) => line.includes("Pending"))).toContain(fg("accent"));
		view.key("?");
		expect(view.text(100)[0]).toMatch(/^╭─ Pending /);
		view.keys("?", "tui.select.cancel");
		expect(view.text(100)[0]).toMatch(/^╭─ Pending /);
		expect(view.closed()).toBeUndefined();
	});

	it("says under the group keys that a group row answers only its newest ask, and fits the cap on 8, 24 and 50 rows", () => {
		const GROUP = /^│ {3}A group row answers only its newest ask; press l first to close the whole group together\. +│$/;
		const wide = central(branch, { rows: 60 });
		wide.key("?");
		const rows = wide.text(120);
		const at = rows.findIndex((line) => GROUP.test(line));
		expect(rows[at - 1]).toMatch(/^│ {3}l +link the marked asks, or a row's similar asks to the oldest one +│$/);
		expect(wide.lines(120)[at]).toContain(`${fg("muted")}A group row`);
		for (const height of [8, 24, 50]) {
			const cap = Math.min(height - 4, Math.floor(height * 0.9));
			for (const width of [24, 80, 140]) {
				const view = central(branch, { rows: height });
				view.key("?");
				const seen: string[] = [];
				for (let press = 0; press < 40; press += 1) {
					const lines = view.text(width);
					expect(lines.length).toBeLessThanOrEqual(cap);
					expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
					expect(lines.at(-1)).toMatch(/^╰─/);
					seen.push(...lines);
					view.key("tui.select.down");
				}
				expect(seen.some((line) => line.startsWith("│   A group row"))).toBe(true);
				if (width === 140) expect(seen).toContainEqual(expect.stringMatching(GROUP));
			}
		}
	});

	it("does nothing else while open, and returns to the tab it opened from", () => {
		const view = central(branch);
		view.keys("?", "x", "f", "tui.select.confirm", "\t", "?");
		expect(view.actions).toEqual([]);
		expect(view.formats).toEqual([]);
		expect(view.closed()).toBeUndefined();
		expect(view.text()[0]).toMatch(/^╭─ Pending /);
		for (const tab of ["Replies", "Answered"]) {
			view.key("\t");
			view.key("?");
			expect(view.text()[0]).toMatch(/^╭─ Keys /);
			view.key("?");
			expect(view.text()[0]).toMatch(new RegExp(`^╭─ ${tab} `));
		}
	});

	it("fits the overlay cap on 8, 24 and 50 rows at exact widths and scrolls to its last line", () => {
		for (const rows of [8, 24, 50]) {
			const cap = Math.min(rows - 4, Math.floor(rows * 0.9));
			for (const width of [24, 80, 140]) {
				const view = central(branch, { rows });
				view.key("?");
				const first = view.text(width);
				expect(first.length).toBeLessThanOrEqual(cap);
				expect(first.every((line) => visibleWidth(line) === width)).toBe(true);
				expect(first.at(-1)).toMatch(/^╰─/);
				for (let press = 0; press < 40; press += 1) view.key("tui.select.down");
				const last = view.text(width);
				expect(last.length).toBeLessThanOrEqual(cap);
				expect(last.every((line) => visibleWidth(line) === width)).toBe(true);
				expect(last.at(-3)).toMatch(/^│ {3}esc, q /);
				expect(last.at(-2)).toMatch(/^│ Asks: decision sect/);
			}
		}
	});
});

describe("ask mode in the central", () => {
	const NOTE = "outside the decision section";

	const reply = (questions: number) => {
		resetIds();
		const outside = Array.from({ length: questions }, (_, index) => `Question ${index + 1} outside?`);
		const lines = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`);
		const text = [...outside, "", "## Needs your decision", "", "1. Merge now", "", ...lines].join("\n");
		return [user("go"), assistant(text, { id: "a1b2c3d4" })];
	};

	it("notes the untracked questions under the open asks, muted, singular or plural", () => {
		const two = central(reply(2), { rows: 30 });
		two.key("o");
		const rows = two.text(140);
		expect(rows.slice(1, 5)).toEqual([
			expect.stringMatching(/^│ ▌ go +│$/),
			expect.stringMatching(/^│ ⚠ Waits on you +│$/),
			expect.stringMatching(/^│   • Merge now +│$/),
			expect.stringMatching(
				/^│ 2 more questions outside the decision section are not tracked \(--reply-thread-asks all tracks them\)\. +│$/,
			),
		]);
		expect(rows[5]).toMatch(/^├─+┤$/);
		expect(two.lines(140)[4]).toContain(fg("muted"));
		const one = central(reply(1), { rows: 30 });
		one.key("o");
		expect(one.text(140)[4]).toMatch(
			/^│ 1 more question outside the decision section is not tracked \(--reply-thread-asks all tracks them\)\. +│$/,
		);
	});

	it("leaves the note out in all mode and when every question is tracked", () => {
		const all = central(reply(2), { mode: "all" });
		all.key("o");
		expect(all.text(140).some((line) => line.includes(NOTE))).toBe(false);
		const none = central(reply(0));
		none.key("o");
		expect(none.text(140).some((line) => line.includes(NOTE))).toBe(false);
	});

	it("fits the note within the overlay cap on any screen, at exact widths", () => {
		for (const rows of [8, 10, 12, 14, 24]) {
			const cap = Math.min(rows - 4, Math.floor(rows * 0.9));
			for (const width of [24, 80, 140]) {
				const view = central(reply(3), { rows });
				view.key("o");
				const lines = view.text(width);
				expect(lines.length).toBeLessThanOrEqual(cap);
				expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
				expect(lines.at(-1)).toMatch(/^╰─/);
			}
		}
		const view = central(reply(3), { rows: 14 });
		view.key("o");
		expect(view.text(140).some((line) => line.includes(NOTE))).toBe(true);
	});

	it("names the mode on the last line of the key help", () => {
		for (const [mode, line] of [
			["section", "Asks: decision section only"],
			["all", "Asks: every question"],
		] as const) {
			const view = central(reply(1), { rows: 60, mode });
			view.key("?");
			const rows = view.text(100);
			expect(rows.at(-2)).toMatch(new RegExp(`^│ ${line} +│$`));
		}
	});
});
