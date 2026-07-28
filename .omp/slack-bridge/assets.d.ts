/**
 * Text imports for the prompt assets under `prompts/`.
 *
 * Model-facing prose lives in `.md` files, never in string literals in code, and
 * is pulled in with `import … with { type: "text" }`. The monorepo declares this
 * centrally in `types/assets`, but the bridge is deployed as a standalone tree
 * (`install.sh` copies it to `~/.omp/slack-bridge` and it typechecks there with
 * its own tsconfig), so it carries its own copy of the declaration.
 */
declare module "*.md" {
	const content: string;
	export default content;
}
