import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { apiPath, parseJsonData, parseJsonObject, rowsOf } from './pure';
import { DEFAULT_WAIT_MS, call } from './transport';

// Free-text fields default to $fromAI so the node works on an AI Agent's tool
// connector with no extra setup; a workflow user overwrites the field with a
// fixed value or their own expression.
const fromAI = (name: string, description: string) =>
	`={{ $fromAI('${name}', '${description}', 'string') }}`;

export class DataGrout implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DataGrout',
		name: 'dataGrout',
		icon: { light: 'file:datagrout.svg', dark: 'file:datagrout.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Ask questions of your connected business data, and get verified answers',
		defaults: { name: 'DataGrout' },
		usableAsTool: true,
		codex: {
			categories: ['AI', 'Data & Storage'],
			alias: ['DataGrout', 'ask', 'verified', 'business data'],
			resources: { primaryDocumentation: [{ url: 'https://library.datagrout.ai/' }] },
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'dataGroutApi',
				required: true,
				displayOptions: { show: { authentication: ['apiToken'] } },
			},
			{
				name: 'dataGroutOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['oAuth2'] } },
			},
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'API Token', value: 'apiToken' },
					{ name: 'OAuth2', value: 'oAuth2' },
				],
				default: 'apiToken',
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Answer', value: 'answer' },
					{ name: 'Data', value: 'data' },
					{ name: 'Memory', value: 'memory' },
					{ name: 'Skill', value: 'skill' },
				],
				default: 'answer',
			},

			// ── Answer ──────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['answer'] } },
				options: [
					{
						name: 'Ask',
						value: 'ask',
						action: 'Ask a question about your data',
						description:
							'Ask in plain language. DataGrout plans the work, runs it against your connected systems, checks the result against the question, and returns a certificate showing exactly what ran.',
					},
				],
				default: 'ask',
			},
			{
				displayName: 'Question',
				name: 'question',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: fromAI('question', 'The question to answer using the connected business data'),
				displayOptions: { show: { resource: ['answer'] } },
				description:
					'What you want to know, in plain language — e.g. "which accounts closed deals last month but have no open support tickets?". Include any computation you need; DataGrout works it out server-side.',
			},

			// ── Data ────────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['data'] } },
				options: [
					{
						name: 'Transform',
						value: 'transform',
						action: 'Transform data',
						description:
							'Describe the result you want and DataGrout computes it on its own servers — so a large result set never has to pass through this workflow',
					},
				],
				default: 'transform',
			},
			{
				displayName: 'Goal',
				name: 'goal',
				type: 'string',
				typeOptions: { rows: 2 },
				required: true,
				default: fromAI('goal', 'What the data should be reshaped or aggregated into'),
				displayOptions: { show: { resource: ['data'] } },
				description:
					'The result you want — e.g. "total revenue by month, highest first". Aggregations, groupings and rankings are computed server-side.',
			},
			{
				displayName: 'Input',
				name: 'inputMode',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['data'] } },
				options: [
					{ name: 'Data From This Workflow', value: 'payload' },
					{ name: 'Reference From a Previous DataGrout Step', value: 'cacheRef' },
				],
				default: 'payload',
				description:
					'A reference keeps a large result on DataGrout between steps, so the rows never enter this workflow',
			},
			{
				displayName: 'Data',
				name: 'payload',
				type: 'json',
				default: '',
				displayOptions: { show: { resource: ['data'], inputMode: ['payload'] } },
				description: 'The records to transform, as JSON',
			},
			{
				displayName: 'Reference',
				name: 'cacheRef',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['data'], inputMode: ['cacheRef'] } },
				description: 'The reference returned by an earlier DataGrout step',
			},
			{
				displayName: 'Split Rows Into Items',
				name: 'splitRows',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['data'] } },
				description:
					'Whether to output one item per row of the result. Turn off to get the whole response as one item, with its certificate and reference.',
			},

			// ── Memory ──────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['memory'] } },
				options: [
					{
						name: 'Recall',
						value: 'recall',
						action: 'Recall facts',
						description: 'Ask what is known, including facts inferred from what you stored',
					},
					{
						name: 'Remember',
						value: 'remember',
						action: 'Remember a fact',
						description: 'Store a fact so later runs of any workflow can reason over it',
					},
				],
				default: 'remember',
			},
			{
				displayName: 'Fact',
				name: 'statement',
				type: 'string',
				typeOptions: { rows: 2 },
				required: true,
				default: fromAI('fact', 'The fact to remember, as a plain sentence'),
				displayOptions: { show: { resource: ['memory'], operation: ['remember'] } },
				description: 'A plain sentence — e.g. "Acme Corp is on net-30 payment terms"',
			},
			{
				displayName: 'Question',
				name: 'memoryQuestion',
				type: 'string',
				typeOptions: { rows: 2 },
				required: true,
				default: fromAI('question', 'What to look up in stored memory'),
				displayOptions: { show: { resource: ['memory'], operation: ['recall'] } },
				description: 'What you want to know from stored facts',
			},
			{
				displayName: 'Memory Name',
				name: 'namespace',
				type: 'string',
				required: true,
				default: 'default',
				displayOptions: { show: { resource: ['memory'] } },
				description:
					'Keeps separate sets of facts apart — e.g. one per customer or project. "default" is the memory DataGrout uses when none is named.',
			},

			// ── Skill ───────────────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['skill'] } },
				options: [
					{
						name: 'Run',
						value: 'run',
						action: 'Run a saved skill',
						description:
							'Re-run work DataGrout has already verified. No planning happens, so it is fast and repeatable.',
					},
				],
				default: 'run',
			},
			{
				displayName: 'Skill',
				name: 'skillHandle',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['skill'] } },
				description:
					'A saved skill\'s ID (skill_…), or the Skill ID an earlier Ask returned. A saved skill does not expire.',
			},
			{
				displayName: 'Inputs',
				name: 'skillInputs',
				type: 'json',
				default: '',
				displayOptions: { show: { resource: ['skill'] } },
				description: 'Values the skill expects, as a JSON object',
			},

			// ── Shared options ──────────────────────────────────────────
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Wait for Result (Ms)',
						name: 'waitForResult',
						type: 'number',
						default: DEFAULT_WAIT_MS,
						description:
							'DataGrout moves slow work to the background; the node waits this long for the finished result. Set 0 to return immediately with the task to follow.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const options = this.getNodeParameter('options', i, {}) as IDataObject;
				const waitMs = (options.waitForResult as number) ?? DEFAULT_WAIT_MS;

				const text = (name: string, label: string): string => {
					const value = String(this.getNodeParameter(name, i, '') ?? '').trim();
					if (!value) {
						throw new NodeOperationError(this.getNode(), `${label} is empty`, { itemIndex: i });
					}
					return value;
				};

				const emit = (json: IDataObject) => out.push({ json, pairedItem: { item: i } });

				if (resource === 'answer') {
					emit(await call(this, 'POST', '/answers', { question: text('question', 'Question') }, i, waitMs));
				} else if (resource === 'data') {
					const body: IDataObject = { goal: text('goal', 'Goal') };

					if (this.getNodeParameter('inputMode', i, 'payload') === 'cacheRef') {
						body.reference = text('cacheRef', 'Reference');
					} else {
						let data: unknown;
						try {
							data = parseJsonData(this.getNodeParameter('payload', i, ''));
						} catch (e) {
							throw new NodeOperationError(this.getNode(), `Data: ${(e as Error).message}`, {
								itemIndex: i,
							});
						}
						body.data = (data ?? items[i].json) as IDataObject;
					}

					const transform = await call(this, 'POST', '/transforms', body, i, waitMs);
					const split = this.getNodeParameter('splitRows', i, true) as boolean;

					if (split && transform.status !== 'running') {
						rowsOf(transform.result).forEach(emit);
					} else {
						emit(transform);
					}
				} else if (resource === 'memory') {
					const name = text('namespace', 'Memory Name');

					if (this.getNodeParameter('operation', i) === 'remember') {
						const statement = text('statement', 'Fact');
						emit(await call(this, 'POST', apiPath('memories', name, 'facts'), { statement }, i, waitMs));
					} else {
						const question = text('memoryQuestion', 'Question');
						emit(await call(this, 'POST', apiPath('memories', name, 'recall'), { question }, i, waitMs));
					}
				} else if (resource === 'skill') {
					let inputs: IDataObject | undefined;
					try {
						inputs = parseJsonObject(this.getNodeParameter('skillInputs', i, ''));
					} catch (e) {
						throw new NodeOperationError(this.getNode(), `Inputs: ${(e as Error).message}`, {
							itemIndex: i,
						});
					}

					const path = apiPath('skills', text('skillHandle', 'Skill'), 'runs');
					emit(await call(this, 'POST', path, inputs ? { inputs } : {}, i, waitMs));
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource "${resource}"`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [out];
	}
}
