import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { beforeEach, test } from 'node:test'
import {
	entryBody,
	parseEntryBody,
	readVaultConfig,
	splitNote,
	syncVault,
	vaultStatus,
	writeVaultConfig,
} from '../dist/esm/vault.js'

// YAML is a superset of JSON: one `key: <json>` line per value is enough here.
const yaml = {
	stringify: (value) =>
		Object.entries(value)
			.map(([key, item]) => `${key}: ${JSON.stringify(item)}`)
			.join('\n'),
	parse: (text) =>
		Object.fromEntries(
			text
				.split('\n')
				.filter(Boolean)
				.map((line) => {
					const at = line.indexOf(': ')
					return [line.slice(0, at), JSON.parse(line.slice(at + 2))]
				}),
		),
}

function memoryFiles(initial = {}) {
	const store = new Map(Object.entries(initial))
	return {
		store,
		list: async () => [...store.keys()].filter((path) => path.endsWith('.md')),
		read: async (path) => store.get(path),
		write: async (path, text) => void store.set(path, text),
		rename: async (from, to) => {
			store.set(to, store.get(from))
			store.delete(from)
		},
		exists: async (path) => store.has(path),
	}
}

/** Just enough of Literary Universe for the engine, with every call recorded. */
function fakeServer() {
	const calls = []
	const page = (nodes) => ({
		nodes,
		pageInfo: { endCursor: null, hasNextPage: false },
	})
	const state = {
		universe: {
			id: 'u1',
			title: 'Struggle',
			language: 'en',
			description: 'A galaxy.',
			genre: 'scifi',
			rating: 'teen',
			license: 'cc-by',
			aiModel: null,
			version: 'uv1',
			translations: [],
		},
		story: {
			id: 's1',
			universeId: 'u1',
			title: 'Balance',
			language: 'en',
			description: 'War.',
			genres: ['scifi'],
			tags: [],
			rating: 'teen',
			license: 'cc-by',
			aiModel: null,
			version: 'sv1',
			translations: ['cs'],
		},
		chapters: [
			{
				id: 'c1',
				sequence: 0,
				title: 'One',
				markdown: 'First.',
				version: 'v1',
				updatedAt: 't1',
			},
			{
				id: 'c2',
				sequence: 1,
				title: 'Two',
				markdown: 'Second.',
				version: 'v1',
				updatedAt: 't1',
			},
		],
		translations: {
			c1: {
				title: 'Jedna',
				markdown: 'První.',
				version: 'cv1',
				updatedAt: 't1',
			},
		},
		entry: {
			id: 'e1',
			universeId: 'u1',
			name: 'Nemo',
			categoryTitle: 'Characters',
			language: 'en',
			pronunciation: null,
			tags: ['captain'],
			summary: 'A captain.',
			parent: null,
			related: [{ id: 'e2', name: 'Nautilus' }],
			fields: [
				{
					id: 'f1',
					title: 'Biography',
					type: 'textarea',
					private: false,
					text: 'Born a prince.',
				},
				{ id: 'f2', title: 'Map', type: 'image', private: false, text: null },
			],
			aiModel: null,
			version: 'ev1',
			released: [
				{
					language: 'en',
					audience: 'READERS',
					revision: 1,
					version: 'ev1',
					publishedAt: 'x',
				},
			],
		},
	}
	const chapterHeader = (chapter, language) => ({
		id: chapter.id,
		storyId: 's1',
		sequence: chapter.sequence,
		title:
			language === 'en' ? chapter.title : state.translations[chapter.id]?.title,
		language,
		hasDraft: language === 'en' || Boolean(state.translations[chapter.id]),
		updatedAt:
			language === 'en'
				? chapter.updatedAt
				: state.translations[chapter.id]?.updatedAt,
		publishedAt: null,
	})
	const record = (name, input) => calls.push([name, input])
	const client = {
		universe: async () => state.universe,
		stories: async () =>
			page([
				{ id: 's1', title: state.story.title, universeId: 'u1' },
				{ id: 'other', title: 'Elsewhere', universeId: null },
			]),
		story: async ({ id }) => (id === 's1' ? state.story : null),
		chapters: async ({ language }) =>
			page(
				// Paged by ID, as the API does, not in reading order.
				[...state.chapters]
					.sort((a, b) => b.id.localeCompare(a.id))
					.map((chapter) => chapterHeader(chapter, language))
					.filter((chapter) => chapter.hasDraft),
			),
		draft: async ({ id, language }) => {
			const chapter = state.chapters.find((item) => item.id === id)
			const edition = language === 'en' ? chapter : state.translations[id]
			return {
				id,
				storyId: 's1',
				sequence: chapter.sequence,
				language,
				...edition,
			}
		},
		saveDraft: async (input) => {
			record('saveDraft', input)
			const chapter = state.chapters.find((item) => item.id === input.id)
			if (chapter.version !== input.expectedVersion)
				throw Object.assign(new Error('stale'), { code: 'VERSION_CONFLICT' })
			chapter.markdown = input.markdown
			chapter.version = `${chapter.version}+`
			chapter.updatedAt = `${chapter.updatedAt}+`
			return {
				version: chapter.version,
				draft: { updatedAt: chapter.updatedAt },
			}
		},
		renameChapter: async (input) => {
			record('renameChapter', input)
			state.chapters.find((item) => item.id === input.id).title = input.title
		},
		reorderChapters: async (input) => {
			record('reorderChapters', input)
			input.chapterIds.forEach((id, index) => {
				state.chapters.find((item) => item.id === id).sequence = index
			})
		},
		createChapter: async (input) => {
			record('createChapter', input)
			const chapter = {
				id: 'c3',
				sequence: state.chapters.length,
				title: input.title,
				markdown: input.markdown,
				version: 'v1',
				updatedAt: 't1',
			}
			state.chapters.push(chapter)
			return {
				id: 'c3',
				storyId: 's1',
				language: 'en',
				sequence: chapter.sequence,
				title: chapter.title,
				version: 'v1',
			}
		},
		updateStory: async (input) => record('updateStory', input),
		updateUniverse: async (input) => record('updateUniverse', input),
		encyclopediaEntries: async () =>
			page([
				{
					...state.entry,
					editions: [{ language: 'en', version: state.entry.version }],
				},
			]),
		encyclopediaEntry: async () => state.entry,
		updateEncyclopediaEntry: async (input) => {
			record('updateEncyclopediaEntry', input)
			state.entry.version = 'ev2'
			return state.entry
		},
		createEncyclopediaEntry: async (input) => {
			record('createEncyclopediaEntry', input)
			return {
				...state.entry,
				id: 'e9',
				name: input.name,
				version: 'n1',
				related: [],
				tags: [],
				summary: input.summary,
				fields: [],
			}
		},
		series: async () => [
			{ id: 'r1', title: 'Reading order', storyIds: ['s1'] },
		],
		comics: async () =>
			page([
				{
					id: 'k1',
					title: 'Skyward',
					universeId: 'u1',
					format: 'webtoon',
					genres: [],
					chaptersCount: 1,
					pageCountTotal: 3,
					description: 'Up.',
					aiModel: null,
				},
			]),
	}
	return { client, state, calls }
}

