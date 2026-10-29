import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { inspect } from 'node:util'
import {
	LiteraryUniverseApiError,
	LiteraryUniverseClient,
} from '../dist/esm/index.js'

test('creates a draft chapter with a stable caller-supplied operation ID', async () => {
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		fetch: async (_url, options) => {
			const { operationName, variables } = JSON.parse(options.body)
			assert.equal(operationName, 'LuCreateChapter')
			assert.equal(variables.input.operationId, 'create-once')
			assert.equal(variables.input.title, 'A new chapter')
			return Response.json({
				data: {
					result: { id: 'chapter', version: 'v1', sequence: 2, warnings: [] },
				},
			})
		},
	})
	const created = await client.createChapter({
		storyId: 'story',
		title: 'A new chapter',
		operationId: 'create-once',
	})
	assert.equal(created.id, 'chapter')
	assert.equal(created.version, 'v1')
})

test('publishes an exact draft version with a separate operation ID and scheduled time', async () => {
	const input = {
		id: 'chapter',
		expectedVersion: 'v1',
		operationId: 'publish-once',
		publishAt: '2027-01-01T12:00:00Z',
	}
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		fetch: async (_url, options) => {
			const request = JSON.parse(options.body)
			assert.equal(request.operationName, 'LuPublishChapter')
			assert.deepEqual(request.variables.input, input)
			return Response.json({
				data: {
					result: {
						id: 'chapter',
						revisionId: 'revision',
						version: 'v2',
						audience: 'READERS',
						publishedAt: input.publishAt,
					},
				},
			})
		},
	})
	const result = await client.publishChapter(input)
	assert.equal(result.revisionId, 'revision')
	assert.equal(result.version, 'v2')
})

test('saves a canonical draft with its version and idempotency key', async () => {
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		fetch: async (_url, options) => {
			const request = JSON.parse(options.body)
			assert.equal(request.operationName, 'LuSaveDraft')
			assert.equal(request.variables.input.expectedVersion, 'before')
			assert.equal(request.variables.input.operationId, 'once')
			return Response.json({
				data: {
					result: {
						draft: { id: 'chapter', version: 'after' },
						warnings: [],
						recoveryId: 'once',
					},
				},
			})
		},
	})
	const result = await client.saveDraft({
		id: 'chapter',
		expectedVersion: 'before',
		operationId: 'once',
		content: { type: 'doc', content: [{ type: 'paragraph' }] },
	})
	assert.equal(result.draft.version, 'after')
})

test('loads current credentials for each request without exposing them on the client', async () => {
	let token = 'lu_test_first'
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		credentials: () => ({ kind: 'api-key', token }),
		fetch: async (_url, options) => {
			assert.equal(options.headers.Authorization, `Bearer ${token}`)
			return Response.json({ data: { result: { version: '1' } } })
		},
	})
	await client.identity()
	token = 'lu_test_second'
	await client.identity()
	assert.ok(!inspect(client).includes(token))
})

test('retries the original immutable write input even when the caller changes its object', async () => {
	const input = {
		id: 'chapter',
		expectedVersion: 'v1',
		operationId: 'once',
		content: { type: 'doc', content: [] },
	}
	let calls = 0
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		maxRetries: 1,
		fetch: async (_url, options) => {
			if (!calls++) {
				input.content = { type: 'doc', content: [{ type: 'paragraph' }] }
				throw new Error('lost reply')
			}
			assert.deepEqual(JSON.parse(options.body).variables.input.content, {
				type: 'doc',
				content: [],
			})
			return Response.json({ data: { result: { version: 'v2' } } })
		},
	})
	await client.saveDraft(input)
})

test('the request deadline includes an asynchronous credential provider', async () => {
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		credentials: () => new Promise(() => {}),
		fetch: () => {
			throw new Error('Must not dispatch')
		},
	})
	await assert.rejects(
		client.identity({ timeoutMs: 10 }),
		(error) => error.code === 'TIMEOUT',
	)
})

