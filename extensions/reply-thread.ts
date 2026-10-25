import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatIndex, formatReplyPlain, type IndexRow, indexRows, replyHeader, widgetLines } from "../src/format.ts";
import { findReply, noMatchMessage } from "../src/lookup.ts";
import { buildThreads, type Reply, type Thread } from "../src/threads.ts";

const WIDGET = "reply-thread";

const DESCRIPTION = "List the replies of each prompt; /replies <P#.R# | entry ID> opens one in full";

/** Rows the overlay leaves to the rest of the screen, and the lines it spends on its own chrome. */
const SCREEN_MARGIN = 4;
const CHROME = 4;

function threadsOf(ctx: ExtensionContext): Thread[] {
	return buildThreads(ctx.sessionManager.getBranch());
}

function refreshWidget(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	const lines = widgetLines(threadsOf(ctx));
	if (!lines) {
		ctx.ui.setWidget(WIDGET, undefined, { placement: "aboveEditor" });
		return;
	}
	ctx.ui.setWidget(
		WIDGET,
		(_tui: TUI, theme: Theme) => ({
			render: (width: number) =>
				lines.map((line, index) =>
					truncateToWidth(index === 0 ? theme.fg("dim", line) : theme.fg("warning", line), width),
				),
			invalidate: () => {},
		}),
		{ placement: "aboveEditor" },
	);
}

/** The thread list with a full-reply viewer: Enter opens a reply, Esc goes back, Esc on the list closes. */
class RepliesView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private readonly rows: IndexRow[];
	private selected: number;
	private listTop = 0;
	private reply: Reply | undefined;
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
		this.selected = Math.max(
			0,
			this.rows.findIndex((row) => row.reply),
		);
		this.closeFromViewer = Boolean(direct);
		if (direct) this.open(direct);
	}

	private height(): number {
		return Math.max(3, this.tui.terminal.rows - SCREEN_MARGIN - CHROME);
	}

	private open(reply: Reply): void {
		this.reply = reply;
		this.body = new Markdown(reply.text, 1, 0, getMarkdownTheme());
		this.scroll = 0;
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
		const page = this.height() - 1;
		if (this.reply) {
			if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
				if (this.closeFromViewer) return this.done();
				this.reply = undefined;
				this.body = undefined;
			} else if (kb.matches(data, "tui.select.up")) this.scroll -= 1;
			else if (kb.matches(data, "tui.select.down")) this.scroll += 1;
			else if (kb.matches(data, "tui.select.pageUp")) this.scroll -= page;
			else if (kb.matches(data, "tui.select.pageDown") || matchesKey(data, "space")) this.scroll += page;
			else if (matchesKey(data, "home")) this.scroll = 0;
			else if (matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER;
			else return;
		} else {
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

	render(width: number): string[] {
		const theme = this.theme;
		const height = this.height();
		const border = theme.fg("borderMuted", "─".repeat(width));
		const fit = (line: string) => truncateToWidth(line, width);

		if (this.reply && this.body) {
			const body = this.body.render(width);
			const maxScroll = Math.max(0, body.length - height);
			this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);
			const end = Math.min(body.length, this.scroll + height);
			const position = body.length > height ? ` · ${this.scroll + 1}-${end}/${body.length}` : "";
			const back = this.closeFromViewer ? "esc close" : "esc back";
			return [
				border,
				fit(theme.fg("accent", theme.bold(replyHeader(this.reply)))),
				...body.slice(this.scroll, end),
				fit(theme.fg("dim", `↑↓ scroll · pgup/pgdn page · ${back}${position}`)),
				border,
			];
		}

		if (!this.rows.length) {
			return [border, fit(theme.fg("dim", "No replies on this branch yet. esc close")), border];
		}
		if (this.selected < this.listTop) this.listTop = this.selected;
		if (this.selected >= this.listTop + height) this.listTop = this.selected - height + 1;
		// Show the thread row above the first visible reply when the list starts at the top of a thread.
		if (this.listTop > 0 && !this.rows[this.listTop - 1].reply && this.selected - this.listTop + 1 < height) {
			this.listTop -= 1;
		}
		const visible = this.rows.slice(this.listTop, this.listTop + height).map((row, offset) => {
			const index = this.listTop + offset;
			if (!row.reply) return fit(theme.fg("accent", row.text));
			const marker = index === this.selected ? theme.fg("accent", "› ") : "  ";
			const text = index === this.selected ? theme.bold(row.text) : row.text;
			return fit(`${marker}${text}`);
		});
		return [
			border,
			fit(theme.fg("accent", theme.bold("Replies (newest prompt first)"))),
			...visible,
			fit(theme.fg("dim", "↑↓ move · enter open · esc close")),
			border,
		];
	}

	invalidate(): void {
		this.body?.invalidate();
	}
}

export default function replyThread(pi: ExtensionAPI): void {
	pi.registerCommand("replies", {
		description: DESCRIPTION,
		handler: async (args, ctx) => {
			const threads = threadsOf(ctx);
			const arg = args.trim();
			const reply = arg ? findReply(threads, arg) : undefined;
			if (arg && !reply) {
				ctx.ui.notify(noMatchMessage(arg), "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(reply ? formatReplyPlain(reply) : formatIndex(threads), "info");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => new RepliesView(tui, theme, keybindings, threads, () => done(), reply),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } },
			);
		},
	});

	pi.on("session_start", (_event, ctx) => refreshWidget(ctx));

	// Pi stores the message only after the message_end handlers return, so read the branch on the next tick.
	let pending: ReturnType<typeof setTimeout> | undefined;
	pi.on("message_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		clearTimeout(pending);
		pending = setTimeout(() => {
			pending = undefined;
			try {
				refreshWidget(ctx);
			} catch {
				// The session was replaced or shut down before the tick; its next session_start redraws.
			}
		}, 0);
	});

	pi.on("session_shutdown", () => {
		clearTimeout(pending);
		pending = undefined;
	});
}
