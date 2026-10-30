import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { LiteraryUniverseClient } from '../dist/esm/index.js'
import {
	DEFAULT_TOOL_SELECTION,
	registerLiteraryUniverseTools,
	selectTools,
	TOOL_CATEGORIES,
} from '../dist/esm/mcp.js'

const NOT_SIGNED_IN =
	'Not signed in to Literary Universe. Run `lu login` (or set LU_TOKEN) and restart the agent.'
const draft = {
	id: 'chapter',
	storyId: 'story',
	sequence: 3,
	title: 'Three',
	language: 'en',
	version: 'v1',
	content: { type: 'doc', content: [] },
	html: '<p>Hi</p>',
	text: 'Hi',
	markdown: 'Hi *there*',
}
const results = {
	LuIdentity: { version: '1', kind: 'PERSONAL_API_KEY', userId: 'writer' },
	LuStory: { id: 'story', title: 'A story' },
	LuDraft: draft,
	LuSaveDraft: { version: 'v2', recoveryId: 'r', warnings: [], draft },
	LuPublishChapter: { id: 'chapter', version: 'v2', audience: 'READERS' },
}

/** An MCP client talking to a server with the SDK tools over a fake deployment. */
async function connect(options = {}, respond) {
	const sent = []
	const lu = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		fetch: async (url, init) => {
			const request =
				init.body instanceof Uint8Array
					? { url: String(url), method: init.method }
					: JSON.parse(init.body)
			sent.push(request)
			if (respond) return respond(request)
			return Response.json({ data: { result: results[request.operationName] } })
		},
	})
	const server = new McpServer({ name: 'test', version: '0' })
	const { registered } = registerLiteraryUniverseTools(server, {
		client: () => lu,
		...options,
	})
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
	await server.connect(serverSide)
	const client = new Client({ name: 'agent', version: '0' })
	await client.connect(clientSide)
	const call = (name, args = {}) => client.callTool({ name, arguments: args })
	return { client, call, sent, registered }
}

test('selectTools expands categories and names, dedupes, and rejects unknown entries', () => {
	const defaults = selectTools(undefined)
	assert.ok(defaults.includes('get-identity'))
	assert.ok(defaults.includes('save-chapter-draft'))
	assert.ok(!defaults.includes('publish-chapter'))
	assert.deepEqual(selectTools(DEFAULT_TOOL_SELECTION), defaults)
	assert.deepEqual(selectTools(['publish']), ['publish-chapter'])
	assert.deepEqual(selectTools(['get-story', 'stories']), [
		'get-story',
		'list-stories',
		'list-chapters',
		'get-chapter-draft',
	])
	const all = selectTools(['all'])
	assert.equal(all.length, Object.values(TOOL_CATEGORIES).flat().length)
	assert.equal(all.length, 31)
	assert.throws(() => selectTools(['nope']), {
		code: 'INVALID_CONFIGURATION',
		message: 'Unknown tool or category: nope',
	})
	assert.deepEqual(TOOL_CATEGORIES.docs, ['search-lu-docs', 'fetch-lu-docs'])
})

test('every registered tool carries a title and all four annotation hints', async () => {
	const { client, registered } = await connect({
		tools: ['all'],
		readLocalFile: async () => new Uint8Array([1]),
	})
	const { tools } = await client.listTools()
	assert.equal(tools.length, 31)
	assert.deepEqual(
		tools.map((tool) => tool.name).sort(),
		[...registered].sort(),
	)
	for (const tool of tools) {
		assert.ok(tool.title, tool.name)
		assert.ok(tool.description, tool.name)
		assert.ok(tool.inputSchema, tool.name)
		for (const hint of [
			'readOnlyHint',
			'destructiveHint',
			'idempotentHint',
			'openWorldHint',
		])
			assert.equal(
				typeof tool.annotations?.[hint],
				'boolean',
				`${tool.name} ${hint}`,
			)
	}
	const remove = tools.find((tool) => tool.name === 'remove-chapter')
	assert.equal(remove.annotations.destructiveHint, true)
	const read = tools.find((tool) => tool.name === 'get-story')
	assert.equal(read.annotations.readOnlyHint, true)
	const { resourceTemplates } = await client.listResourceTemplates()
	assert.deepEqual(
		resourceTemplates.map((template) => template.uriTemplate),
		['lu://story/{id}', 'lu://chapter/{id}/draft'],
	)
})

