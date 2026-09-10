import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isEnotdir } from "@oh-my-pi/pi-utils";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	ADVISOR_TRANSCRIPT_STEM,
	isAdvisorTranscriptName,
} from "../advisor/transcript-recorder";
import { MAIN_AGENT_ID } from "./agent-registry";

export type SubagentTranscriptKind = "sub" | "advisor";

export interface SubagentTranscript {
	id: string;
	displayName: string;
	kind: SubagentTranscriptKind;
	parentId: string;
	sessionFile: string;
	depth: number;
	mtimeMs: number;
	size: number;
}

const JSONL_SUFFIX = ".jsonl";
const ADVISOR_PREFIX_LENGTH = `${ADVISOR_TRANSCRIPT_STEM}.`.length;

export async function scanSubagentTranscripts(sessionFile: string | null | undefined): Promise<SubagentTranscript[]> {
	if (!sessionFile?.endsWith(JSONL_SUFFIX)) return [];
	const found: SubagentTranscript[] = [];
	await scanDir(sessionFile.slice(0, -JSONL_SUFFIX.length), MAIN_AGENT_ID, 1, found);
	return found;
}

async function scanDir(dir: string, parentId: string, depth: number, found: SubagentTranscript[]): Promise<void> {
	const nested = depth > 1;
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
		if (nested || isEnoent(err) || isEnotdir(err)) return null;
		throw err;
	});
	if (!entries) return;
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(JSONL_SUFFIX) || entry.name.includes(".bak")) continue;
		const transcriptFile = path.join(dir, entry.name);
		const { mtimeMs, size } = await statTranscript(transcriptFile);
		if (isAdvisorTranscriptName(entry.name)) {
			const slug =
				entry.name === ADVISOR_TRANSCRIPT_FILENAME
					? ""
					: entry.name.slice(ADVISOR_PREFIX_LENGTH, -JSONL_SUFFIX.length);
			found.push({
				id: slug ? `${parentId}/advisor:${slug}` : `${parentId}/advisor`,
				displayName: slug ? `advisor:${slug}` : "advisor",
				kind: "advisor",
				parentId,
				sessionFile: transcriptFile,
				depth,
				mtimeMs,
				size,
			});
			continue;
		}
		const id = entry.name.slice(0, -JSONL_SUFFIX.length);
		found.push({
			id,
			displayName: id,
			kind: "sub",
			parentId,
			sessionFile: transcriptFile,
			depth,
			mtimeMs,
			size,
		});
		await scanDir(path.join(dir, id), id, depth + 1, found);
	}
}

async function statTranscript(file: string): Promise<{ mtimeMs: number; size: number }> {
	try {
		const stats = await fs.stat(file);
		return { mtimeMs: stats.mtimeMs, size: stats.size };
	} catch {
		return { mtimeMs: 0, size: 0 };
	}
}
