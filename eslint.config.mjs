import { config } from '@n8n/node-cli/eslint';

export default [
	...config,
	// Unit tests are never published — `files: ["dist"]` ships only the build
	// output, and tsconfig compiles `credentials/` and `nodes/` only. n8n
	// Cloud's no-dependencies rule is about the node's shipped runtime, so it
	// does not apply here; without this the rule rejects `node:test`.
	{ ignores: ['test/**'] },
];