test('reads identity through the existing GraphQL endpoint without cookies or redirects', async () => {
	const client = new LiteraryUniverseClient({
		baseUrl: 'http://localhost:4200',
		token: 'lu_test_fixture',
		fetch: async (url, options) => {
			assert.equal(String(url), 'http://localhost:4200/graphql')
			assert.equal(options.headers.Authorization, 'Bearer lu_test_fixture')
			assert.equal(options.credentials, 'omit')
			assert.equal(options.redirect, 'manual')
			assert.equal(JSON.parse(options.body).operationName, 'LuIdentity')
			return new Response(
				JSON.stringify({
					data: {
						result: {
							version: '1',
							kind: 'PERSONAL_API_KEY',
							userId: 'writer',
							scopes: ['story:read'],
						},
					},
				}),
				{
					headers: {
						'content-type': 'application/json',
						'x-request-id': 'request-123',
					},
				},
			)
		},
	})
	assert.equal((await client.identity()).userId, 'writer')
})

test('calls fetch without a receiver, as browser and Electron implementations require', async () => {
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		// Native fetch throws "Illegal invocation" when called as a method of another object.
		fetch: async function () {
			assert.equal(this, undefined)
			return new Response(
				JSON.stringify({ data: { result: { version: '1' } } }),
			)
		},
	})
	assert.equal((await client.identity()).version, '1')
})

test('rejects partial GraphQL data and preserves safe diagnostic codes and request IDs', async () => {
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		fetch: async () =>
			new Response(
				JSON.stringify({
					data: { result: { id: 'secret' } },
					errors: [
						{
							message: 'Denied',
							extensions: { code: 'FORBIDDEN', requestId: 'request-456' },
						},
					],
				}),
			),
	})
	await assert.rejects(
		client.story({ id: 'story' }),
		(error) =>
			error instanceof LiteraryUniverseApiError &&
			error.code === 'FORBIDDEN' &&
			error.requestId === 'request-456',
	)
})

test('does not retry denied reads and never exposes the configured token in errors', async () => {
	let requests = 0
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		maxRetries: 2,
		fetch: async () => {
			requests++
			return new Response(
				JSON.stringify({
					errors: [
						{
							message: 'Bearer lu_test_fixture was denied',
							extensions: { code: 'UNAUTHENTICATED' },
						},
					],
				}),
				{ status: 500 },
			)
		},
	})
	await assert.rejects(
		client.identity(),
		(error) =>
			error.code === 'UNAUTHENTICATED' &&
			!error.message.includes('lu_test_fixture'),
	)
	assert.equal(requests, 1)
})

test('retries read throttling a bounded number of times and respects long Retry-After values', async () => {
	let requests = 0
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		maxRetries: 1,
		fetch: async () => {
			requests++
			return requests === 1
				? new Response('Rate limit exceeded', {
						status: 429,
						headers: { 'retry-after': '0' },
					})
				: new Response(JSON.stringify({ data: { result: { version: '1' } } }))
		},
	})
	await client.identity()
	assert.equal(requests, 2)
	const throttled = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		maxRetries: 2,
		fetch: async () =>
			new Response('Rate limit exceeded', {
				status: 429,
				headers: { 'retry-after': '30', 'x-request-id': 'throttled' },
			}),
	})
	await assert.rejects(
		throttled.identity(),
		(error) =>
			error.code === 'RATE_LIMITED' &&
			error.retryAfterSeconds === 30 &&
			error.requestId === 'throttled',
	)
})

test('cancels an in-flight request and enforces the whole request timeout', async () => {
	const fetch = async (_url, options) =>
		new Promise((_resolve, reject) => {
			options.signal.addEventListener(
				'abort',
				() => reject(new Error('aborted')),
				{ once: true },
			)
		})
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		fetch,
		timeoutMs: 10,
	})
	await assert.rejects(client.identity(), (error) => error.code === 'TIMEOUT')
	const controller = new AbortController()
	const pending = client.identity({
		signal: controller.signal,
		timeoutMs: 1000,
	})
	controller.abort()
	await assert.rejects(pending, (error) => error.code === 'CANCELLED')
})

test('rejects a response larger than the documented read ceiling before returning data', async () => {
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		fetch: async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
	})
	await assert.rejects(
		client.identity(),
		(error) => error.code === 'PAYLOAD_TOO_LARGE',
	)
})