test('tools needing login answer with the sign-in message; docs tools work without', async () => {
	const { call, sent } = await connect({ client: () => null, tools: ['all'] })
	const identity = await call('get-identity')
	assert.equal(identity.isError, true)
	assert.equal(identity.content[0].text, NOT_SIGNED_IN)
	assert.equal(sent.length, 0)
	const docs = await call('search-lu-docs', { query: 'universe' })
	assert.equal(docs.isError, undefined)
	assert.ok(
		docs.structuredContent.results.every((entry) =>
			entry.url.startsWith('https://literaryuniverse.com/'),
		),
	)
	assert.ok(
		docs.structuredContent.results.some((entry) =>
			entry.url.includes('/universe/'),
		),
	)
})

test('publish-chapter without confirm echoes the request and sends nothing', async () => {
	const { call, sent } = await connect({ tools: ['publish'] })
	const dry = await call('publish-chapter', {
		id: 'chapter',
		expectedVersion: 'v1',
	})
	assert.equal(sent.length, 0)
	assert.equal(dry.isError, undefined)
	assert.equal(dry.structuredContent.published, false)
	assert.equal(dry.structuredContent.wouldPublish.audience, 'READERS')
	assert.match(dry.content[0].text, /confirm: true/)
	const real = await call('publish-chapter', {
		id: 'chapter',
		expectedVersion: 'v1',
		confirm: true,
		operationId: 'once',
	})
	assert.equal(sent.length, 1)
	assert.equal(sent[0].operationName, 'LuPublishChapter')
	assert.equal(sent[0].variables.input.operationId, 'once')
	assert.equal(real.structuredContent.published, true)
	assert.equal(real.structuredContent.version, 'v2')
})

test('save-chapter-draft with markdown maps to the saveDraft mutation with a fresh operation ID', async () => {
	const { call, sent } = await connect()
	const saved = await call('save-chapter-draft', {
		chapterId: 'chapter',
		expectedVersion: 'v1',
		markdown: '# One\n\nText.',
	})
	assert.equal(sent[0].operationName, 'LuSaveDraft')
	const { input } = sent[0].variables
	assert.equal(input.id, 'chapter')
	assert.equal(input.expectedVersion, 'v1')
	assert.equal(input.markdown, '# One\n\nText.')
	assert.equal('content' in input, false)
	assert.match(input.operationId, /^[0-9a-f-]{36}$/)
	assert.deepEqual(saved.structuredContent, {
		version: 'v2',
		recoveryId: 'r',
		warnings: [],
	})
	assert.equal(JSON.parse(saved.content[0].text).version, 'v2')
})

test('get-chapter-draft returns Markdown text by default and JSON content on request', async () => {
	const { call } = await connect()
	const markdown = await call('get-chapter-draft', { id: 'chapter' })
	assert.equal(markdown.structuredContent.markdown, 'Hi *there*')
	assert.equal('content' in markdown.structuredContent, false)
	assert.equal(
		markdown.content[0].text,
		'Chapter 3 "Three" (chapter, en, version v1)\n\nHi *there*',
	)
	const json = await call('get-chapter-draft', {
		id: 'chapter',
		format: 'json',
	})
	assert.deepEqual(json.structuredContent.content, { type: 'doc', content: [] })
	assert.equal('markdown' in json.structuredContent, false)
})

test('set-cover is registered only with local file access and reads the given path', async () => {
	const without = await connect({ tools: ['images'] })
	assert.deepEqual(without.registered, ['get-image-policy'])
	const read = []
	const { call, sent, registered } = await connect(
		{
			tools: ['images'],
			readLocalFile: async (path) => {
				read.push(path)
				return new Uint8Array([1, 2, 3])
			},
		},
		() =>
			Response.json({
				cover: { url: 'https://cdn.test/c.webp', handle: 'h', size: 3 },
			}),
	)
	assert.deepEqual(registered, ['get-image-policy', 'set-cover'])
	const result = await call('set-cover', {
		kind: 'story',
		id: 'story',
		path: '/tmp/cover.png',
	})
	assert.deepEqual(read, ['/tmp/cover.png'])
	assert.deepEqual(sent, [
		{ url: 'https://example.test/api/stories/story/cover', method: 'PUT' },
	])
	assert.equal(result.structuredContent.handle, 'h')
})

