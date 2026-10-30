import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import {
	type McpServer,
	ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
	CallToolResult,
	ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	LiteraryUniverseApiError,
	type LiteraryUniverseClient,
} from './index.js'
import type { JsonValue } from './json.js'

export type McpToolOptions = {
	/** The signed-in client, or null when the agent is not logged in. */
	client: () => LiteraryUniverseClient | null
	/** Categories and/or tool names to register; 'all' for every tool. Defaults to DEFAULT_TOOL_SELECTION. */
	tools?: readonly string[]
	docsBaseUrl?: string
	fetch?: typeof globalThis.fetch
	/** Enables set-cover from a local path; stdio servers only. */
	readLocalFile?: (path: string) => Promise<Uint8Array>
}

const NOT_SIGNED_IN =
	'Not signed in to Literary Universe. Run `lu login` (or set LU_TOKEN) and restart the agent.'
const DOCS = 'https://literaryuniverse.com'
type Json = Record<string, unknown>
type Infer<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>
type Spec<Shape extends z.ZodRawShape = z.ZodRawShape> = {
	title: string
	description: string
	input: Shape
	annotations: ToolAnnotations
	text?(result: Json): string
} & (
	| {
			docs?: false
			run(
				client: LiteraryUniverseClient,
				args: Infer<Shape>,
				options: McpToolOptions,
			): Promise<Json>
	  }
	| {
			docs: true
			run(options: McpToolOptions, args: Infer<Shape>): Promise<Json>
	  }
)
const tool = <Shape extends z.ZodRawShape>(spec: Spec<Shape>): Spec => spec

const hints = (
	readOnlyHint: boolean,
	destructiveHint: boolean,
	idempotentHint: boolean,
	openWorldHint = false,
): ToolAnnotations => ({
	readOnlyHint,
	destructiveHint,
	idempotentHint,
	openWorldHint,
})
const READ = hints(true, false, true)
const WRITE = hints(false, false, true)
const CREATE = hints(false, false, false)
const DESTROY = hints(false, true, false)
const WEB = hints(true, false, true, true)

const id = z.string().min(1)
const page = {
	first: z.number().int().min(1).max(100).optional().describe('Page size'),
	after: z.string().optional().describe('endCursor of the previous page'),
}
const language = z
	.string()
	.optional()
	.describe('Locale code such as en; the original language when omitted')
const json = z
	.record(z.string(), z.unknown())
	.describe(
		'Tiptap JSON document, as get-chapter-draft returns with format json',
	)
const operationId = z
	.string()
	.optional()
	.describe('Idempotency key; keep it for a retry, omit for a fresh one')
const textField = { title: z.string(), text: z.string() }
const timeField = {
	title: z.string(),
	value: z.string().describe('A date like 1402-03-01, or HH:MM'),
}
type Draft = Awaited<ReturnType<LiteraryUniverseClient['draft']>>
function draftView(draft: Draft, format: 'markdown' | 'json') {
	const { content, html, text, oldHtml, markdown, ...meta } = draft
	return format === 'json' ? { ...meta, content } : { ...meta, markdown }
}
const draftText = (result: Json) =>
	`Chapter ${result.sequence} "${result.title}" (${result.id}, ${result.language}, version ${result.version})\n\n${result.markdown ?? ''}`

const stories: Record<string, Spec> = {
	'list-stories': tool({
		title: 'List stories',
		description: 'A page of the stories this account can write.',
		input: page,
		annotations: READ,
		run: (client, args) => client.stories(args),
	}),
	'get-story': tool({
		title: 'Get story',
		description: 'A story with its description and notes.',
		input: { id },
		annotations: READ,
		run: (client, args) => client.story(args),
	}),
	'list-chapters': tool({
		title: 'List chapters',
		description:
			'A page of chapters of a story in reading order, drafts included.',
		input: { storyId: id, language, ...page },
		annotations: READ,
		run: (client, args) => client.chapters(args),
	}),
	'get-chapter-draft': tool({
		title: 'Get chapter draft',
		description:
			'The current draft of a chapter as Markdown (default) or Tiptap JSON, with the version a save must name.',
		input: {
			id,
			language,
			format: z.enum(['markdown', 'json']).default('markdown'),
		},
		annotations: READ,
		run: async (client, { format, ...args }) =>
			draftView(await client.draft(args), format),
		text: (result) =>
			'markdown' in result
				? draftText(result)
				: JSON.stringify(result, null, 2),
	}),
}