test('rejects credentials in URLs and HTTP deployments without an explicit opt-in', () => {
	assert.throws(
		() =>
			new LiteraryUniverseClient({
				baseUrl: 'https://user:password@example.test',
				token: 'lu_test_fixture',
			}),
		(error) => error.code === 'INVALID_CONFIGURATION',
	)
	assert.throws(
		() =>
			new LiteraryUniverseClient({
				baseUrl: 'http://example.test',
				token: 'lu_test_fixture',
			}),
		(error) => error.code === 'INVALID_CONFIGURATION',
	)
	assert.throws(
		() =>
			new LiteraryUniverseClient({
				baseUrl: 'https://example.test',
				token: 'lu_test_fixture\nextra',
			}),
		(error) => error.code === 'INVALID_CONFIGURATION',
	)
})

test('honors cancellation before dispatch and reports timeout while waiting to retry', async () => {
	let requests = 0
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		maxRetries: 1,
		timeoutMs: 10,
		fetch: async () => {
			requests++
			return new Response('Unavailable', { status: 503 })
		},
	})
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(
		client.identity({ signal: controller.signal }),
		(error) => error.code === 'CANCELLED',
	)
	assert.equal(requests, 0)
	await assert.rejects(client.identity(), (error) => error.code === 'TIMEOUT')
})

const ok = () =>
	new Response(JSON.stringify({ data: { result: { version: '1' } } }))

test('reports a redirect once, without following it or retrying', async () => {
	let requests = 0
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://www.example.test',
		token: 'lu_test_fixture',
		maxRetries: 2,
		fetch: async () => {
			requests++
			return new Response(null, {
				status: 301,
				headers: { location: 'https://example.test/graphql' },
			})
		},
	})
	await assert.rejects(
		client.identity(),
		(error) =>
			error.code === 'REDIRECTED' &&
			error.status === 301 &&
			error.message.includes('https://example.test/graphql'),
	)
	assert.equal(requests, 1)
})

test('keeps the mount prefix for every accepted base URL form', async () => {
	for (const baseUrl of [
		'https://example.test/api',
		'https://example.test/api/',
		'https://example.test/api//',
		'https://example.test/api?',
		'https://example.test/api#',
	]) {
		let requested
		const client = new LiteraryUniverseClient({
			baseUrl,
			token: 'lu_test_fixture',
			fetch: async (url) => {
				requested = String(url)
				return ok()
			},
		})
		await client.identity()
		assert.equal(requested, 'https://example.test/api/graphql', baseUrl)
	}
})

test('does not call an unrecognized HTTP failure a bad input', async () => {
	const status = (code) =>
		new LiteraryUniverseClient({
			baseUrl: 'https://example.test/wrong-prefix',
			token: 'lu_test_fixture',
			fetch: async () => new Response('', { status: code }),
		}).identity()
	await assert.rejects(
		status(404),
		(error) => error.code === 'INVALID_RESPONSE',
	)
	await assert.rejects(
		status(405),
		(error) => error.code === 'INVALID_RESPONSE',
	)
	await assert.rejects(status(400), (error) => error.code === 'BAD_USER_INPUT')
})

test('does not retry a rejection whose message is not a string', async () => {
	let requests = 0
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		maxRetries: 2,
		fetch: async () => {
			requests++
			return new Response(
				JSON.stringify({
					errors: [
						{ message: { text: 'Denied' }, extensions: { code: 'FORBIDDEN' } },
					],
				}),
			)
		},
	})
	await assert.rejects(client.identity(), (error) => error.code === 'FORBIDDEN')
	assert.equal(requests, 1)
})

test('reports cancellation even when the timeout elapses before fetch settles', async () => {
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		timeoutMs: 10,
		fetch: (_url, options) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener(
					'abort',
					() => setTimeout(() => reject(new Error('aborted')), 30),
					{ once: true },
				)
			}),
	})
	const controller = new AbortController()
	const pending = client.identity({ signal: controller.signal })
	controller.abort()
	await assert.rejects(pending, (error) => error.code === 'CANCELLED')
})

test('keeps the token out of logged or serialized clients and names invalid limits', () => {
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
	})
	assert.ok(!inspect(client, { depth: 5 }).includes('lu_test_fixture'))
	assert.ok(!JSON.stringify(client).includes('lu_test_fixture'))
	assert.throws(
		() =>
			new LiteraryUniverseClient({
				baseUrl: 'https://example.test',
				token: 'lu_test_fixture',
				maxRetries: 3,
			}),
		(error) =>
			error.code === 'INVALID_CONFIGURATION' && /retries/i.test(error.message),
	)
})

