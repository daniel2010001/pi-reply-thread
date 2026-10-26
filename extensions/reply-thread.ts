import { BorderedLoader, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { AskMode } from "../src/asks.ts";
import { answerFormat, FORMAT_ENTRY, formatIndex, formatPending, formatReplyPlain, widgetLines } from "../src/format.ts";
import { findReply, noMatchMessage } from "../src/lookup.ts";
import { ASK_ENTRY, type AskAction, buildAsks, buildPending, similarGroups, TRIAGE_ENTRY } from "../src/pending.ts";
import { buildThreads } from "../src/threads.ts";
import { parseTriage, triageRequest } from "../src/triage.ts";
import { type Central, OVERLAY_OPTIONS, RepliesView } from "./replies-view.ts";

const WIDGET = "reply-thread";

/** Opens the index without typing the command; the widget names it. */
const SHORTCUT = "alt+r";

const DESCRIPTION =
	"List the replies of each prompt and the asks waiting on you; /replies <P#.R#[.Q#] | entry ID[.#]> opens one in full, /replies pending lists the open asks, /replies triage asks the session model to propose answered and repeated asks";

/** Which lines of a reply are asks; Gentle Shell passes it after `--`. */
const FLAG = "reply-thread-asks";

const FLAG_DESCRIPTION =
	'Which lines of a reply are asks: "section" (default) tracks only the decision section when a reply has one, "all" tracks every question';

/** The ask mode the flag asks for; any other value is `section`. */
function askMode(pi: ExtensionAPI): AskMode {
	return pi.getFlag(FLAG) === "all" ? "all" : "section";
}

/** The warning for a flag value that is not a mode; undefined for a mode or no value. */
function unknownMode(pi: ExtensionAPI): string | undefined {
	const value = pi.getFlag(FLAG);
	if (value === undefined || value === "section" || value === "all") return undefined;
	return `Unknown --${FLAG} "${value}"; using "section". Use "section" or "all".`;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function refreshWidget(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	const branch = ctx.sessionManager.getBranch();
	const threads = buildThreads(branch, askMode(pi));
	const pending = buildPending(branch, threads);
	const lines = widgetLines(threads, pending, similarGroups(pending).length);
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

/** Writes a central action to the branch, outside the model context, and returns the asks after it. */
function act(pi: ExtensionAPI, ctx: ExtensionContext, action: AskAction) {
	pi.appendEntry(ASK_ENTRY, action);
	refreshWidget(pi, ctx);
	const branch = ctx.sessionManager.getBranch();
	return buildAsks(branch, buildThreads(branch, askMode(pi)));
}

/**
 * Opens the central, or the reply `arg` names, or the Pending tab for `pending`; plain text outside
 * the TUI. Answering in the central pastes the quotes into the editor.
 */
async function openReplies(pi: ExtensionAPI, ctx: ExtensionContext, arg: string): Promise<void> {
	const branch = ctx.sessionManager.getBranch();
	const mode = askMode(pi);
	const threads = buildThreads(branch, mode);
	const pendingTab = arg.toLowerCase() === "pending";
	const reply = arg && !pendingTab ? findReply(threads, arg) : undefined;
	if (arg && !pendingTab && !reply) {
		ctx.ui.notify(noMatchMessage(arg), "error");
		return;
	}
	const { pending, closed } = buildAsks(branch, threads);
	if (ctx.mode !== "tui") {
		const text = pendingTab ? formatPending(pending) : reply ? formatReplyPlain(reply) : formatIndex(threads, pending);
		ctx.ui.notify(text, "info");
		return;
	}
	const central: Central = {
		pending,
		closed,
		act: (action) => act(pi, ctx, action),
		tab: pendingTab ? "pending" : undefined,
		format: answerFormat(branch),
		setFormat: (format) => pi.appendEntry(FORMAT_ENTRY, { format }),
		mode,
	};
	const paste = await ctx.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => new RepliesView(tui, theme, keybindings, threads, done, reply, central),
		{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
	);
	if (paste) ctx.ui.pasteToEditor(paste);
}

/** How the model call ended: its reply text, its error, or undefined when cancelled. */
type TriageOutcome = { text: string } | { error: string } | undefined;

/**
 * Asks the session model, after a confirm, which open asks a later prompt answered or another ask
 * repeats; stores its proposals on the branch and opens Pending. Nothing closes or links here.
 */
async function triage(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/replies triage needs the interactive TUI.", "error");
		return;
	}
	const branch = ctx.sessionManager.getBranch();
	const threads = buildThreads(branch, askMode(pi));
	const state = buildAsks(branch, threads);
	const request = triageRequest(state, threads);
	if (!request) {
		ctx.ui.notify("No open asks to triage.", "info");
		return;
	}
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("No model selected; choose one with /model.", "error");
		return;
	}
	const name = `${model.provider}/${model.id}`;
	const sent = `${plural(request.asks, "open ask", "open asks")} and ${plural(request.prompts, "later prompt", "later prompts")}`;
	const ok = await ctx.ui.confirm(
		"Triage open asks?",
		`Send ${sent} (about ${Math.ceil(request.chars / 4)} tokens) to ${name}. The model only proposes; nothing closes until you accept.`,
	);
	if (!ok) return;

	const outcome = await ctx.ui.custom<TriageOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Triage with ${name}… (esc cancels)`, { cancellable: true });
		let finished = false;
		const finish = (result: TriageOutcome) => {
			if (finished) return;
			finished = true;
			done(result);
		};
		loader.onAbort = () => finish(undefined);
		const context = {
			systemPrompt: request.systemPrompt,
			messages: [{ role: "user" as const, content: [{ type: "text" as const, text: request.text }], timestamp: Date.now() }],
		};
		const call = async (): Promise<TriageOutcome> => {
			const message = await ctx.modelRegistry.streamSimple(model, context, { signal: loader.signal }).result();
			if (message.stopReason === "aborted") return undefined;
			if (message.stopReason === "error") return { error: message.errorMessage ?? "unknown error" };
			return { text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") };
		};
		call()
			.then(finish)
			.catch((error: unknown) => {
				if (loader.signal.aborted) return finish(undefined);
				finish({ error: error instanceof Error ? error.message : String(error) });
			});
		return loader;
	});

	if (!outcome) {
		ctx.ui.notify("Triage cancelled.", "info");
		return;
	}
	if ("error" in outcome) {
		ctx.ui.notify(`Triage failed: ${outcome.error}`, "error");
		return;
	}
	const proposals = parseTriage(outcome.text, state, threads);
	if (!proposals.length) {
		ctx.ui.notify("Triage found nothing to propose.", "info");
		return;
	}
	pi.appendEntry(TRIAGE_ENTRY, { model: name, proposals });
	refreshWidget(pi, ctx);
	ctx.ui.notify(`Triage: ${plural(proposals.length, "proposal", "proposals")}; a accepts and n rejects in Pending.`, "info");
	await openReplies(pi, ctx, "pending");
}

export default function replyThread(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG, { type: "string", default: "section", description: FLAG_DESCRIPTION });

	pi.registerCommand("replies", {
		description: DESCRIPTION,
		handler: (args, ctx) => {
			const arg = args.trim();
			return arg.toLowerCase() === "triage" ? triage(pi, ctx) : openReplies(pi, ctx, arg);
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the pending asks and the reply index (/replies)",
		handler: (ctx) => openReplies(pi, ctx, ""),
	});

	pi.on("session_start", (_event, ctx) => {
		const warning = unknownMode(pi);
		if (warning && ctx.mode === "tui") ctx.ui.notify(warning, "warning");
		refreshWidget(pi, ctx);
	});

	// Pi stores the message only after the message_end handlers return, so read the branch on the next tick.
	let pending: ReturnType<typeof setTimeout> | undefined;
	pi.on("message_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		clearTimeout(pending);
		pending = setTimeout(() => {
			pending = undefined;
			try {
				refreshWidget(pi, ctx);
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
