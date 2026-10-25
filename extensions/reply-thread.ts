import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatIndex, formatReplyPlain, widgetLines } from "../src/format.ts";
import { findReply, noMatchMessage } from "../src/lookup.ts";
import { buildThreads, type Thread } from "../src/threads.ts";
import { RepliesView } from "./replies-view.ts";

const WIDGET = "reply-thread";

const DESCRIPTION = "List the replies of each prompt; /replies <P#.R# | entry ID> opens one in full";

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