let server
let files
const sync = (extra = {}) =>
	syncVault({
		client: server.client,
		files,
		yaml,
		scope: { kind: 'universe', universeId: 'u1' },
		...extra,
	})
const note = (path) => splitNote(files.store.get(path), yaml)
const edit = (path, change) => {
	const { meta, body } = note(path)
	const next = change({ meta, body }) ?? { meta, body }
	files.store.set(
		path,
		`---\n${yaml.stringify(next.meta)}\n---\n\n${next.body}\n`,
	)
}

beforeEach(() => {
	server = fakeServer()
	files = memoryFiles({ 'Notes/plan.md': '# My own notes' })
})

test('pulls a universe as notes and changes nothing on a second sync', async () => {
	const first = await sync()
	assert.deepEqual(first.failures, [])
	assert.deepEqual([...files.store.keys()].sort(), [
		'Comics/Skyward.md',
		'Encyclopedia/Characters/Nemo.md',
		'Notes/plan.md',
		'Series.md',
		'Stories/Balance/01 Jedna.cs.md',
		'Stories/Balance/01 One.md',
		'Stories/Balance/02 Two.md',
		'Stories/Balance/Story.md',
		'Universe.md',
	])
	const chapter = note('Stories/Balance/01 One.md')
	assert.equal(chapter.body, 'First.')
	assert.equal(chapter.meta.title, 'One')
	assert.equal(chapter.meta.sequence, 1)
	assert.equal(note('Stories/Balance/01 Jedna.cs.md').meta.sequence, undefined)
	const entry = note('Encyclopedia/Characters/Nemo.md')
	assert.equal(entry.body, 'A captain.\n\n## Biography\n\nBorn a prince.')
	assert.deepEqual(entry.meta.related, ['[[Nautilus]]'])
	assert.deepEqual(entry.meta.lu_released, { readers: 1 })
	assert.match(files.store.get('Series.md'), /1\. \[\[Balance\]\]/)
	assert.equal(files.store.get('Notes/plan.md'), '# My own notes')

	const second = await sync()
	assert.deepEqual(
		[second.created, second.updated, second.pushed, second.conflicts],
		[[], [], [], []],
	)
	assert.deepEqual(server.calls, [])
})

