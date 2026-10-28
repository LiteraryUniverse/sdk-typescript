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

type ChapterFile = {
	id: string
	language: string
	file: string
	version: string
	hash: string
	pending?: {
		operationId: string
		expectedVersion: string
		hash: string
		content: JsonValue
	}
}
export type LocalProject = {
	version: 1
	baseUrl: string
	storyId: string
	chapters: ChapterFile[]
}
const failure = (code: string, message: string): never => {
	throw new LiteraryUniverseApiError(code, message)
}
const digest = (content: JsonValue) =>
	createHash('sha256').update(JSON.stringify(content)).digest('hex')
const filename = (id: string, language: string) =>
	`chapters/chapter-${id}.${language}.json`
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

function writeJson(root: string, file: string, value: unknown) {
	const path = pathFor(root, file)
	const temporary = `${path}.${randomUUID()}.tmp`
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
		flag: 'wx',
	})
	try {
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
}

function readJson(root: string, file: string): JsonValue {
	const path = pathFor(root, file)
	if (statSync(path).size > 16 * 1024 * 1024)
		failure('PAYLOAD_TOO_LARGE', 'Project file exceeds the size limit')
	try {
		return JSON.parse(
			readFileSync(path, 'utf8').replace(/^\uFEFF/, ''),
		) as JsonValue
	} catch {
		return failure('INVALID_PROJECT', 'Project file contains invalid JSON')
	}
}

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
		!Array.isArray(project.chapters)
	)
		failure('INVALID_PROJECT', 'Invalid project manifest')
	const files = new Set<string>()
	for (const chapter of project.chapters) {
		validateChapter(chapter, files)
		files.add(chapter.file.toLowerCase())
	}
	return project
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

export function localProjectStatus(directory: string) {
	const root = rootFor(directory)
	return readLocalProject(root).chapters.map((chapter) => ({
		id: chapter.id,
		language: chapter.language,
		file: chapter.file,
		version: chapter.version,
		changed: digest(readJson(root, chapter.file)) !== chapter.hash,
		pending: Boolean(chapter.pending),
	}))
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
function storePulledDraft(
	root: string,
	project: LocalProject,
	draft: Awaited<ReturnType<LiteraryUniverseClient['draft']>>,
) {
	const file = filename(draft.id, draft.language)
	assertDistinctFile(project, file)
	writeJson(root, file, draft.content)
	writeJson(root, `.lu/${file.split('/')[1]}`, draft)
	project.chapters.push({
		id: draft.id,
		language: draft.language,
		file,
		version: draft.version,
		hash: digest(draft.content),
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
	},
) {
	const root = initializeProject(input.directory)
	const release = lock(root)
	try {
		const project: LocalProject = {
			version: 1,
			baseUrl: input.baseUrl,
			storyId: input.storyId,
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

function savedLocally(
	root: string,
	project: LocalProject,
	chapter: ChapterFile,
	result: Awaited<ReturnType<LiteraryUniverseClient['saveDraft']>>,
) {
	if (digest(readJson(root, chapter.file)) === chapter.pending?.hash)
		writeJson(root, chapter.file, result.draft.content)
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

type PushChange = {
	chapter: ChapterFile
	pending: NonNullable<ChapterFile['pending']>
}
const saveInput = ({ chapter, pending }: PushChange) => ({
	id: chapter.id,
	language: chapter.language,
	expectedVersion: pending.expectedVersion,
	operationId: pending.operationId,
	content: pending.content,
})

function snapshot(root: string, chapter: ChapterFile): PushChange {
	const content = chapter.pending?.content ?? readJson(root, chapter.file)
	const pending = chapter.pending ?? {
		operationId: randomUUID(),
		expectedVersion: chapter.version,
		hash: digest(content),
		content,
	}
	return { chapter, pending }
}

async function preflight(
	client: LiteraryUniverseClient,
	root: string,
	baseUrl: string,
) {
	const project = readLocalProject(root)
	if (new URL(project.baseUrl).href !== new URL(baseUrl).href)
		failure(
			'DEPLOYMENT_MISMATCH',
			'The selected deployment does not match this project',
		)
	const changes = project.chapters
		.map((chapter) => snapshot(root, chapter))
		.filter(
			({ chapter, pending }) =>
				chapter.pending || pending.hash !== chapter.hash,
		)
	for (const change of changes.filter(({ chapter }) => !chapter.pending))
		await client.validateDraft(saveInput(change))
	return { project, changes }
}

async function pushLocked(
	client: LiteraryUniverseClient,
	root: string,
	baseUrl: string,
) {
	const { project, changes } = await preflight(client, root, baseUrl)
	// Chapters are independent: a failure keeps its pending intent and the rest still push.
	const results: PushResult[] = []
	for (const change of changes)
		results.push(await pushChapter(client, root, project, change))
	return results
}