const saveShape = {
	language,
	markdown: z
		.string()
		.optional()
		.describe('The whole chapter body as Markdown'),
	content: json.optional(),
	operationId,
}
const storiesWrite: Record<string, Spec> = {
	'save-chapter-draft': tool({
		title: 'Save chapter draft',
		description:
			'Replace a chapter draft with markdown or content (exactly one). expectedVersion must be the version last read; a changed draft fails with VERSION_CONFLICT.',
		input: { chapterId: id, expectedVersion: z.string(), ...saveShape },
		annotations: WRITE,
		run: async (client, { chapterId, content, ...args }) => {
			const result = await client.saveDraft({
				...args,
				id: chapterId,
				operationId: args.operationId ?? randomUUID(),
				content: content as JsonValue,
			})
			const { version, recoveryId, warnings } = result
			return { version, recoveryId, warnings }
		},
	}),
	'create-chapter': tool({
		title: 'Create chapter',
		description: 'Append a draft chapter to a story; it is not published.',
		input: {
			storyId: id,
			title: z.string().optional(),
			isAIGenerated: z.boolean().optional(),
			...saveShape,
		},
		annotations: CREATE,
		run: (client, { content, language: _language, ...args }) =>
			client.createChapter({
				...args,
				operationId: args.operationId ?? randomUUID(),
				content: content as JsonValue,
			}),
	}),
	'update-story': tool({
		title: 'Update story',
		description: 'Change story details; only the given fields change.',
		input: {
			storyId: id,
			title: z.string().optional(),
			description: z.string().optional(),
			genres: z.array(z.string()).optional(),
			tags: z.array(z.string()).optional(),
			rating: z.string().optional(),
			license: z.string().optional(),
			language,
			universeId: z
				.string()
				.nullable()
				.optional()
				.describe('null makes the story standalone'),
		},
		annotations: WRITE,
		run: (client, { storyId, ...input }) =>
			client.updateStory({ storyId, input }),
	}),
	'set-story-visibility': tool({
		title: 'Set story visibility',
		description:
			'Hide a published story from readers (PRIVATE) or show it again (PUBLIC).',
		input: { storyId: id, visibility: z.enum(['PUBLIC', 'PRIVATE']) },
		annotations: WRITE,
		run: (client, args) => client.setStoryVisibility(args),
	}),
	'rename-chapter': tool({
		title: 'Rename chapter',
		description:
			'Rename a chapter; readers see the change at once when it is published.',
		input: { id, language, title: z.string().min(1) },
		annotations: WRITE,
		run: (client, args) => client.renameChapter(args),
	}),
	'reorder-chapters': tool({
		title: 'Reorder chapters',
		description:
			'Put every chapter of a story, each once, in a new reading order.',
		input: { storyId: id, chapterIds: z.array(z.string()).min(1) },
		annotations: WRITE,
		run: (client, args) => client.reorderChapters(args),
	}),
	'remove-chapter': tool({
		title: 'Remove chapter',
		description:
			'Delete a chapter that was never published and renumber the rest.',
		input: { id },
		annotations: DESTROY,
		run: (client, args) => client.removeChapter(args),
	}),
}