test('pushes an edited chapter with its version and AI disclosure', async () => {
	await sync()
	edit('Stories/Balance/02 Two.md', ({ meta, body }) => ({
		meta: { ...meta, ai_model: 'claude-opus-5-5' },
		body: `${body}\n\nMore.`,
	}))
	const report = await sync()
	assert.deepEqual(report.pushed, ['Stories/Balance/02 Two.md'])
	const [[name, input]] = server.calls
	assert.equal(name, 'saveDraft')
	assert.deepEqual(
		{
			id: input.id,
			expectedVersion: input.expectedVersion,
			markdown: input.markdown,
			aiModel: input.aiModel,
		},
		{
			id: 'c2',
			expectedVersion: 'v1',
			markdown: 'Second.\n\nMore.',
			aiModel: 'claude-opus-5-5',
		},
	)
	server.calls.length = 0
	assert.deepEqual((await sync()).pushed, [])
	assert.deepEqual(server.calls, [])
})

test('keeps both sides when a chapter changed here and on Literary Universe', async () => {
	await sync()
	edit('Stories/Balance/01 One.md', ({ meta }) => ({ meta, body: 'Mine.' }))
	Object.assign(server.state.chapters[0], {
		markdown: 'Theirs.',
		version: 'v2',
		updatedAt: 't2',
	})
	const report = await sync()
	assert.equal(report.conflicts.length, 1)
	assert.equal(note('Stories/Balance/01 One.md').body, 'Mine.')
	assert.equal(
		note('Stories/Balance/01 One (Literary Universe).md').body,
		'Theirs.',
	)
	assert.deepEqual(server.calls, [])
	// Held back while the copy exists, then pushed on the server's version.
	files.store.delete('Stories/Balance/01 One (Literary Universe).md')
	await sync()
	assert.equal(server.calls[0][1].expectedVersion, 'v2')
	assert.equal(server.state.chapters[0].markdown, 'Mine.')
})

test('takes a change made only on Literary Universe and brings back a deleted note', async () => {
	await sync()
	Object.assign(server.state.chapters[1], {
		markdown: 'Rewritten.',
		version: 'v2',
		updatedAt: 't2',
	})
	files.store.delete('Stories/Balance/01 One.md')
	const report = await sync()
	assert.deepEqual(report.updated, ['Stories/Balance/02 Two.md'])
	assert.deepEqual(report.created, ['Stories/Balance/01 One.md'])
	assert.equal(note('Stories/Balance/02 Two.md').body, 'Rewritten.')
	assert.deepEqual(server.calls, [])
})

test('renames and reorders chapters from their frontmatter', async () => {
	await sync()
	edit('Stories/Balance/02 Two.md', ({ meta, body }) => ({
		meta: { ...meta, title: 'Prologue', sequence: 1 },
		body,
	}))
	await sync()
	assert.deepEqual(
		server.calls.map(([name]) => name),
		['renameChapter', 'reorderChapters'],
	)
	assert.deepEqual(server.calls[1][1].chapterIds, ['c2', 'c1'])
	assert.ok(files.store.has('Stories/Balance/01 Prologue.md'))
	assert.equal(note('Stories/Balance/01 Prologue.md').meta.sequence, 1)
	server.calls.length = 0
	await sync()
	assert.deepEqual(server.calls, [])
})

test('creates a chapter from a note that asks for it', async () => {
	await sync()
	files.store.set(
		'Stories/Balance/Draft.md',
		`---\n${yaml.stringify({ lu_kind: 'chapter', title: 'Three', ai_model: 'claude-opus-5-5' })}\n---\n\nThird.\n`,
	)
	const report = await sync()
	assert.deepEqual(report.failures, [])
	const [name, input] = server.calls[0]
	assert.equal(name, 'createChapter')
	assert.deepEqual(
		{
			storyId: input.storyId,
			title: input.title,
			markdown: input.markdown,
			aiModel: input.aiModel,
		},
		{
			storyId: 's1',
			title: 'Three',
			markdown: 'Third.',
			aiModel: 'claude-opus-5-5',
		},
	)
	assert.equal(note('Stories/Balance/03 Three.md').meta.lu_id, 'c3')
	server.calls.length = 0
	assert.deepEqual((await sync()).created, [])
	assert.deepEqual(server.calls, [])
})

test('pushes entry edits, a category move and removed links', async () => {
	await sync()
	edit('Encyclopedia/Characters/Nemo.md', ({ meta, body }) => ({
		meta: { ...meta, related: [] },
		body: `${body}\n\n## Secrets (private)\n\nHe hides.`,
	}))
	files.store.set(
		'Encyclopedia/Villains/Nemo.md',
		files.store.get('Encyclopedia/Characters/Nemo.md'),
	)
	files.store.delete('Encyclopedia/Characters/Nemo.md')
	await sync()
	const [[name, input]] = server.calls
	assert.equal(name, 'updateEncyclopediaEntry')
	assert.equal(input.expectedVersion, 'ev1')
	assert.equal(input.changes.categoryTitle, 'Villains')
	assert.deepEqual(input.changes.relatedRemove, ['Nautilus'])
	assert.deepEqual(input.changes.fields, [
		{ title: 'Biography', text: 'Born a prince.' },
		{ title: 'Secrets', text: 'He hides.' },
	])
	assert.equal(note('Encyclopedia/Villains/Nemo.md').meta.lu_version, 'ev2')
})

