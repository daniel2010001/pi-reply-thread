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
import { type AskMode, untrackedAsks } from "../src/asks.ts";
import {
	type Ask,
	type AskAction,
	type AskState,
	type ClosedAsk,
	groupLinks,
	type LiveProposal,
	looksAnsweredBy,
	type PendingAsk,
	questionIds,
	similarGroups,
} from "../src/pending.ts";
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
/** Narrowest ask text kept before a row drops its chain, its count of similar asks or its `✓?` mark. */
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

export type Tab = "pending" | "replies" | "answered";

/** How the view closed with something to do: the text to paste, or `t` asking for a triage. */
export type ViewResult = string | { triage: true };

/** The pending central: the open asks, and how to dismiss or link them on the branch. */
export interface Central {
	pending: readonly PendingAsk[];
	/** The closed asks, so the replies and the viewer mark only the open ones. */
	closed: readonly ClosedAsk[];
	/** Writes the action to the branch and returns the asks rebuilt from it. */
	act(action: AskAction): AskState;
	/** The tab to open on; Pending when any ask is open, else Replies. */
	tab?: Tab;
	/** How answers are pasted when the central opens. */
	format: AnswerFormat;
	/** Saves the format `f` switches to on the branch. */
	setFormat(format: AnswerFormat): void;
	/** Which lines of a reply are asks, from `--reply-thread-asks`. */
	mode: AskMode;
}

/**
 * One line of the Pending tab: a prompt header, an open ask (the newest of its repeat group), an older
 * member of an expanded group, the triage proposal under one of those, or the folded older prompts.
 */
type PendingRow =
	| { kind: "prompt"; thread: Thread }
	| { kind: "ask"; ask: PendingAsk }
	| { kind: "member"; ask: PendingAsk; head: PendingAsk }
	| { kind: "proposal"; ask: PendingAsk; member: boolean }
	| { kind: "older"; count: number };

/** Prompt headers and proposal lines only label the rows under or above them. */
function selectable(row: PendingRow): boolean {
	return row.kind !== "prompt" && row.kind !== "proposal";
}

/** One line of the Answered tab: a prompt header, a closed ask, or the line under it that tells how it closed. */
type AnsweredRow = { kind: "prompt"; thread: Thread } | { kind: "ask"; row: ClosedAsk } | { kind: "how"; row: ClosedAsk };

/**
 * The entry that undoes an action: a dismiss reopens, a reopen dismisses, a link unlinks the same pair and
 * back, an answer reopens, a reject restores the same proposal and back.
 */
function inverse(action: AskAction): AskAction {
	if (action.action === "link" || action.action === "unlink") {
		return { action: action.action === "link" ? "unlink" : "link", ask: action.ask, continues: action.continues };
	}
	if (action.action === "reject" || action.action === "restore") {
		return { action: action.action === "reject" ? "restore" : "reject", ask: action.ask, proposal: action.proposal };
	}
	if (action.action === "answer") return { action: "reopen", ask: action.ask };
	return { action: action.action === "dismiss" ? "reopen" : "dismiss", ask: action.ask };
}

/** The row `step` selectable rows away from `from`, stopping at either end. */
function stepSelection<T>(rows: readonly T[], from: number, step: number, selectable: (row: T) => boolean): number {
	let selected = from;
	let next = from;
	for (let left = Math.abs(step); left > 0; ) {
		const candidate = next + Math.sign(step);
		if (candidate < 0 || candidate >= rows.length) break;
		next = candidate;
		if (selectable(rows[next])) {
			selected = next;
			left -= 1;
		}
	}
	return selected;
}

/** The asks of a reply still open, and the closed ones with how they closed (`→ P13` or `dismissed`). */
interface AskStatus {
	open: string[];
	closed: { text: string; how: string }[];
}

/** What one list of the viewer header shows: its title, the first asks, and how many it leaves out. */
interface HeaderList {
	title: boolean;
	shown: number;
	hidden: number;
}

const NO_LIST: HeaderList = { title: false, shown: 0, hidden: 0 };

/** A list of `count` asks in `room` rows: all of them, the first ones and a "more" line, or its title with the count. */
function headerList(count: number, room: number): HeaderList {
	if (!count || room < 1) return NO_LIST;
	if (count + 1 <= room) return { title: true, shown: count, hidden: 0 };
	if (room >= 3) return { title: true, shown: room - 2, hidden: count - room + 2 };
	return { title: true, shown: 0, hidden: count };
}

