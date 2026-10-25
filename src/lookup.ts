import type { Reply, Thread } from "./threads.ts";

/** A question ID: the reply's ordered ID or entry ID, then the question number (`P12.R1.Q2`, `a1b2c3d4.2`). */
const QUESTION = /^(.+?)(?:\.q|\.)([1-9]\d*)$/i;

function findOne(threads: readonly Thread[], wanted: string): Reply | undefined {
	const ordinal = wanted.toLowerCase();
	for (const thread of threads) {
		for (const reply of thread.replies) {
			if (reply.entryId === wanted || reply.ordinal.toLowerCase() === ordinal) return reply;
		}
	}
	return undefined;
}

/**
 * Finds a reply by ordered ID (`P12.R1`, any case) or by its exact Pi entry ID, or the reply of a question
 * by its ordered ID (`P12.R1.Q2`, any case) or unique ID (`a1b2c3d4.2`).
 */
export function findReply(threads: readonly Thread[], id: string): Reply | undefined {
	const wanted = id.trim();
	if (!wanted) return undefined;
	const reply = findOne(threads, wanted);
	if (reply) return reply;
	const question = QUESTION.exec(wanted);
	if (!question) return undefined;
	const [, base, number] = question;
	const asker = findOne(threads, base);
	if (!asker || Number(number) > asker.openAsks.length) return undefined;
	const ordered = asker.ordinal.toLowerCase() === base.toLowerCase();
	// The ordered form takes `.Q<n>`, the unique form a bare `.<n>`.
	return ordered === /\.q\d+$/i.test(wanted) ? asker : undefined;
}

export function noMatchMessage(arg: string): string {
	return `No reply matches "${arg}". Run /replies to list them.`;
}
