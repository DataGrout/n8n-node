import { config } from '@n8n/node-cli/eslint';

const base = Array.isArray(config) ? config : [config];

export default [
	...base,
	{
		rules: {
			// This node is an AI Agent tool sub-node (AiTool output via supplyData),
			// which requires `@langchain/core` + `zod` at runtime. That intentionally
			// forgoes n8n Cloud / verified eligibility, so the Cloud-only dependency
			// rules are off on purpose.
			'@n8n/community-nodes/no-restricted-imports': 'off',
			'@n8n/community-nodes/no-runtime-dependencies': 'off',
			// The node already IS an agent tool (AiTool output) and must NOT also set
			// usableAsTool (conflicts with supplyData at runtime).
			'@n8n/community-nodes/node-usable-as-tool': 'off',
		},
	},
];
