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
import { RepliesView, type ViewResult } from "../extensions/replies-view.ts";
import type { AskMode } from "../src/asks.ts";
import type { AnswerFormat } from "../src/format.ts";
import { type AskAction, buildAsks } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { askEntry, assistant, customEntry, resetIds, user } from "./helpers.ts";

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
	let closed: { paste?: ViewResult } | undefined;
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
		(paste?: ViewResult) => (closed = { paste }),
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
			/^╰─ enter answer · y yes · f format · t triage · \? help · esc close ─+╯$/,
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

	it("shows the short hints whole from 70 columns, whatever the selected ask allows, and cuts them below", () => {
		const view = central(branch);
		expect(view.text(70).at(-1)).toBe("╰─ enter answer · y yes · f format · t triage · ? help · esc close ──╯");
		expect(view.text(80).at(-1)).toBe(`╰─ enter answer · y yes · f format · t triage · ? help · esc close ${"─".repeat(12)}╯`);
		view.keys(" ", "tui.select.down", " ");
		expect(view.text(80).at(-1)).toBe(`╰─ enter answer · y yes · f format · t triage · ? help · esc close ${"─".repeat(12)}╯`);
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

	it("t closes Pending asking for a triage, with marks too, and writes nothing", () => {
		const view = central(branch);
		view.key(" ");
		view.key("t");
		expect(view.closed()).toEqual({ paste: { triage: true } });
		expect(view.actions).toEqual([]);
	});

	it("t closes an empty Pending tab asking for a triage too; the command says there is nothing to triage", () => {
		const view = central([user("hola"), assistant("Listo.")], { tab: "pending" });
		expect(view.text().some((line) => line.includes("Nothing waits on you."))).toBe(true);
		view.key("t");
		expect(view.closed()).toEqual({ paste: { triage: true } });
	});

	it("t means nothing in the Replies and Answered tabs, in the help card or in the reply viewer", () => {
		const view = central(branch);
		view.key("\t");
		view.key("t");
		expect(view.text()[0]).toMatch(/^╭─ Replies /);
		view.keys("\t", "t");
		expect(view.text()[0]).toMatch(/^╭─ Answered /);
		view.keys("\t", "?", "t");
		expect(view.text()[0]).toMatch(/^╭─ Keys /);
		view.keys("?", "o", "t");
		expect(view.text()[0]).toMatch(/^╭─ P3\.R1 /);
		expect(view.closed()).toBeUndefined();
	});

	it("the key help lists t under Pending, before a and n", () => {
		const view = central(branch, { rows: 60 });
		view.key("?");
		const rows = view.text(140);
		const at = rows.findIndex((line) => /^│ {3}t +triage: ask the session model for ✦ proposals +│$/.test(line));
		expect(at).toBeGreaterThan(rows.findIndex((line) => /^│ Pending +│$/.test(line)));
		expect(rows[at + 1]).toMatch(/^│ {3}a +accept the row's ✦ triage proposal +│$/);
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
			// P4.R1.Q1 now looks like the dismissed P3.R1.Q1, older than it.
			expect.stringMatching(/^│ {2}○ P4\.R1\.Q1  ¿Borro las ramas viejas\?  ≈ 1 similar · ✓\? like P3\.R1\.Q1 +│$/),
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

describe("looks answered", () => {
	const OLD = "Should I delete the old branches?";
	/** An answered ask, then `asks` in a later reply. */
	const answered = (...asks: string[]) => {
		resetIds();
		return [
			user("clean up"),
			assistant(OLD, { id: "a1a1a1a1" }),
			user(`> P1.R1.Q1: ${OLD}\nR: yes`),
			assistant(asks.join("\n\n"), { id: "b2b2b2b2" }),
		];
	};

	it("marks an open ask like an older answered one with ✓? like <ordinal>, muted, and closes nothing", () => {
		const view = central(answered("Should I delete the three old branches?"));
		const rows = view.text(100);
		expect(rows[0]).toMatch(/^╭─ Pending ─+ 1 open · 0 linked ─╮$/);
		expect(rows[2]).toMatch(/^│ ›○ P2\.R1\.Q1  Should I delete the three old branches\?  ✓\? like P1\.R1\.Q1 +│$/);
		expect(view.lines(100)[2]).toContain(`${fg("muted")}  ✓? like P1.R1.Q1`);
		expect(view.actions).toEqual([]);
		view.key("x");
		expect(view.actions).toEqual([{ action: "dismiss", ask: "b2b2b2b2.1" }]);
		expect(view.text(100)[1]).toMatch(/^│ Nothing waits on you\. +│$/);
	});

	it("marks an open ask like an older dismissed one, and nothing when no closed ask is alike or the closed one is newer", () => {
		resetIds();
		const dismissed = central([
			user("clean up"),
			assistant(OLD, { id: "a1a1a1a1" }),
			askEntry({ action: "dismiss", ask: "a1a1a1a1.1" }),
			user("go on"),
			assistant("Should I delete the three old branches?\n\nShould I push to main?", { id: "b2b2b2b2" }),
		]).text(100);
		expect(dismissed[2]).toMatch(/^│ ›○ P2\.R1\.Q1  Should I delete the three old branches\?  ✓\? like P1\.R1\.Q1 +│$/);
		expect(dismissed[3]).toMatch(/^│  ○ P2\.R1\.Q2  Should I push to main\? +│$/);
		resetIds();
		const newer = central([
			user("clean up"),
			assistant(OLD, { id: "a1a1a1a1" }),
			user("go on"),
			assistant("Should I delete the three old branches?", { id: "b2b2b2b2" }),
			askEntry({ action: "dismiss", ask: "b2b2b2b2.1" }),
		]).text(100);
		expect(newer[2]).toMatch(/^│ ›○ P1\.R1\.Q1  Should I delete the old branches\? +│$/);
		expect(newer.some((line) => line.includes("✓?"))).toBe(false);
	});

	it("names the newest closed ask alike", () => {
		resetIds();
		const rows = central([
			user("clean up"),
			assistant(OLD, { id: "a1a1a1a1" }),
			user(`> P1.R1.Q1: ${OLD}\nR: yes`),
			assistant("Should I delete the three old branches?", { id: "b2b2b2b2" }),
			askEntry({ action: "dismiss", ask: "b2b2b2b2.1" }),
			user("and now"),
			assistant("Should I delete the old branches now?", { id: "c3c3c3c3" }),
		]).text(100);
		expect(rows[2]).toMatch(/^│ ›○ P3\.R1\.Q1  Should I delete the old branches now\?  ✓\? like P2\.R1\.Q1 +│$/);
	});

	it("marks a group row when a hidden member is alike, after ≈ N similar, and an expanded member shows its own mark", () => {
		resetIds();
		const view = central([
			user("release"),
			assistant("Should I merge the release branch?", { id: "a1a1a1a1" }),
			askEntry({ action: "dismiss", ask: "a1a1a1a1.1" }),
			user("go on"),
			assistant("Should I merge the release branch today?", { id: "b2b2b2b2" }),
			user("and"),
			assistant("Today, should I merge the release notes?", { id: "c3c3c3c3" }),
		]);
		expect(view.text(100)[2]).toMatch(
			/^│ ›○ P3\.R1\.Q1  Today, should I merge the release notes\?  ≈ 1 similar · ✓\? like P1\.R1\.Q1 +│$/,
		);
		expect(view.lines(100)[2]).toContain(`${fg("muted")}  ≈ 1 similar · ✓? like P1.R1.Q1`);
		view.key(RIGHT);
		expect(view.text(100)[3]).toMatch(/^│ {4}≈ P2\.R1\.Q1  Should I merge the release branch today\?  ✓\? like P1\.R1\.Q1 +│$/);
	});

	it("keeps ↺ and the mark on a chain row, joined by ·", () => {
		const entries = answered("Should I push to origin?", "Should I delete the old branches now?");
		entries.push(askEntry({ action: "link", ask: "b2b2b2b2.2", continues: "b2b2b2b2.1" }));
		const rows = central(entries).text(100);
		expect(rows[2]).toMatch(/^│ ›○ P2\.R1\.Q2  Should I delete the old branches now\?  ↺ P2\.R1\.Q1 · ✓\? like P1\.R1\.Q1 +│$/);
	});

	it("cuts a long ask before the suffixes, which stay whole", () => {
		const entries = answered(`Should I delete the old branches ${"a ".repeat(30)}now?`);
		entries.push(user("x"), assistant("Should I delete the old branches, all of them?", { id: "c3c3c3c3" }));
		const view = central(entries);
		const row = view.text(70)[2];
		expect(visibleWidth(row)).toBe(70);
		expect(row).toMatch(/^│ ›○ P3\.R1\.Q1  Should I delete.*…  ≈ 1 similar · ✓\? like P1\.R1\.Q1 │$/);
		const lone = central(answered(`Should I delete the old branches ${"a ".repeat(30)}now?`)).text(50)[2];
		expect(visibleWidth(lone)).toBe(50);
		expect(lone).toMatch(/^│ ›○ P2\.R1\.Q1  Should I.*…  ✓\? like P1\.R1\.Q1 │$/);
	});

	it("explains ✓? in the key help", () => {
		const view = central(branch, { rows: 60 });
		view.key("?");
		expect(view.text(120)).toContainEqual(
			expect.stringMatching(/^│ {3}✓\? like <ID>: looks answered by that closed ask; it stays open until you answer it or press x\. +│$/),
		);
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

describe("undo and reopen", () => {
	const BACKSPACE = "\x7f";

	/** `branch` with P1.R1.Q2 dismissed and a prompt that answers P1.R1.Q1 and P3.R1.Q1, on the Answered tab. */
	const answered = () => {
		branch.push(
			askEntry({ action: "dismiss", ask: "a1b2c3d4.2" }),
			user("> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?\nR: sí, las tres\n\n> P3.R1.Q1: ¿Borro las tres ramas viejas?\nR: "),
		);
		const view = central(branch, { tab: "replies" });
		view.key("\t");
		return view;
	};

	it("Backspace after x writes exactly a reopen for that ask and its row comes back", () => {
		const view = central(branch);
		const before = view.text(100);
		view.key("x");
		expect(view.text(100)).not.toEqual(before);
		view.key(BACKSPACE);
		expect(view.actions).toEqual([
			{ action: "dismiss", ask: "c9d0e1f2.1" },
			{ action: "reopen", ask: "c9d0e1f2.1" },
		]);
		expect(view.text(100)).toEqual(before);
		expect(view.closed()).toBeUndefined();
	});

	it("two x then two Backspace undo both, newest first", () => {
		const view = central(branch);
		const before = view.text(100);
		view.keys("x", "x");
		expect(view.actions).toEqual([
			{ action: "dismiss", ask: "c9d0e1f2.1" },
			{ action: "dismiss", ask: "a1b2c3d4.1" },
		]);
		view.key(BACKSPACE);
		expect(view.actions.slice(2)).toEqual([{ action: "reopen", ask: "a1b2c3d4.1" }]);
		view.key(BACKSPACE);
		expect(view.actions.slice(3)).toEqual([{ action: "reopen", ask: "c9d0e1f2.1" }]);
		expect(view.text(100)).toEqual(before);
	});

	it("Backspace after x on marked asks reopens all of them as one step", () => {
		const view = central(branch);
		view.keys(" ", "tui.select.down", " ", "x", BACKSPACE);
		expect(view.actions.slice(2)).toEqual([
			{ action: "reopen", ask: "a1b2c3d4.2" },
			{ action: "reopen", ask: "c9d0e1f2.1" },
		]);
		expect(view.text(100)[0]).toMatch(/ 2 open · 0 linked ─╮$/);
	});

	it("Backspace after a group l writes the unlink of every link it wrote, newest first, as one step", () => {
		const repeats = [...branch, user("y ahora"), assistant("¿Borro las ramas viejas?", { id: "d0d0d0d4" })];
		const view = central(repeats);
		const before = view.text(100);
		view.key("l");
		expect(view.actions).toEqual([
			{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" },
			{ action: "link", ask: "d0d0d0d4.1", continues: "a1b2c3d4.1" },
		]);
		expect(view.text(100)[0]).toMatch(/ 2 open · 1 linked ─╮$/);
		view.key(BACKSPACE);
		expect(view.actions.slice(2)).toEqual([
			{ action: "unlink", ask: "d0d0d0d4.1", continues: "a1b2c3d4.1" },
			{ action: "unlink", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" },
		]);
		expect(view.text(100)).toEqual(before);
		view.key(BACKSPACE);
		expect(view.actions).toHaveLength(4);
	});

	it("Backspace after a marked l writes the unlink of every link it wrote, newest first, as one step", () => {
		const view = central(branch);
		view.keys(RIGHT, " ", "tui.select.down", " ", "tui.select.down", " ", "l");
		expect(view.actions).toEqual([
			{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.2" },
			{ action: "link", ask: "a1b2c3d4.2", continues: "a1b2c3d4.1" },
		]);
		view.key(BACKSPACE);
		expect(view.actions.slice(2)).toEqual([
			{ action: "unlink", ask: "a1b2c3d4.2", continues: "a1b2c3d4.1" },
			{ action: "unlink", ask: "c9d0e1f2.1", continues: "a1b2c3d4.2" },
		]);
		const rows = view.text(100);
		expect(rows[0]).toMatch(/ 2 open · 0 linked ─╮$/);
		expect(rows.some((line) => line.includes("↺"))).toBe(false);
	});

	it("Backspace after u writes the link back and the chain shows ↺ again", () => {
		branch.push(askEntry({ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }));
		const view = central(branch);
		const before = view.text(100);
		view.key("u");
		expect(view.actions).toEqual([{ action: "unlink", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }]);
		view.key(BACKSPACE);
		expect(view.actions.slice(1)).toEqual([{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }]);
		expect(view.text(100)).toEqual(before);
		expect(before[2]).toMatch(/  ↺ P1\.R1\.Q1 +│$/);
	});

	it("f is not undone and does not take an undo step", () => {
		const view = central(branch);
		view.keys("x", "f", BACKSPACE);
		expect(view.formats).toEqual(["inline"]);
		expect(view.actions).toEqual([
			{ action: "dismiss", ask: "c9d0e1f2.1" },
			{ action: "reopen", ask: "c9d0e1f2.1" },
		]);
		view.key(BACKSPACE);
		expect(view.formats).toEqual(["inline"]);
		expect(view.actions).toHaveLength(2);
	});

	it("Backspace with nothing to undo writes nothing and changes nothing", () => {
		const view = central(branch);
		const before = view.text(100);
		view.key(BACKSPACE);
		expect(view.actions).toEqual([]);
		expect(view.text(100)).toEqual(before);
		expect(view.closed()).toBeUndefined();
		const done = answered();
		const shown = done.text(100);
		done.key(BACKSPACE);
		expect(done.actions).toEqual([]);
		expect(done.text(100)).toEqual(shown);
	});

	it("keeps the undo steps per overlay: a new one starts empty", () => {
		const first = central(branch);
		first.key("x");
		const second = central(branch);
		second.key(BACKSPACE);
		expect(second.actions).toEqual([]);
		expect(branch.filter((entry) => entry.type === "custom")).toHaveLength(1);
		first.key(BACKSPACE);
		expect(first.actions.at(-1)).toEqual({ action: "reopen", ask: "c9d0e1f2.1" });
	});

	it("r on an answered ask in Answered reopens it: back in Pending, ⚠ in Replies", () => {
		const view = answered();
		expect(view.text(100)[2]).toMatch(/^│ ›✓ P3\.R1\.Q1/);
		view.key("r");
		expect(view.actions).toEqual([{ action: "reopen", ask: "c9d0e1f2.1" }]);
		expect(view.text(100)[0]).toMatch(/ 1 answered · 1 dismissed ─╮$/);
		expect(view.text(100).some((line) => line.includes("P3.R1.Q1"))).toBe(false);
		view.key("\t");
		const pending = view.text(100);
		expect(pending[0]).toMatch(/^╭─ Pending ─+ 1 open · 0 linked ─╮$/);
		expect(pending[2]).toMatch(/^│ ›○ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?/);
		view.key("\t");
		expect(view.text(100)).toContainEqual(
			expect.stringMatching(/^│ .└ P3\.R1  c9d0e1f2  prompt +⚠ ¿Borro las tres ramas viejas\? +│$/),
		);
	});

	it("r on a dismissed ask in Answered reopens it the same way", () => {
		const view = answered();
		view.keys("tui.select.down", "tui.select.down");
		expect(view.text(100)[7]).toMatch(/^│ ›✓ P1\.R1\.Q2/);
		view.key("r");
		expect(view.actions).toEqual([{ action: "reopen", ask: "a1b2c3d4.2" }]);
		expect(view.text(100)[0]).toMatch(/ 2 answered · 0 dismissed ─╮$/);
		view.key("\t");
		expect(view.text(100)).toContainEqual(expect.stringMatching(/^│ .○ P1\.R1\.Q2  Necesito tu OK para pushear\. +│$/));
		view.key("\t");
		expect(view.text(100)).toContainEqual(
			expect.stringMatching(/^│ .└ P1\.R1  a1b2c3d4  prompt +⚠ Necesito tu OK para pushear\. +│$/),
		);
	});

	it("r on a chain row reopens every member, and Backspace dismisses every ask it reopened, newest first", () => {
		branch.push(
			askEntry({ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }),
			user("> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?\nR: no"),
		);
		const view = central(branch, { tab: "replies" });
		view.key("\t");
		expect(view.text(100)[2]).toMatch(/^│ ›✓ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?  ↺ P1\.R1\.Q1 +│$/);
		view.key("r");
		expect(view.actions).toEqual([
			{ action: "reopen", ask: "a1b2c3d4.1" },
			{ action: "reopen", ask: "c9d0e1f2.1" },
		]);
		expect(view.text(100)[1]).toMatch(/^│ Nothing answered yet\. +│$/);
		view.key(BACKSPACE);
		expect(view.actions.slice(2)).toEqual([
			{ action: "dismiss", ask: "c9d0e1f2.1" },
			{ action: "dismiss", ask: "a1b2c3d4.1" },
		]);
		const rows = view.text(100);
		expect(rows[0]).toMatch(/ 0 answered · 1 dismissed ─╮$/);
		expect(rows[2]).toMatch(/^│ ›✓ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?  ↺ P1\.R1\.Q1 +│$/);
		expect(rows[3]).toMatch(/^│ {4}✕ dismissed +│$/);
	});

	it("Backspace after r on a single ask writes its dismiss and the ask is closed again", () => {
		const view = answered();
		view.keys("r", BACKSPACE);
		expect(view.actions).toEqual([
			{ action: "reopen", ask: "c9d0e1f2.1" },
			{ action: "dismiss", ask: "c9d0e1f2.1" },
		]);
		expect(view.text(100)[0]).toMatch(/ 1 answered · 2 dismissed ─╮$/);
	});

	it("Backspace and r do nothing in the Replies tab, the viewer, the help card, and r nothing in Pending", () => {
		const view = central(branch);
		view.keys("x", "r");
		expect(view.actions).toHaveLength(1);
		view.key("\t");
		const replies = view.text(100);
		view.keys(BACKSPACE, "r");
		expect(view.text(100)).toEqual(replies);
		view.keys("tui.select.confirm", BACKSPACE, "r");
		expect(view.text(100)[0]).toMatch(/^╭─ P3\.R1 /);
		view.keys("tui.select.cancel", "\t", "\t", "o", BACKSPACE, "r");
		expect(view.text(100)[0]).toMatch(/^╭─ P1\.R1 /);
		view.keys("tui.select.cancel", "?", BACKSPACE, "r");
		expect(view.text(100)[0]).toMatch(/^╭─ Keys /);
		view.key("?");
		expect(view.actions).toEqual([{ action: "dismiss", ask: "c9d0e1f2.1" }]);
		expect(view.closed()).toBeUndefined();
		view.key(BACKSPACE);
		expect(view.actions.at(-1)).toEqual({ action: "reopen", ask: "c9d0e1f2.1" });
	});

	it("the key help lists ⌫ and r and still fits the cap on 8, 24 and 50 rows", () => {
		const UNDO = /^│ {3}⌫ +undo the last action +│$/;
		const REOPEN = /^│ {3}r +reopen the selected ask +│$/;
		const wide = central(branch, { rows: 60 });
		wide.key("?");
		const rows = wide.text(100);
		const answeredAt = rows.findIndex((line) => /^│ Answered +│$/.test(line));
		const everyAt = rows.findIndex((line) => /^│ Every tab +│$/.test(line));
		const pendingUndo = rows.findIndex((line) => UNDO.test(line));
		expect(pendingUndo).toBeGreaterThan(0);
		expect(pendingUndo).toBeLessThan(answeredAt);
		const answeredKeys = rows.slice(answeredAt, everyAt);
		expect(answeredKeys).toContainEqual(expect.stringMatching(REOPEN));
		expect(answeredKeys).toContainEqual(expect.stringMatching(UNDO));
		expect(wide.lines(100)[pendingUndo]).toContain(`${fg("accent")}⌫`);
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
				expect(seen.some((line) => line.startsWith("│   ⌫"))).toBe(true);
				expect(seen.some((line) => line.startsWith("│   r "))).toBe(true);
				if (width === 140) {
					expect(seen).toContainEqual(expect.stringMatching(UNDO));
					expect(seen).toContainEqual(expect.stringMatching(REOPEN));
				}
			}
		}
	});
});

describe("triage proposals", () => {
	const BACKSPACE = "\x7f";
	/** P2 is `seguí` (entry 00000003) and P3 `revisá los tests` (entry 00000005). */
	const triaged = (proposals: unknown[]) => [...branch, customEntry("reply-thread.triage", { model: "anthropic/test", proposals })];
	const SAME = { kind: "same", ask: "c9d0e1f2.1", as: "a1b2c3d4.1" };
	const ANSWERED = { kind: "answered", ask: "a1b2c3d4.2", prompt: "00000003", quote: "seguí" };
	const LATER = { kind: "answered", ask: "a1b2c3d4.2", prompt: "00000005", quote: "revisá los tests" };

	it("shows the first live proposal under its row, indented under the ask text, with +N more", () => {
		const view = central(triaged([SAME, ANSWERED, LATER]));
		const rows = view.text(100);
		expect(rows.slice(1, -1)).toEqual([
			expect.stringMatching(/^│ ▌P3  revisá los tests +12:00 │$/),
			expect.stringMatching(/^│ ›○ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?  ≈ 1 similar +│$/),
			expect.stringMatching(/^│ {14}✦ same as P1\.R1\.Q1  Hay tres ramas viejas\. ¿Las borro\? +│$/),
			expect.stringMatching(/^│ ▌P1  limpiá la rama +12:00 │$/),
			expect.stringMatching(/^│  ○ P1\.R1\.Q2  Necesito tu OK para pushear\. +│$/),
			expect.stringMatching(/^│ {14}✦ answered in P2: "seguí"  \+1 more +│$/),
		]);
		const line = view.lines(100)[3];
		expect(line).toContain(`${fg("accent")}✦`);
		expect(line).toContain(`${fg("muted")} same as P1.R1.Q1  Hay tres ramas viejas. ¿Las borro?`);
		expect(line).not.toContain(bg("selectedBg"));
		expect(rows[0]).toMatch(/ 2 open · 0 linked ─╮$/);
	});

	it("shows a proposal under an expanded member that has one", () => {
		const view = central(triaged([{ kind: "answered", ask: "a1b2c3d4.1", prompt: "00000003", quote: "seguí" }]));
		expect(view.text(100).some((line) => line.includes("✦"))).toBe(false);
		view.key(RIGHT);
		expect(view.text(100).slice(2, 5)).toEqual([
			expect.stringMatching(/^│ ›○ P3\.R1\.Q1 /),
			expect.stringMatching(/^│ {4}≈ P1\.R1\.Q1  Hay tres ramas viejas\. ¿Las borro\? +│$/),
			expect.stringMatching(/^│ {16}✦ answered in P2: "seguí" +│$/),
		]);
	});

	it("cuts a long proposal to the width, keeping +N more, and every line keeps the exact width", () => {
		const long = { ...ANSWERED, quote: "seguí ".repeat(30) };
		const entries = triaged([long, LATER]);
		for (const width of [24, 60, 80, 140]) {
			const lines = central([...entries]).text(width);
			expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
		}
		expect(central([...entries]).text(60)[5]).toMatch(/^│ {14}✦ answered in P2: "seguí seguí.*…  \+1 more │$/);
	});

	it("skips proposal rows on up, down and page keys", () => {
		const view = central(triaged([SAME, ANSWERED]));
		view.key("tui.select.down");
		expect(view.text(100)[5]).toMatch(/^│ ›○ P1\.R1\.Q2/);
		view.key("tui.select.down");
		expect(view.text(100)[5]).toMatch(/^│ ›○ P1\.R1\.Q2/);
		view.key("tui.select.up");
		expect(view.text(100)[2]).toMatch(/^│ ›○ P3\.R1\.Q1/);
		view.key("tui.select.pageDown");
		expect(view.text(100)[5]).toMatch(/^│ ›○ P1\.R1\.Q2/);
		expect(view.text(100).filter((line) => line.includes("✦")).every((line) => !line.includes("›"))).toBe(true);
		view.key("tui.select.pageUp");
		expect(view.text(100)[2]).toMatch(/^│ ›○ P3\.R1\.Q1/);
	});

	it("a accepts an answered proposal as an answer entry, and Backspace reopens the ask", () => {
		const view = central(triaged([SAME, ANSWERED]));
		const before = view.text(100);
		view.keys("tui.select.down", "a");
		expect(view.actions).toEqual([{ action: "answer", ask: "a1b2c3d4.2", prompt: "00000003", text: "seguí" }]);
		expect(view.text(100)[0]).toMatch(/ 1 open · 0 linked ─╮$/);
		expect(view.text(100).some((line) => line.includes("P1.R1.Q2"))).toBe(false);
		view.key("\t");
		view.key("\t");
		expect(view.text(100)).toContainEqual(expect.stringMatching(/^│ {4}↳ P2  seguí +│$/));
		view.key("\t");
		view.key(BACKSPACE);
		expect(view.actions.slice(1)).toEqual([{ action: "reopen", ask: "a1b2c3d4.2" }]);
		view.key("tui.select.up");
		expect(view.text(100)).toEqual(before);
	});

	it("a accepts a same proposal as the links of the two rows, and Backspace unlinks them", () => {
		const view = central(triaged([SAME, ANSWERED]));
		const before = view.text(100);
		view.key("a");
		expect(view.actions).toEqual([{ action: "link", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }]);
		expect(view.text(100)[0]).toMatch(/ 2 open · 1 linked ─╮$/);
		expect(view.text(100)[2]).toMatch(/  ↺ P1\.R1\.Q1 +│$/);
		view.key(BACKSPACE);
		expect(view.actions.slice(1)).toEqual([{ action: "unlink", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" }]);
		expect(view.text(100)).toEqual(before);
	});

	it("a on a same proposal whose other ask is a chain member links to that chain's row", () => {
		resetIds();
		const entries = [
			user("a"),
			assistant("¿Subo la versión?\n\n¿Taggeo el release?", { id: "aaaaaaa1" }),
			askEntry({ action: "link", ask: "aaaaaaa1.2", continues: "aaaaaaa1.1" }),
			user("b"),
			assistant("¿Publico en npm?", { id: "aaaaaaa2" }),
			customEntry("reply-thread.triage", { model: "m", proposals: [{ kind: "same", ask: "aaaaaaa2.1", as: "aaaaaaa1.1" }] }),
		];
		const view = central(entries);
		expect(view.text(100)[3]).toMatch(/✦ same as P1\.R1\.Q1  ¿Subo la versión\?/);
		view.key("a");
		expect(view.actions).toEqual([{ action: "link", ask: "aaaaaaa2.1", continues: "aaaaaaa1.1" }]);
		expect(view.text(100)[0]).toMatch(/ 1 open · 1 linked ─╮$/);
	});

	it("n rejects the first proposal, the next one shows, and Backspace restores it", () => {
		const view = central(triaged([ANSWERED, LATER]));
		const before = view.text(100);
		view.keys("tui.select.down", "n");
		expect(view.actions).toEqual([{ action: "reject", ask: "a1b2c3d4.2", proposal: "answered:00000003" }]);
		expect(view.text(100)[5]).toMatch(/^│ {14}✦ answered in P3: "revisá los tests" +│$/);
		view.key(BACKSPACE);
		expect(view.actions.slice(1)).toEqual([{ action: "restore", ask: "a1b2c3d4.2", proposal: "answered:00000003" }]);
		view.key("tui.select.up");
		expect(view.text(100)).toEqual(before);
	});

	it("a and n write nothing on a row without a proposal, or without any triage", () => {
		const view = central(triaged([ANSWERED]));
		const before = view.text(100);
		view.keys("a", "n");
		expect(view.actions).toEqual([]);
		expect(view.text(100)).toEqual(before);
		const plain = central(branch);
		const shown = plain.text(100);
		plain.keys("a", "n", "tui.select.down", "a", "n");
		expect(plain.actions).toEqual([]);
		expect(plain.closed()).toBeUndefined();
		plain.key("tui.select.up");
		expect(plain.text(100)).toEqual(shown);
	});

	it("keeps the short hints line as it was with proposals on screen", () => {
		const view = central(triaged([SAME, ANSWERED]));
		expect(view.text(70).at(-1)).toBe("╰─ enter answer · y yes · f format · t triage · ? help · esc close ──╯");
		expect(view.text(80).at(-1)).toBe(`╰─ enter answer · y yes · f format · t triage · ? help · esc close ${"─".repeat(12)}╯`);
	});

	it("the key help lists a and n with the ✦ note under them and still fits the cap", () => {
		const ACCEPT = /^│ {3}a +accept the row's ✦ triage proposal +│$/;
		const REJECT = /^│ {3}n +reject the row's ✦ triage proposal +│$/;
		const NOTE = /^│ {3}✦ comes from \/replies triage: a model's proposal; nothing closes or links until you press a\. +│$/;
		const wide = central(branch, { rows: 60 });
		wide.key("?");
		const rows = wide.text(140);
		const answeredAt = rows.findIndex((line) => /^│ Replies +│$/.test(line));
		const at = rows.findIndex((line) => ACCEPT.test(line));
		expect(at).toBeGreaterThan(0);
		expect(at).toBeLessThan(answeredAt);
		expect(rows[at + 1]).toMatch(REJECT);
		expect(rows[at + 2]).toMatch(NOTE);
		expect(wide.lines(140)[at]).toContain(`${fg("accent")}a`);
		expect(wide.lines(140)[at + 2]).toContain(`${fg("muted")}✦ comes from`);
		for (const height of [8, 24, 50]) {
			const cap = Math.min(height - 4, Math.floor(height * 0.9));
			for (const width of [24, 80, 140]) {
				const view = central(branch, { rows: height });
				view.key("?");
				const seen: string[] = [];
				for (let press = 0; press < 45; press += 1) {
					const lines = view.text(width);
					expect(lines.length).toBeLessThanOrEqual(cap);
					expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
					expect(lines.at(-1)).toMatch(/^╰─/);
					seen.push(...lines);
					view.key("tui.select.down");
				}
				expect(seen.some((line) => line.startsWith("│   a "))).toBe(true);
				expect(seen.some((line) => line.startsWith("│   ✦ comes from"))).toBe(true);
				if (width === 140) expect(seen).toContainEqual(expect.stringMatching(NOTE));
				expect(seen.at(-2)).toMatch(/^│ Asks: decision sect/);
			}
		}
	});

	it("fits the overlay cap with proposals on 8, 24 and 50 rows at exact widths", () => {
		const many = () => {
			resetIds();
			const entries = Array.from({ length: 20 }, (_, index) => [
				user(`prompt ${index + 1}`),
				assistant(`¿Primera tema${index + 1}?`, { id: `c${index.toString(16).padStart(7, "0")}` }),
			]).flat();
			const proposals = Array.from({ length: 19 }, (_, index) => ({
				kind: "answered",
				ask: `c${index.toString(16).padStart(7, "0")}.1`,
				prompt: entries[2 * index + 2].id,
				quote: `prompt ${index + 2}`,
			}));
			return [...entries, customEntry("reply-thread.triage", { model: "m", proposals })];
		};
		for (const rows of [8, 24, 50]) {
			const cap = Math.min(rows - 4, Math.floor(rows * 0.9));
			for (const width of [24, 80, 140]) {
				const view = central(many(), { rows });
				for (const press of ["", "tui.select.down", "tui.select.pageDown", "tui.select.pageDown", "tui.select.pageUp", "tui.select.up"]) {
					if (press) view.key(press);
					const lines = view.text(width);
					expect(lines.length).toBeLessThanOrEqual(cap);
					expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
					expect(lines.at(-1)).toMatch(/^╰─/);
					expect(lines.slice(1, -1).some((line) => line.includes("›"))).toBe(true);
				}
			}
		}
	});
});
