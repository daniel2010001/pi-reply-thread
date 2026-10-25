import type { KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTime, type IndexRow, indexRows, promptLine, triggerText } from "../src/format.ts";
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

/** The thread list with a full-reply viewer: Enter opens a reply, Esc goes back, Esc on the list closes. */
export class RepliesView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
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

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		threads: readonly Thread[],
		done: () => void,
		direct?: Reply,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
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

	private open(reply: Reply): void {
		this.reply = reply;
		this.thread = this.rows.find((row) => row.reply === reply)?.thread;
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
		} else {
			const page = this.listHeight() - 1;
			if (kb.matches(data, "tui.select.cancel")) return this.done();
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
		return this.reply && this.body ? this.renderViewer(width) : this.renderList(width);
	}

	invalidate(): void {
		this.body?.invalidate();
	}
}