test('creates an entry from a note in a category folder', async () => {
	await sync()
	files.store.set(
		'Encyclopedia/Ships/Nautilus II.md',
		`---\n${yaml.stringify({ lu_kind: 'entry', tags: ['ship'] })}\n---\n\nA submarine.\n\n## Crew\n\nForty.\n`,
	)
	await sync()
	const [name, input] = server.calls[0]
	assert.equal(name, 'createEncyclopediaEntry')
	assert.deepEqual(
		{
			name: input.name,
			categoryTitle: input.categoryTitle,
			summary: input.summary,
			fields: input.fields,
		},
		{
			name: 'Nautilus II',
			categoryTitle: 'Ships',
			summary: 'A submarine.',
			fields: [{ title: 'Crew', text: 'Forty.' }],
		},
	)
	assert.equal(note('Encyclopedia/Ships/Nautilus II.md').meta.lu_id, 'e9')
})

test('pushes story details with their version', async () => {
	await sync()
	edit('Stories/Balance/Story.md', ({ meta }) => ({
		meta: { ...meta, tags: ['war'] },
		body: 'War and peace.',
	}))
	await sync()
	assert.deepEqual(server.calls[0], [
		'updateStory',
		{
			storyId: 's1',
			expectedVersion: 'sv1',
			input: {
				title: 'Balance',
				description: 'War and peace.',
				genres: ['scifi'],
				tags: ['war'],
				rating: 'teen',
				license: 'cc-by',
				aiModel: undefined,
			},
		},
	])
})

test('adopts chapter notes from earlier plugin versions', async () => {
	files.store.set(
		'Stories/Balance/1 Old name.md',
		`---\n${yaml.stringify({ lu_id: 'c1', lu_story: 's1', lu_language: 'en', lu_version: 'v1', lu_updated: 't1', lu_hash: createHash('sha256').update('First.').digest('hex') })}\n---\n\nFirst.\n`,
	)
	await sync()
	assert.ok(!files.store.has('Stories/Balance/1 Old name.md'))
	assert.deepEqual(note('Stories/Balance/01 One.md').meta.title, 'One')
	assert.deepEqual(server.calls, [])
})

test('syncs only the chosen language', async () => {
	await sync({ language: 'cs' })
	assert.deepEqual(
		[...files.store.keys()]
			.filter((path) => path.startsWith('Stories/'))
			.sort(),
		['Stories/Balance/01 Jedna.cs.md', 'Stories/Balance/Story.md'],
	)
})

test('entry bodies round-trip and the config is checked', async () => {
	const body = entryBody('Sum.', [
		{ title: 'A', private: false, text: 'x' },
		{ title: 'B', private: true, text: 'y\n\nz' },
	])
	assert.deepEqual(parseEntryBody(body), {
		summary: 'Sum.',
		fields: [
			{ title: 'A', text: 'x' },
			{ title: 'B', text: 'y\n\nz' },
		],
	})
	const store = memoryFiles()
	assert.equal(await readVaultConfig(store), undefined)
	await writeVaultConfig(store, {
		version: 1,
		baseUrl: 'https://x',
		scope: { kind: 'story', storyId: 's1' },
	})
	assert.equal((await readVaultConfig(store)).scope.storyId, 's1')
	await store.write('.lu/vault.json', '{"version":2}')
	await assert.rejects(readVaultConfig(store), { code: 'INVALID_PROJECT' })
})

test('reports offline what the next sync would push', async () => {
	await sync()
	const status = () =>
		vaultStatus({ files, yaml, scope: { kind: 'universe', universeId: 'u1' } })
	assert.deepEqual(await status(), [])
	edit('Stories/Balance/02 Two.md', ({ meta, body }) => ({
		meta,
		body: `${body} More.`,
	}))
	edit('Encyclopedia/Characters/Nemo.md', ({ meta, body }) => ({
		meta: { ...meta, tags: [] },
		body,
	}))
	files.store.set(
		'Stories/Balance/New.md',
		'---\nlu_kind: "chapter"\n---\n\nText.\n',
	)
	assert.deepEqual(
		(await status()).map(({ path, state }) => [path, state]),
		[
			['Encyclopedia/Characters/Nemo.md', 'edited'],
			['Stories/Balance/02 Two.md', 'edited'],
			['Stories/Balance/New.md', 'new'],
		],
	)
})