const publish: Record<string, Spec> = {
	'publish-chapter': tool({
		title: 'Publish chapter',
		description:
			'Publish the draft at expectedVersion to readers or beta readers, now or at publishAt. Without confirm: true nothing happens and the request is echoed back; ask the author first.',
		input: {
			id,
			language,
			expectedVersion: z.string(),
			publishAt: z
				.string()
				.optional()
				.describe('ISO 8601 with timezone; now when omitted'),
			audience: z.enum(['READERS', 'BETA']).default('READERS'),
			operationId,
			confirm: z.boolean().default(false),
		},
		annotations: hints(false, false, true, true),
		run: async (client, { confirm, ...input }) => {
			if (!confirm) return { published: false, wouldPublish: input }
			const result = await client.publishChapter({
				...input,
				operationId: input.operationId ?? randomUUID(),
			})
			return { published: true, ...result }
		},
		text: (result) =>
			result.published
				? JSON.stringify(result, null, 2)
				: `Nothing published. Call publish-chapter again with confirm: true to publish ${JSON.stringify(result.wouldPublish)}.`,
	}),
}

const universes: Record<string, Spec> = {
	'list-universes': tool({
		title: 'List universes',
		description: 'A page of the universes this account can write.',
		input: page,
		annotations: READ,
		run: (client, args) => client.universes(args),
	}),
	'get-universe': tool({
		title: 'Get universe',
		description: 'A universe with its description and translations.',
		input: { id },
		annotations: READ,
		run: (client, args) => client.universe(args),
	}),
	'list-encyclopedia-entries': tool({
		title: 'List encyclopedia entries',
		description: 'A page of a universe encyclopedia, drafts included.',
		input: { universeId: id, ...page },
		annotations: READ,
		run: (client, args) => client.encyclopediaEntries(args),
	}),
	'get-encyclopedia-entry': tool({
		title: 'Get encyclopedia entry',
		description:
			'An entry with its summary, fields, parent and related entries.',
		input: { id, language },
		annotations: READ,
		run: (client, args) => client.encyclopediaEntry(args),
	}),
	'list-series': tool({
		title: 'List series',
		description:
			'The series of a universe with their stories in reading order.',
		input: { universeId: id },
		annotations: READ,
		run: async (client, args) => ({ series: await client.series(args) }),
	}),
}

