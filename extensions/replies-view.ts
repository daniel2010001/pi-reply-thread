import type { KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type AnswerFormat,
	answerText,
	FORMAT_NAMES,
	formatTime,
	type IndexRow,
	indexRows,
	promptLine,
	triggerText,
} from "../src/format.ts";
import type { Ask, AskAction, PendingAsk } from "../src/pending.ts";
import type { Reply, Thread, Trigger, TriggerKind } from "../src/threads.ts";

/** Pi cuts an overlay taller than its `maxHeight`, so the view sizes itself to the same cap. */
const MAX_HEIGHT_PERCENT = 90;
export const OVERLAY_OPTIONS = { width: "90%", maxHeight: `${MAX_HEIGHT_PERCENT}%`, anchor: "center" } as const;
/** Rows the overlay leaves to the rest of the screen on a short one. */
const SCREEN_MARGIN = 4;
/** Body rows the viewer keeps before it shows the prompt and open asks above them. */
const MIN_BODY = 3;
/** Widest trigger column in the list; longer labels are cut there. */
const TRIGGER_COLUMN = 24;
/** Prompts with open asks shown before the rest fold into one `Older (N)` row. */
const UNFOLDED_PROMPTS = 10;
/** Narrowest ask text kept before a row drops its chain or suggestion. */
const MIN_ASK = 8;

/** Theme token of each trigger kind, so a glance tells a job from a worker. */
const TRIGGER_COLOR: Record<TriggerKind, ThemeColor> = {
	prompt: "muted",
	job: "success",
	monitor: "mdLink",
	worker: "customMessageLabel",
	session: "thinkingText",
	other: "dim",
};

type Hint = [key: string, action: string];

export type Tab = "pending" | "replies";

/** The pending central: the open asks, and how to dismiss or link them on the branch. */
export interface Central {
	pending: readonly PendingAsk[];
	/** Writes the action to the branch and returns the open asks rebuilt from it. */
	act(action: AskAction): readonly PendingAsk[];
	/** The tab to open on; Pending when any ask is open, else Replies. */
	tab?: Tab;
	/** How answers are pasted when the central opens. */
	format: AnswerFormat;
	/** Saves the format `f` switches to on the branch. */
	setFormat(format: AnswerFormat): void;
}

