import assert from 'node:assert/strict'
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LiteraryUniverseClient } from '../dist/esm/index.js'
import {
	localProjectStatus,
	MARKDOWN_LOSSY_TYPES,
	pullLocalProject,
	pushLocalProject,
	readLocalProject,
	refreshLocalProject,
} from '../dist/esm/project.js'

const baseUrl = 'https://example.test'
const paragraph = (text) => ({
	type: 'doc',
	content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
const draft = (id, sequence, title, text, extra = {}) => ({
	id,
	storyId: 'story',
	sequence,
	title,
	language: 'en',
	version: 'v1',
	content: paragraph(text),
	markdown: text,
	...extra,
})

/** A fake deployment: `drafts` is what the server holds, `sent` records every request. */
function fakeServer(drafts) {
	const sent = []
	const handlers = {
		LuChapters: () => ({
			nodes: drafts.map((item) => ({ ...item, hasDraft: true })),
			pageInfo: { hasNextPage: false, endCursor: null },
		}),
		LuDraft: ({ id }) => drafts.find((item) => item.id === id),
		LuValidateDraft: () => ({ version: 'v1', warnings: [] }),
		LuSaveDraft: ({ input }) => {
			const current = drafts.find((item) => item.id === input.id)
			const text = input.markdown ?? input.content.content[0].content[0].text
			Object.assign(current, {
				version: 'v2',
				content: paragraph(text),
				markdown: `${text} (normalized)`,
			})
			return { version: 'v2', recoveryId: 'r', warnings: [], draft: current }
		},
	}
	const client = new LiteraryUniverseClient({
		baseUrl,
		token: 'lu_test_fixture',
		fetch: async (_url, init) => {
			const { operationName, variables } = JSON.parse(init.body)
			sent.push({ operationName, variables })
			return Response.json({
				data: { result: handlers[operationName](variables) },
			})
		},
	})
	return { client, sent }
}

const temporary = () => mkdtempSync(join(tmpdir(), 'lu-project-'))
const pulled = async (drafts) => {
	const directory = temporary()
	const server = fakeServer(drafts)
	await pullLocalProject(server.client, {
		directory,
		baseUrl,
		storyId: 'story',
	})
	return { directory, ...server }
}
const markdownFile = (directory, id) =>
	readLocalProject(directory).chapters.find((c) => c.id === id).markdown.file
const edit = (directory, file, text) =>
	writeFileSync(join(directory, file), text)

test('pull writes a Markdown mirror with frontmatter, sequence and slug names', async () => {
	const { directory } = await pulled([
		draft('a', 1, 'Chapter One: The Beginning!', 'Once upon a time.'),
		draft('b', 2, 'Chapter One: The Beginning!', 'Again.'),
		draft('c', 12, '!!!', ''),
	])
	try {
		const project = readLocalProject(directory)
		assert.deepEqual(
			project.chapters.map((chapter) => chapter.markdown.file),
			[
				'chapters/001-chapter-one-the-beginning.en.md',
				'chapters/002-chapter-one-the-beginning.en.md',
				'chapters/012-chapter.en.md',
			],
		)
		assert.equal(
			readFileSync(join(directory, project.chapters[0].markdown.file), 'utf8'),
			'---\nid: "a"\ntitle: "Chapter One: The Beginning!"\nlanguage: "en"\nversion: "v1"\neditable: true\n---\n\nOnce upon a time.',
		)
		assert.equal(project.chapters[0].file, 'chapters/chapter-a.en.json')
		assert.ok(
			project.chapters.every((chapter) => chapter.markdown.hash.length === 64),
		)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('numbers a Markdown name collision and keeps the mirror readable back', async () => {
	const { directory } = await pulled([
		draft('a', 1, 'Same', 'One'),
		draft('b', 1, 'same', 'Two'),
	])
	try {
		assert.equal(markdownFile(directory, 'b'), 'chapters/001-same-2.en.md')
		assert.deepEqual(
			localProjectStatus(directory).map((entry) => entry.source),
			['none', 'none'],
		)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('status reports which file changed', async () => {
	const { directory } = await pulled([
		draft('a', 1, 'A', 'a'),
		draft('b', 2, 'B', 'b'),
		draft('c', 3, 'C', 'c'),
		draft('d', 4, 'D', 'd'),
	])
	try {
		edit(
			directory,
			'chapters/chapter-b.en.json',
			JSON.stringify(paragraph('B2')),
		)
		edit(directory, markdownFile(directory, 'c'), '---\nid: "c"\n---\n\nC2')
		edit(
			directory,
			'chapters/chapter-d.en.json',
			JSON.stringify(paragraph('D2')),
		)
		edit(directory, markdownFile(directory, 'd'), 'D2')
		const status = localProjectStatus(directory)
		assert.deepEqual(
			status.map((entry) => [entry.source, entry.changed]),
			[
				['none', false],
				['json', true],
				['markdown', true],
				['both', true],
			],
		)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('push sends the form that changed, refuses ambiguity, and rewrites both files', async () => {
	const { directory, client, sent } = await pulled([
		draft('json', 1, 'J', 'j'),
		draft('md', 2, 'M', 'm'),
		draft('both', 3, 'B', 'b'),
	])
	try {
		edit(
			directory,
			'chapters/chapter-json.en.json',
			JSON.stringify(paragraph('J2')),
		)
		edit(
			directory,
			markdownFile(directory, 'md'),
			'---\nid: "md"\n---\n\nM2\r\n',
		)
		edit(
			directory,
			'chapters/chapter-both.en.json',
			JSON.stringify(paragraph('B2')),
		)
		edit(directory, markdownFile(directory, 'both'), 'B2')
		sent.length = 0
		const results = await pushLocalProject(client, { directory, baseUrl })
		assert.deepEqual(
			results.map(({ id, status, code }) => [id, status, code]),
			[
				['both', 'failed', 'AMBIGUOUS_CHANGE'],
				['json', 'saved', undefined],
				['md', 'saved', undefined],
			],
		)
		const inputs = sent.map((request) => request.variables.input)
		assert.deepEqual(
			sent.map((request) => request.operationName),
			['LuValidateDraft', 'LuValidateDraft', 'LuSaveDraft', 'LuSaveDraft'],
		)
		assert.ok(inputs.every((input) => !input.id.includes('both')))
		assert.deepEqual(inputs[2].content, paragraph('J2'))
		assert.equal('markdown' in inputs[2], false)
		assert.equal(inputs[3].markdown, 'M2\n')
		assert.equal('content' in inputs[3], false)
		assert.match(inputs[3].operationId, /^[0-9a-f-]{36}$/)
		assert.equal(inputs[3].expectedVersion, 'v1')
		// Both files now hold the server's normalized draft.
		assert.equal(
			readFileSync(join(directory, markdownFile(directory, 'json')), 'utf8'),
			'---\nid: "json"\ntitle: "J"\nlanguage: "en"\nversion: "v2"\neditable: true\n---\n\nJ2 (normalized)',
		)
		assert.deepEqual(
			JSON.parse(
				readFileSync(join(directory, 'chapters/chapter-md.en.json'), 'utf8'),
			),
			paragraph('M2\n'),
		)
		const status = localProjectStatus(directory)
		assert.deepEqual(
			status.map((entry) => [entry.id, entry.source, entry.version]),
			[
				['json', 'none', 'v2'],
				['md', 'none', 'v2'],
				['both', 'both', 'v1'],
			],
		)
		assert.ok(readLocalProject(directory).chapters.every((c) => !c.pending))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('a chapter the server cannot read back from Markdown is marked and refused locally', async () => {
	const ruby = {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				attrs: { textAlign: 'center' },
				content: [{ type: 'ruby' }],
			},
			{ type: 'playSceneHeading' },
			{ type: 'heading', attrs: { initialLetter: true } },
			{
				type: 'paragraph',
				content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle' }] }],
			},
		],
	}
	assert.ok(MARKDOWN_LOSSY_TYPES.includes('ruby'))
	const { directory, client, sent } = await pulled([
		draft('lossy', 1, 'L', 'l', { content: ruby }),
		draft('plain', 2, 'P', 'p'),
	])
	try {
		const file = markdownFile(directory, 'lossy')
		assert.equal(
			readFileSync(join(directory, file), 'utf8'),
			'---\nid: "lossy"\ntitle: "L"\nlanguage: "en"\nversion: "v1"\neditable: false\n---\n# Edit chapters/chapter-lossy.en.json instead: this chapter contains textAlign, ruby, playSceneHeading, initialLetter, textStyle\n\nl',
		)
		assert.equal(localProjectStatus(directory)[0].source, 'none')
		edit(
			directory,
			file,
			`${readFileSync(join(directory, file), 'utf8')} edited`,
		)
		sent.length = 0
		const results = await pushLocalProject(client, { directory, baseUrl })
		assert.deepEqual(results, [
			{ id: 'lossy', status: 'failed', code: 'MARKDOWN_UNSUPPORTED' },
		])
		assert.equal(sent.length, 0)
		// The JSON form of the same chapter still pushes.
		edit(
			directory,
			file,
			readFileSync(join(directory, file), 'utf8').replace(' edited', ''),
		)
		edit(
			directory,
			'chapters/chapter-lossy.en.json',
			JSON.stringify(paragraph('L2')),
		)
		assert.equal(
			(await pushLocalProject(client, { directory, baseUrl }))[0].status,
			'saved',
		)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('a legacy chapter without a Markdown form is marked and never pushed from Markdown', async () => {
	const { directory, client, sent } = await pulled([
		draft('legacy', 1, 'Old', null, {
			version: 'legacy',
			content: null,
			html: '<p>Old</p>',
		}),
	])
	try {
		const file = markdownFile(directory, 'legacy')
		assert.equal(
			readFileSync(join(directory, file), 'utf8'),
			'---\nid: "legacy"\ntitle: "Old"\nlanguage: "en"\nversion: "legacy"\neditable: false\n---\n# This chapter has no Markdown form yet; open it once in the web editor to convert it, then run lu refresh\n\n',
		)
		assert.equal(
			readFileSync(join(directory, 'chapters/chapter-legacy.en.json'), 'utf8'),
			'null\n',
		)
		assert.deepEqual(
			localProjectStatus(directory).map((entry) => [
				entry.source,
				entry.changed,
			]),
			[['none', false]],
		)
		edit(
			directory,
			file,
			`${readFileSync(join(directory, file), 'utf8')}New text`,
		)
		assert.equal(localProjectStatus(directory)[0].source, 'markdown')
		sent.length = 0
		assert.deepEqual(await pushLocalProject(client, { directory, baseUrl }), [
			{ id: 'legacy', status: 'failed', code: 'MARKDOWN_UNSUPPORTED' },
		])
		assert.equal(sent.length, 0)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('refresh refuses local changes, then rewrites, adds and removes chapters', async () => {
	const drafts = [draft('a', 1, 'A', 'a'), draft('b', 2, 'B', 'b')]
	const { directory, client } = await pulled(drafts)
	try {
		edit(directory, markdownFile(directory, 'a'), 'changed')
		await assert.rejects(refreshLocalProject(client, { directory, baseUrl }), {
			code: 'LOCAL_CHANGES',
		})
		await assert.rejects(
			pullLocalProject(client, {
				directory,
				baseUrl,
				storyId: 'story',
				refresh: true,
			}),
			{ code: 'LOCAL_CHANGES' },
		)
		const oldMarkdown = markdownFile(directory, 'a')
		edit(directory, oldMarkdown, '---\nid: "a"\n---\n\na')
		Object.assign(drafts[0], {
			title: 'A renamed',
			version: 'v3',
			markdown: 'a3',
			content: paragraph('a3'),
		})
		drafts.splice(1, 1, draft('c', 2, 'C', 'c'))
		const report = await refreshLocalProject(client, { directory, baseUrl })
		assert.deepEqual(report, { added: ['c'], updated: ['a'], removed: ['b'] })
		assert.equal(existsSync(join(directory, oldMarkdown)), false)
		assert.equal(
			existsSync(join(directory, 'chapters/chapter-b.en.json')),
			false,
		)
		assert.equal(existsSync(join(directory, '.lu/chapter-b.en.json')), false)
		assert.equal(markdownFile(directory, 'a'), 'chapters/001-a-renamed.en.md')
		assert.deepEqual(
			localProjectStatus(directory).map((entry) => [
				entry.id,
				entry.version,
				entry.source,
			]),
			[
				['a', 'v3', 'none'],
				['c', 'v1', 'none'],
			],
		)
		assert.deepEqual(
			await refreshLocalProject(client, { directory, baseUrl }),
			{
				added: [],
				updated: [],
				removed: [],
			},
		)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('a manifest without a Markdown mirror still loads and gains one on save', async () => {
	const { directory, client } = await pulled([draft('a', 1, 'A', 'a')])
	try {
		const project = readLocalProject(directory)
		rmSync(join(directory, project.chapters[0].markdown.file))
		delete project.chapters[0].markdown
		writeFileSync(join(directory, '.lu/project.json'), JSON.stringify(project))
		assert.deepEqual(localProjectStatus(directory)[0].source, 'none')
		edit(
			directory,
			'chapters/chapter-a.en.json',
			JSON.stringify(paragraph('a2')),
		)
		await pushLocalProject(client, { directory, baseUrl })
		assert.equal(markdownFile(directory, 'a'), 'chapters/001-a.en.md')
		assert.equal(localProjectStatus(directory)[0].source, 'none')
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