const translation = {
	title: z.string().optional(),
	description: z.string().optional(),
}
const universesWrite: Record<string, Spec> = {
	'update-universe': tool({
		title: 'Update universe',
		description: 'Change universe details; only the given fields change.',
		input: {
			universeId: id,
			...translation,
			slug: z.string().optional(),
			genre: z.string().optional(),
			rating: z.string().optional(),
			license: z.string().optional(),
			language,
		},
		annotations: WRITE,
		run: (client, { universeId, ...input }) =>
			client.updateUniverse({ universeId, input }),
	}),
	'create-universe-translation': tool({
		title: 'Create universe translation',
		description:
			'Open a language for a universe; an existing translation is returned unchanged.',
		input: { universeId: id, language: z.string(), ...translation },
		annotations: WRITE,
		run: (client, { universeId, language, ...input }) =>
			client.createUniverseTranslation({ universeId, language, input }),
	}),
	'update-universe-translation': tool({
		title: 'Update universe translation',
		description:
			'Change a translation at expectedRevision; a stale revision fails with VERSION_CONFLICT.',
		input: {
			universeId: id,
			language: z.string(),
			expectedRevision: z.number().int(),
			...translation,
		},
		annotations: WRITE,
		run: (client, { universeId, language, expectedRevision, ...input }) =>
			client.updateUniverseTranslation({
				universeId,
				language,
				expectedRevision,
				input,
			}),
	}),
	'create-encyclopedia-entry': tool({
		title: 'Create encyclopedia entry',
		description:
			'Add a draft entry in a category; a taken name fails with CONFLICT.',
		input: {
			universeId: id,
			name: z.string().min(1),
			categoryTitle: z.string().min(1),
			pronunciation: z.string().optional(),
			tags: z.array(z.string()).optional(),
			parentName: z.string().optional(),
			relatedAdd: z.array(z.string()).optional(),
			summary: z.string().optional(),
			fields: z.array(z.object(textField)).optional(),
			timeFields: z.array(z.object(timeField)).optional(),
		},
		annotations: CREATE,
		run: (client, args) => client.createEncyclopediaEntry(args),
	}),
	'update-encyclopedia-entry': tool({
		title: 'Update encyclopedia entry',
		description:
			'Change an entry in its original language; only the given values change.',
		input: {
			id,
			name: z.string().optional(),
			pronunciation: z.string().optional(),
			tags: z.array(z.string()).optional(),
			categoryTitle: z.string().optional(),
			parentName: z
				.string()
				.nullable()
				.optional()
				.describe('null removes the parent'),
			relatedAdd: z.array(z.string()).optional(),
			relatedRemove: z.array(z.string()).optional(),
			summary: z.string().optional(),
			fields: z.array(z.object(textField)).optional(),
			timeFields: z.array(z.object(timeField)).optional(),
		},
		annotations: WRITE,
		run: (client, { id, ...changes }) =>
			client.updateEncyclopediaEntry({ id, changes }),
	}),
	'translate-encyclopedia-entry': tool({
		title: 'Translate encyclopedia entry',
		description:
			'Write an entry edition in a language the universe is translated into.',
		input: {
			id,
			language: z.string(),
			name: z.string().optional(),
			pronunciation: z.string().optional(),
			summary: z.string().optional(),
			fields: z
				.array(
					z.object({ ...textField, translatedTitle: z.string().optional() }),
				)
				.optional(),
		},
		annotations: WRITE,
		run: (client, args) => client.translateEncyclopediaEntry(args),
	}),
	'set-encyclopedia-entry-publication': tool({
		title: 'Set encyclopedia entry publication',
		description: 'Publish an entry to readers, or take it back to a draft.',
		input: { id, published: z.boolean() },
		annotations: WRITE,
		run: (client, args) => client.setEncyclopediaEntryPublication(args),
	}),
	'delete-encyclopedia-entry': tool({
		title: 'Delete encyclopedia entry',
		description: 'Delete an entry and its links from other entries.',
		input: { id },
		annotations: DESTROY,
		run: (client, args) => client.deleteEncyclopediaEntry(args),
	}),
	'save-series': tool({
		title: 'Save series',
		description:
			'Create a series (no seriesId, expectedVersion 0) or replace one at expectedVersion.',
		input: {
			universeId: id,
			seriesId: z.string().optional(),
			expectedVersion: z.number().int(),
			title: z.string().min(1),
			storyIds: z.array(z.string()),
		},
		annotations: WRITE,
		run: (client, args) => client.saveSeries(args),
	}),
}

const imageTypes: Record<string, string> = {
	'.png': 'image/png',
	'.webp': 'image/webp',
}
const images: Record<string, Spec> = {
	'get-image-policy': tool({
		title: 'Get image policy',
		description: 'Size, type and aspect limits for every image purpose.',
		input: {},
		annotations: READ,
		run: (client) => client.imagePolicy(),
	}),
	'set-cover': tool({
		title: 'Set cover',
		description:
			'Replace a story or universe cover with a local image file under 5 MB; the server crops it.',
		input: {
			kind: z.enum(['story', 'universe']),
			id,
			path: z.string().describe('Local path of a JPEG, PNG or WebP file'),
		},
		annotations: WRITE,
		run: async (client, { path, ...args }, options) => {
			if (!options.readLocalFile)
				throw new Error('set-cover needs local file access')
			const bytes = await options.readLocalFile(path)
			const type = imageTypes[extname(path).toLowerCase()] ?? 'image/jpeg'
			return client.setCover({ ...args, bytes, type })
		},
	}),
}

