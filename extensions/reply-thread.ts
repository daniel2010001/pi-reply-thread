import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatIndex, formatPending, formatReplyPlain, widgetLines } from "../src/format.ts";
import { findReply, noMatchMessage } from "../src/lookup.ts";
import { ASK_ENTRY, type AskAction, buildPending } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { type Central, OVERLAY_OPTIONS, RepliesView } from "./replies-view.ts";

const WIDGET = "reply-thread";

/** Opens the index without typing the command; the widget names it. */
const SHORTCUT = "alt+r";

const DESCRIPTION =
	"List the replies of each prompt and the asks waiting on you; /replies <P#.R#[.Q#] | entry ID[.#]> opens one in full, /replies pending lists the open asks";

function refreshWidget(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	const branch = ctx.sessionManager.getBranch();
	const threads = buildThreads(branch);
	const lines = widgetLines(threads, buildPending(branch, threads));
	if (!lines) {
		ctx.ui.setWidget(WIDGET, undefined, { placement: "aboveEditor" });
		return;
	}
	ctx.ui.setWidget(
		WIDGET,
		(_tui: TUI, theme: Theme) => ({
			render: (width: number) =>
				lines.map((line, index) =>
					truncateToWidth(line.startsWith("⚠ ") ? theme.fg("warning", line) : theme.fg("dim", line), width),
				),
			invalidate: () => {},
		}),
		{ placement: "aboveEditor" },
	);
}

/** Writes a central action to the branch, outside the model context, and returns the open asks after it. */
function act(pi: ExtensionAPI, ctx: ExtensionContext, action: AskAction) {
	pi.appendEntry(ASK_ENTRY, action);
	refreshWidget(ctx);
	return buildPending(ctx.sessionManager.getBranch());
}

/**
 * Opens the central, or the reply `arg` names, or the Pending tab for `pending`; plain text outside
 * the TUI. Answering in the central pastes the quotes into the editor.
 */
async function openReplies(pi: ExtensionAPI, ctx: ExtensionContext, arg: string): Promise<void> {
	const branch = ctx.sessionManager.getBranch();
	const threads = buildThreads(branch);
	const pendingTab = arg.toLowerCase() === "pending";
	const reply = arg && !pendingTab ? findReply(threads, arg) : undefined;
	if (arg && !pendingTab && !reply) {
		ctx.ui.notify(noMatchMessage(arg), "error");
		return;
	}
	const pending = buildPending(branch, threads);
	if (ctx.mode !== "tui") {
		const text = pendingTab ? formatPending(pending) : reply ? formatReplyPlain(reply) : formatIndex(threads);
		ctx.ui.notify(text, "info");
		return;
	}
	const central: Central = {
		pending,
		act: (action) => act(pi, ctx, action),
		tab: pendingTab ? "pending" : undefined,
	};
	const paste = await ctx.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => new RepliesView(tui, theme, keybindings, threads, done, reply, central),
		{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
	);
	if (paste) ctx.ui.pasteToEditor(paste);
}

export default function replyThread(pi: ExtensionAPI): void {
	pi.registerCommand("replies", {
		description: DESCRIPTION,
		handler: (args, ctx) => openReplies(pi, ctx, args.trim()),
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the pending asks and the reply index (/replies)",
		handler: (ctx) => openReplies(pi, ctx, ""),
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