/** One line of the Pending tab: a prompt header, an open ask, or the folded older prompts. */
type PendingRow = { kind: "prompt"; thread: Thread } | { kind: "ask"; ask: PendingAsk } | { kind: "older"; count: number };

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** Cuts a styled line to `width` columns and pads it with spaces to exactly that width. */
function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const cut = truncateToWidth(text, width, "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/**
 * The right border of each body row: it turns into a scrollbar, a thumb where the window sits and
 * a track elsewhere, only when the rows do not fit.
 */
function scrollCells(theme: Theme, total: number, height: number, top: number): string[] {
	if (total <= height) return Array(height).fill(theme.fg("borderAccent", "│"));
	const thumb = Math.max(1, Math.round((height * height) / total));
	const start = Math.round((top / (total - height)) * (height - thumb));
	return Array.from({ length: height }, (_, index) =>
		index >= start && index < start + thumb ? theme.fg("scrollbarThumb", "┃") : theme.fg("scrollbarTrack", "│"),
	);
}

/**
 * The thread list with a full-reply viewer: Enter opens a reply, Esc goes back, Esc on the list closes.
 * With a central, a Pending tab lists the open asks; Enter or `s` closes it with the text to paste,
 * in the format `f` toggles.
 */
export class RepliesView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (paste?: string) => void;
	private readonly rows: IndexRow[];
	private readonly counts: string;
	private readonly ordinalWidth: number;
	private readonly triggerWidth: number;
	private selected: number;
	private listTop = 0;
	private reply: Reply | undefined;
	private thread: Thread | undefined;
	private body: Markdown | undefined;
	private scroll = 0;
	/** Opened straight on a reply by `/replies <id>`: Esc in the viewer closes instead of going back. */
	private readonly closeFromViewer: boolean;
	private readonly central: Central | undefined;
	private tab: Tab;
	private pending: readonly PendingAsk[] = [];
	private pendingRows: PendingRow[] = [];
	private pendingSelected = 0;
	private pendingTop = 0;
	private askOrdinalWidth = 0;
	private readonly marked = new Set<string>();
	private expanded = false;
	private format: AnswerFormat = "lines";

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		threads: readonly Thread[],
		done: (paste?: string) => void,
		direct?: Reply,
		central?: Central,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.central = central;
		this.tab = central ? (central.tab ?? (central.pending.length ? "pending" : "replies")) : "replies";
		if (central) {
			this.format = central.format;
			this.setPending(central.pending);
		}
		this.rows = indexRows(threads);
		const replies = this.rows.flatMap((row) => (row.reply ? [row.reply] : []));
		const prompts = threads.filter((thread) => thread.prompt > 0).length;
		this.counts = threads.length
			? `${plural(prompts, "prompt", "prompts")} · ${plural(replies.length, "reply", "replies")}`
			: "";
		this.ordinalWidth = Math.max(0, ...replies.map((reply) => reply.ordinal.length));
		this.triggerWidth = Math.min(
			TRIGGER_COLUMN,
			Math.max(0, ...replies.map((reply) => visibleWidth(triggerText(reply.triggers)))),
		);
		this.selected = Math.max(
			0,
			this.rows.findIndex((row) => row.reply),
		);
		this.closeFromViewer = Boolean(direct);
		if (direct) this.open(direct);
	}

	/** Rows the whole view may use: never more than Pi's overlay cap, and at least the two borders and a row. */
	private available(): number {
		const rows = this.tui.terminal.rows;
		return Math.max(3, Math.min(rows - SCREEN_MARGIN, Math.floor((rows * MAX_HEIGHT_PERCENT) / 100)));
	}

	/** Body rows of the list: the screen minus the top and bottom borders. */
	private listHeight(): number {
		return this.available() - 2;
	}

	private open(reply: Reply, thread?: Thread): void {
		this.reply = reply;
		this.thread = thread ?? this.rows.find((row) => row.reply === reply)?.thread;
		this.body = new Markdown(reply.text, 0, 0, getMarkdownTheme());
		this.scroll = 0;
	}

	private close(): void {
		this.reply = undefined;
		this.thread = undefined;
		this.body = undefined;
	}

	private moveSelection(step: number): void {
		let next = this.selected;
		for (let left = Math.abs(step); left > 0; ) {
			const candidate = next + Math.sign(step);
			if (candidate < 0 || candidate >= this.rows.length) break;
			next = candidate;
			if (this.rows[next].reply) {
				this.selected = next;
				left -= 1;
			}
		}
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (this.reply) {
			const page = Math.max(1, this.viewerHeight() - 1);
			if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
				if (this.closeFromViewer) return this.done();
				this.close();
			} else if (kb.matches(data, "tui.select.up")) this.scroll -= 1;
			else if (kb.matches(data, "tui.select.down")) this.scroll += 1;
			else if (kb.matches(data, "tui.select.pageUp")) this.scroll -= page;
			else if (kb.matches(data, "tui.select.pageDown") || matchesKey(data, "space")) this.scroll += page;
			else if (matchesKey(data, "home")) this.scroll = 0;
			else if (matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER;
			else return;
		} else if (this.tab === "pending") {
			if (!this.pendingInput(data)) return;
		} else {
			const page = this.listHeight() - 1;
			if (kb.matches(data, "tui.select.cancel")) return this.done();
			if (this.central && matchesKey(data, "tab")) this.tab = "pending";
			if (kb.matches(data, "tui.select.confirm")) {
				const reply = this.rows[this.selected]?.reply;
				if (!reply) return;
				this.open(reply);
			} else if (kb.matches(data, "tui.select.up")) this.moveSelection(-1);
			else if (kb.matches(data, "tui.select.down")) this.moveSelection(1);
			else if (kb.matches(data, "tui.select.pageUp")) this.moveSelection(-page);
			else if (kb.matches(data, "tui.select.pageDown")) this.moveSelection(page);
			else return;
		}
		this.tui.requestRender();
	}

	// ── Pending ──────────────────────────────────────────────────────────────

	/** Takes the open asks and rebuilds the rows: prompts newest first, the older ones folded. */
	private setPending(pending: readonly PendingAsk[]): void {
		this.pending = pending;
		const ids = new Set(pending.map((ask) => ask.id));
		for (const id of this.marked) if (!ids.has(id)) this.marked.delete(id);
		this.askOrdinalWidth = Math.max(0, ...pending.map((ask) => ask.ordinal.length));

		const groups = new Map<number, { thread: Thread; asks: PendingAsk[] }>();
		for (const ask of pending) {
			const group = groups.get(ask.thread.prompt) ?? { thread: ask.thread, asks: [] };
			group.asks.push(ask);
			groups.set(ask.thread.prompt, group);
		}
		const ordered = [...groups.values()].sort((a, b) => b.thread.prompt - a.thread.prompt);
		const shown = this.expanded ? ordered : ordered.slice(0, UNFOLDED_PROMPTS);
		const rows: PendingRow[] = shown.flatMap(({ thread, asks }) => [
			{ kind: "prompt" as const, thread },
			...asks.map((ask) => ({ kind: "ask" as const, ask })),
		]);
		const folded = ordered.slice(shown.length).reduce((count, group) => count + group.asks.length, 0);
		if (folded) rows.push({ kind: "older", count: folded });
		this.pendingRows = rows;
		this.selectPending(this.pendingSelected);
	}

	/** Selects the first selectable row at or after `index`, or the last one before it. */
	private selectPending(index: number): void {
		const rows = this.pendingRows;
		const at = Math.min(Math.max(0, index), Math.max(0, rows.length - 1));
		let next = rows.findIndex((row, offset) => offset >= at && row.kind !== "prompt");
		if (next < 0) next = rows.findLastIndex((row) => row.kind !== "prompt");
		this.pendingSelected = Math.max(0, next);
	}

	private movePending(step: number): void {
		let next = this.pendingSelected;
		for (let left = Math.abs(step); left > 0; ) {
			const candidate = next + Math.sign(step);
			if (candidate < 0 || candidate >= this.pendingRows.length) break;
			next = candidate;
			if (this.pendingRows[next].kind !== "prompt") {
				this.pendingSelected = next;
				left -= 1;
			}
		}
	}

	private selectedAsk(): PendingAsk | undefined {
		const row = this.pendingRows[this.pendingSelected];
		return row?.kind === "ask" ? row.ask : undefined;
	}

	/** The marked asks in list order, or the selected one when none is marked. */
	private targets(): PendingAsk[] {
		const marked = this.pendingRows.flatMap((row) => (row.kind === "ask" && this.marked.has(row.ask.id) ? [row.ask] : []));
		if (marked.length) return marked;
		const ask = this.selectedAsk();
		return ask ? [ask] : [];
	}

	/** The marked asks and the older members of their chains, newest first. */
	private markedChain(): Ask[] {
		const rows = this.pending.filter((ask) => this.marked.has(ask.id));
		return rows.flatMap((row) => [...row.chain, row]).sort((a, b) => b.seq - a.seq);
	}

	private act(actions: AskAction[]): void {
		const central = this.central as Central;
		let pending = this.pending;
		for (const action of actions) pending = central.act(action);
		this.setPending(pending);
	}

	/** Keys of the Pending tab; false when the key means nothing there. */
	private pendingInput(data: string): boolean {
		const kb = this.keybindings;
		const page = this.listHeight() - 1;
		const row = this.pendingRows[this.pendingSelected];
		const ask = this.selectedAsk();
		if (kb.matches(data, "tui.select.cancel")) {
			this.done();
			return false;
		}
		if (matchesKey(data, "tab")) this.tab = "replies";
		else if (kb.matches(data, "tui.select.up")) this.movePending(-1);
		else if (kb.matches(data, "tui.select.down")) this.movePending(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.movePending(-page);
		else if (kb.matches(data, "tui.select.pageDown")) this.movePending(page);
		else if (kb.matches(data, "tui.select.confirm") && row?.kind === "older") {
			this.expanded = true;
			this.setPending(this.pending);
		} else if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "s")) {
			const targets = this.targets();
			if (!targets.length) return false;
			this.done(answerText(targets, matchesKey(data, "s"), this.format));
			return false;
		} else if (matchesKey(data, "f")) {
			this.format = this.format === "lines" ? "inline" : "lines";
			(this.central as Central).setFormat(this.format);
		} else if (matchesKey(data, "space") && ask) {
			if (!this.marked.delete(ask.id)) this.marked.add(ask.id);
		} else if (matchesKey(data, "x")) {
			const targets = this.targets();
			if (!targets.length) return false;
			this.act(targets.map((target) => ({ action: "dismiss", ask: target.id })));
		} else if (matchesKey(data, "l") && this.marked.size >= 2) {
			// Each ask continues the next older one, so the marked asks and their chains become one chain.
			const members = this.markedChain();
			this.act(members.slice(1).map((older, index) => ({ action: "link", ask: members[index].id, continues: older.id })));
			this.marked.clear();
		} else if (matchesKey(data, "l") && ask?.suggestion) {
			this.act([{ action: "link", ask: ask.id, continues: ask.suggestion.id }]);
		} else if (matchesKey(data, "u") && ask?.continues) {
			this.act([{ action: "unlink", ask: ask.id, continues: ask.continues }]);
		} else if (matchesKey(data, "o") && ask) this.open(ask.reply, ask.thread);
		else return false;
		return true;
	}

	// ── Frame ────────────────────────────────────────────────────────────────

	private border(text: string): string {
		return this.theme.fg("borderAccent", text);
	}

	/** `╭─ title ──── detail ─╮`; the detail goes first when the width runs short. */
	private top(title: string, detail: string, width: number): string {
		const theme = this.theme;
		const inner = width - 2;
		let right = detail ? ` ${detail} ` : "";
		if (inner - visibleWidth(title) - 4 - visibleWidth(right) < 1) right = "";
		const left = truncateToWidth(title, Math.max(0, inner - 4 - visibleWidth(right)), "…");
		const fill = Math.max(0, inner - 3 - visibleWidth(left) - visibleWidth(right) - (right ? 1 : 0));
		return [
			this.border("╭─ "),
			theme.fg("accent", theme.bold(left)),
			this.border(` ${"─".repeat(fill)}`),
			right ? theme.fg("muted", right) + this.border("─") : "",
			this.border("╮"),
		].join("");
	}

	/** `╰─ hints ─────╯`, with the key of each hint in the accent colour. */
	private bottom(hints: Hint[], extra: string, width: number): string {
		const theme = this.theme;
		const inner = width - 2;
		const separator = theme.fg("dim", " · ");
		const styled =
			hints.map(([key, action]) => `${theme.fg("accent", key)} ${theme.fg("dim", action)}`).join(separator) +
			(extra ? separator + theme.fg("muted", extra) : "");
		const text = truncateToWidth(styled, Math.max(0, inner - 4), "…");
		const fill = Math.max(0, inner - 3 - visibleWidth(text));
		return `${this.border("╰─ ")}${text}${this.border(` ${"─".repeat(fill)}╯`)}`;
	}

	/** `│ content │`; `edge` replaces the right border, for the scrollbar. */
	private line(content: string, width: number, edge = this.border("│")): string {
		return `${this.border("│")} ${fit(content, width - 4)} ${edge}`;
	}

	private separator(width: number): string {
		return this.border(`├${"─".repeat(Math.max(0, width - 2))}┤`);
	}

	// ── List ─────────────────────────────────────────────────────────────────

	private triggers(triggers: readonly Trigger[]): string {
		const theme = this.theme;
		if (!triggers.length) return theme.fg("dim", triggerText(triggers));
		return triggers
			.map((trigger) => theme.fg(TRIGGER_COLOR[trigger.kind], triggerText([trigger])))
			.join(theme.fg("dim", ", "));
	}

	private threadLine(thread: Thread, width: number): string {
		const theme = this.theme;
		const label = `P${thread.prompt}`;
		const time = formatTime(thread.timestamp);
		const lead = 1 + label.length + 2;
		const room = width - lead - time.length - 1;
		const showTime = room >= 4;
		const prompt = truncateToWidth(promptLine(thread), Math.max(0, showTime ? room : width - lead), "…");
		const gap = showTime ? " ".repeat(Math.max(1, width - lead - visibleWidth(prompt) - time.length)) : "";
		const content = [
			theme.fg("accent", "▌"),
			theme.fg("accent", theme.bold(label)),
			"  ",
			theme.fg("userMessageText", prompt),
			gap,
			showTime ? theme.fg("muted", time) : "",
		].join("");
		return theme.bg("userMessageBg", fit(content, width));
	}

	private replyLine(row: IndexRow, selected: boolean, width: number): string {
		const theme = this.theme;
		const reply = row.reply as Reply;
		const last = reply.index === row.thread.replies.length;
		const ordinal = reply.ordinal.padEnd(this.ordinalWidth);
		const trigger = fit(this.triggers(reply.triggers), this.triggerWidth);
		const ask = reply.openAsks[0];
		const content = [
			selected ? theme.fg("accent", "›") : " ",
			theme.fg("borderMuted", last ? "└" : "├"),
			" ",
			theme.fg("accent", selected ? theme.bold(ordinal) : ordinal),
			"  ",
			theme.fg("dim", reply.entryId),
			"  ",
			trigger,
			ask ? `  ${theme.fg("warning", "⚠")} ${theme.fg("muted", ask)}` : "",
		].join("");
		const line = fit(content, width);
		return selected ? theme.bg("selectedBg", line) : line;
	}

	private renderList(width: number): string[] {
		const theme = this.theme;
		const top = this.top("Replies", this.counts, width);
		if (!this.rows.length) {
			return [
				top,
				this.line(theme.fg("dim", "No replies on this branch yet."), width),
				this.bottom([["esc", "close"]], "", width),
			];
		}

		const height = Math.min(this.listHeight(), this.rows.length);
		if (this.selected < this.listTop) this.listTop = this.selected;
		if (this.selected >= this.listTop + height) this.listTop = this.selected - height + 1;
		// Show the thread row above the first visible reply when the list starts at the top of a thread.
		if (this.listTop > 0 && !this.rows[this.listTop - 1].reply && this.selected - this.listTop + 1 < height) {
			this.listTop -= 1;
		}
		const cells = scrollCells(theme, this.rows.length, height, this.listTop);
		const content = width - 4;
		const visible = this.rows.slice(this.listTop, this.listTop + height).map((row, offset) => {
			const index = this.listTop + offset;
			const text = row.reply ? this.replyLine(row, index === this.selected, content) : this.threadLine(row.thread, content);
			return this.line(text, width, cells[offset]);
		});
		const hints: Hint[] = [
			["↑↓", "move"],
			["enter", "open"],
			["esc", "close"],
		];
		return [top, ...visible, this.bottom(hints, "", width)];
	}

	// ── Pending view ─────────────────────────────────────────────────────────

	/** `›○ P13.R1.Q1  <ask>  ↺ <older members>` or `  ≈ <suggested repeat>`; the ask is cut first. */
	private askLine(ask: PendingAsk, selected: boolean, width: number): string {
		const theme = this.theme;
		const ordinal = ask.ordinal.padEnd(this.askOrdinalWidth);
		const room = width - 3 - ordinal.length - 2;
		let suffix = "";
		let color: ThemeColor = "muted";
		if (ask.chain.length) suffix = `  ↺ ${ask.chain.map((member) => member.ordinal).join(", ")}`;
		else if (ask.suggestion) {
			suffix = `  ≈ ${ask.suggestion.ordinal}`;
			color = "mdLink";
		}
		if (room - visibleWidth(suffix) < MIN_ASK) suffix = "";
		const text = truncateToWidth(ask.text, Math.max(0, room - visibleWidth(suffix)), "…");
		const content = [
			selected ? theme.fg("accent", "›") : " ",
			this.marked.has(ask.id) ? theme.fg("accent", "●") : theme.fg("muted", "○"),
			" ",
			theme.fg("accent", selected ? theme.bold(ordinal) : ordinal),
			"  ",
			theme.fg("text", text),
			suffix ? theme.fg(color, suffix) : "",
		].join("");
		const line = fit(content, width);
		return selected ? theme.bg("selectedBg", line) : line;
	}

	private olderLine(count: number, selected: boolean, width: number): string {
		const theme = this.theme;
		const line = fit(`${selected ? theme.fg("accent", "›") : " "}${theme.fg("muted", `▸ Older (${count})`)}`, width);
		return selected ? theme.bg("selectedBg", line) : line;
	}

	private pendingHints(): Hint[] {
		const ask = this.selectedAsk();
		return [
			["enter", "answer"],
			["s", "sí"],
			["f", FORMAT_NAMES[this.format]],
			["space", "mark"],
			["x", "dismiss"],
			...(this.marked.size >= 2 || ask?.suggestion ? ([["l", "link"]] as Hint[]) : []),
			...(ask?.continues ? ([["u", "unlink"]] as Hint[]) : []),
			["o", "open"],
			["tab", "replies"],
			["esc", "close"],
		];
	}

	private renderPending(width: number): string[] {
		const theme = this.theme;
		const linked = this.pending.filter((ask) => ask.chain.length).length;
		const top = this.top("Pending", this.pending.length ? `${this.pending.length} open · ${linked} linked` : "", width);
		if (!this.pendingRows.length) {
			return [
				top,
				this.line(theme.fg("dim", "Nothing waits on you."), width),
				this.bottom(
					[
						["tab", "replies"],
						["esc", "close"],
					],
					"",
					width,
				),
			];
		}

		const rows = this.pendingRows;
		const height = Math.min(this.listHeight(), rows.length);
		if (this.pendingSelected < this.pendingTop) this.pendingTop = this.pendingSelected;
		if (this.pendingSelected >= this.pendingTop + height) this.pendingTop = this.pendingSelected - height + 1;
		this.pendingTop = Math.min(this.pendingTop, rows.length - height);
		// Show the prompt above the first visible ask when the window starts right under it.
		if (
			this.pendingTop > 0 &&
			rows[this.pendingTop - 1].kind === "prompt" &&
			this.pendingSelected - this.pendingTop + 1 < height
		) {
			this.pendingTop -= 1;
		}
		const cells = scrollCells(theme, rows.length, height, this.pendingTop);
		const content = width - 4;
		const visible = rows.slice(this.pendingTop, this.pendingTop + height).map((row, offset) => {
			const selected = this.pendingTop + offset === this.pendingSelected;
			const text =
				row.kind === "prompt"
					? this.threadLine(row.thread, content)
					: row.kind === "ask"
						? this.askLine(row.ask, selected, content)
						: this.olderLine(row.count, selected, content);
			return this.line(text, width, cells[offset]);
		});
		return [top, ...visible, this.bottom(this.pendingHints(), "", width)];
	}

	// ── Viewer ───────────────────────────────────────────────────────────────

	/**
	 * What fits above the reply while it keeps MIN_BODY rows: the thread's prompt, then the open asks,
	 * cut to the first ones and a "more" line, or to a title with their count, when the screen is short.
	 */
	private headerPlan(): { prompt: boolean; title: boolean; shown: number; hidden: number } {
		const asks = this.reply?.openAsks.length ?? 0;
		const room = this.available() - 3 - MIN_BODY;
		if (room < 1) return { prompt: false, title: false, shown: 0, hidden: 0 };
		const list = room - 2;
		if (!asks || list < 0) return { prompt: true, title: false, shown: 0, hidden: 0 };
		if (asks <= list) return { prompt: true, title: true, shown: asks, hidden: 0 };
		if (list >= 2) return { prompt: true, title: true, shown: list - 1, hidden: asks - list + 1 };
		return { prompt: true, title: true, shown: 0, hidden: asks };
	}

	/** Content rows above the separator, following `headerPlan`. */
	private viewerHeader(width: number): string[] {
		const theme = this.theme;
		const reply = this.reply as Reply;
		const plan = this.headerPlan();
		const lines: string[] = [];
		if (plan.prompt) {
			const prompt = this.thread ? promptLine(this.thread) : "";
			lines.push(
				theme.bg("userMessageBg", fit(`${theme.fg("accent", "▌")} ${theme.fg("userMessageText", prompt)}`, width)),
			);
		}
		if (plan.title) {
			const count = plan.shown ? "" : ` (${plan.hidden})`;
			lines.push(theme.fg("warning", theme.bold(`⚠ Waits on you${count}`)));
			for (const ask of reply.openAsks.slice(0, plan.shown)) {
				lines.push(`  ${theme.fg("mdListBullet", "•")} ${theme.fg("text", ask)}`);
			}
			if (plan.shown && plan.hidden) lines.push(theme.fg("muted", `  … ${plan.hidden} more in the reply`));
		}
		return lines;
	}

	/** Body rows of the viewer: the screen minus both borders and, when there is a header, it and its separator. */
	private viewerHeight(): number {
		const plan = this.headerPlan();
		const header = (plan.prompt ? 1 : 0) + (plan.title ? 1 + plan.shown + (plan.shown && plan.hidden ? 1 : 0) : 0);
		return Math.max(1, this.available() - 2 - (header ? header + 1 : 0));
	}

	private renderViewer(width: number): string[] {
		const reply = this.reply as Reply;
		const content = width - 4;
		const header = this.viewerHeader(content);
		const body = (this.body as Markdown).render(Math.max(1, content));
		const height = Math.min(this.viewerHeight(), Math.max(1, body.length));
		const maxScroll = Math.max(0, body.length - height);
		this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);
		const end = Math.min(body.length, this.scroll + height);
		const cells = scrollCells(this.theme, body.length, height, this.scroll);
		const detail = `${reply.entryId} · ${formatTime(reply.timestamp)} · ${triggerText(reply.triggers)}`;
		const hints: Hint[] = [
			["↑↓", "scroll"],
			["pgup/pgdn", "page"],
			["esc", this.closeFromViewer ? "close" : "back"],
		];
		const position = body.length > height ? `${this.scroll + 1}-${end}/${body.length}` : "";
		return [
			this.top(reply.ordinal, detail, width),
			...header.map((line) => this.line(line, width)),
			...(header.length ? [this.separator(width)] : []),
			...body.slice(this.scroll, end).map((line, offset) => this.line(line, width, cells[offset])),
			this.bottom(hints, position, width),
		];
	}

	render(width: number): string[] {
		if (this.reply && this.body) return this.renderViewer(width);
		return this.tab === "pending" ? this.renderPending(width) : this.renderList(width);
	}

	invalidate(): void {
		this.body?.invalidate();
	}
}