const docsIndex = (base: string) => [
	{ title: 'Help centre (open in a browser)', url: `${base}/feedback/help` },
	{ title: 'A story for agents', url: `${base}/story/<slug>/llms.txt` },
	{ title: 'A universe for agents', url: `${base}/universe/<slug>/llms.txt` },
	{
		title: 'A published chapter for agents',
		url: `${base}/read/<slug>/<language>/llms.txt`,
	},
	{
		title: 'A universe encyclopedia for agents (author access)',
		url: `${base}/workshop/universe/<slug>/encyclopedia/llms.txt`,
	},
]
async function fetchDocs(options: McpToolOptions, url: string) {
	const base = new URL(options.docsBaseUrl ?? DOCS)
	const target = new URL(url, base)
	if (target.origin !== base.origin || !target.pathname.endsWith('/llms.txt'))
		throw new LiteraryUniverseApiError(
			'BAD_USER_INPUT',
			`Only ${base.origin} llms.txt pages can be fetched`,
		)
	const fetcher = options.fetch ?? globalThis.fetch
	const response = await fetcher(target, {
		signal: AbortSignal.timeout(30_000),
		redirect: 'manual',
	})
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel()
		throw new LiteraryUniverseApiError(
			'REDIRECTED',
			'Docs redirects are not followed',
		)
	}
	const reader =
		typeof response.body?.getReader === 'function'
			? response.body.getReader()
			: undefined
	// Nonstreaming fetch polyfills must buffer before the limit can be checked.
	if (!reader) {
		const bytes = new Uint8Array(await response.arrayBuffer())
		if (bytes.byteLength > 1_000_000)
			throw new LiteraryUniverseApiError(
				'PAYLOAD_TOO_LARGE',
				'Docs page exceeds the read size limit',
			)
		return {
			url: target.href,
			status: response.status,
			text: new TextDecoder().decode(bytes),
		}
	}
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.byteLength
			if (size > 1_000_000) {
				await reader.cancel()
				throw new LiteraryUniverseApiError(
					'PAYLOAD_TOO_LARGE',
					'Docs page exceeds the read size limit',
				)
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	const text = new TextDecoder().decode(Buffer.concat(chunks))
	return { url: target.href, status: response.status, text }
}
const docs: Record<string, Spec> = {
	'search-lu-docs': tool({
		title: 'Search Literary Universe docs',
		description:
			'Pages about Literary Universe and its works that an agent can read; replace the <placeholders>.',
		input: { query: z.string().optional() },
		annotations: WEB,
		docs: true,
		run: async (options, { query }) => {
			const index = docsIndex(options.docsBaseUrl ?? DOCS)
			const q = query?.toLowerCase() ?? ''
			const hits = index.filter((entry) =>
				`${entry.title} ${entry.url}`.toLowerCase().includes(q),
			)
			return { results: hits.length ? hits : index }
		},
	}),
	'fetch-lu-docs': tool({
		title: 'Fetch Literary Universe docs',
		description:
			'Read one llms.txt page of the Literary Universe site as text.',
		input: { url: z.string().describe('A URL from search-lu-docs') },
		annotations: WEB,
		docs: true,
		run: (options, { url }) => fetchDocs(options, url),
		text: (result) => String(result.text),
	}),
}

const account: Record<string, Spec> = {
	'get-identity': tool({
		title: 'Get identity',
		description: 'Who is signed in, with scopes, limits and the deployment.',
		input: {},
		annotations: READ,
		run: (client) => client.identity(),
	}),
}

const CATEGORIES = {
	account,
	stories,
	'stories-write': storiesWrite,
	publish,
	universes,
	'universes-write': universesWrite,
	images,
	docs,
}
const TOOLS: Record<string, Spec> = Object.assign(
	{},
	...Object.values(CATEGORIES),
)
export const TOOL_CATEGORIES: Record<string, readonly string[]> =
	Object.fromEntries(
		Object.entries(CATEGORIES).map(([name, tools]) => [
			name,
			Object.keys(tools),
		]),
	)
