/**
 * List the sessions recorded for a project directory.
 */
import * as path from "node:path";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { SessionManager } from "../session/session-manager";

const FIRST_MESSAGE_MAX = 120;
const TITLE_MAX = 60;

/** Coarse age of the last write, mirroring the session picker's `timeAgo` buckets. */
function age(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	if (!Number.isFinite(diffMs)) return "?";
	const mins = Math.floor(diffMs / 60000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export default class Sessions extends Command {
	static description = "List sessions for a project directory";

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output sessions as JSON", default: false }),
		dir: Flags.string({ char: "d", description: "Project directory to list (defaults to the cwd)" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Sessions);
		// ponytail: SessionManager.list is the single listing entry point and already
		// sorts newest-first; reused as-is rather than re-deriving the session dir.
		const sessions = await SessionManager.list(flags.dir ?? process.cwd());

		if (flags.json) {
			// Sessions written without a header timestamp parse to an Invalid Date,
			// whose toISOString() throws — those surface as null rather than a crash.
			const picked = sessions.map(s => ({
				path: s.path,
				id: s.id,
				title: s.title,
				firstMessage:
					s.firstMessage.length > FIRST_MESSAGE_MAX
						? `${s.firstMessage.slice(0, FIRST_MESSAGE_MAX - 1)}…`
						: s.firstMessage,
				created: Number.isFinite(s.created.getTime()) ? s.created.toISOString() : null,
				modified: Number.isFinite(s.modified.getTime()) ? s.modified.toISOString() : null,
				messageCount: s.messageCount,
				status: s.status,
			}));
			process.stdout.write(`${JSON.stringify(picked)}\n`);
			return;
		}

		if (sessions.length === 0) return;
		const rows = sessions.map(s => {
			const label = (s.title ?? s.firstMessage).replace(/\s+/g, " ").trim() || "(untitled)";
			return {
				age: age(s.modified),
				status: s.status ?? "unknown",
				title: label.length > TITLE_MAX ? `${label.slice(0, TITLE_MAX - 1)}…` : label,
				file: path.basename(s.path),
			};
		});
		const ageWidth = Math.max(...rows.map(r => r.age.length));
		const statusWidth = Math.max(...rows.map(r => r.status.length));
		const titleWidth = Math.max(...rows.map(r => r.title.length));
		const lines = rows.map(
			r => `${r.age.padStart(ageWidth)}  ${r.status.padEnd(statusWidth)}  ${r.title.padEnd(titleWidth)}  ${r.file}`,
		);
		process.stdout.write(`${lines.join("\n")}\n`);
	}
}
