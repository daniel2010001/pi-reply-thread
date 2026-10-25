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
import { type AskAction, buildPending } from "../src/pending.ts";
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
function central(entries: SessionEntry[], options: { rows?: number; tab?: "pending" | "replies" } = {}) {
	let closed: { paste?: string } | undefined;
	const actions: AskAction[] = [];
	const tui = { terminal: { rows: options.rows ?? 30 }, requestRender: () => {} } as unknown as TUI;
	const act = (action: AskAction) => {
		actions.push(action);
		entries.push(askEntry(action as unknown as Record<string, string>));
		return buildPending(entries);
	};
	const component = new RepliesView(
		tui,
		theme,
		keybindings,
		buildThreads(entries),
		(paste?: string) => (closed = { paste }),
		undefined,
		{ pending: buildPending(entries), act, tab: options.tab },
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
		const rows = view.text(100);
		expect(rows[0]).toMatch(/^╭─ Pending ─+ 3 open · 0 linked ─╮$/);
		expect(rows.at(-1)).toMatch(/^╰─ enter answer · s sí · space mark · x dismiss · l link · o open · tab replies · esc close ─+╯$/);
		view.key("\t");
		expect(view.text()[0]).toMatch(/^╭─ Replies ─+ 3 prompts · 3 replies ─╮$/);
		expect(view.text().at(-1)).toMatch(/^╰─ ↑↓ move · enter open · esc close ─+╯$/);
		view.key("\t");
		expect(view.text()[0]).toMatch(/^╭─ Pending /);
	});

	it("opens on Replies when nothing is open", () => {
		const view = central([user("hola"), assistant("Listo.")]);
		expect(view.text()[0]).toMatch(/^╭─ Replies /);
		view.key("\t");
		expect(view.text()).toEqual([
			expect.stringMatching(/^╭─ Pending ─+╮$/),
			expect.stringMatching(/^│ Nothing waits on you\. +│$/),
			expect.stringMatching(/^╰─ tab replies · esc close ─+╯$/),
		]);
	});

	it("groups the open asks under their prompt, newest prompt first, and suggests a repeat with ≈", () => {
		const { lines, text } = central(branch);
		expect(text().slice(1, 6)).toEqual([
			expect.stringMatching(/^│ ▌P3  revisá los tests +12:00 │$/),
			expect.stringMatching(/^│ ›○ P3\.R1\.Q1  ¿Borro las tres ramas viejas\?  ≈ P1\.R1\.Q1 +│$/),
			expect.stringMatching(/^│ ▌P1  limpiá la rama +12:00 │$/),
			expect.stringMatching(/^│  ○ P1\.R1\.Q1  Hay tres ramas viejas\. ¿Las borro\? +│$/),
			expect.stringMatching(/^│  ○ P1\.R1\.Q2  Necesito tu OK para pushear\. +│$/),
		]);
		expect(lines()[1]).toContain(bg("userMessageBg"));
		expect(lines()[2]).toContain(bg("selectedBg"));
		expect(lines()[2]).toContain(`${fg("mdLink")}  ≈ P1.R1.Q1`);
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
	it("Enter closes and pastes the selected ask as a quote, then an empty line", () => {
		const view = central(branch);
		view.key("tui.select.confirm");
		expect(view.closed()).toEqual({ paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas?\n\n" });
	});

	it("space marks asks with ● and Enter pastes every marked ask in list order", () => {
		const view = central(branch);
		view.keys(" ", "tui.select.down", "tui.select.down", " ");
		expect(view.text()[2]).toMatch(/^│  ● P3\.R1\.Q1/);
		expect(view.lines()[2]).toContain(`${fg("accent")}●`);
		view.keys("tui.select.up", " ", " ", "tui.select.confirm");
		expect(view.closed()).toEqual({
			paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas?\n> P1.R1.Q2: Necesito tu OK para pushear.\n\n",
		});
	});

	it("s pastes the same quotes with Sí. after each one", () => {
		const view = central(branch);
		view.keys(" ", "tui.select.down", " ", "s");
		expect(view.closed()).toEqual({
			paste: "> P3.R1.Q1: ¿Borro las tres ramas viejas?\nSí.\n> P1.R1.Q1: Hay tres ramas viejas. ¿Las borro?\nSí.\n\n",
		});
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
		expect(rows.at(-1)).toContain("u unlink");
		view.key("u");
		expect(view.actions.at(-1)).toEqual({ action: "unlink", ask: "c9d0e1f2.1", continues: "a1b2c3d4.1" });
		expect(view.text(100)[0]).toMatch(/ 3 open · 0 linked ─╮$/);
	});

	it("l and u do nothing on an ask without a suggestion or a chain", () => {
		const view = central(branch);
		view.keys("tui.select.down", "tui.select.down", "l", "u");
		expect(view.actions).toEqual([]);
		expect(view.text(100).at(-1)).not.toMatch(/l link|u unlink/);
	});
});

describe("folding", () => {
	const prompts = (count: number) => {
		resetIds();
		return Array.from({ length: count }, (_, index) => [
			user(`prompt ${index + 1}`),
			assistant(`¿Pregunta ${index + 1} de ${count} ${"x".repeat(index)}?`),
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
			assistant(`¿Primera ${index + 1}?\n\n¿Segunda ${index + 1}?`),
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