test('API errors become isError text; BAD_USER_INPUT includes the input schema', async () => {
	const { call } = await connect({ tools: ['stories'] }, () =>
		Response.json({
			errors: [
				{
					message: 'Unknown story',
					extensions: { code: 'BAD_USER_INPUT', requestId: 'req-1' },
				},
			],
		}),
	)
	const result = await call('get-story', { id: 'missing' })
	assert.equal(result.isError, true)
	const [text, schema] = result.content[0].text.split('\nInput schema: ')
	assert.equal(text, 'BAD_USER_INPUT: Unknown story (request req-1)')
	assert.deepEqual(JSON.parse(schema).required, ['id'])
})

test('resources read a story and a draft, and refuse without login', async () => {
	const { client } = await connect()
	const story = await client.readResource({ uri: 'lu://story/story' })
	assert.equal(story.contents[0].mimeType, 'application/json')
	assert.equal(JSON.parse(story.contents[0].text).title, 'A story')
	const chapter = await client.readResource({
		uri: 'lu://chapter/chapter/draft',
	})
	assert.equal(chapter.contents[0].mimeType, 'text/markdown')
	assert.match(chapter.contents[0].text, /Hi \*there\*$/)
	const anonymous = await connect({ client: () => null })
	await assert.rejects(
		anonymous.client.readResource({ uri: 'lu://story/story' }),
		(error) => error.message.includes(NOT_SIGNED_IN),
	)
})

test('fetch-lu-docs reads only llms.txt pages of the docs origin', async () => {
	const fetched = []
	const { call } = await connect({
		tools: ['docs'],
		docsBaseUrl: 'https://docs.test',
		fetch: async (url) => {
			fetched.push(String(url))
			return new Response('# Story\n\nBody', { status: 200 })
		},
	})
	const page = await call('fetch-lu-docs', {
		url: 'https://docs.test/story/slug/llms.txt',
	})
	assert.deepEqual(fetched, ['https://docs.test/story/slug/llms.txt'])
	assert.equal(page.content[0].text, '# Story\n\nBody')
	assert.equal(page.structuredContent.status, 200)
	const other = await call('fetch-lu-docs', {
		url: 'https://elsewhere.test/story/slug/llms.txt',
	})
	assert.equal(other.isError, true)
	assert.match(
		other.content[0].text,
		/^BAD_USER_INPUT: Only https:\/\/docs.test llms.txt/,
	)
	assert.equal(fetched.length, 1)
	const html = await call('fetch-lu-docs', {
		url: 'https://docs.test/feedback/help',
	})
	assert.equal(html.isError, true)
})

test('the CommonJS build exposes the same MCP entry', () => {
	const mcp = createRequire(import.meta.url)('../dist/cjs/mcp.js')
	assert.equal(typeof mcp.registerLiteraryUniverseTools, 'function')
	assert.deepEqual(mcp.selectTools(['publish']), ['publish-chapter'])
})

test('inherited object names are rejected as tool selections', () => {
	for (const name of [
		'toString',
		'constructor',
		'__proto__',
		'hasOwnProperty',
	]) {
		assert.throws(() => selectTools([name]), { code: 'INVALID_CONFIGURATION' })
	}
})

test('docs fetch refuses redirects and cancels oversized streams', async () => {
	let cancelled = false
	let reads = 0
	const { call } = await connect({
		tools: ['docs'],
		docsBaseUrl: 'https://docs.test',
		fetch: async (url, init) => {
			assert.equal(init.redirect, 'manual')
			if (String(url).includes('/redirect/')) {
				return new Response(null, {
					status: 302,
					headers: { location: 'http://127.0.0.1/private' },
				})
			}
			return new Response(
				new ReadableStream({
					pull(controller) {
						reads++
						controller.enqueue(new Uint8Array(600_000))
					},
					cancel() {
						cancelled = true
					},
				}),
			)
		},
	})
	assert.match(
		(await call('fetch-lu-docs', { url: '/redirect/llms.txt' })).content[0]
			.text,
		/^REDIRECTED:/,
	)
	assert.match(
		(await call('fetch-lu-docs', { url: '/large/llms.txt' })).content[0].text,
		/^PAYLOAD_TOO_LARGE:/,
	)
	assert.ok(cancelled)
	assert.ok(reads <= 3)
})

test('docs fetch supports a Response polyfill without a body stream', async () => {
	const { call } = await connect({
		tools: ['docs'],
		docsBaseUrl: 'https://docs.test',
		fetch: async () => ({
			status: 200,
			arrayBuffer: async () =>
				new TextEncoder().encode('Polyfilled docs').buffer,
		}),
	})
	const result = await call('fetch-lu-docs', { url: '/story/llms.txt' })
	assert.equal(result.content[0].text, 'Polyfilled docs')
})
