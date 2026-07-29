import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { getEnabledPlugins, resolvePluginExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { getAgentDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

describe("pi plugin fallback", () => {
	let home = "";
	let cwd = "";
	let piAgentDir = "";
	let ompPluginsDir = "";
	let piClone = "";

	const writeJson = (file: string, value: unknown): void => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(value));
	};

	const writeModule = (file: string): void => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "export default () => {};\n");
	};

	/**
	 * A pi `packages` entry plus the clone pi materialized for it. The declared
	 * remote carries both a `.git` suffix and a `#ref`, which the clone directory
	 * does not — the resolver has to strip them to find the package on disk.
	 */
	const writePiSettingsPackage = (): void => {
		writeJson(path.join(piAgentDir, "settings.json"), { packages: ["git:git@github.com:acme/demo-ext.git#main"] });
		writeJson(path.join(piClone, "package.json"), {
			name: "demo-ext",
			private: true,
			pi: { extensions: ["./index.ts"] },
		});
		writeModule(path.join(piClone, "index.ts"));
	};

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pi-fallback-home-"));
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pi-fallback-cwd-"));
		piAgentDir = path.join(home, ".pi", "agent");
		ompPluginsDir = path.join(home, ".omp", "plugins");
		piClone = path.join(piAgentDir, "git", "github.com", "acme", "demo-ext");
	});

	afterEach(() => {
		removeSyncWithRetries(home);
		removeSyncWithRetries(cwd);
	});

	it("loads a pi settings package when omp provides no plugin of that name", async () => {
		writePiSettingsPackage();

		const plugins = await getEnabledPlugins(cwd, { home });
		const demo = plugins.find(plugin => plugin.name === "demo-ext");

		expect(demo?.path).toBe(piClone);
		expect(demo?.scope).toBe("user");
		expect(demo ? resolvePluginExtensionPaths(demo) : []).toEqual([path.join(piClone, "index.ts")]);
	});

	it("prefers the omp-installed plugin over the pi copy of the same name", async () => {
		writePiSettingsPackage();
		const ompPlugin = path.join(ompPluginsDir, "node_modules", "demo-ext");
		writeJson(path.join(ompPluginsDir, "package.json"), {
			name: "omp-plugins",
			private: true,
			dependencies: { "demo-ext": "1.0.0" },
		});
		writeJson(path.join(ompPlugin, "package.json"), {
			name: "demo-ext",
			version: "1.0.0",
			omp: { extensions: ["./index.ts"] },
		});
		writeModule(path.join(ompPlugin, "index.ts"));

		const plugins = await getEnabledPlugins(cwd, { home });
		const matches = plugins.filter(plugin => plugin.name === "demo-ext");

		expect(matches).toHaveLength(1);
		expect(matches[0]?.path).toBe(ompPlugin);
	});

	it("loads pi extensions-directory packages and bare modules", async () => {
		const packageDir = path.join(piAgentDir, "extensions", "legacy-ext");
		writeModule(path.join(packageDir, "index.ts"));
		writeModule(path.join(piAgentDir, "extensions", "solo.ts"));

		const plugins = await getEnabledPlugins(cwd, { home });
		const legacy = plugins.find(plugin => plugin.name === "legacy-ext");
		const solo = plugins.find(plugin => plugin.name === "solo");

		expect(legacy ? resolvePluginExtensionPaths(legacy) : []).toEqual([path.join(packageDir, "index.ts")]);
		expect(solo ? resolvePluginExtensionPaths(solo) : []).toEqual([path.join(piAgentDir, "extensions", "solo.ts")]);
	});

	it("keeps an omp-disabled plugin disabled when only pi provides it", async () => {
		writePiSettingsPackage();
		writeJson(path.join(ompPluginsDir, "omp-plugins.lock.json"), {
			plugins: { "demo-ext": { version: "1.0.0", enabledFeatures: null, enabled: false } },
			settings: {},
		});

		const plugins = await getEnabledPlugins(cwd, { home });

		expect(plugins.some(plugin => plugin.name === "demo-ext")).toBe(false);
	});

	it("ignores a declared pi package that has not been cloned", async () => {
		writeJson(path.join(piAgentDir, "settings.json"), {
			packages: ["git:git@github.com:acme/never-cloned", "npm:some-registry-package"],
		});

		const plugins = await getEnabledPlugins(cwd, { home });

		expect(plugins).toEqual([]);
	});

	it("loads a pi-only extension through the whole discovery path", async () => {
		const probeDir = path.join(piAgentDir, "extensions", "probe-ext");
		fs.mkdirSync(probeDir, { recursive: true });
		fs.writeFileSync(
			path.join(probeDir, "index.ts"),
			'export default function(pi) { pi.registerCommand("pi-fallback-probe", { handler: async () => {} }); }\n',
		);
		fs.mkdirSync(path.join(ompPluginsDir, "node_modules"), { recursive: true });

		// `discoverAndLoadExtensions` resolves every root from the process home, so
		// the whole config root has to move into the fixture — otherwise discovery
		// would load the developer's real extensions alongside the probe.
		const originalAgentDir = getAgentDir();
		const xdgVars = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
		const originalXdg = new Map<string, string | undefined>();
		for (const key of xdgVars) {
			originalXdg.set(key, process.env[key]);
			delete process.env[key];
		}
		const homedir = spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		try {
			const result = await discoverAndLoadExtensions([], cwd);
			const probe = result.extensions.find(extension => extension.path === path.join(probeDir, "index.ts"));

			expect(result.errors).toHaveLength(0);
			expect(probe?.commands.has("pi-fallback-probe")).toBe(true);
		} finally {
			setAgentDir(originalAgentDir);
			homedir.mockRestore();
			for (const [key, value] of originalXdg) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
