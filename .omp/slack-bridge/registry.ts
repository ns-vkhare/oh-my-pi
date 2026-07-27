/**
 * Thread↔session registry with debounced JSON persistence.
 *
 * Persists RegistryData at `<stateDir>/state.json`. Mutations schedule a
 * debounced (250ms) async save; `flush()` forces an immediate write for
 * shutdown/tests. A missing or corrupt state file loads as an empty registry
 * (corrupt file is renamed to `state.json.bak` and logged).
 */

import type { RegistryData, TaskRecord } from "./types";

const SAVE_DEBOUNCE_MS = 250;

export class TaskRegistry {
	readonly #path: string;
	readonly #tasks = new Map<string, TaskRecord>();
	/** channel → newest message ts the catch-up sweep has already considered. */
	readonly #catchup = new Map<string, string>();
	#saveTimer: ReturnType<typeof setTimeout> | undefined;
	#saving: Promise<void> | undefined;

	private constructor(path: string, data: RegistryData) {
		this.#path = path;
		for (const record of data.tasks) this.#tasks.set(record.threadTs, record);
		for (const [channel, ts] of Object.entries(data.catchup ?? {})) {
			if (typeof ts === "string") this.#catchup.set(channel, ts);
		}
	}

	static async load(stateDir: string): Promise<TaskRegistry> {
		const path = `${stateDir}/state.json`;
		const file = Bun.file(path);
		if (!(await file.exists())) return new TaskRegistry(path, { tasks: [] });
		try {
			const parsed = JSON.parse(await file.text()) as RegistryData;
			const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
			return new TaskRegistry(path, { tasks, catchup: parsed?.catchup });
		} catch (err) {
			const backup = `${path}.bak`;
			console.error(`registry: corrupt state file at ${path} (${String(err)}); renaming to ${backup}`);
			try {
				await Bun.write(backup, file);
			} catch (backupErr) {
				console.error(`registry: failed to back up corrupt state file: ${String(backupErr)}`);
			}
			return new TaskRegistry(path, { tasks: [] });
		}
	}

	/** Newest message ts already considered by the catch-up sweep for `channel`. */
	catchupTs(channel: string): string | undefined {
		return this.#catchup.get(channel);
	}

	setCatchupTs(channel: string, ts: string): void {
		if (this.#catchup.get(channel) === ts) return;
		this.#catchup.set(channel, ts);
		this.#scheduleSave();
	}

	upsert(record: TaskRecord): void {
		this.#tasks.set(record.threadTs, record);
		this.#scheduleSave();
	}

	byThread(threadTs: string): TaskRecord | undefined {
		return this.#tasks.get(threadTs);
	}

	bySessionPath(path: string): TaskRecord | undefined {
		for (const record of this.#tasks.values()) {
			if (record.sessionPath === path) return record;
		}
		return undefined;
	}

	all(): TaskRecord[] {
		return [...this.#tasks.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	}

	touch(threadTs: string): void {
		const record = this.#tasks.get(threadTs);
		if (!record) return;
		record.lastActivityAt = Date.now();
		this.#scheduleSave();
	}

	remove(threadTs: string): void {
		if (this.#tasks.delete(threadTs)) this.#scheduleSave();
	}

	async flush(): Promise<void> {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		await this.#save();
	}

	#scheduleSave(): void {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			void this.#save();
		}, SAVE_DEBOUNCE_MS);
	}

	async #save(): Promise<void> {
		// Serialize concurrent saves so a debounced write can't race flush().
		while (this.#saving) await this.#saving;
		const data: RegistryData = { tasks: [...this.#tasks.values()], catchup: Object.fromEntries(this.#catchup) };
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#saving = promise;
		try {
			await Bun.write(this.#path, JSON.stringify(data, null, 2));
		} catch (err) {
			console.error(`registry: failed to save state to ${this.#path}: ${String(err)}`);
		} finally {
			this.#saving = undefined;
			resolve();
		}
	}
}
