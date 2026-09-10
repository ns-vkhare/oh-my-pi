/**
 * `pi` installs as a lowest-precedence plugin source.
 *
 * omp owns `~/.omp/plugins`. A machine that also runs `pi` keeps a second,
 * independent set of installs that omp never looked at:
 *
 *   - `~/.pi/agent/extensions/<name>` — a package directory, or a bare
 *     `<name>.{ts,js,mjs,cjs}` module. pi's original extension convention.
 *   - every entry of `~/.pi/agent/settings.json#packages`. A `git:<url>` entry
 *     is materialized by pi at `~/.pi/agent/git/<host>/<owner>/<repo>`; a
 *     filesystem entry names the package directory directly.
 *
 * Both are consulted ONLY for plugin names omp does not already provide, so an
 * omp-installed (or `omp plugin link`ed) plugin always shadows the pi copy and
 * nothing is loaded twice. An explicit omp disable — `omp-plugins.lock.json` or
 * a project's `plugin-overrides.json` — also suppresses the fallback, so
 * removing an omp install can never silently re-enable a plugin through pi.
 *
 * Read-only: `omp plugin install/link/remove` never writes into `~/.pi`, and
 * every filesystem failure degrades to "no fallback" rather than breaking
 * startup — the source is optional by construction.
 */
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import { expandTilde } from "../../tools/path-utils";
import type { ScopedInstalledPlugin } from "./loader";
import type { PluginManifest, PluginRuntimeConfig, ProjectPluginOverrides } from "./types";

/**
 * pi's user config root, relative to home. Deliberately not profile-scoped and
 * not derived from `PI_CONFIG_DIR`: this is the other tool's own default layout,
 * not an omp directory that follows omp's profile/env overrides.
 */
const PI_AGENT_DIR_SEGMENTS = [".pi", "agent"] as const;

const MODULE_EXTENSIONS: Record<string, true> = { ".ts": true, ".js": true, ".mjs": true, ".cjs": true };

/** `.d.ts` / `.d.mts` / `.d.cts` declaration files — never loadable as modules. */
const DECLARATION_FILE_RE = /\.d\.[mc]?ts$/;

/**
 * A pi-side package root plus the manifest entry naming its extension modules.
 * `entry` is `"."` for a package directory (resolved through the directory's own
 * `omp`/`pi` manifest, then `index.*`, then one level of sub-extensions) and
 * `./<file>` for a bare module in pi's `extensions/` directory.
 */
interface PiCandidate {
	dir: string;
	entry: string;
}

interface PiPackageJson {
	name?: string;
	version?: string;
	omp?: PluginManifest;
	pi?: PluginManifest;
}

export interface PiFallbackOptions {
	/** Home directory whose `.pi/agent` tree is consulted. */
	home: string;
	/** Plugin names omp already provides; these are never shadowed by pi. */
	ownedNames: ReadonlySet<string>;
	/** omp's plugin lock state — an explicit `enabled: false` suppresses the fallback. */
	runtimeConfig: PluginRuntimeConfig;
	/** Project-local overrides, applied to fallback entries exactly as to omp's own. */
	projectOverrides: ProjectPluginOverrides;
}

async function readJsonFile<T>(file: string): Promise<T | null> {
	try {
		return (await Bun.file(file).json()) as T;
	} catch (err) {
		if (!isEnoent(err)) logger.debug("pi fallback: unreadable JSON", { file, error: String(err) });
		return null;
	}
}

/** Candidates from `~/.pi/agent/extensions`: package directories and bare modules. */
async function listExtensionCandidates(piAgentDir: string): Promise<PiCandidate[]> {
	const extensionsDir = path.join(piAgentDir, "extensions");
	let entries: Dirent[];
	try {
		entries = await fs.readdir(extensionsDir, { withFileTypes: true });
	} catch (err) {
		if (!isEnoent(err)) logger.debug("pi fallback: unreadable extensions dir", { extensionsDir, error: String(err) });
		return [];
	}

	const candidates: PiCandidate[] = [];
	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".")) continue;
		// A symlink may point at either a directory or a module file; `"."` covers
		// both, because entry resolution stats through the link.
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			candidates.push({ dir: path.join(extensionsDir, entry.name), entry: "." });
			continue;
		}
		if (!MODULE_EXTENSIONS[path.extname(entry.name)] || DECLARATION_FILE_RE.test(entry.name)) continue;
		candidates.push({ dir: extensionsDir, entry: `./${entry.name}` });
	}
	return candidates;
}

/**
 * Split a `git:` remote into the `<host>/<owner>/<repo>` segments pi clones it
 * into. Handles scp-style (`git@host:owner/repo.git`) and URL-style
 * (`https://host/owner/repo`, `ssh://git@host/owner/repo`) remotes, stripping a
 * `#ref` suffix and the `.git` extension. Traversal segments are dropped so a
 * hostile remote cannot escape pi's git cache.
 */
