/**
 * Pauses: dialogs that stopped a turn to ask the user something (`ask_user_question`, `ask_user_choice`).
 * The session keeps the tool call and its result, so each question comes back with the answer chosen.
 */

/** One question of a dialog and the answer the user gave in it. */
export interface Pause {
	text: string;
	answer: string;
}

/** Tools whose calls are dialogs with the user, read from the session. */
export const ASK_TOOLS: ReadonlySet<string> = new Set(["ask_user_question", "ask_user_choice"]);

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
		return [{ text: question.trim(), answer: typeof label === "string" ? label : choiceAnswer(result.text) }];
	}
	if (name !== "ask_user_question" || !Array.isArray(input?.questions)) return [];
	const answers = Array.isArray(details?.answers) ? details.answers.map(record) : [];
	return input.questions.flatMap((one, index) => {
		const question = record(one)?.question;
		if (typeof question !== "string" || !question.trim()) return [];
		const given = answers.find((answer) => answer?.questionIndex === index) ?? answers[index];
		const answer = detailAnswer(given) ?? questionAnswer(result.text, index, question.trim());
		return [{ text: question.trim(), answer }];
	});
}
