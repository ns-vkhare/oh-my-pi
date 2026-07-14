/**
 * `omp hub` — the tmux-supervised session hub (Claude-Code "agent view" model).
 *
 * From a bare shell (or a different tmux session) this ensures the `omp-hub`
 * tmux session exists and attaches/switches to it. As the hub window's own
 * process it renders the fullscreen hub TUI. See {@link runHub}.
 */
import { Command } from "@oh-my-pi/pi-utils/cli";
import { runHub } from "../hub/run-hub";

export default class Hub extends Command {
	static description = "Open the tmux-supervised session hub (background/foreground across sessions)";

	static examples = ["# Open the session hub\n  omp hub"];

	async run(): Promise<void> {
		await runHub();
	}
}