function gitRemoteSegments(remote: string): string[] | null {
	const withoutRef = remote.split("#", 1)[0];
	let host: string;
	let repoPath: string;
	if (withoutRef.includes("://")) {
		let parsed: URL;
		try {
			parsed = new URL(withoutRef);
		} catch {
			return null;
		}
		host = parsed.host;
		repoPath = parsed.pathname;
	} else {
		const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(withoutRef);
		if (!scp) return null;
		host = scp[1];
		repoPath = scp[2];
	}
	const segments = repoPath
		.replace(/\.git$/, "")
		.split("/")
		.filter(segment => segment.length > 0 && segment !== "." && segment !== "..");
	if (host.length === 0 || segments.length === 0) return null;
	return [host, ...segments];
}

/**
 * Map one `settings.json#packages` entry to its on-disk package directory.
 * Schemes without a stable on-disk convention (`npm:`, `jsr:`, …) are skipped:
 * omp cannot guess where pi installed them.
 */
function resolvePackageDir(source: string, piAgentDir: string, home: string): string | null {
	if (source.startsWith("git:")) {
		const segments = gitRemoteSegments(source.slice("git:".length));
		return segments ? path.join(piAgentDir, "git", ...segments) : null;
	}
	if (source.startsWith("~") || source.startsWith(".") || path.isAbsolute(source)) {
		const expanded = expandTilde(source, home);
		return path.isAbsolute(expanded) ? expanded : path.resolve(piAgentDir, expanded);
	}
	return null;
}

/** Candidates declared in `~/.pi/agent/settings.json#packages`. */
async function listSettingsPackageCandidates(piAgentDir: string, home: string): Promise<PiCandidate[]> {
	const settings = await readJsonFile<{ packages?: unknown }>(path.join(piAgentDir, "settings.json"));
	const declared = settings?.packages;
	if (!Array.isArray(declared)) return [];

	const candidates: PiCandidate[] = [];
	for (const source of declared) {
		if (typeof source !== "string" || source.length === 0) continue;
		const dir = resolvePackageDir(source, piAgentDir, home);
		if (!dir) {
			logger.debug("pi fallback: unsupported package source", { source });
			continue;
		}
		candidates.push({ dir, entry: "." });
	}
	return candidates;
}

async function resolveCandidate(
	candidate: PiCandidate,
	opts: Pick<PiFallbackOptions, "runtimeConfig" | "projectOverrides">,
): Promise<ScopedInstalledPlugin | null> {
	const isPackageDir = candidate.entry === ".";
	// A declared-but-not-yet-cloned `packages` entry must not claim the name.
	if (isPackageDir) {
		let stats: Stats;
		try {
			stats = await fs.stat(candidate.dir);
		} catch (err) {
			if (!isEnoent(err))
				logger.debug("pi fallback: unreadable package dir", { dir: candidate.dir, error: String(err) });
			return null;
		}
		if (!stats.isDirectory()) return null;
	}

	// Only a package-directory candidate owns the `package.json` beside it. A bare
	// module shares pi's `extensions/` directory with its siblings, so adopting a
	// manifest found there would hand every sibling the same name and entries.
	const pkg = isPackageDir ? await readJsonFile<PiPackageJson>(path.join(candidate.dir, "package.json")) : null;
	const declared = pkg?.omp ?? pkg?.pi;
	const name =
		pkg?.name && pkg.name.length > 0
			? pkg.name
			: getExtensionNameFromPath(isPackageDir ? candidate.dir : path.join(candidate.dir, candidate.entry));
	const version = pkg?.version ?? "0.0.0";
	const manifest: PluginManifest = declared ? { ...declared, version } : { version, extensions: [candidate.entry] };

	const runtimeState = opts.runtimeConfig.plugins[name];
	if (runtimeState && !runtimeState.enabled) return null;
	if (opts.projectOverrides.disabled?.includes(name)) return null;

	return {
		name,
		version,
		path: candidate.dir,
		scope: "user",
		manifest,
		enabledFeatures: opts.projectOverrides.features?.[name] ?? runtimeState?.enabledFeatures ?? null,
		enabled: true,
	};
}

/**
 * Enumerate pi-installed plugins that omp should load because it has no package
 * of the same name. `extensions/` entries are resolved before
 * `settings.json#packages` ones, and the first candidate to claim a name wins,
 * so the result is stable across runs.
 */
export async function collectPiFallbackPlugins(opts: PiFallbackOptions): Promise<ScopedInstalledPlugin[]> {
	const piAgentDir = path.join(opts.home, ...PI_AGENT_DIR_SEGMENTS);
	const [extensionCandidates, packageCandidates] = await Promise.all([
		listExtensionCandidates(piAgentDir),
		listSettingsPackageCandidates(piAgentDir, opts.home),
	]);
	if (extensionCandidates.length === 0 && packageCandidates.length === 0) return [];

	const seenDirs = new Set<string>();
	const candidates = [...extensionCandidates, ...packageCandidates].filter(candidate => {
		const key = `${path.resolve(candidate.dir)}\0${candidate.entry}`;
		if (seenDirs.has(key)) return false;
		seenDirs.add(key);
		return true;
	});

	const resolved = await Promise.all(candidates.map(candidate => resolveCandidate(candidate, opts)));

	const claimed = new Set(opts.ownedNames);
	const plugins: ScopedInstalledPlugin[] = [];
	for (const plugin of resolved) {
		if (!plugin || claimed.has(plugin.name)) continue;
		claimed.add(plugin.name);
		plugins.push(plugin);
	}
	return plugins;
}
