/**
 * Pauses: dialogs that stopped a turn to ask the user something (`ask_user_question`, `ask_user_choice`).
 * The session keeps the tool call and its result, so each question comes back with the answer chosen.
 * Other dialogs shown while a tool runs are `reply-thread.pause` entries, closed with the tool's outcome.
 */

/** One question of a dialog and the answer the user gave in it. */
export interface Pause {
	text: string;
	answer: string;
	/** The tool that showed the dialog: `ask_user_question`, `ask_user_choice`, or the tool a dialog ran in. */
	tool: string;
	/** The option labels the dialog offered, in order; absent for other dialogs and calls without options. */
	options?: string[];
	/** For a dialog shown while bash ran, the program name (never its arguments). */
	program?: string;
}

/** Tools whose calls are dialogs with the user, read from the session. */
export const ASK_TOOLS: ReadonlySet<string> = new Set(["ask_user_question", "ask_user_choice"]);

/** Custom entry type of a dialog shown while a tool ran (a command guard's confirm, a review consent). */
export const PAUSE_ENTRY = "reply-thread.pause";

/**
 * A dialog shown while a tool other than the ask tools ran. Pi does not tell extensions what the user
 * pressed, so it keeps only its title, the tool and, for bash, the program name (never its arguments).
 */
export interface DialogPause {
	toolCallId: string;
	toolName: string;
	kind: string;
	title?: string;
	program?: string;
}

/** The data of a `reply-thread.pause` entry, or undefined when it does not have that shape. */
export function dialogOf(data: unknown): DialogPause | undefined {
	const input = record(data);
	if (!input) return undefined;
	const { toolCallId, toolName, kind, title, program } = input;
	const text = (value: unknown) => typeof value === "string" && value.length > 0;
	if (!text(toolCallId) || !text(toolName) || !text(kind)) return undefined;
	if (title !== undefined && typeof title !== "string") return undefined;
	if (program !== undefined && typeof program !== "string") return undefined;
	return { toolCallId, toolName, kind, title, program } as DialogPause;
}

/**
 * A dialog as a pause: the first line of its title (else `<kind> dialog`) with the tool and program, answered `ran` when
 * the tool's result is not an error, else `stopped: <first line of the result>`.
 */
export function dialogPause(dialog: DialogPause, result: PauseResult): Pause {
	// Only the first line: a command guard puts the whole command under its question.
	const title = firstLine(dialog.title ?? "") || `${dialog.kind} dialog`;
	const program = dialog.program?.trim();
	const tool = program ? `${dialog.toolName}: ${program}` : dialog.toolName;
	const line = firstLine(result.text);
	const answer = !result.isError ? "ran" : line ? `stopped: ${line}` : "stopped";
	const pause: Pause = { text: `${title} [${tool}]`, answer, tool: dialog.toolName };
	if (program) pause.program = program;
	return pause;
}

/** The parts of a tool result a pause reads. */
export interface PauseResult {
	text: string;
	details?: unknown;
	isError?: boolean;
}

type Loose = Record<string, unknown> | undefined;

function record(value: unknown): Loose {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

/** The text labels of a call's `options` in order; undefined when it has none. */
function labelsOf(options: unknown): string[] | undefined {
	if (!Array.isArray(options)) return undefined;
	const labels = options.flatMap((option) => {
		const label = record(option)?.label;
		return typeof label === "string" ? [label] : [];
	});
	return labels.length ? labels : undefined;
}

/** Lines joined by one space: every row of the overlay is one line. */
function oneLine(text: string): string {
	return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** A pause of an ask tool, on one line, with its options only when the call had some. */
function askPause(question: string, chosen: string, tool: string, options: unknown): Pause {
	const text = oneLine(question);
	const answer = oneLine(chosen);
	const labels = labelsOf(options);
	return labels ? { text, answer, tool, options: labels } : { text, answer, tool };
}

/** `User selected: 1. <label> (value: <value>)` → `<label>`, else the first line. */
function choiceAnswer(text: string): string {
	const line = firstLine(text);
	const match = /^User selected:\s*(?:\d+\.\s*)?(.*?)(?:\s*\(value: [^)]*\))?$/.exec(line);
	return match?.[1] || line;
}

/** The text after the question on its `N. <question> — <answer>` line, else the first line. */
function questionAnswer(text: string, index: number, question: string): string {
	const lines = text.split("\n").map((line) => line.trim());
	const exact = `${index + 1}. ${question} — `;
	const line = lines.find((one) => one.startsWith(exact));
	if (line) return line.slice(exact.length).trim();
	const numbered = lines.find((one) => one.startsWith(`${index + 1}. `) && one.includes(" — "));
	if (numbered) return numbered.slice(numbered.lastIndexOf(" — ") + 3).trim();
	return firstLine(text);
}

/** An `ask_user_question` answer from `details.answers`: the option, the selected ones, or the typed text. */
function detailAnswer(answer: Loose): string | undefined {
	if (!answer) return undefined;
	if (answer.kind === "multi" && Array.isArray(answer.selected)) return answer.selected.map(String).join(", ");
	return typeof answer.answer === "string" ? answer.answer : undefined;
}

/**
 * The questions of one ask tool call, each with its answer: from the result's `details` when present, else
 * from its text. A failed call (`isError`) or an unknown tool asked nothing.
 */
export function pausesOf(name: string, args: unknown, result: PauseResult): Pause[] {
	if (result.isError) return [];
	const input = record(args);
	const details = record(result.details);
	if (name === "ask_user_choice") {
		const question = input?.question;
		if (typeof question !== "string" || !question.trim()) return [];
		const label = record(details?.selection)?.label;
		const answer = typeof label === "string" ? label : choiceAnswer(result.text);
		return [askPause(question.trim(), answer, name, input?.options)];
	}
	if (name !== "ask_user_question" || !Array.isArray(input?.questions)) return [];
	const answers = Array.isArray(details?.answers) ? details.answers.map(record) : [];
	return input.questions.flatMap((one, index) => {
		const question = record(one)?.question;
		if (typeof question !== "string" || !question.trim()) return [];
		const given = answers.find((answer) => answer?.questionIndex === index) ?? answers[index];
		const answer = detailAnswer(given) ?? questionAnswer(result.text, index, question.trim());
		return [askPause(question.trim(), answer, name, record(one)?.options)];
	});
}