export const DEFAULT_TOOL_SELECTION: readonly string[] = [
	'account',
	'stories',
	'stories-write',
	'universes',
	'universes-write',
	'images',
	'docs',
]

/** Expands categories and tool names into tool names; throws on an unknown entry. */
export function selectTools(
	selection: readonly string[] | undefined,
): string[] {
	const names = (selection ?? DEFAULT_TOOL_SELECTION).flatMap((entry) => {
		if (entry === 'all') return Object.keys(TOOLS)
		if (Object.hasOwn(TOOL_CATEGORIES, entry)) return TOOL_CATEGORIES[entry]
		if (Object.hasOwn(TOOLS, entry)) return [entry]
		throw new LiteraryUniverseApiError(
			'INVALID_CONFIGURATION',
			`Unknown tool or category: ${entry}`,
		)
	})
	return [...new Set(names)]
}

const failed = (text: string): CallToolResult => ({
	isError: true,
	content: [{ type: 'text', text }],
})
function describe(error: LiteraryUniverseApiError, spec: Spec) {
	const request = error.requestId ? ` (request ${error.requestId})` : ''
	const schema =
		error.code === 'BAD_USER_INPUT'
			? `\nInput schema: ${JSON.stringify(z.toJSONSchema(z.object(spec.input)))}`
			: ''
	return `${error.code}: ${error.message}${request}${schema}`
}
function run(spec: Spec, args: Json, options: McpToolOptions) {
	if (spec.docs) return spec.run(options, args)
	const client = options.client()
	if (!client)
		throw new LiteraryUniverseApiError('UNAUTHENTICATED', NOT_SIGNED_IN)
	return spec.run(client, args, options)
}
const handler =
	(spec: Spec, options: McpToolOptions) =>
	async (args: Json): Promise<CallToolResult> => {
		try {
			const result = await run(spec, args, options)
			const text = spec.text?.(result) ?? JSON.stringify(result, null, 2)
			return { content: [{ type: 'text', text }], structuredContent: result }
		} catch (error) {
			if (!(error instanceof LiteraryUniverseApiError)) throw error
			return failed(
				error.message === NOT_SIGNED_IN ? NOT_SIGNED_IN : describe(error, spec),
			)
		}
	}

function signedIn(options: McpToolOptions) {
	const client = options.client()
	if (!client) throw new Error(NOT_SIGNED_IN)
	return client
}
function registerResources(server: McpServer, options: McpToolOptions) {
	server.registerResource(
		'story',
		new ResourceTemplate('lu://story/{id}', { list: undefined }),
		{
			title: 'Story',
			description: 'A story as get-story returns it',
			mimeType: 'application/json',
		},
		async (uri, { id }) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: 'application/json',
					text: JSON.stringify(
						await signedIn(options).story({ id: String(id) }),
					),
				},
			],
		}),
	)
	server.registerResource(
		'chapter-draft',
		new ResourceTemplate('lu://chapter/{id}/draft', { list: undefined }),
		{
			title: 'Chapter draft',
			description: 'A chapter draft as Markdown',
			mimeType: 'text/markdown',
		},
		async (uri, { id }) => {
			const draft = await signedIn(options).draft({ id: String(id) })
			const text = draftText(draftView(draft, 'markdown'))
			return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] }
		},
	)
}

/** Registers the selected tools and the story/draft resources on an MCP server. */
export function registerLiteraryUniverseTools(
	server: McpServer,
	options: McpToolOptions,
): { registered: string[] } {
	const registered = selectTools(options.tools).filter(
		(name) => name !== 'set-cover' || options.readLocalFile,
	)
	for (const name of registered) {
		const spec = TOOLS[name]
		server.registerTool(
			name,
			{
				title: spec.title,
				description: spec.description,
				inputSchema: spec.input,
				annotations: spec.annotations,
			},
			handler(spec, options),
		)
	}
	registerResources(server, options)
	return { registered }
}
