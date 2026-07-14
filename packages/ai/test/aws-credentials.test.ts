import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearAwsCredentialCache,
	resolveAwsCredentials,
	tokenizeCredentialProcessCommand,
} from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { removeWithRetries } from "../../utils/src/temp";

// `credential_process` integration coverage. Drives a real `Bun.spawn`
// against a fixture script so the JSON envelope contract, exit-code
// handling, abort propagation, cache behavior, and the POSIX-style
// tokenizer are all exercised end-to-end.

const ENV_KEYS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
] as const;

function quoteForConfig(p: string): string {
	if (!/[\s"]/.test(p)) return p;
	// Wrap in double quotes; our tokenizer preserves backslashes so Windows
	// paths survive without further escaping.
	return `"${p.replace(/(["])/g, "\\$1")}"`;
}

describe("tokenizeCredentialProcessCommand", () => {
	test("splits on whitespace", () => {
		expect(tokenizeCredentialProcessCommand("/bin/auth --json")).toEqual(["/bin/auth", "--json"]);
	});

	test("collapses runs of whitespace", () => {
		expect(tokenizeCredentialProcessCommand("  a\tb \n c")).toEqual(["a", "b", "c"]);
	});

	test("double quotes preserve Windows backslashes", () => {
		expect(tokenizeCredentialProcessCommand(`"C:\\Program Files\\auth\\tool.exe" --json`)).toEqual([
			"C:\\Program Files\\auth\\tool.exe",
			"--json",
		]);
	});

	test('double quotes still escape $ ` " and \\', () => {
		expect(tokenizeCredentialProcessCommand(`"a\\"b" "\\$x" "\\\\n"`)).toEqual([`a"b`, "$x", "\\n"]);
	});

	test("single quotes are fully literal", () => {
		expect(tokenizeCredentialProcessCommand(`'C:\\path with spaces\\bin' --x`)).toEqual([
			"C:\\path with spaces\\bin",
			"--x",
		]);
	});

	test("backslash outside quotes escapes the next character", () => {
		expect(tokenizeCredentialProcessCommand(`a\\ b c`)).toEqual(["a b", "c"]);
	});

	test("rejects unterminated quotes", () => {
		expect(() => tokenizeCredentialProcessCommand(`"unterminated`)).toThrow(/unterminated/);
		expect(() => tokenizeCredentialProcessCommand(`'half`)).toThrow(/unterminated/);
	});

	test("empty input yields no tokens", () => {
		expect(tokenizeCredentialProcessCommand("")).toEqual([]);
		expect(tokenizeCredentialProcessCommand("   \t  ")).toEqual([]);
	});
});

describe("resolveAwsCredentials credential_process", () => {
	let tmp: string;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const k of ENV_KEYS) {
			saved.set(k, Bun.env[k]);
			delete Bun.env[k];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-credproc-"));
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete Bun.env[k];
			else Bun.env[k] = v;
		}
		saved.clear();
		await removeWithRetries(tmp);
		clearAwsCredentialCache();
	});

	async function writeFixture(name: string, body: string): Promise<string> {
		const p = path.join(tmp, name);
		await Bun.write(p, body);
		return p;
	}

	async function writeConfig(profile: string, line: string): Promise<void> {
		const cfg = path.join(tmp, "config");
		await Bun.write(cfg, `[profile ${profile}]\n${line}\n`);
		Bun.env.AWS_CONFIG_FILE = cfg;
		// Point shared credentials at a known-empty file so static-creds resolution
		// definitely misses.
		const sharedPath = path.join(tmp, "credentials");
		await Bun.write(sharedPath, "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = sharedPath;
	}

	test("parses a Version 1 envelope and honors Expiration", async () => {
		const script = await writeFixture(
			"good.js",
			`console.log(JSON.stringify({Version:1,AccessKeyId:"AKIATEST",SecretAccessKey:"sek",SessionToken:"tok",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig("good", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);

		const creds = await resolveAwsCredentials({ profile: "good", region: "us-east-1" });
		expect(creds.accessKeyId).toBe("AKIATEST");
		expect(creds.secretAccessKey).toBe("sek");
		expect(creds.sessionToken).toBe("tok");
		expect(creds.expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z"));
	});

	test("caches by profile so the helper is only invoked once", async () => {
		const counterPath = path.join(tmp, "calls.txt");
		const script = await writeFixture(
			"counted.js",
			`const fs=require("node:fs");
			 const prev=fs.existsSync(${JSON.stringify(counterPath)})?Number(fs.readFileSync(${JSON.stringify(counterPath)},"utf8")):0;
			 fs.writeFileSync(${JSON.stringify(counterPath)},String(prev+1));
			 console.log(JSON.stringify({Version:1,AccessKeyId:"AKIA",SecretAccessKey:"s",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig(
			"counted",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);

		await resolveAwsCredentials({ profile: "counted" });
		await resolveAwsCredentials({ profile: "counted" });
		const calls = Number(await Bun.file(counterPath).text());
		expect(calls).toBe(1);
	});

	test("rejects unsupported envelope versions", async () => {
		const script = await writeFixture(
			"badversion.js",
			`console.log(JSON.stringify({Version:2,AccessKeyId:"a",SecretAccessKey:"b"}));`,
		);
		await writeConfig("badv", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		await expect(resolveAwsCredentials({ profile: "badv" })).rejects.toThrow(/unsupported Version 2/);
	});

	test("surfaces stderr on non-zero exit", async () => {
		const script = await writeFixture("fail.js", `process.stderr.write("auth helper broke");process.exit(7);`);
		await writeConfig(
			"failing",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);
		await expect(resolveAwsCredentials({ profile: "failing" })).rejects.toThrow(/exited 7.*auth helper broke/);
	});

	test("aborts a long-running helper when the caller's signal fires", async () => {
		const script = await writeFixture("hang.js", `setTimeout(()=>{},60_000);`);
		await writeConfig("hangs", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		const ctrl = new AbortController();
		const promise = resolveAwsCredentials({ profile: "hangs", signal: ctrl.signal });
		setTimeout(() => ctrl.abort(new Error("test abort")), 50);
		await expect(promise).rejects.toBeDefined();
	});
});

describe("resolveAwsCredentials SSO silent refresh", () => {
	let tmp: string;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const k of ENV_KEYS) {
			saved.set(k, Bun.env[k]);
			delete Bun.env[k];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-sso-"));
		// The SSO cache dir is rooted at os.homedir() (getpwuid, not $HOME), so
		// spy it onto the sandbox to keep the test hermetic.
		spyOn(os, "homedir").mockReturnValue(tmp);
		clearAwsCredentialCache();
	});

	afterEach(async () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete Bun.env[k];
			else Bun.env[k] = v;
		}
		saved.clear();
		await removeWithRetries(tmp);
		clearAwsCredentialCache();
		mock.restore();
	});

	const START_URL = "https://d-test.awsapps.com/start";
	const SSO_REGION = "us-west-2";

	async function writeSsoProfile(profile: string): Promise<void> {
		const cfg = path.join(tmp, "config");
		await Bun.write(
			cfg,
			`[profile ${profile}]\nsso_start_url = ${START_URL}\nsso_region = ${SSO_REGION}\n` +
				`sso_account_id = 111122223333\nsso_role_name = TestRole\nregion = us-east-1\n`,
		);
		Bun.env.AWS_CONFIG_FILE = cfg;
		const shared = path.join(tmp, "credentials");
		await Bun.write(shared, "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = shared;
	}

	async function writeCachedToken(token: Record<string, unknown>): Promise<string> {
		const dir = path.join(tmp, ".aws", "sso", "cache");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "token.json");
		await Bun.write(file, JSON.stringify(token));
		return file;
	}

	test("silently refreshes an expired token via OIDC CreateToken and rewrites the cache", async () => {
		await writeSsoProfile("sso");
		const tokenFile = await writeCachedToken({
			startUrl: START_URL,
			region: SSO_REGION,
			accessToken: "stale-access",
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			refreshToken: "refresh-abc",
			clientId: "client-id",
			clientSecret: "client-secret",
			registrationExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		});

		let oidcCalls = 0;
		let bearerSeenByFederation: string | undefined;
		const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.startsWith(`https://oidc.${SSO_REGION}.amazonaws.com/token`)) {
				oidcCalls++;
				const body = JSON.parse(String(init?.body)) as Record<string, string>;
				expect(body.grantType).toBe("refresh_token");
				expect(body.refreshToken).toBe("refresh-abc");
				expect(body.clientId).toBe("client-id");
				expect(body.clientSecret).toBe("client-secret");
				return new Response(
					JSON.stringify({ accessToken: "fresh-access", expiresIn: 3600, refreshToken: "refresh-next" }),
					{ status: 200 },
				);
			}
			if (u.includes("/federation/credentials")) {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				bearerSeenByFederation = headers["x-amz-sso_bearer_token"];
				return new Response(
					JSON.stringify({
						roleCredentials: {
							accessKeyId: "AKIAROLE",
							secretAccessKey: "role-secret",
							sessionToken: "role-token",
							expiration: Date.now() + 3_600_000,
						},
					}),
					{ status: 200 },
				);
			}
			throw new Error(`unexpected fetch: ${u}`);
		}) as unknown as typeof fetch;

		const creds = await resolveAwsCredentials({ profile: "sso", region: "us-east-1", fetch: fetchImpl });

		// Fresh role credentials returned, minted from the refreshed bearer token.
		expect(creds.accessKeyId).toBe("AKIAROLE");
		expect(creds.sessionToken).toBe("role-token");
		expect(oidcCalls).toBe(1);
		expect(bearerSeenByFederation).toBe("fresh-access");

		// Cache file rewritten so other AWS tools reuse the refreshed token.
		const persisted = await Bun.file(tokenFile).json();
		expect(persisted.accessToken).toBe("fresh-access");
		expect(persisted.refreshToken).toBe("refresh-next");
		expect(Date.parse(persisted.expiresAt)).toBeGreaterThan(Date.now());
		// Unmodelled fields survive the round-trip.
		expect(persisted.clientId).toBe("client-id");
	});

	test("throws sso-token-expired when an expired token has no refresh token", async () => {
		await writeSsoProfile("sso2");
		await writeCachedToken({
			startUrl: START_URL,
			region: SSO_REGION,
			accessToken: "stale-access",
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
		});
		const fetchImpl = (async () => {
			throw new Error("should not be called");
		}) as unknown as typeof fetch;
		await expect(resolveAwsCredentials({ profile: "sso2", region: "us-east-1", fetch: fetchImpl })).rejects.toThrow(
			/has expired and automatic refresh failed/,
		);
	});
});
