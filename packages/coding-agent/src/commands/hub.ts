/**
 * `omp hub` — the tmux-supervised session hub (Claude-Code "agent view" model).
 *
 * From a bare shell (or a different tmux session) this ensures the project's
 * hub tmux session exists and attaches/switches to it. As the hub window's own
 * process it renders the fullscreen hub TUI. See {@link runHub}.
 *
 * `omp hub list` prints every active hub across projects instead. See
 * {@link runHubList}.
 */
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { runHub, runHubList } from "../hub/run-hub";

export default class Hub extends Command {
	static description = "Open the tmux-supervised session hub (background/foreground across sessions)";

	static examples = ["# Open the session hub\n  omp hub", "# List active hubs across projects\n  omp hub list"];

	static args = {
		action: Args.string({
			description: "Subcommand: 'list' to show active hubs; omitted opens the hub",
			required: false,
			options: ["list"],
		}),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(Hub);
		if (args.action === "list") {
			await runHubList();
			return;
		}
		await runHub();
	}
}
