import { createHash, randomUUID } from 'node:crypto'
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import {
	LiteraryUniverseApiError,
	type LiteraryUniverseClient,
} from './index.js'
import type { JsonValue } from './json.js'

type Draft = Awaited<ReturnType<LiteraryUniverseClient['draft']>>
type Pending = {
	operationId: string
	expectedVersion: string
	/** Digest of the form sent: `content`, or the Markdown body. */
	hash: string
	content?: JsonValue
	markdown?: string
}
type ChapterFile = {
	id: string
	language: string
	file: string
	version: string
	hash: string
	/** The Markdown mirror; absent in projects pulled before it existed. */
	markdown?: { file: string; hash: string }
	pending?: Pending
}
export type LocalProject = {
	version: 1
	baseUrl: string
	storyId: string
	/** The language filter the project was pulled with. */
	language?: string
	chapters: ChapterFile[]
}
export type ChangeSource = 'none' | 'json' | 'markdown' | 'both'
const failure = (code: string, message: string): never => {
	throw new LiteraryUniverseApiError(code, message)
}
const digest = (content: JsonValue) =>
	createHash('sha256').update(JSON.stringify(content)).digest('hex')
const filename = (id: string, language: string) =>
	`chapters/chapter-${id}.${language}.json`
/** Node and mark types the server's Markdown has no form for; `play*` nodes and non-left alignment count too. */
export const MARKDOWN_LOSSY_TYPES: readonly string[] = [
	'ruby',
	'connection',
	'textStyle',
	'initialLetter',
	'emoji',
	'video',
	'workCard',
]
function lossyTypes(node: JsonValue, found = new Set<string>()) {
	if (!node || typeof node !== 'object') return found
	const { type, attrs } = node as {
		type?: unknown
		attrs?: { textAlign?: unknown }
	}
	if (
		typeof type === 'string' &&
		(MARKDOWN_LOSSY_TYPES.includes(type) || type.startsWith('play'))
	)
		found.add(type)
	if (
		(type === 'paragraph' || type === 'heading') &&
		attrs?.textAlign &&
		attrs.textAlign !== 'left'
	)
		found.add('textAlign')
	for (const value of Object.values(node)) lossyTypes(value, found)
	return found
}
const FRONTMATTER = /^---\n(?:[^\n]*\n)*?---\n(?:# Edit chapters\/[^\n]*\n)?\n?/
function frontmatter(draft: Draft) {
	const lossy = [...lossyTypes(draft.content)]
	const fields = ['id', 'title', 'language', 'version'].map(
		(key) => `${key}: ${JSON.stringify(draft[key as keyof Draft])}`,
	)
	const notice = lossy.length
		? `# Edit ${filename(draft.id, draft.language)} instead: this chapter contains ${lossy.join(', ')}\n`
		: ''
	const header = ['---', ...fields, `editable: ${!lossy.length}`, '---', '']
	return `${header.join('\n')}${notice}\n`
}
const rootFor = (directory: string) => realpathSync(resolve(directory))

function pathFor(root: string, file: string) {
	if (
		!/^(\.lu|chapters)\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?$/.test(file) ||
		file.split('/').some((part) => part === '..')
	)
		failure('INVALID_PROJECT', 'Invalid project file path')
	const path = join(root, file)
	let current = root
	for (const part of file.split('/')) {
		current = join(current, part)
		if (existsSync(current) && lstatSync(current).isSymbolicLink())
			failure('INVALID_PROJECT', 'Project files must not be symbolic links')
	}
	return path
}

function writeText(root: string, file: string, text: string) {
	const path = pathFor(root, file)
	const temporary = `${path}.${randomUUID()}.tmp`
	writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
	try {
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
}
const writeJson = (root: string, file: string, value: unknown) =>
	writeText(root, file, `${JSON.stringify(value, null, 2)}\n`)
const writeMarkdown = (root: string, file: string, draft: Draft) =>
	writeText(root, file, frontmatter(draft) + (draft.markdown ?? ''))

function readText(root: string, file: string) {
	const path = pathFor(root, file)
	if (statSync(path).size > 16 * 1024 * 1024)
		failure('PAYLOAD_TOO_LARGE', 'Project file exceeds the size limit')
	return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
}

function readJson(root: string, file: string): JsonValue {
	try {
		return JSON.parse(readText(root, file)) as JsonValue
	} catch {
		return failure('INVALID_PROJECT', 'Project file contains invalid JSON')
	}
}

/** The Markdown body: the file without its frontmatter, with LF line ends. */
const readBody = (root: string, file: string) =>
	readText(root, file).replaceAll('\r\n', '\n').replace(FRONTMATTER, '')

function clearDeadLock(root: string) {
	const existing = readJson(root, '.lu/lock') as {
		host?: string
		pid?: number
	}
	if (
		existing.host !== hostname() ||
		!Number.isInteger(existing.pid) ||
		(existing.pid ?? 0) <= 0
	)
		failure('PROJECT_LOCKED', 'Inspect .lu/lock before removing a stale lock')
	try {
		process.kill(existing.pid ?? 0, 0)
		failure('PROJECT_LOCKED', 'Another process owns this project')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
	}
	rmSync(pathFor(root, '.lu/lock'))
}

function lock(root: string) {
	const file = pathFor(root, '.lu/lock')
	if (existsSync(file)) clearDeadLock(root)
	try {
		writeFileSync(
			file,
			JSON.stringify({ host: hostname(), pid: process.pid }),
			{ flag: 'wx', mode: 0o600 },
		)
	} catch {
		failure('PROJECT_LOCKED', 'Another process owns this project')
	}
	return () => rmSync(file, { force: true })
}

/** Loads only the fixed managed-project layout, never arbitrary manifest paths. */
export function readLocalProject(directory: string): LocalProject {
	const project = readJson(
		rootFor(directory),
		'.lu/project.json',
	) as unknown as LocalProject
	if (
		project?.version !== 1 ||
		typeof project.baseUrl !== 'string' ||
		!/^[a-zA-Z0-9_-]{1,100}$/.test(project.storyId) ||
		(project.language !== undefined &&
			!/^[a-zA-Z0-9-]{1,32}$/.test(project.language)) ||
		!Array.isArray(project.chapters)
	)
		failure('INVALID_PROJECT', 'Invalid project manifest')
	const files = new Set<string>()
	for (const chapter of project.chapters) {
		validateChapter(chapter, files)
		files.add(chapter.file.toLowerCase())
		if (chapter.markdown) validateMarkdown(chapter.markdown, files)
	}
	return project
}

function validateMarkdown(
	markdown: NonNullable<ChapterFile['markdown']>,
	files: Set<string>,
) {
	if (
		typeof markdown.file !== 'string' ||
		!/^chapters\/[a-zA-Z0-9._-]+\.md$/.test(markdown.file) ||
		typeof markdown.hash !== 'string' ||
		files.has(markdown.file.toLowerCase())
	)
		failure('INVALID_PROJECT', 'Invalid chapter manifest')
	files.add(markdown.file.toLowerCase())
}

function validateChapter(chapter: ChapterFile, files: Set<string>) {
	if (
		!chapter ||
		typeof chapter.id !== 'string' ||
		typeof chapter.language !== 'string' ||
		!/^[a-zA-Z0-9_-]{1,100}$/.test(chapter.id) ||
		!/^[a-zA-Z0-9-]{1,32}$/.test(chapter.language) ||
		chapter.file !== filename(chapter.id, chapter.language) ||
		typeof chapter.version !== 'string' ||
		typeof chapter.hash !== 'string' ||
		files.has(chapter.file.toLowerCase())
	)
		failure('INVALID_PROJECT', 'Invalid chapter manifest')
}

/** Which local file differs from the manifest; `both` cannot be pushed. */
function inspect(root: string, chapter: ChapterFile) {
	const content = readJson(root, chapter.file)
	const body = chapter.markdown ? readBody(root, chapter.markdown.file) : ''
	const json = digest(content) !== chapter.hash
	const markdown =
		chapter.markdown !== undefined && digest(body) !== chapter.markdown.hash
	const source: ChangeSource =
		json && markdown ? 'both' : json ? 'json' : markdown ? 'markdown' : 'none'
	return { content, body, source }
}

export function localProjectStatus(directory: string) {
	const root = rootFor(directory)
	return readLocalProject(root).chapters.map((chapter) => {
		const { source } = inspect(root, chapter)
		return {
			id: chapter.id,
			language: chapter.language,
			file: chapter.file,
			version: chapter.version,
			changed: source !== 'none',
			source,
			pending: Boolean(chapter.pending),
		}
	})
}

function initializeProject(directory: string) {
	mkdirSync(directory, { recursive: true })
	const root = rootFor(directory)
	if (existsSync(join(root, '.lu')) || existsSync(join(root, 'chapters')))
		failure(
			'PROJECT_EXISTS',
			'Pull into a new directory to preserve existing files',
		)
	mkdirSync(join(root, '.lu'), { mode: 0o700 })
	mkdirSync(join(root, 'chapters'), { mode: 0o700 })
	return root
}

async function pullPage(
	client: LiteraryUniverseClient,
	root: string,
	project: LocalProject,
	input: { language?: string },
	after?: string,
) {
	const page = await client.chapters({
		storyId: project.storyId,
		language: input.language,
		after,
	})
	for (const chapter of page.nodes.filter((item) => item.hasDraft)) {
		const draft = await client.draft({
			id: chapter.id,
			language: input.language,
		})
		storePulledDraft(root, project, draft)
		// A refresh stopped midway keeps a manifest that matches the files written so far.
		writeJson(root, '.lu/project.json', project)
	}
	return page.pageInfo
}

function assertDistinctFile(project: LocalProject, file: string) {
	if (
		project.chapters.some(
			(chapter) => chapter.file.toLowerCase() === file.toLowerCase(),
		)
	)
		failure(
			'INVALID_PROJECT',
			'Chapter filenames differ only by case; use individual draft files',
		)
}
/** `chapters/<seq>-<slug>.<lang>.md`, numbered on a collision. */
function markdownName(project: LocalProject, draft: Draft) {
	const slug =
		draft.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.slice(0, 60)
			.replace(/^-+|-+$/g, '') || 'chapter'
	const base = `chapters/${String(draft.sequence).padStart(3, '0')}-${slug}`
	const taken = new Set(
		project.chapters.map((chapter) => chapter.markdown?.file.toLowerCase()),
	)
	for (let n = 1; ; n++) {
		const file = `${base}${n > 1 ? `-${n}` : ''}.${draft.language}.md`
		if (!taken.has(file.toLowerCase())) return file
	}
}

function storePulledDraft(root: string, project: LocalProject, draft: Draft) {
	const file = filename(draft.id, draft.language)
	assertDistinctFile(project, file)
	const markdown = markdownName(project, draft)
	writeJson(root, file, draft.content)
	writeMarkdown(root, markdown, draft)
	writeJson(root, `.lu/${file.split('/')[1]}`, draft)
	project.chapters.push({
		id: draft.id,
		language: draft.language,
		file,
		version: draft.version,
		hash: digest(draft.content),
		markdown: { file: markdown, hash: digest(draft.markdown ?? '') },
	})
}

async function pullPages(
	client: LiteraryUniverseClient,
	root: string,
	project: LocalProject,
	language?: string,
) {
	let after: string | undefined
	const cursors = new Set<string>()
	do {
		const page = await pullPage(client, root, project, { language }, after)
		after = page.hasNextPage
			? (page.endCursor ??
				failure('INVALID_RESPONSE', 'Missing pagination cursor'))
			: undefined
		if (after && cursors.has(after))
			failure('INVALID_RESPONSE', 'Repeated pagination cursor')
		if (after) cursors.add(after)
	} while (after)
}

/** Pulls into a new directory, preserving existing local files. */
export async function pullLocalProject(
	client: LiteraryUniverseClient,
	input: {
		directory: string
		baseUrl: string
		storyId: string
		language?: string
		/** Re-pull an existing project instead; see refreshLocalProject. */
		refresh?: boolean
	},
) {
	if (input.refresh) return refreshLocalProject(client, input)
	const root = initializeProject(input.directory)
	const release = lock(root)
	try {
		const project: LocalProject = {
			version: 1,
			baseUrl: input.baseUrl,
			storyId: input.storyId,
			...(input.language ? { language: input.language } : {}),
			chapters: [],
		}
		await pullPages(client, root, project, input.language)
		writeJson(root, '.lu/project.json', project)
		return project
	} catch (error) {
		// This pull created both folders, so removing them lets a retry start over.
		for (const name of ['.lu', 'chapters'])
			rmSync(join(root, name), { recursive: true, force: true })
		throw error
	} finally {
		release()
	}
}

/** Deletes the files of chapters the server no longer has and reports the difference. */
function reconcile(
	root: string,
	previous: ChapterFile[],
	project: LocalProject,
) {
	const current = new Set(project.chapters.map((chapter) => chapter.file))
	const kept = new Set(
		project.chapters.flatMap((chapter) => [
			chapter.file,
			chapter.markdown?.file,
		]),
	)
	for (const chapter of previous) {
		for (const file of [chapter.file, chapter.markdown?.file])
			if (file && !kept.has(file)) rmSync(pathFor(root, file), { force: true })
		if (!current.has(chapter.file))
			rmSync(pathFor(root, `.lu/${chapter.file.split('/')[1]}`), {
				force: true,
			})
	}
	return difference(previous, project.chapters)
}

const sameState = (before: ChapterFile, after: ChapterFile) =>
	before.version === after.version &&
	before.hash === after.hash &&
	before.markdown?.hash === after.markdown?.hash
function difference(previous: ChapterFile[], chapters: ChapterFile[]) {
	const was = new Map(previous.map((chapter) => [chapter.file, chapter]))
	const current = new Set(chapters.map((chapter) => chapter.file))
	const ids = (list: ChapterFile[]) => [...new Set(list.map((c) => c.id))]
	return {
		added: ids(chapters.filter((chapter) => !was.has(chapter.file))),
		updated: ids(
			chapters.filter((chapter) => {
				const before = was.get(chapter.file)
				return before && !sameState(before, chapter)
			}),
		),
		removed: ids(previous.filter((chapter) => !current.has(chapter.file))),
	}
}

/** Re-pulls every chapter of an existing project; refuses while anything local is unpushed. */
export async function refreshLocalProject(
	client: LiteraryUniverseClient,
	input: { directory: string; baseUrl: string },
) {
	const root = rootFor(input.directory)
	const release = lock(root)
	try {
		const project = openProject(root, input.baseUrl)
		if (
			project.chapters.some(
				(chapter) =>
					chapter.pending || inspect(root, chapter).source !== 'none',
			)
		)
			failure('LOCAL_CHANGES', 'Push or revert local changes before refreshing')
		const previous = project.chapters
		project.chapters = []
		await pullPages(client, root, project, project.language)
		writeJson(root, '.lu/project.json', project)
		return reconcile(root, previous, project)
	} finally {
		release()
	}
}

/** Saves each changed draft once; pending intents survive a lost response or stopped process. */
export async function pushLocalProject(
	client: LiteraryUniverseClient,
	input: { directory: string; baseUrl: string },
) {
	const root = rootFor(input.directory)
	const release = lock(root)
	try {
		return await pushLocked(client, root, input.baseUrl)
	} finally {
		release()
	}
}

type PushResult = {
	id: string
	status: 'saved' | 'failed'
	code?: string
	recoveryId?: string
	warnings?: unknown
}

/** Rewrites both files from the server's draft unless they changed again meanwhile. */
function savedLocally(
	root: string,
	project: LocalProject,
	chapter: ChapterFile,
	result: Awaited<ReturnType<LiteraryUniverseClient['saveDraft']>>,
) {
	const { pending, markdown } = chapter
	const sentMarkdown = pending?.markdown !== undefined
	const jsonBefore = sentMarkdown ? chapter.hash : pending?.hash
	if (digest(readJson(root, chapter.file)) === jsonBefore)
		writeJson(root, chapter.file, result.draft.content)
	const file = markdown?.file ?? markdownName(project, result.draft)
	const bodyBefore = sentMarkdown ? pending?.hash : markdown?.hash
	if (!markdown || digest(readBody(root, file)) === bodyBefore)
		writeMarkdown(root, file, result.draft)
	chapter.markdown = { file, hash: digest(result.draft.markdown ?? '') }
	chapter.hash = digest(result.draft.content)
	chapter.version = result.version
	delete chapter.pending
	writeJson(root, `.lu/${chapter.file.split('/')[1]}`, result.draft)
	writeJson(root, '.lu/project.json', project)
}

const permanentRejections = new Set([
	'BAD_USER_INPUT',
	'GRAPHQL_VALIDATION_FAILED',
	'FORBIDDEN',
	'UNAUTHENTICATED',
	'VERSION_CONFLICT',
	'IDEMPOTENCY_CONFLICT',
])

function rejectedLocally(
	root: string,
	project: LocalProject,
	chapter: ChapterFile,
	error: unknown,
): PushResult {
	if (
		error instanceof LiteraryUniverseApiError &&
		(permanentRejections.has(error.code) ||
			// 413 refuses the request; an oversized response may follow a write.
			(error.code === 'PAYLOAD_TOO_LARGE' && error.status === 413))
	) {
		delete chapter.pending
		writeJson(root, '.lu/project.json', project)
	}
	return {
		id: chapter.id,
		status: 'failed',
		code:
			error instanceof LiteraryUniverseApiError ? error.code : 'LOCAL_IO_ERROR',
	}
}

async function pushChapter(
	client: LiteraryUniverseClient,
	root: string,
	project: LocalProject,
	change: PushChange,
): Promise<PushResult> {
	const { chapter, pending } = change
	chapter.pending = pending
	writeJson(root, '.lu/project.json', project)
	try {
		const result = await client.saveDraft(saveInput(change))
		savedLocally(root, project, chapter, result)
		return {
			id: chapter.id,
			status: 'saved',
			recoveryId: result.recoveryId,
			warnings: result.warnings,
		}
	} catch (error) {
		return rejectedLocally(root, project, chapter, error)
	}
}

type PushChange = { chapter: ChapterFile; pending: Pending }
const saveInput = ({ chapter, pending }: PushChange) => ({
	id: chapter.id,
	language: chapter.language,
	expectedVersion: pending.expectedVersion,
	operationId: pending.operationId,
	...(pending.markdown === undefined
		? { content: pending.content }
		: { markdown: pending.markdown }),
})

/** The intent to send: an earlier pending one, else the changed file's; or why nothing can be sent. */
function snapshot(
	root: string,
	chapter: ChapterFile,
): PushChange | 'none' | 'AMBIGUOUS_CHANGE' | 'MARKDOWN_UNSUPPORTED' {
	if (chapter.pending) return { chapter, pending: chapter.pending }
	const { content, body, source } = inspect(root, chapter)
	if (source === 'none') return source
	if (source === 'both') return 'AMBIGUOUS_CHANGE'
	if (source === 'markdown' && lossyTypes(content).size)
		return 'MARKDOWN_UNSUPPORTED'
	const sent = source === 'markdown' ? { markdown: body } : { content }
	const hash = digest(source === 'markdown' ? body : content)
	const operationId = randomUUID()
	const pending = {
		operationId,
		expectedVersion: chapter.version,
		hash,
		...sent,
	}
	return { chapter, pending }
}

function openProject(root: string, baseUrl: string) {
	const project = readLocalProject(root)
	if (new URL(project.baseUrl).href !== new URL(baseUrl).href)
		failure(
			'DEPLOYMENT_MISMATCH',
			'The selected deployment does not match this project',
		)
	return project
}

async function preflight(
	client: LiteraryUniverseClient,
	root: string,
	baseUrl: string,
) {
	const project = openProject(root, baseUrl)
	const changes: PushChange[] = []
	const unsendable: PushResult[] = []
	for (const chapter of project.chapters) {
		const change = snapshot(root, chapter)
		if (typeof change === 'object') changes.push(change)
		else if (change !== 'none')
			unsendable.push({ id: chapter.id, status: 'failed', code: change })
	}
	for (const change of changes.filter(({ chapter }) => !chapter.pending))
		await client.validateDraft(saveInput(change))
	return { project, changes, unsendable }
}

async function pushLocked(
	client: LiteraryUniverseClient,
	root: string,
	baseUrl: string,
) {
	const { project, changes, unsendable } = await preflight(
		client,
		root,
		baseUrl,
	)
	// Chapters are independent: a failure keeps its pending intent and the rest still push.
	const results: PushResult[] = [...unsendable]
	for (const change of changes)
		results.push(await pushChapter(client, root, project, change))
	return results
}