test('the CommonJS build loads and exposes the same client', () => {
	const sdk = createRequire(import.meta.url)('../dist/cjs/index.js')
	assert.equal(typeof sdk.LiteraryUniverseClient, 'function')
	assert.equal(typeof sdk.LiteraryUniverseApiError, 'function')
})

test('uploads immutable image bytes through the same credential, timeout and retry contract', async () => {
	const bytes = new Uint8Array([1, 2, 3])
	let attempts = 0
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test/lu',
		token: 'lu_test_fixture',
		maxRetries: 1,
		fetch: async (url, options) => {
			assert.equal(url.pathname, '/lu/api/author/images')
			assert.equal(url.searchParams.get('operationId'), 'asset-once')
			assert.equal(options.headers['Content-Type'], 'image/png')
			assert.equal(options.redirect, 'manual')
			assert.deepEqual([...options.body], [1, 2, 3])
			if (attempts++ === 0) {
				bytes.fill(9)
				throw new TypeError('lost reply')
			}
			return Response.json({
				data: {
					result: { fileId: 'asset', url: 'https://storage.test/asset' },
				},
			})
		},
	})
	const result = await client.uploadImage({
		bytes,
		purpose: 'chapter-image',
		targetId: 'chapter',
		operationId: 'asset-once',
		policyVersion: '1',
		type: 'image/png',
	})
	assert.equal(result.fileId, 'asset')
	assert.equal(attempts, 2)
})

test('redacts API-key-shaped client labels before requests and serialization', async () => {
	const token = 'lu_test_do_not_log'
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token,
		clientName: token,
		fetch: async (_url, options) => {
			assert.equal(options.headers['X-LU-Client'], 'redacted')
			return Response.json({ data: { result: { version: '1' } } })
		},
	})
	assert.ok(!JSON.stringify(client).includes(token))
	await client.identity()
})

test('updates a universe translation once, without retrying, and reports the current revision on a conflict', async () => {
	const bodies = []
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		maxRetries: 2,
		fetch: async (_url, init) => {
			bodies.push(JSON.parse(init.body))
			return new Response(
				JSON.stringify({
					errors: [
						{
							message: 'The translation changed meanwhile',
							extensions: { code: 'VERSION_CONFLICT', currentRevision: 7 },
						},
					],
				}),
			)
		},
	})
	const input = {
		universeId: 'universe',
		language: 'en',
		expectedRevision: 4,
		input: { title: 'The Tale of Genji' },
	}
	await assert.rejects(
		client.updateUniverseTranslation(input),
		(error) =>
			error instanceof LiteraryUniverseApiError &&
			error.code === 'VERSION_CONFLICT' &&
			error.currentRevision === 7,
	)
	assert.equal(bodies.length, 1)
	assert.equal(bodies[0].operationName, 'LuUpdateUniverseTranslation')
	assert.deepEqual(bodies[0].variables, input)

	const offline = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		maxRetries: 2,
		fetch: async () => {
			bodies.push('attempt')
			throw new TypeError('network down')
		},
	})
	bodies.length = 0
	await assert.rejects(
		offline.createUniverseTranslation({
			universeId: 'universe',
			language: 'en',
		}),
		(error) => error.code === 'NETWORK_ERROR',
	)
	assert.equal(bodies.length, 1)
})

test('sets a cover with PUT on the cover route and keeps cover purposes off the asset upload', async () => {
	const calls = []
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test/prefix/',
		token: 'lu_test_fixture',
		fetch: async (url, options) => {
			calls.push({ url: String(url), method: options.method })
			return String(url).includes('missing')
				? Response.json({ error: 'No story with this ID' }, { status: 404 })
				: Response.json({
						cover: { url: 'https://cdn.test/c.webp', handle: 'h', size: 3 },
					})
		},
	})
	const bytes = new Uint8Array([1, 2, 3])
	const cover = await client.setCover({
		kind: 'story',
		id: 'story',
		bytes,
		type: 'image/png',
	})
	assert.equal(cover.handle, 'h')
	assert.deepEqual(calls[0], {
		url: 'https://example.test/prefix/api/stories/story/cover',
		method: 'PUT',
	})
	await assert.rejects(
		client.setCover({
			kind: 'universe',
			id: 'missing',
			bytes,
			type: 'image/png',
		}),
		{ code: 'NOT_FOUND' },
	)
	assert.throws(
		() =>
			client.uploadImage({
				bytes,
				purpose: 'story-cover',
				targetId: 'story',
				operationId: 'op',
				policyVersion: '1',
				type: 'image/png',
			}),
		{ code: 'BAD_USER_INPUT' },
	)
	assert.equal(calls.length, 2)
})