function headerListRows(list: HeaderList): number {
	return list.title ? 1 + list.shown + (list.shown && list.hidden ? 1 : 0) : 0;
}

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
 * With a central, a Pending tab lists the open asks; Enter or `y` closes it with the text to paste,
 * in the format `f` toggles, and `t` closes it asking for a triage. An Answered tab lists the closed asks and how they closed; `r` reopens one.
 * Backspace in either tab undoes the newest action this overlay wrote.
 */
export class RepliesView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result?: ViewResult) => void;
	private readonly rows: IndexRow[];
	private readonly counts: string;
	private readonly ordinalWidth: number;
	private readonly triggerWidth: number;
	private selected: number;
	private listTop = 0;
	private reply: Reply | undefined;
	private thread: Thread | undefined;
	private body: Markdown | undefined;
	/** Questions of the open reply that `section` mode leaves outside the decision section. */
	private untracked = 0;
	private scroll = 0;
	/** Opened straight on a reply by `/replies <id>`: Esc in the viewer closes instead of going back. */
	private readonly closeFromViewer: boolean;
	private readonly central: Central | undefined;
	private tab: Tab;
	private pending: readonly PendingAsk[] = [];
	private closed: readonly ClosedAsk[] = [];
	/** The closed row of each closed ask, chain members included. */
	private readonly closings = new Map<string, ClosedAsk>();
	private answeredRows: AnsweredRow[] = [];
	private answeredSelected = 0;
	private answeredTop = 0;
	private closedOrdinalWidth = 0;
	private pendingRows: PendingRow[] = [];
	private pendingSelected = 0;
	private pendingTop = 0;
	private askOrdinalWidth = 0;
	/** The repeat group of each open row, oldest first, by the row's unique ID. */
	private readonly groups = new Map<string, PendingAsk[]>();
	/** Unique IDs of the group rows `→` expanded. */
	private readonly unfolded = new Set<string>();
	/** Every open row in list order, a group's older members right after it, folded ones too. */
	private listOrder: PendingAsk[] = [];
	private readonly marked = new Set<string>();
	/** The actions this overlay wrote and Backspace has not undone yet, one step per key, newest last. */
	private readonly undoSteps: AskAction[][] = [];
	private expanded = false;
	private format: AnswerFormat = "lines";
	/** The key help card, shown over the tab `?` opened it from. */
	private help = false;
	private helpTop = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		threads: readonly Thread[],
		done: (result?: ViewResult) => void,
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
			this.setAsks(central);
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
		this.untracked = this.central?.mode === "section" ? untrackedAsks(reply.text) : 0;
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
		} else if (this.help) {
			if (!this.helpInput(data)) return;
		} else if (this.central && matchesKey(data, "?")) {
			this.help = true;
			this.helpTop = 0;
		} else if (this.tab === "pending") {
			if (!this.pendingInput(data)) return;
		} else if (this.tab === "answered") {
			if (!this.answeredInput(data)) return;
		} else {
			const page = this.listHeight() - 1;
			if (kb.matches(data, "tui.select.cancel")) return this.done();
			if (this.central && matchesKey(data, "tab")) this.tab = "answered";
			else if (kb.matches(data, "tui.select.confirm")) {
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

	/** Takes the open and closed asks rebuilt from the branch. */
	private setAsks(state: { pending: readonly PendingAsk[]; closed: readonly ClosedAsk[] }): void {
		this.closed = state.closed;
		this.closings.clear();
		for (const row of state.closed) for (const ask of [...row.chain, row.ask]) this.closings.set(ask.id, row);
		this.closedOrdinalWidth = Math.max(0, ...state.closed.map((row) => row.ask.ordinal.length));
		const groups = new Map<number, { thread: Thread; rows: ClosedAsk[] }>();
		for (const row of state.closed) {
			const group = groups.get(row.ask.thread.prompt) ?? { thread: row.ask.thread, rows: [] };
			group.rows.push(row);
			groups.set(row.ask.thread.prompt, group);
		}
		this.answeredRows = [...groups.values()]
			.sort((a, b) => b.thread.prompt - a.thread.prompt)
			.flatMap(({ thread, rows }) => [
				{ kind: "prompt" as const, thread },
				...rows.flatMap((row) => [
					{ kind: "ask" as const, row },
					{ kind: "how" as const, row },
				]),
			]);
		const at = Math.min(this.answeredSelected, Math.max(0, this.answeredRows.length - 1));
		const next = this.answeredRows.findIndex((row, index) => index >= at && row.kind === "ask");
		this.answeredSelected = Math.max(0, next >= 0 ? next : this.answeredRows.findLastIndex((row) => row.kind === "ask"));
		this.setPending(state.pending);
	}

	/** The asks of a reply still open and the closed ones; all open without a central. */
	private askStatus(reply: Reply): AskStatus {
		const status: AskStatus = { open: [], closed: [] };
		for (const ask of questionIds(reply)) {
			const row = this.closings.get(ask.id);
			if (!row) status.open.push(ask.text);
			else {
				const how = row.closedBy.kind === "answer" ? `→ P${row.closedBy.prompt.prompt}` : "dismissed";
				status.closed.push({ text: ask.text, how });
			}
		}
		return status;
	}

	/**
	 * Takes the open asks and rebuilds the rows: one row per repeat group, on its newest ask, under that
	 * ask's prompt; prompts newest first, the older ones folded; an expanded group's older members under it.
	 */
	private setPending(pending: readonly PendingAsk[]): void {
		this.pending = pending;
		const ids = new Set(pending.map((ask) => ask.id));
		for (const id of this.marked) if (!ids.has(id)) this.marked.delete(id);
		this.askOrdinalWidth = Math.max(0, ...pending.map((ask) => ask.ordinal.length));
		this.groups.clear();
		const heads: PendingAsk[] = [];
		for (const group of similarGroups(pending)) {
			for (const ask of group) this.groups.set(ask.id, group);
			heads.push(group.at(-1) as PendingAsk);
		}
		for (const id of this.unfolded) if (this.groups.get(id)?.at(-1)?.id !== id) this.unfolded.delete(id);
		/** The older members of a group row, newest first, like the prompts. */
		const members = (head: PendingAsk) => (this.groups.get(head.id) ?? []).slice(0, -1).reverse();

		const groups = new Map<number, { thread: Thread; asks: PendingAsk[] }>();
		for (const ask of heads) {
			const group = groups.get(ask.thread.prompt) ?? { thread: ask.thread, asks: [] };
			group.asks.push(ask);
			groups.set(ask.thread.prompt, group);
		}
		const ordered = [...groups.values()].sort((a, b) => b.thread.prompt - a.thread.prompt);
		this.listOrder = ordered.flatMap(({ asks }) => asks.flatMap((head) => [head, ...members(head)]));
		const shown = this.expanded ? ordered : ordered.slice(0, UNFOLDED_PROMPTS);
		const proposal = (ask: PendingAsk, member: boolean): PendingRow[] =>
			ask.proposals?.length ? [{ kind: "proposal", ask, member }] : [];
		const rows: PendingRow[] = shown.flatMap(({ thread, asks }) => [
			{ kind: "prompt" as const, thread },
			...asks.flatMap((head) => [
				{ kind: "ask" as const, ask: head },
				...proposal(head, false),
				...(this.unfolded.has(head.id)
					? members(head).flatMap((ask) => [{ kind: "member" as const, ask, head }, ...proposal(ask, true)])
					: []),
			]),
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
		let next = rows.findIndex((row, offset) => offset >= at && selectable(row));
		if (next < 0) next = rows.findLastIndex(selectable);
		this.pendingSelected = Math.max(0, next);
	}

	private movePending(step: number): void {
		let next = this.pendingSelected;
		for (let left = Math.abs(step); left > 0; ) {
			const candidate = next + Math.sign(step);
			if (candidate < 0 || candidate >= this.pendingRows.length) break;
			next = candidate;
			if (selectable(this.pendingRows[next])) {
				this.pendingSelected = next;
				left -= 1;
			}
		}
	}

	private selectedAsk(): PendingAsk | undefined {
		const row = this.pendingRows[this.pendingSelected];
		return row?.kind === "ask" || row?.kind === "member" ? row.ask : undefined;
	}

	/** The marked asks in list order, collapsed members too, or the selected one when none is marked. */
	private targets(): PendingAsk[] {
		const marked = this.listOrder.filter((ask) => this.marked.has(ask.id));
		if (marked.length) return marked;
		const ask = this.selectedAsk();
		return ask ? [ask] : [];
	}

	/** The marked asks and the older members of their chains, newest first. */
	private markedChain(): Ask[] {
		const rows = this.pending.filter((ask) => this.marked.has(ask.id));
		return rows.flatMap((row) => [...row.chain, row]).sort((a, b) => b.seq - a.seq);
	}

	/**
	 * The actions that accept a triage proposal: `answered` closes its ask with the quote, `same` links
	 * the selected row and the row holding the other ask as one chain. Empty when that row is gone.
	 */
	private accept(row: PendingAsk, proposal: LiveProposal): AskAction[] {
		if (proposal.kind === "answered") {
			return [{ action: "answer", ask: proposal.ask.id, prompt: proposal.prompt.entryId as string, text: proposal.quote }];
		}
		const other = this.pending.find(
			(next) => next.id === proposal.as.id || next.chain.some((member) => member.id === proposal.as.id),
		);
		return other ? groupLinks([row, other]) : [];
	}

	/** Writes the actions of one key, which Backspace can undo as one step. */
	private act(actions: AskAction[]): void {
		if (!actions.length) return;
		this.write(actions);
		this.undoSteps.push(actions);
	}

	private write(actions: AskAction[]): void {
		const central = this.central as Central;
		let state: AskState | undefined;
		for (const action of actions) state = central.act(action);
		if (state) this.setAsks(state);
	}

	/** Writes the inverse of every entry of the newest step, newest first; nothing when no step is left. */
	private undo(): void {
		const step = this.undoSteps.pop();
		if (step) this.write(step.map(inverse).reverse());
	}

	/** Keys of the Pending tab; false when the key means nothing there. */
	private pendingInput(data: string): boolean {
		const kb = this.keybindings;
		const page = this.listHeight() - 1;
		const row = this.pendingRows[this.pendingSelected];
		const ask = this.selectedAsk();
		const proposal = ask?.proposals?.[0];
		if (kb.matches(data, "tui.select.cancel")) {
			this.done();
			return false;
		}
		if (matchesKey(data, "t")) {
			this.done({ triage: true });
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
		} else if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "y")) {
			const targets = this.targets();
			if (!targets.length) return false;
			this.done(answerText(targets, matchesKey(data, "y"), this.format));
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
		} else if (matchesKey(data, "l") && ask && (this.groups.get(ask.id)?.length ?? 0) > 1) {
			// The whole repeat group, from the group row or one of its members, hangs from its oldest ask.
			this.act(groupLinks(this.groups.get(ask.id) as PendingAsk[]));
		} else if (matchesKey(data, "right") && row?.kind === "ask" && (this.groups.get(row.ask.id)?.length ?? 0) > 1) {
			this.unfolded.add(row.ask.id);
			this.setPending(this.pending);
		} else if (matchesKey(data, "left") && (row?.kind === "ask" || row?.kind === "member")) {
			const head = row.kind === "member" ? row.head : row.ask;
			if (!this.unfolded.delete(head.id)) return false;
			this.setPending(this.pending);
			this.selectPending(this.pendingRows.findIndex((next) => next.kind === "ask" && next.ask.id === head.id));
		} else if (matchesKey(data, "u") && ask?.continues) {
			this.act([{ action: "unlink", ask: ask.id, continues: ask.continues }]);
		} else if (matchesKey(data, "o") && ask) this.open(ask.reply, ask.thread);
		else if (matchesKey(data, "a") && ask && proposal) {
			const actions = this.accept(ask, proposal);
			if (!actions.length) return false;
			this.act(actions);
		} else if (matchesKey(data, "n") && proposal) {
			this.act([{ action: "reject", ask: proposal.ask.id, proposal: proposal.key }]);
		} else if (matchesKey(data, "backspace")) this.undo();
		else return false;
		return true;
	}

	// ── Answered ─────────────────────────────────────────────────────────────

	/** Keys of the Answered tab; false when the key means nothing there. */
	private answeredInput(data: string): boolean {
		const kb = this.keybindings;
		const page = this.listHeight() - 1;
		const row = this.answeredRows[this.answeredSelected];
		const move = (step: number) => {
			this.answeredSelected = stepSelection(this.answeredRows, this.answeredSelected, step, (next) => next.kind === "ask");
		};
		if (kb.matches(data, "tui.select.cancel")) {
			this.done();
			return false;
		}
		if (matchesKey(data, "tab")) this.tab = "pending";
		else if (kb.matches(data, "tui.select.up")) move(-1);
		else if (kb.matches(data, "tui.select.down")) move(1);
		else if (kb.matches(data, "tui.select.pageUp")) move(-page);
		else if (kb.matches(data, "tui.select.pageDown")) move(page);
		else if ((kb.matches(data, "tui.select.confirm") || matchesKey(data, "o")) && row?.kind === "ask") {
			this.open(row.row.ask.reply, row.row.ask.thread);
		} else if (matchesKey(data, "r") && row?.kind === "ask") {
			// A chain closed together, so every member reopens.
			this.act([...row.row.chain, row.row.ask].map((ask) => ({ action: "reopen", ask: ask.id })));
		} else if (matchesKey(data, "backspace")) this.undo();
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
		const status = this.askStatus(reply);
		const ask = status.open[0];
		const content = [
			selected ? theme.fg("accent", "›") : " ",
			theme.fg("borderMuted", last ? "└" : "├"),
			" ",
			theme.fg("accent", selected ? theme.bold(ordinal) : ordinal),
			"  ",
			theme.fg("dim", reply.entryId),
			"  ",
			trigger,
			ask
				? `  ${theme.fg("warning", "⚠")} ${theme.fg("muted", ask)}`
				: status.closed.length
					? `  ${theme.fg("success", "✓")}`
					: "",
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

	/**
	 * `  ↺ <older members>  ≈ N similar · ✓? like <closed ask>`, as much of it as leaves the ask `MIN_ASK`
	 * columns of `room`: the chain goes first, then the count of similar asks, then the mark.
	 */
	private askSuffix(ask: PendingAsk, room: number, similar: number, like?: Ask): string {
		const chain = ask.chain.length ? `  ↺ ${ask.chain.map((member) => member.ordinal).join(", ")}` : "";
		const count = similar ? `  ≈ ${similar} similar` : "";
		const mark = like ? `✓? like ${like.ordinal}` : "";
		const join = (head: string) => (head && mark ? `${head} · ${mark}` : head || (mark && `  ${mark}`));
		for (const suffix of [join(chain + count), join(count), join(""), ""]) {
			if (room - visibleWidth(suffix) >= MIN_ASK) return suffix;
		}
		return "";
	}

	/** `›○ P13.R1.Q1  <ask>  ↺ <older members>  ≈ N similar · ✓? like <closed ask>`; the ask is cut first. */
	private askLine(ask: PendingAsk, selected: boolean, width: number): string {
		const theme = this.theme;
		const ordinal = ask.ordinal.padEnd(this.askOrdinalWidth);
		const room = width - 3 - ordinal.length - 2;
		const group = this.groups.get(ask.id) ?? [ask];
		// A group row looks answered when any of its asks does, hidden ones too.
		const suffix = this.askSuffix(ask, room, group.length - 1, looksAnsweredBy(group));
		const text = truncateToWidth(ask.text, Math.max(0, room - visibleWidth(suffix)), "…");
		const content = [
			selected ? theme.fg("accent", "›") : " ",
			this.marked.has(ask.id) ? theme.fg("accent", "●") : theme.fg("muted", "○"),
			" ",
			theme.fg("accent", selected ? theme.bold(ordinal) : ordinal),
			"  ",
			theme.fg("text", text),
			suffix ? theme.fg("muted", suffix) : "",
		].join("");
		const line = fit(content, width);
		return selected ? theme.bg("selectedBg", line) : line;
	}

	/**
	 * `›  ≈ P12.R1.Q1  <ask>  ↺ <older members> · ✓? like <closed ask>`, muted, under its group row, with its
	 * own mark; `●` replaces `≈` when marked.
	 */
	private memberLine(ask: PendingAsk, selected: boolean, width: number): string {
		const theme = this.theme;
		const ordinal = ask.ordinal.padEnd(this.askOrdinalWidth);
		const room = width - 5 - ordinal.length - 2;
		const suffix = this.askSuffix(ask, room, 0, ask.looksAnswered);
		const text = truncateToWidth(ask.text, Math.max(0, room - visibleWidth(suffix)), "…");
		const content = [
			selected ? theme.fg("accent", "›") : " ",
			"  ",
			this.marked.has(ask.id) ? theme.fg("accent", "●") : theme.fg("muted", "≈"),
			" ",
			theme.fg("muted", selected ? theme.bold(ordinal) : ordinal),
			"  ",
			theme.fg("muted", text + suffix),
		].join("");
		const line = fit(content, width);
		return selected ? theme.bg("selectedBg", line) : line;
	}

	/**
	 * `✦ answered in P2: "<quote>"` or `✦ same as P1.R1.Q2  <ask>`, the row's first proposal, under the ask
	 * text of its row, muted, with `  +N more` when it has more; the proposal is cut first.
	 */
	private proposalLine(ask: PendingAsk, member: boolean, width: number): string {
		const theme = this.theme;
		const [first, ...rest] = ask.proposals as LiveProposal[];
		const indent = (member ? 5 : 3) + this.askOrdinalWidth + 2;
		const more = rest.length ? `  +${rest.length} more` : "";
		const text =
			first.kind === "answered"
				? ` answered in P${first.prompt.prompt}: "${first.quote}"`
				: ` same as ${first.as.ordinal}  ${first.as.text}`;
		const room = width - indent - 1 - visibleWidth(more);
		const cut = truncateToWidth(text, Math.max(0, room), "…");
		return fit(`${" ".repeat(indent)}${theme.fg("accent", "✦")}${theme.fg("muted", cut + more)}`, width);
	}

	private olderLine(count: number, selected: boolean, width: number): string {
		const theme = this.theme;
		const line = fit(`${selected ? theme.fg("accent", "›") : " "}${theme.fg("muted", `▸ Older (${count})`)}`, width);
		return selected ? theme.bg("selectedBg", line) : line;
	}

	/** The short hints; `?` lists the rest. */
	private pendingHints(): Hint[] {
		return [
			["enter", "answer"],
			["y", "yes"],
			["f", "format"],
			["t", "triage"],
			["?", "help"],
			["esc", "close"],
		];
	}

	private renderPending(width: number): string[] {
		const theme = this.theme;
		// A repeat group counts once, as the row it shows on.
		const heads = this.pending.filter((ask) => this.groups.get(ask.id)?.at(-1) === ask);
		const linked = heads.filter((ask) => ask.chain.length).length;
		const top = this.top("Pending", heads.length ? `${heads.length} open · ${linked} linked` : "", width);
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
		const at = this.pendingSelected;
		// Keep the proposal under the selected ask in view with it, when there is room.
		const last = height >= 2 && rows[at + 1]?.kind === "proposal" ? at + 1 : at;
		if (at < this.pendingTop) this.pendingTop = at;
		if (last >= this.pendingTop + height) this.pendingTop = last - height + 1;
		this.pendingTop = Math.min(this.pendingTop, rows.length - height);
		// Show the prompt above the first visible ask when the window starts right under it.
		if (this.pendingTop > 0 && rows[this.pendingTop - 1].kind === "prompt" && last - this.pendingTop + 1 < height) {
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
						: row.kind === "member"
							? this.memberLine(row.ask, selected, content)
							: row.kind === "proposal"
								? this.proposalLine(row.ask, row.member, content)
								: this.olderLine(row.count, selected, content);
			return this.line(text, width, cells[offset]);
		});
		return [top, ...visible, this.bottom(this.pendingHints(), "", width)];
	}

	// ── Answered view ────────────────────────────────────────────────────────

	/** `›✓ P12.R2.Q1  <ask>  ↺ <older members>`; the ask is cut first. */
	private closedAskLine(row: ClosedAsk, selected: boolean, width: number): string {
		const theme = this.theme;
		const ordinal = row.ask.ordinal.padEnd(this.closedOrdinalWidth);
		const room = width - 3 - ordinal.length - 2;
		let suffix = row.chain.length ? `  ↺ ${row.chain.map((member) => member.ordinal).join(", ")}` : "";
		if (room - visibleWidth(suffix) < MIN_ASK) suffix = "";
		const text = truncateToWidth(row.ask.text, Math.max(0, room - visibleWidth(suffix)), "…");
		const content = [
			selected ? theme.fg("accent", "›") : " ",
			theme.fg("success", "✓"),
			" ",
			theme.fg("accent", selected ? theme.bold(ordinal) : ordinal),
			"  ",
			theme.fg("text", text),
			suffix ? theme.fg("muted", suffix) : "",
		].join("");
		const line = fit(content, width);
		return selected ? theme.bg("selectedBg", line) : line;
	}

	/** `   ↳ P13  <answer text>`, or `   ✕ dismissed`, under the ordinal of the closed ask. */
	private howLine(row: ClosedAsk, width: number): string {
		const theme = this.theme;
		const how = row.closedBy;
		if (how.kind === "dismiss") return fit(`   ${theme.fg("dim", "✕ dismissed")}`, width);
		const answer = how.text ? `  ${how.text}` : "";
		return fit(`   ${theme.fg("muted", `↳ P${how.prompt.prompt}${answer}`)}`, width);
	}

	private renderAnswered(width: number): string[] {
		const theme = this.theme;
		const answered = this.closed.filter((row) => row.closedBy.kind === "answer").length;
		const detail = this.closed.length ? `${answered} answered · ${this.closed.length - answered} dismissed` : "";
		const top = this.top("Answered", detail, width);
		const rows = this.answeredRows;
		if (!rows.length) {
			return [top, this.line(theme.fg("dim", "Nothing answered yet."), width), this.bottom([["esc", "close"]], "", width)];
		}

		const height = Math.min(this.listHeight(), rows.length);
		const selected = this.answeredSelected;
		// Keep the line that tells how the selected ask closed in view with it, when there is room.
		const last = height >= 2 ? Math.min(selected + 1, rows.length - 1) : selected;
		if (selected < this.answeredTop) this.answeredTop = selected;
		if (last >= this.answeredTop + height) this.answeredTop = last - height + 1;
		this.answeredTop = Math.max(0, Math.min(this.answeredTop, rows.length - height));
		// Show the prompt above the first visible ask when the window starts right under it.
		if (this.answeredTop > 0 && rows[this.answeredTop - 1].kind === "prompt" && last - this.answeredTop + 1 < height) {
			this.answeredTop -= 1;
		}
		const cells = scrollCells(theme, rows.length, height, this.answeredTop);
		const content = width - 4;
		const visible = rows.slice(this.answeredTop, this.answeredTop + height).map((row, offset) => {
			const text =
				row.kind === "prompt"
					? this.threadLine(row.thread, content)
					: row.kind === "ask"
						? this.closedAskLine(row.row, this.answeredTop + offset === selected, content)
						: this.howLine(row.row, content);
			return this.line(text, width, cells[offset]);
		});
		const hints: Hint[] = [
			["↑↓", "move"],
			["enter", "open"],
			["esc", "close"],
		];
		return [top, ...visible, this.bottom(hints, "", width)];
	}

	// ── Key help ─────────────────────────────────────────────────────────────

	/**
	 * Every key of the central, under the place it works in; a string is a section title, a note a muted
	 * line, indented under the keys it explains. Ends with the ask mode.
	 */
	private helpEntries(): (string | [key: string, action: string] | { note: string; indent?: boolean })[] {
		const mode = this.central?.mode === "all" ? "every question" : "decision section only";
		return [
			"Pending",
			["enter", "answer the marked or selected asks; expand Older (N)"],
			["y", "answer Yes."],
			["f", `switch the answer format; now ${FORMAT_NAMES[this.format]}`],
			["space", "mark or unmark an ask"],
			["x", "dismiss the marked or selected asks"],
			["→, ←", "expand or collapse the similar asks (≈) of a row"],
			["l", "link the marked asks, or a row's similar asks to the oldest one"],
			{ note: "A group row answers only its newest ask; press l first to close the whole group together.", indent: true },
			{ note: "✓? like <ID>: looks answered by that closed ask; it stays open until you answer it or press x.", indent: true },
			["u", "unlink the ask from its chain"],
			["o", "open the reply that asks it"],
			["t", "triage: ask the session model for ✦ proposals"],
			["a", "accept the row's ✦ triage proposal"],
			["n", "reject the row's ✦ triage proposal"],
			{ note: "✦ comes from /replies triage: a model's proposal; nothing closes or links until you press a.", indent: true },
			["⌫", "undo the last action"],
			"Replies",
			["enter", "open the reply"],
			"Answered",
			["enter, o", "open the reply"],
			["r", "reopen the selected ask"],
			["⌫", "undo the last action"],
			"Every tab",
			["↑↓, pgup/pgdn", "move"],
			["tab", "next tab: Pending → Replies → Answered"],
			["?", "show or hide this help"],
			["esc", "close"],
			"Reply viewer",
			["↑↓", "scroll"],
			["pgup/pgdn, space", "page"],
			["home/end", "jump to the top or the end"],
			["esc, q", "back"],
			{ note: `Asks: ${mode}` },
		];
	}

	/** Keys of the help card; false when the key means nothing there. */
	private helpInput(data: string): boolean {
		const kb = this.keybindings;
		const page = Math.max(1, this.listHeight() - 1);
		if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "?")) this.help = false;
		else if (kb.matches(data, "tui.select.up")) this.helpTop = Math.max(0, this.helpTop - 1);
		else if (kb.matches(data, "tui.select.down")) this.helpTop += 1;
		else if (kb.matches(data, "tui.select.pageUp")) this.helpTop = Math.max(0, this.helpTop - page);
		else if (kb.matches(data, "tui.select.pageDown")) this.helpTop += page;
		else return false;
		return true;
	}

	private renderHelp(width: number): string[] {
		const theme = this.theme;
		const entries = this.helpEntries();
		const keyWidth = Math.max(...entries.map((entry) => (Array.isArray(entry) ? visibleWidth(entry[0]) : 0)));
		const rows = entries.map((entry) =>
			typeof entry === "string"
				? theme.fg("accent", theme.bold(entry))
				: Array.isArray(entry)
					? `  ${theme.fg("accent", entry[0])}${" ".repeat(keyWidth - visibleWidth(entry[0]))}  ${theme.fg("text", entry[1])}`
					: `${entry.indent ? "  " : ""}${theme.fg("muted", entry.note)}`,
		);
		const height = Math.min(this.listHeight(), rows.length);
		this.helpTop = Math.min(this.helpTop, rows.length - height);
		const cells = scrollCells(theme, rows.length, height, this.helpTop);
		const visible = rows
			.slice(this.helpTop, this.helpTop + height)
			.map((row, offset) => this.line(row, width, cells[offset]));
		const hints: Hint[] = [
			["↑↓", "scroll"],
			["?/esc", "back"],
		];
		return [this.top("Keys", "", width), ...visible, this.bottom(hints, "", width)];
	}

	// ── Viewer ───────────────────────────────────────────────────────────────

	/**
	 * What fits above the reply while it keeps MIN_BODY rows: the thread's prompt, then the open asks,
	 * then the note on untracked questions, then the closed asks, each list cut to the first ones and
	 * a "more" line, or to a title with their count, when the screen is short.
	 */
	private headerPlan(status: AskStatus): { prompt: boolean; open: HeaderList; note: boolean; closed: HeaderList } {
		const room = this.available() - 3 - MIN_BODY;
		if (room < 1) return { prompt: false, open: NO_LIST, note: false, closed: NO_LIST };
		const open = headerList(status.open.length, room - 1);
		const note = this.untracked > 0 && room - 1 - headerListRows(open) >= 1;
		const closed = headerList(status.closed.length, room - 1 - headerListRows(open) - (note ? 1 : 0));
		return { prompt: true, open, note, closed };
	}

	/** `  • <ask>  → P13` or `  • <ask>  dismissed`; the ask is cut first. */
	private closedLine(ask: { text: string; how: string }, width: number): string {
		const theme = this.theme;
		const how = `  ${ask.how}`;
		const text = truncateToWidth(ask.text, Math.max(0, width - 4 - visibleWidth(how)), "…");
		return theme.fg("muted", `  • ${text}${how}`);
	}

	/** Content rows above the separator, following `headerPlan`. */
	private viewerHeader(width: number): string[] {
		const theme = this.theme;
		const status = this.askStatus(this.reply as Reply);
		const plan = this.headerPlan(status);
		const lines: string[] = [];
		if (plan.prompt) {
			const prompt = this.thread ? promptLine(this.thread) : "";
			lines.push(
				theme.bg("userMessageBg", fit(`${theme.fg("accent", "▌")} ${theme.fg("userMessageText", prompt)}`, width)),
			);
		}
		const { open, closed } = plan;
		if (open.title) {
			const count = open.shown ? "" : ` (${open.hidden})`;
			lines.push(theme.fg("warning", theme.bold(`⚠ Waits on you${count}`)));
			for (const ask of status.open.slice(0, open.shown)) {
				lines.push(`  ${theme.fg("mdListBullet", "•")} ${theme.fg("text", ask)}`);
			}
			if (open.shown && open.hidden) lines.push(theme.fg("muted", `  … ${open.hidden} more in the reply`));
		}
		if (plan.note) {
			const count = this.untracked === 1 ? "1 more question" : `${this.untracked} more questions`;
			const verb = this.untracked === 1 ? "is" : "are";
			lines.push(
				theme.fg("muted", `${count} outside the decision section ${verb} not tracked (--reply-thread-asks all tracks them).`),
			);
		}
		if (closed.title) {
			const count = closed.shown ? "" : ` (${closed.hidden})`;
			lines.push(theme.fg("muted", theme.bold(`✓ Answered${count}`)));
			for (const ask of status.closed.slice(0, closed.shown)) lines.push(this.closedLine(ask, width));
			if (closed.shown && closed.hidden) lines.push(theme.fg("muted", `  … ${closed.hidden} more in the reply`));
		}
		return lines;
	}

	/** Body rows of the viewer: the screen minus both borders and, when there is a header, it and its separator. */
	private viewerHeight(): number {
		const plan = this.headerPlan(this.askStatus(this.reply as Reply));
		const header = (plan.prompt ? 1 : 0) + headerListRows(plan.open) + (plan.note ? 1 : 0) + headerListRows(plan.closed);
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
		if (this.help) return this.renderHelp(width);
		if (this.tab === "pending") return this.renderPending(width);
		return this.tab === "answered" ? this.renderAnswered(width) : this.renderList(width);
	}

	invalidate(): void {
		this.body?.invalidate();
	}
}
