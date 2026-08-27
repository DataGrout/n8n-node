import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	parseJsonData,
	parseJsonObject,
	payloadError,
	shapeAnswer,
	toolPayload,
	unwrapData,
} from './pure';
import { DEFAULT_TASK_WAIT_MS, callTool } from './transport';

// The tools behind each operation. Users never see these — they pick an
// operation, and the node knows which DataGrout capability serves it.
const ASK = 'data-grout@1/discovery.plan@1';
const TRANSFORM = 'data-grout@1/prism.refract@1';
const REMEMBER = 'data-grout@1/logic.remember@1';
const RECALL = 'data-grout@1/logic.query@1';
const RUN_SKILL = 'data-grout@1/discovery.perform@1';

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
				default: '',
				displayOptions: { show: { resource: ['memory'] } },
				description:
					'Keeps separate sets of facts apart — e.g. one per customer or project. Leave empty for the default memory.',
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
				description: 'The skill to run, as returned by an earlier Ask',
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
						default: DEFAULT_TASK_WAIT_MS,
						description:
							'DataGrout moves slow work to the background; the node waits this long for the finished result. Set 0 to return immediately.',
					},
					{
						displayName: 'Full Response',
						name: 'fullResponse',
						type: 'boolean',
						default: false,
						description:
							'Whether to return everything DataGrout sent, instead of the tidied answer',
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
				const waitMs = (options.waitForResult as number) ?? DEFAULT_TASK_WAIT_MS;
				const full = (options.fullResponse as boolean) ?? false;

				const json = (raw: unknown, field: string) => {
					try {
						return parseJsonObject(raw);
					} catch (e) {
						throw new NodeOperationError(this.getNode(), `${field}: ${(e as Error).message}`, {
							itemIndex: i,
						});
					}
				};

				let result: IDataObject;

				if (resource === 'answer') {
					const question = String(this.getNodeParameter('question', i, '') ?? '').trim();
					if (!question) {
						throw new NodeOperationError(this.getNode(), 'Question is empty', { itemIndex: i });
					}
					result = await callTool(
						this,
						ASK,
						{ goal: question, execute: true, verify: true, lean: true, head: true },
						i,
						waitMs,
					);
					const payload = toolPayload(result);
					const failure = payloadError(payload);
					if (failure) {
						throw new NodeOperationError(this.getNode(), `DataGrout: ${failure}`, {
							itemIndex: i,
						});
					}
					out.push({
						json: full ? payload : shapeAnswer(payload),
						pairedItem: { item: i },
					});
					continue;
				}

				if (resource === 'data') {
					const goal = String(this.getNodeParameter('goal', i, '') ?? '').trim();
					if (!goal) {
						throw new NodeOperationError(this.getNode(), 'Goal is empty', { itemIndex: i });
					}
					const mode = this.getNodeParameter('inputMode', i, 'payload') as string;
					const args: IDataObject = { goal };

					if (mode === 'cacheRef') {
						const ref = String(this.getNodeParameter('cacheRef', i, '') ?? '').trim();
						if (!ref) {
							throw new NodeOperationError(this.getNode(), 'Reference is empty', { itemIndex: i });
						}
						args.cache_ref = ref;
					} else {
						let data: unknown;
						try {
							data = parseJsonData(this.getNodeParameter('payload', i, ''));
						} catch (e) {
							throw new NodeOperationError(this.getNode(), `Data: ${(e as Error).message}`, {
								itemIndex: i,
							});
						}
						args.payload = data ?? items[i].json;
					}

					result = await callTool(this, TRANSFORM, args, i, waitMs);

					const transformFailure = payloadError(toolPayload(result));
					if (transformFailure) {
						throw new NodeOperationError(this.getNode(), `DataGrout: ${transformFailure}`, {
							itemIndex: i,
						});
					}

					if (!full) {
						const value = unwrapData(toolPayload(result));
						if (Array.isArray(value)) {
							for (const row of value) {
								out.push({
									json: (row && typeof row === 'object' && !Array.isArray(row)
										? row
										: { result: row }) as IDataObject,
									pairedItem: { item: i },
								});
							}
						} else {
							out.push({
								json: (value && typeof value === 'object' && !Array.isArray(value)
									? value
									: { result: value }) as IDataObject,
								pairedItem: { item: i },
							});
						}
						continue;
					}
				} else if (resource === 'memory') {
					const operation = this.getNodeParameter('operation', i) as string;
					const namespace = String(this.getNodeParameter('namespace', i, '') ?? '').trim();
					const args: IDataObject = {};
					if (namespace) args.namespace = namespace;

					if (operation === 'remember') {
						const statement = String(this.getNodeParameter('statement', i, '') ?? '').trim();
						if (!statement) {
							throw new NodeOperationError(this.getNode(), 'Fact is empty', { itemIndex: i });
						}
						args.statement = statement;
						result = await callTool(this, REMEMBER, args, i, waitMs);
					} else {
						const question = String(
							this.getNodeParameter('memoryQuestion', i, '') ?? '',
						).trim();
						if (!question) {
							throw new NodeOperationError(this.getNode(), 'Question is empty', { itemIndex: i });
						}
						args.question = question;
						result = await callTool(this, RECALL, args, i, waitMs);
					}
				} else if (resource === 'skill') {
					const handle = String(this.getNodeParameter('skillHandle', i, '') ?? '').trim();
					if (!handle) {
						throw new NodeOperationError(this.getNode(), 'Skill is empty', { itemIndex: i });
					}
					const inputs = json(this.getNodeParameter('skillInputs', i, ''), 'Inputs');
					const args: IDataObject = { skill_handle: handle };
					if (inputs) args.args = inputs;
					result = await callTool(this, RUN_SKILL, args, i, waitMs);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown resource "${resource}"`, {
						itemIndex: i,
					});
				}

				const payload = toolPayload(result);
				const failure = payloadError(payload);
				if (failure) {
					throw new NodeOperationError(this.getNode(), `DataGrout: ${failure}`, { itemIndex: i });
				}

				out.push({
					json: full ? result : payload,
					pairedItem: { item: i },
				});
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