test('sends each curation write as its named operation with the caller input', async () => {
	const sent = []
	const results = {
		LuUpdateStory: { id: 'story', license: 'cc-by-sa' },
		LuSetStoryVisibility: { id: 'story', privateAt: '2026-10-29T00:00:00Z' },
		LuRenameChapter: { id: 'chapter', title: 'Two' },
		LuReorderChapters: { storyId: 'story', chapterIds: ['b', 'a'] },
		LuUpdateUniverse: { id: 'universe', title: 'Myths' },
		LuUpdateEncyclopediaEntry: { id: 'entry', summary: 'A captain.' },
		LuTranslateEncyclopediaEntry: { id: 'entry', language: 'en' },
		LuSetEncyclopediaEntryPublication: { id: 'entry', wip: false },
		LuEncyclopediaEntries: { nodes: [], pageInfo: { hasNextPage: false } },
		LuSeries: [{ id: 'series', storyIds: ['a', 'b'] }],
	}
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		fetch: async (_url, init) => {
			const request = JSON.parse(init.body)
			sent.push(request)
			return Response.json({ data: { result: results[request.operationName] } })
		},
	})
	await client.updateStory({ storyId: 'story', input: { license: 'cc-by-sa' } })
	await client.setStoryVisibility({ storyId: 'story', visibility: 'PRIVATE' })
	await client.renameChapter({ id: 'chapter', title: 'Two' })
	await client.reorderChapters({ storyId: 'story', chapterIds: ['b', 'a'] })
	await client.updateUniverse({
		universeId: 'universe',
		input: { title: 'Myths' },
	})
	await client.updateEncyclopediaEntry({
		id: 'entry',
		changes: { summary: 'A captain.' },
	})
	await client.translateEncyclopediaEntry({ id: 'entry', language: 'en' })
	await client.setEncyclopediaEntryPublication({ id: 'entry', published: true })
	await client.encyclopediaEntries({ universeId: 'universe' })
	const series = await client.series({ universeId: 'universe' })
	assert.deepEqual(series, results.LuSeries)
	assert.deepEqual(
		sent.map((request) => request.operationName),
		Object.keys(results),
	)
	assert.deepEqual(sent[0].variables, {
		storyId: 'story',
		input: { license: 'cc-by-sa' },
	})
	assert.deepEqual(sent[2].variables, {
		input: { id: 'chapter', title: 'Two' },
	})
})

test('does not repeat removals, creations or series saves, and names the entry holding a taken name', async () => {
	let calls = 0
	const client = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		maxRetries: 2,
		fetch: async () => {
			calls++
			throw new TypeError('network down')
		},
	})
	for (const write of [
		() => client.removeChapter({ id: 'chapter' }),
		() => client.deleteEncyclopediaEntry({ id: 'entry' }),
		() =>
			client.createEncyclopediaEntry({
				universeId: 'universe',
				name: 'Nemo',
				categoryTitle: 'Characters',
			}),
		() =>
			client.saveSeries({
				universeId: 'universe',
				expectedVersion: 0,
				title: 'Voyages',
				storyIds: ['a'],
			}),
	]) {
		calls = 0
		await assert.rejects(write(), (error) => error.code === 'NETWORK_ERROR')
		assert.equal(calls, 1)
	}

	const conflicting = new LiteraryUniverseClient({
		baseUrl: 'https://example.test',
		token: 'lu_test_fixture',
		fetch: async () =>
			Response.json({
				errors: [
					{
						message: 'An entry with this name already exists',
						extensions: { code: 'CONFLICT', entryId: 'existing' },
					},
				],
			}),
	})
	await assert.rejects(
		conflicting.createEncyclopediaEntry({
			universeId: 'universe',
			name: 'Nemo',
			categoryTitle: 'Characters',
		}),
		(error) =>
			error instanceof LiteraryUniverseApiError &&
			error.code === 'CONFLICT' &&
			error.resourceId === 'existing',
	)
})
