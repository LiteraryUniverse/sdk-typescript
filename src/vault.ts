/**
 * Two-way sync between Literary Universe and a folder of Markdown notes, as
 * the CLI (`lu sync`) and the Obsidian plugin both run it. Notes carry their
 * sync state in `lu_*` frontmatter, so they can be renamed and moved; the
 * rules are the same everywhere:
 *
 * - Pull first, then push what changed locally.
 * - A note edited locally while its item changed on Literary Universe is
 *   kept; the server text is written beside it as `<name> (Literary
 *   Universe).md`, and the note is not pushed while that copy exists.
 * - Every write names the version it is based on, so a sync never replaces
 *   work saved on Literary Universe meanwhile.
 * - Deleting a note deletes nothing on Literary Universe; the next pull
 *   brings it back.
 * - New chapters and entries are notes with `lu_kind` and no `lu_id`.
 *
 * Only the files adapter touches storage, so this runs in Node, Bun and
 * Obsidian (desktop and mobile).
 */
import {
	LiteraryUniverseApiError,
	type LiteraryUniverseClient,
} from './index.js'

/** Storage for the notes; paths are relative to the vault root with `/`. */
export type VaultFiles = {
	/** Every Markdown file under the root. */
	list(): Promise<string[]>
	read(path: string): Promise<string | undefined>
	/** Creates or replaces the file and any missing parent folders. */
	write(path: string, text: string): Promise<void>
	rename(from: string, to: string): Promise<void>
	exists(path: string): Promise<boolean>
}
/** Frontmatter is YAML; the host supplies its parser (Obsidian's own, or the `yaml` package). */
export type Yaml = {
	parse(text: string): unknown
	stringify(value: unknown): string
}
export type VaultScope =
	/** A universe with its stories, encyclopedia, series and comics. */
	| { kind: 'universe'; universeId: string }
	/** One story at the root. */
	| { kind: 'story'; storyId: string }
	/** Every story you can write, one folder each under `folder`. */
	| { kind: 'workshop'; folder: string }
export type VaultConfig = {
	version: 1
	baseUrl: string
	scope: VaultScope
	/** Only this language's editions are synced when set. */
	language?: string
}
export type SyncReport = {
	created: string[]
	updated: string[]
	pushed: string[]
	conflicts: string[]
	failures: string[]
}
type Client = LiteraryUniverseClient
type Meta = Record<string, unknown>
type Note = { path: string; meta: Meta; body: string }
type Chapter = Awaited<ReturnType<Client['chapters']>>['nodes'][number]
type Entry = NonNullable<Awaited<ReturnType<Client['encyclopediaEntry']>>>
type Story = NonNullable<Awaited<ReturnType<Client['story']>>>
type Universe = NonNullable<Awaited<ReturnType<Client['universe']>>>

export const CONFIG_PATH = '.lu/vault.json'
export const CONFLICT_SUFFIX = ' (Literary Universe)'

/** The vault's scope, or undefined for a folder that is not one. */
export async function readVaultConfig(files: VaultFiles) {
	const text = await files.read(CONFIG_PATH)
	if (!text) return undefined
	const config = JSON.parse(text) as VaultConfig
	if (config.version !== 1 || !config.scope?.kind)
		throw new LiteraryUniverseApiError(
			'INVALID_PROJECT',
			`${CONFIG_PATH} is not a Literary Universe vault configuration`,
		)
	return config
}
export const writeVaultConfig = (files: VaultFiles, config: VaultConfig) =>
	files.write(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)

// --- Notes ---------------------------------------------------------------

export function splitNote(text: string, yaml: Yaml) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
	if (!match) return { meta: {} as Meta, body: text.trim() }
	const meta = (yaml.parse(match[1]) ?? {}) as Meta
	return {
		meta: typeof meta === 'object' && !Array.isArray(meta) ? meta : {},
		body: text.slice(match[0].length).trim(),
	}
}
const render = (yaml: Yaml, meta: Meta, body: string) => {
	const kept = Object.fromEntries(
		Object.entries(meta).filter(
			([, value]) =>
				value !== undefined &&
				value !== null &&
				!(Array.isArray(value) && !value.length) &&
				!(
					typeof value === 'object' &&
					!Array.isArray(value) &&
					!Object.keys(value).length
				),
		),
	)
	return `---\n${yaml.stringify(kept).trimEnd()}\n---\n\n${body.trim()}\n`
}

export async function sha256(text: string) {
	const bytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	)
	return Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('')
}

/** A file or folder name valid on every platform Obsidian runs on. */
export function safeName(name: string, fallback: string) {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]\p{Cc}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[\s.]+|[\s.]+$/g, '')
		.slice(0, 100)
		.trim()
	return cleaned || fallback
}
export const chapterFileName = (sequence: number, title: string) =>
	`${String(sequence).padStart(2, '0')} ${safeName(title, 'Untitled')}`

const dirname = (path: string) => path.split('/').slice(0, -1).join('/')
const basename = (path: string) =>
	(path.split('/').at(-1) ?? '').replace(/\.md$/, '')
const join = (...parts: string[]) => parts.filter(Boolean).join('/')
const str = (value: unknown) =>
	typeof value === 'string' ? value : value == null ? '' : String(value)
const list = (value: unknown) =>
	(Array.isArray(value) ? value : value ? [value] : []).map(str).filter(Boolean)
/** As a value hashes: an empty list or a missing value is no value, as the note writes it. */
const norm = (value: unknown) =>
	value === undefined || (Array.isArray(value) && !value.length) ? null : value
const link = (name: string) => `[[${name}]]`
const unlink = (value: unknown) =>
	str(value)
		.replace(/^\[\[|\]\]$/g, '')
		.split('|')[0]
		.trim()

/** Entry body: the summary, then a `## Title` section per text field. */
export function entryBody(
	summary: string | null,
	fields: { title: string; private: boolean; text: string | null }[],
) {
	const sections = fields.map((field) =>
		`## ${field.title}${field.private ? ' (private)' : ''}\n\n${field.text ?? ''}`.trim(),
	)
	return [summary ?? '', ...sections].filter(Boolean).join('\n\n')
}
export function parseEntryBody(body: string) {
	const [summary, ...sections] = body.split(/^## /m)
	return {
		summary: summary.trim(),
		fields: sections.map((section) => {
			const [heading, ...rest] = section.split('\n')
			return {
				title: heading.replace(/\s*\(private\)\s*$/, '').trim(),
				text: rest.join('\n').trim(),
			}
		}),
	}
}
const TEXT_FIELDS = ['text', 'textarea']
/** Titles of the sections a body marks `(private)`. */
const privateTitles = (body: string) =>
	new Set(
		[...body.matchAll(/^## (.*?)\s*\(private\)\s*$/gm)].map((match) =>
			match[1].trim(),
		),
	)
/**
 * The API makes every new section public: a new one marked private, or one
 * right after a private section (a `## ` line in private text), is refused.
 */
function refuseNewPrivate(
	body: string,
	fields: { title: string }[],
	known: Set<string>,
) {
	const hidden = privateTitles(body)
	if (
		fields.some(
			(field, index) =>
				!known.has(field.title) &&
				(hidden.has(field.title) ||
					(index > 0 && hidden.has(fields[index - 1].title))),
		)
	)
		throw new LiteraryUniverseApiError(
			'BAD_USER_INPUT',
			'New sections are public on Literary Universe: add a private section on the site, and keep lines starting with "## " out of private text',
		)
}

// --- Engine --------------------------------------------------------------

/**
 * Errors that stop the whole sync instead of one item. FORBIDDEN isn't one:
 * an item you can read but not edit must not block the rest.
 */
const fatal = (error: unknown) =>
	error instanceof LiteraryUniverseApiError &&
	[
		'UNAUTHENTICATED',
		'RATE_LIMITED',
		'REDIRECTED',
		'INVALID_CONFIGURATION',
	].includes(error.code)
const describe = (error: unknown) =>
	error instanceof LiteraryUniverseApiError
		? `${error.code}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`
		: String(error)

async function all<T>(
	page: (after?: string) => Promise<{
		nodes: T[]
		pageInfo: { endCursor?: string | null; hasNextPage: boolean }
	}>,
) {
	const nodes: T[] = []
	let after: string | undefined
	do {
		const result = await page(after)
		nodes.push(...result.nodes)
		after = result.pageInfo.hasNextPage
			? (result.pageInfo.endCursor ?? undefined)
			: undefined
	} while (after)
	return nodes
}

type Options = {
	client: Client
	files: VaultFiles
	yaml: Yaml
	scope: VaultScope
	language?: string
}

/** Pull, never overwriting an edited note, then push what changed locally. */
export async function syncVault(options: Options): Promise<SyncReport> {
	return new Sync(options).run()
}

export type NoteStatus = {
	path: string
	kind: string
	/** `edited` is pushed by the next sync; `conflict` waits for its copy to go; `new` is created. */
	state: 'edited' | 'conflict' | 'new'
}
/** What the next sync would push, read offline from the notes alone. */
export async function vaultStatus(
	options: Omit<Options, 'client' | 'language'>,
): Promise<NoteStatus[]> {
	const sync = new Sync({ ...options, client: undefined as unknown as Client })
	await sync.index()
	const found: NoteStatus[] = []
	for (const note of sync.notes.values()) {
		const kind = str(note.meta.lu_kind) || 'chapter'
		if (['series', 'comic'].includes(kind)) continue
		const conflict = str(note.meta.lu_conflict)
		if (conflict && (await options.files.exists(conflict)))
			found.push({ path: note.path, kind, state: 'conflict' })
		else if (await sync.edited(kind, note))
			found.push({ path: note.path, kind, state: 'edited' })
	}
	for (const note of sync.fresh)
		found.push({ path: note.path, kind: str(note.meta.lu_kind), state: 'new' })
	return found.sort((a, b) => a.path.localeCompare(b.path))
}

class Sync {
	report: SyncReport = {
		created: [],
		updated: [],
		pushed: [],
		conflicts: [],
		failures: [],
	}
	/** Notes with sync state, by `kind:id:language`. */
	notes = new Map<string, Note>()
	/** Notes asking to become a chapter or entry. */
	fresh: Note[] = []
	/** Where each story's notes live. */
	storyDirs = new Map<string, string>()
	/** Server titles of each story's chapters in order, for reordering. */
	chapterOrder = new Map<string, Chapter[]>()
	/** The text last read or written for each note, to spot typing during the sync. */
	texts = new Map<string, string>()
	/** Notes the pull left out for their language; they are not pushed either. */
	skipped = new Set<string>()
	/** Notes typed into while a write was due; they sit out the rest of this sync. */
	deferred = new Set<Note>()
	/** Stories and entries the universe's pull listed; only they push. */
	listed = new Set<string>()
	storyLanguages = new Map<string, string>()

	constructor(readonly o: Options) {}

	key = (kind: string, id: string, language = '') => `${kind}:${id}:${language}`
	wanted = (language: string) =>
		!this.o.language || this.o.language === language

	async run() {
		await this.index()
		const { scope } = this.o
		if (scope.kind === 'universe') {
			await this.attempt('Universe', () => this.pullUniverse(scope.universeId))
			const stories = await all((after) =>
				this.o.client.stories({ first: 100, after }),
			)
			for (const story of stories)
				if (story.universeId === scope.universeId) {
					this.listed.add(story.id)
					await this.attempt(story.title, () =>
						this.pullStory(
							story.id,
							join('Stories', safeName(story.title, story.id)),
						),
					)
				}
			await this.attempt('Encyclopedia', () =>
				this.pullEntries(scope.universeId),
			)
			await this.attempt('Series', () => this.pullSeries(scope.universeId))
			await this.attempt('Comics', () => this.pullComics(scope.universeId))
		} else if (scope.kind === 'story') {
			await this.attempt('Story', () => this.pullStory(scope.storyId, ''))
		} else {
			const stories = await all((after) =>
				this.o.client.stories({ first: 100, after }),
			)
			for (const story of stories)
				await this.attempt(story.title, () =>
					this.pullStory(
						story.id,
						join(scope.folder, safeName(story.title, story.id)),
					),
				)
		}
		await this.push()
		return this.report
	}

	async attempt(label: string, work: () => Promise<unknown>) {
		try {
			await work()
		} catch (error) {
			if (fatal(error)) throw error
			this.report.failures.push(`${label}: ${describe(error)}`)
		}
	}

	async index() {
		const root = this.o.scope.kind === 'workshop' ? this.o.scope.folder : ''
		for (const path of await this.o.files.list()) {
			if (root && !path.startsWith(`${root}/`)) continue
			if (basename(path).endsWith(CONFLICT_SUFFIX)) continue
			const text = await this.o.files.read(path)
			if (text === undefined) continue
			const { meta, body } = splitNote(text, this.o.yaml)
			// Chapter notes from plugin versions before `lu_kind` carry `lu_story`.
			const kind = str(meta.lu_kind) || (meta.lu_story ? 'chapter' : '')
			if (!kind) continue
			this.texts.set(path, text)
			const note = { path, meta, body }
			if (!meta.lu_id) this.fresh.push(note)
			else
				this.notes.set(
					this.key(kind, str(meta.lu_id), str(meta.lu_language)),
					note,
				)
		}
	}

	/**
	 * Writes the note; false when it was left alone. A file typed into since it
	 * was read keeps its text and takes only the frontmatter this write
	 * changes (sync state, a new ID, a title or order from the server). A write
	 * that would replace the text is skipped, so the next sync weighs the
	 * typing against the server's text as a conflict.
	 */
	async save(note: Note) {
		if (this.deferred.has(note)) return false
		const last = this.texts.get(note.path)
		const current =
			last === undefined ? undefined : await this.o.files.read(note.path)
		if (current !== undefined && current !== last) {
			const read = splitNote(last as string, this.o.yaml)
			const typed = splitNote(current, this.o.yaml)
			// Through render, so values it leaves out compare as absent.
			const wanted = splitNote(
				render(this.o.yaml, note.meta, note.body),
				this.o.yaml,
			)
			const same = (a: unknown, b: unknown) =>
				JSON.stringify(a) === JSON.stringify(b)
			const skip = () => {
				// The note in memory goes back to the file as last read, typing aside.
				note.meta = read.meta
				note.body = read.body
				this.deferred.add(note)
				this.report.failures.push(
					`${note.path}: changed during sync; sync again`,
				)
				return false
			}
			if (wanted.body !== read.body) return skip()
			const meta = { ...typed.meta }
			for (const name of new Set([
				...Object.keys(wanted.meta),
				...Object.keys(read.meta),
			])) {
				if (same(wanted.meta[name], read.meta[name])) continue
				// Both sides changed this key: a new note keeps what was typed,
				// a synced one waits for the next sync to weigh them.
				if (
					!same(typed.meta[name], read.meta[name]) &&
					!same(typed.meta[name], wanted.meta[name])
				) {
					if (read.meta.lu_id) return skip()
					continue
				}
				if (wanted.meta[name] === undefined) delete meta[name]
				else meta[name] = wanted.meta[name]
			}
			note.meta = meta
			note.body = typed.body
		}
		const text = render(this.o.yaml, note.meta, note.body)
		await this.o.files.write(note.path, text)
		this.texts.set(note.path, text)
		return true
	}
	async move(note: Note, target: string) {
		await this.o.files.rename(note.path, target)
		const text = this.texts.get(note.path)
		this.texts.delete(note.path)
		if (text !== undefined) this.texts.set(target, text)
		note.path = target
	}
	/** A path not taken yet; two items can share a title. */
	async freePath(folder: string, name: string, id: string) {
		for (const suffix of ['', ` (${id.slice(0, 6)})`, ` (${id})`]) {
			const path = join(folder, `${name}${suffix}.md`)
			if (!(await this.o.files.exists(path))) return path
		}
		for (let count = 2; ; count++) {
			const path = join(folder, `${name} (${id}) ${count}.md`)
			if (!(await this.o.files.exists(path))) return path
		}
	}
	/** Keeps the note's file name in line with its title, in its own folder. */
	async rename(note: Note, name: string, id: string) {
		if (basename(note.path) === name) return
		await this.move(note, await this.freePath(dirname(note.path), name, id))
	}

	/**
	 * The shared rule for a note backed by a versioned item: create it, keep a
	 * local edit, take the server's, or keep both on a conflict. True when the
	 * note now holds the server's state.
	 */
	async merge(
		key: string,
		label: string,
		server: { meta: Meta; body: string; version: string; path?: string },
		edit: (note: Note) => Promise<string>,
		place: () => Promise<string>,
	) {
		server = { ...server, body: server.body.trim() }
		const note = this.notes.get(key)
		const serverHash = await edit({
			path: server.path ?? '',
			meta: server.meta,
			body: server.body,
		})
		const state = {
			...server.meta,
			lu_version: server.version,
			lu_hash: serverHash,
		}
		if (!note) {
			const created = { path: await place(), meta: state, body: server.body }
			await this.save(created)
			this.notes.set(key, created)
			this.report.created.push(created.path)
			return true
		}
		const local = await edit(note)
		const edited = local !== note.meta.lu_hash && local !== serverHash
		if (str(note.meta.lu_version) === server.version && edited) return false
		if (edited && serverHash === note.meta.lu_hash) {
			// Only the version moved (say, another language was saved): keep the
			// edit and take the server's sync state, so the push names the new version.
			// The folder stays where the author has it, so its category does too.
			const { lu_conflict: _, lu_category: __, ...synced } = Object.fromEntries(
				Object.entries(state).filter(([name]) => name.startsWith('lu_')),
			)
			note.meta = { ...note.meta, ...synced }
			await this.save(note)
			return false
		}
		if (!edited) {
			// Text the server has, but a conflict or an old hash still to record.
			if (
				local === serverHash &&
				str(note.meta.lu_version) === server.version &&
				note.meta.lu_hash === serverHash &&
				!note.meta.lu_conflict
			)
				return true
			note.meta = { ...note.meta, ...state }
			delete note.meta.lu_conflict
			note.body = server.body
			if (!(await this.save(note))) return false
			this.report.updated.push(note.path)
			return true
		}
		const copy = join(
			dirname(note.path),
			`${basename(note.path)}${CONFLICT_SUFFIX}.md`,
		)
		const shown = Object.fromEntries(
			Object.entries(server.meta).filter(([name]) => !name.startsWith('lu_')),
		)
		await this.o.files.write(copy, render(this.o.yaml, shown, server.body))
		// Rebase on the server version; the note waits while the copy exists.
		note.meta = { ...note.meta, lu_version: server.version, lu_conflict: copy }
		await this.save(note)
		this.report.conflicts.push(`${label}: ${note.path}`)
		return false
	}

	// --- Universe and story details ---

	universeMeta(universe: Universe): Meta {
		return {
			lu_kind: 'universe',
			lu_id: universe.id,
			title: universe.title,
			genre: universe.genre ?? undefined,
			rating: universe.rating ?? undefined,
			license: universe.license ?? undefined,
			ai_model: universe.aiModel ?? undefined,
		}
	}
	storyMeta(story: Story): Meta {
		return {
			lu_kind: 'story',
			lu_id: story.id,
			title: story.title,
			genres: story.genres,
			tags: story.tags,
			rating: story.rating ?? undefined,
			license: story.license ?? undefined,
			ai_model: story.aiModel ?? undefined,
		}
	}
	detailsHash = (fields: string[]) => (note: Note) =>
		sha256(
			JSON.stringify([
				fields.map((field) => norm(note.meta[field])),
				note.body,
			]),
		)
	universeHash = this.detailsHash([
		'title',
		'genre',
		'rating',
		'license',
		'ai_model',
	])
	storyHash = this.detailsHash([
		'title',
		'genres',
		'tags',
		'rating',
		'license',
		'ai_model',
	])
	translationHash = this.detailsHash(['title'])

	/** The AI model counts only when set, so notes without one keep their hash. */
	chapterHash = (note: Note) =>
		note.meta.ai_model
			? sha256(`${str(note.meta.ai_model)}\n${note.body}`)
			: sha256(note.body)

	/** Whether the note changed since its last sync. */
	async edited(kind: string, note: Note) {
		if (kind === 'chapter') {
			const original = note.meta.sequence !== undefined
			const meta = await this.chapterMetaHash(
				note.meta.title,
				original ? note.meta.sequence : 0,
			)
			return (
				(await this.chapterHash(note)) !== note.meta.lu_hash ||
				Boolean(note.meta.lu_meta && meta !== note.meta.lu_meta)
			)
		}
		const hasher =
			kind === 'entry'
				? this.entryHash
				: kind === 'story'
					? this.storyHash
					: kind === 'universe'
						? this.universeHash
						: this.translationHash
		return (await hasher(note)) !== note.meta.lu_hash
	}

	async pullUniverse(id: string) {
		const universe = await this.o.client.universe({ id })
		if (!universe)
			throw new LiteraryUniverseApiError('NOT_FOUND', 'Universe not found')
		if (!this.wanted(universe.language))
			this.skipped.add(this.key('universe', id))
		else
			await this.merge(
				this.key('universe', id),
				'Universe',
				{
					meta: this.universeMeta(universe),
					body: universe.description ?? '',
					version: universe.version,
				},
				this.universeHash,
				() => this.freePath('', 'Universe', id),
			)
		for (const translation of universe.translations)
			if (this.wanted(translation.language))
				await this.merge(
					this.key('universe-translation', id, translation.language),
					`Universe (${translation.language})`,
					{
						meta: {
							lu_kind: 'universe-translation',
							lu_id: id,
							lu_language: translation.language,
							title: translation.title,
						},
						body: translation.description ?? '',
						version: String(translation.revision),
					},
					this.translationHash,
					() => this.freePath('', `Universe.${translation.language}`, id),
				)
	}

	async pullStory(id: string, folder: string) {
		const story = await this.o.client.story({ id })
		if (!story)
			throw new LiteraryUniverseApiError('NOT_FOUND', 'Story not found')
		const key = this.key('story', id)
		const existing = this.notes.get(key)
		// Two stories can share a title; each gets its own folder.
		const taken =
			folder &&
			([...this.storyDirs.values()].includes(folder) ||
				[...this.notes.values()].some(
					(note) =>
						note.meta.lu_kind === 'story' &&
						note.meta.lu_id !== id &&
						dirname(note.path) === folder,
				))
		const dir = existing
			? dirname(existing.path)
			: taken
				? `${folder} (${id.slice(0, 6)})`
				: folder
		this.storyDirs.set(id, dir)
		this.storyLanguages.set(id, story.language)
		await this.merge(
			key,
			story.title,
			{
				meta: this.storyMeta(story),
				body: story.description ?? '',
				version: story.version,
			},
			this.storyHash,
			() => this.freePath(dir, 'Story', id),
		)
		for (const language of [story.language, ...story.translations])
			if (this.wanted(language))
				await this.attempt(`${story.title} (${language})`, () =>
					this.pullChapters(story, language, dir),
				)
	}

	chapterMetaHash = (title: unknown, sequence: unknown) =>
		sha256(JSON.stringify([str(title), Number(sequence) || 0]))

	async pullChapters(story: Story, language: string, dir: string) {
		const original = language === story.language
		const chapters = await all((after) =>
			this.o.client.chapters({
				storyId: story.id,
				language,
				first: 100,
				after,
			}),
		)
		// The API pages chapters by ID; their order is `sequence`.
		chapters.sort((a, b) => a.sequence - b.sequence)
		if (original) this.chapterOrder.set(story.id, chapters)
		for (const chapter of chapters) {
			if (!chapter.hasDraft) continue
			await this.attempt(`${story.title} / ${chapter.title}`, () =>
				this.pullChapter(story, chapter, language, original, dir),
			)
		}
	}

	async pullChapter(
		story: Story,
		chapter: Chapter,
		language: string,
		original: boolean,
		dir: string,
	) {
		const key = this.key('chapter', chapter.id, language)
		const note = this.notes.get(key)
		const sequence = chapter.sequence + 1
		const name = `${chapterFileName(sequence, chapter.title)}${original ? '' : `.${language}`}`
		const serverMeta = await this.chapterMetaHash(
			chapter.title,
			original ? sequence : 0,
		)
		if (note) {
			// Title and order: whichever side changed since the last sync wins.
			const localMeta = await this.chapterMetaHash(
				note.meta.title,
				original ? note.meta.sequence : 0,
			)
			const base = note.meta.lu_meta
			if (!base || (localMeta === base && serverMeta !== base)) {
				note.meta.title = chapter.title
				if (original) note.meta.sequence = sequence
				note.meta.lu_meta = serverMeta
				if (await this.save(note)) await this.rename(note, name, chapter.id)
			} else if (
				original &&
				serverMeta !== base &&
				Number(note.meta.sequence) !== sequence &&
				(await this.chapterMetaHash(chapter.title, note.meta.sequence)) ===
					base
			) {
				// Renamed here, reordered there: take the order, keep the new title.
				note.meta.sequence = sequence
				note.meta.lu_meta = serverMeta
				if (await this.save(note))
					await this.rename(
						note,
						chapterFileName(sequence, str(note.meta.title)),
						chapter.id,
					)
			} else if (
				original &&
				serverMeta !== base &&
				str(note.meta.title) !== chapter.title &&
				(await this.chapterMetaHash(note.meta.title, sequence)) === base
			) {
				// Reordered here, renamed there: take the title, keep the new order
				// (the reorder push records it and renames the file).
				note.meta.title = chapter.title
				note.meta.lu_meta = serverMeta
				await this.save(note)
			}
		}
		const fresh =
			!note ||
			!note.meta.lu_updated ||
			// A resolved conflict is merged again against the server's text.
			Boolean(note.meta.lu_conflict) ||
			note.meta.lu_updated !== chapter.updatedAt ||
			// One version for every language: a save in another one moves it.
			str(note.meta.lu_version) !== chapter.version
		if (!fresh) return
		const draft = await this.o.client.draft({ id: chapter.id, language })
		// Plugin 0.2.1 hashed the body alone; with the server on the same model,
		// such a note is as synced.
		if (
			note?.meta.ai_model &&
			str(note.meta.ai_model) === str(draft.aiModel) &&
			note.meta.lu_hash === (await sha256(note.body))
		)
			note.meta.lu_hash = await this.chapterHash(note)
		await this.merge(
			key,
			`${story.title} / ${chapter.title}`,
			{
				meta: {
					lu_kind: 'chapter',
					lu_id: draft.id,
					lu_story: story.id,
					lu_language: draft.language,
					lu_updated: chapter.updatedAt,
					title: note?.meta.title ?? draft.title,
					sequence: original ? (note?.meta.sequence ?? sequence) : undefined,
					lu_meta: note?.meta.lu_meta ?? serverMeta,
					ai_model: draft.aiModel ?? undefined,
				},
				body: draft.markdown ?? '',
				version: draft.version,
			},
			this.chapterHash,
			async () => this.freePath(dir, name, chapter.id),
		)
		// A header seen as is needs no fetch next time, even when the note was kept.
		const kept = this.notes.get(key)
		if (kept && kept.meta.lu_updated !== chapter.updatedAt) {
			kept.meta.lu_updated = chapter.updatedAt
			await this.save(kept)
		}
	}

	// --- Encyclopedia ---

	entryHash = async (note: Note) =>
		sha256(
			JSON.stringify([
				['name', 'pronunciation', 'tags', 'parent', 'related', 'ai_model'].map(
					(field) => norm(note.meta[field]),
				),
				note.meta.lu_language ? null : basename(dirname(note.path)),
				note.body,
			]),
		)

	entryNote(entry: Entry, original: boolean): { meta: Meta; body: string } {
		const fields = entry.fields.filter((field) =>
			TEXT_FIELDS.includes(field.type),
		)
		return {
			meta: {
				lu_kind: 'entry',
				lu_id: entry.id,
				lu_language: original ? undefined : entry.language,
				// The category the note's folder stands for; a move here changes the folder.
				lu_category: original
					? (entry.categoryTitle ?? 'Uncategorized')
					: undefined,
				lu_released: Object.fromEntries(
					entry.released
						.filter((release) => release.language === entry.language)
						.map((release) => [
							release.audience.toLowerCase(),
							release.version === entry.version
								? release.revision
								: `${release.revision} (draft changed since)`,
						]),
				),
				name: entry.name,
				pronunciation: entry.pronunciation ?? undefined,
				tags: entry.tags,
				parent: original && entry.parent ? link(entry.parent.name) : undefined,
				related: original
					? entry.related.map((item) => link(item.name))
					: undefined,
				ai_model: entry.aiModel ?? undefined,
			},
			body: entryBody(entry.summary, fields),
		}
	}

	async pullEntries(universeId: string) {
		const headers = await all((after) =>
			this.o.client.encyclopediaEntries({ universeId, first: 100, after }),
		)
		for (const header of headers) this.listed.add(header.id)
		for (const header of headers)
			for (const edition of header.editions) {
				const original = edition.language === header.language
				const key = this.key(
					'entry',
					header.id,
					original ? '' : edition.language,
				)
				if (!this.wanted(edition.language)) {
					this.skipped.add(key)
					continue
				}
				const note = this.notes.get(key)
				if (
					note &&
					!note.meta.lu_conflict &&
					str(note.meta.lu_version) === edition.version
				) {
					// A release leaves the draft alone; refresh only `lu_released`.
					const revisions = Object.values(
						(note.meta.lu_released ?? {}) as Meta,
					)
						.map((value) => Number.parseInt(str(value), 10))
						.filter(Number.isFinite)
					const newest = revisions.length ? Math.max(...revisions) : null
					if ((edition.releasedRevision ?? null) !== newest)
						await this.attempt(`Encyclopedia / ${header.name}`, async () => {
							const entry = await this.o.client.encyclopediaEntry({
								id: header.id,
								language: original ? undefined : edition.language,
							})
							if (!entry) return
							note.meta.lu_released = this.entryNote(
								entry,
								original,
							).meta.lu_released
							if (await this.save(note)) this.report.updated.push(note.path)
						})
					continue
				}
				await this.attempt(`Encyclopedia / ${header.name}`, async () => {
					const entry = await this.o.client.encyclopediaEntry({
						id: header.id,
						language: original ? undefined : edition.language,
					})
					if (!entry) return
					const category = safeName(
						entry.categoryTitle ?? 'Uncategorized',
						'Uncategorized',
					)
					const originalNote = this.notes.get(this.key('entry', header.id, ''))
					// The category is the folder: an entry moved on the site moves here.
					const folder = join(
						originalNote ? dirname(dirname(originalNote.path)) : 'Encyclopedia',
						category,
					)
					const name = safeName(entry.name, entry.id)
					const pulled = this.entryNote(entry, original)
					if (!original) {
						const source = await this.o.client.encyclopediaEntry({
							id: header.id,
						})
						pulled.meta.lu_fields = Object.fromEntries(
							entry.fields.map((field) => [
								field.title,
								source?.fields.find((item) => item.id === field.id)?.title ??
									field.title,
							]),
						)
					}
					const took = await this.merge(
						key,
						`Encyclopedia / ${entry.name}`,
						{
							...pulled,
							version: entry.version,
							path: join(folder, 'entry.md'),
						},
						this.entryHash,
						async () =>
							this.freePath(
								originalNote && !original ? dirname(originalNote.path) : folder,
								original ? name : `${name}.${edition.language}`,
								entry.id,
							),
					)
					// A note kept for its local edit stays where the author put it.
					const merged = this.notes.get(key)
					if (original && took && merged && dirname(merged.path) !== folder) {
						await this.move(
							merged,
							await this.freePath(folder, basename(merged.path), entry.id),
						)
					}
				})
			}
	}

	// --- Read-only notes ---

	async pullSeries(universeId: string) {
		const series = await this.o.client.series({ universeId })
		const stories = new Map(
			[...this.notes.values()]
				.filter((note) => note.meta.lu_kind === 'story')
				.map((note) => [
					str(note.meta.lu_id),
					basename(dirname(note.path)) || str(note.meta.title),
				]),
		)
		const body = series
			.map(
				(item) =>
					`## ${item.title}\n\n${item.storyIds
						.map(
							(id, index) =>
								`${index + 1}. ${stories.has(id) ? link(stories.get(id) as string) : id}`,
						)
						.join('\n')}`,
			)
			.join('\n\n')
		await this.readOnly(
			this.notes.get(this.key('series', universeId))?.path ??
				(await this.freePath('', 'Series', universeId)),
			{ lu_kind: 'series', lu_id: universeId },
			body,
		)
	}

	async pullComics(universeId: string) {
		const comics = await all((after) =>
			this.o.client.comics({ first: 100, after }),
		)
		for (const comic of comics.filter(
			(item) => item.universeId === universeId,
		)) {
			const key = this.key('comic', comic.id)
			const path =
				this.notes.get(key)?.path ??
				(await this.freePath(
					'Comics',
					safeName(comic.title, comic.id),
					comic.id,
				))
			await this.readOnly(
				path,
				{
					lu_kind: 'comic',
					lu_id: comic.id,
					title: comic.title,
					format: comic.format,
					genres: comic.genres,
					chapters: comic.chaptersCount,
					pages: comic.pageCountTotal,
					ai_model: comic.aiModel ?? undefined,
				},
				comic.description,
			)
		}
	}

	/** Written from Literary Universe on every sync; edit these there. */
	async readOnly(path: string, meta: Meta, body: string) {
		const text = render(
			this.o.yaml,
			{
				...meta,
				lu_read_only: 'Edit this on Literary Universe; sync replaces it.',
			},
			body,
		)
		if ((await this.o.files.read(path)) === text) return
		const existed = await this.o.files.exists(path)
		await this.o.files.write(path, text)
		;(existed ? this.report.updated : this.report.created).push(path)
	}

	// --- Push ---

	/** Push only what the pull covers: the wanted languages and, in story scope, that story. */
	inScope(kind: string, note: Note, key: string) {
		const language = str(note.meta.lu_language)
		if (language ? !this.wanted(language) : this.skipped.has(key)) return false
		const { scope } = this.o
		const id = str(note.meta.lu_id)
		if (scope.kind === 'universe') {
			// A note copied in from another universe's folder stays out.
			if (kind === 'universe' || kind === 'universe-translation')
				return id === scope.universeId
			return this.listed.has(kind === 'chapter' ? str(note.meta.lu_story) : id)
		}
		if (scope.kind !== 'story') return true
		if (kind === 'chapter') return str(note.meta.lu_story) === scope.storyId
		return kind === 'story' && id === scope.storyId
	}

	async push() {
		for (const [key, note] of [...this.notes]) {
			const kind = str(note.meta.lu_kind) || 'chapter'
			if (['series', 'comic'].includes(kind)) continue
			if (!this.inScope(kind, note, key) || this.deferred.has(note)) continue
			if (note.meta.lu_conflict) {
				if (await this.o.files.exists(str(note.meta.lu_conflict))) {
					if (!this.report.conflicts.some((line) => line.endsWith(note.path)))
						this.report.conflicts.push(`Unresolved: ${note.path}`)
					continue
				}
				delete note.meta.lu_conflict
			}
			await this.attempt(note.path, () => this.pushNote(kind, note))
		}
		await this.pushOrder()
		for (const note of this.fresh)
			await this.attempt(note.path, () => this.create(note))
	}

	async pushNote(kind: string, note: Note) {
		const { client } = this.o
		const id = str(note.meta.lu_id)
		const aiModel = str(note.meta.ai_model) || undefined
		if (kind === 'chapter') {
			const original = note.meta.sequence !== undefined
			const title = str(note.meta.title)
			const metaHash = await this.chapterMetaHash(
				title,
				original ? note.meta.sequence : 0,
			)
			if (note.meta.lu_meta && metaHash !== note.meta.lu_meta && title) {
				const header = this.chapterOrder
					.get(str(note.meta.lu_story))
					?.find((chapter) => chapter.id === id)
				if (!header || header.title !== title || !original) {
					await client.renameChapter({
						id,
						title,
						language: original ? undefined : str(note.meta.lu_language),
					})
					// pushOrder records the title in `lu_meta` only once the server has it.
					if (header) header.title = title
				}
				if (!original) {
					note.meta.lu_meta = metaHash
					await this.save(note)
				}
				// The original's new sequence is saved after the reorder.
			}
			const hash = await this.chapterHash(note)
			if (hash === note.meta.lu_hash) return
			const expectedVersion = str(note.meta.lu_version)
			const language = str(note.meta.lu_language)
			const saved = await client.saveDraft({
				id,
				language,
				expectedVersion,
				markdown: note.body,
				aiModel,
				operationId: await sha256(
					`${id}:${language}:${expectedVersion}:${hash}`,
				),
			})
			note.meta.lu_version = saved.version
			note.meta.lu_hash = hash
			note.meta.lu_updated = saved.draft.updatedAt
			await this.save(note)
			this.report.pushed.push(note.path)
			// The server took expectedVersion, so no other language changed meanwhile.
			for (const [key, other] of this.notes)
				if (
					other !== note &&
					key.startsWith(`chapter:${id}:`) &&
					str(other.meta.lu_version) === expectedVersion &&
					this.inScope('chapter', other, key)
				) {
					// The disclosure covers the whole chapter: an unedited language
					// takes it; an edited one pushes its own next.
					if (
						aiModel &&
						str(other.meta.ai_model) !== aiModel &&
						(await this.chapterHash(other)) === other.meta.lu_hash
					) {
						other.meta.ai_model = aiModel
						other.meta.lu_hash = await this.chapterHash(other)
					}
					other.meta.lu_version = saved.version
					await this.save(other)
				}
			return
		}
		const hasher =
			kind === 'entry'
				? this.entryHash
				: kind === 'story'
					? this.storyHash
					: kind === 'universe'
						? this.universeHash
						: this.translationHash
		let hash = await hasher(note)
		if (hash === note.meta.lu_hash) return
		const expectedVersion = str(note.meta.lu_version) || undefined
		/** The version read back, unless an edit on the site landed after the push. */
		const readBack = async (meta: Meta, body: string | null | undefined, version: string) =>
			(await hasher({ path: note.path, meta, body: (body ?? '').trim() })) === hash
				? version
				: note.meta.lu_version
		if (kind === 'story') {
			await client.updateStory({
				storyId: id,
				expectedVersion,
				input: {
					title: str(note.meta.title),
					description: note.body,
					...(list(note.meta.genres).length
						? { genres: list(note.meta.genres) }
						: {}),
					tags: list(note.meta.tags),
					...(note.meta.rating ? { rating: str(note.meta.rating) } : {}),
					...(note.meta.license ? { license: str(note.meta.license) } : {}),
					aiModel,
				},
			})
			const story = await client.story({ id })
			if (story)
				note.meta.lu_version = await readBack(
					this.storyMeta(story),
					story.description,
					story.version,
				)
		} else if (kind === 'universe') {
			await client.updateUniverse({
				universeId: id,
				expectedVersion,
				input: {
					title: str(note.meta.title),
					description: note.body,
					...(note.meta.genre ? { genre: str(note.meta.genre) } : {}),
					...(note.meta.rating ? { rating: str(note.meta.rating) } : {}),
					...(note.meta.license ? { license: str(note.meta.license) } : {}),
					aiModel,
				},
			})
			const universe = await client.universe({ id })
			if (universe)
				note.meta.lu_version = await readBack(
					this.universeMeta(universe),
					universe.description,
					universe.version,
				)
		} else if (kind === 'universe-translation') {
			const saved = await client.updateUniverseTranslation({
				universeId: id,
				language: str(note.meta.lu_language),
				expectedRevision: Number(note.meta.lu_version),
				input: { title: str(note.meta.title), description: note.body },
			})
			note.meta.lu_version = String(saved.revision)
		} else if (kind === 'entry') {
			// The note shows what the server kept, such as a section deleted here.
			const entry = await this.pushEntry(note, id, expectedVersion, aiModel)
			const pulled = this.entryNote(entry, !note.meta.lu_language)
			const sent = { meta: note.meta, body: note.body }
			// A category renamed on the site leaves the folder as it is, and with it
			// the category it stands for.
			if (
				note.meta.lu_category !== undefined &&
				safeName(str(pulled.meta.lu_category), 'Uncategorized') !==
					basename(dirname(note.path))
			)
				pulled.meta.lu_category = note.meta.lu_category
			note.meta = { ...note.meta, ...pulled.meta, lu_version: entry.version }
			note.body = pulled.body
			note.meta.lu_hash = await this.entryHash(note)
			await this.record(note, sent)
			this.report.pushed.push(note.path)
			return
		}
		note.meta.lu_hash = hash
		await this.save(note)
		this.report.pushed.push(note.path)
	}

	/**
	 * Saves an entry note rewritten from the server's answer. One typed into
	 * meanwhile keeps its text, recorded as sent, so the typing pushes next.
	 */
	async record(note: Note, sent: { meta: Meta; body: string }) {
		const state = Object.fromEntries(
			Object.entries(note.meta).filter(([name]) => name.startsWith('lu_')),
		)
		const failures = this.report.failures.length
		if (await this.save(note)) return
		this.report.failures.length = failures
		this.deferred.delete(note)
		// The text and frontmatter as sent, with the new sync state.
		note.meta = {
			...Object.fromEntries(
				Object.entries(sent.meta).filter(([name]) => !name.startsWith('lu_')),
			),
			...state,
		}
		note.body = sent.body
		note.meta.lu_hash = await this.entryHash(note)
		await this.save(note)
	}

	async pushEntry(
		note: Note,
		id: string,
		expectedVersion: string | undefined,
		aiModel: string | undefined,
	) {
		const { client } = this.o
		const parsed = parseEntryBody(note.body)
		const language = str(note.meta.lu_language)
		const current = await client.encyclopediaEntry({
			id,
			language: language || undefined,
		})
		// A body as pulled sends no text: a `## ` line inside a field would split it.
		const pulled = current && this.entryNote(current, !language).body.trim()
		const same = current && note.body === pulled
		// Where the server's own text doesn't parse back to its fields, an edit
		// can't be told apart from a split field, which would become a new
		// (public) field: leave such an entry to the site.
		if (
			current &&
			!same &&
			JSON.stringify(parseEntryBody(pulled as string)) !==
				JSON.stringify({
					summary: (current.summary ?? '').trim(),
					fields: current.fields
						.filter((field) => TEXT_FIELDS.includes(field.type))
						.map((field) => ({
							title: field.title,
							text: (field.text ?? '').trim(),
						})),
				})
		)
			throw new LiteraryUniverseApiError(
				'BAD_USER_INPUT',
				'A section of this entry has a line starting with "## " inside its text; edit the entry on Literary Universe',
			)
		// Only text that changed: the server rebuilds rich text from what it gets.
		const summary =
			!same && parsed.summary !== (current?.summary ?? '').trim()
				? parsed.summary
				: undefined
		const fields = parsed.fields.filter(
			(field) =>
				!same &&
				field.text !==
				(
					current?.fields.find((item) => item.title === field.title)?.text ??
					''
				).trim(),
		)
		if (language) {
			const titles = (note.meta.lu_fields ?? {}) as Record<string, string>
			return client.translateEncyclopediaEntry({
				id,
				language,
				expectedVersion,
				name: str(note.meta.name) || undefined,
				pronunciation: str(note.meta.pronunciation),
				summary,
				fields: fields.map((field) => ({
					title: titles[field.title] ?? field.title,
					translatedTitle: field.title,
					text: field.text,
				})),
			})
		}
		if (!same)
			refuseNewPrivate(
				note.body,
				parsed.fields,
				new Set(current?.fields.map((field) => field.title)),
			)
		const parent = unlink(note.meta.parent)
		const related = list(note.meta.related).map(unlink)
		// The folder is the category as a file name; send it only when the note moved.
		const folder = basename(dirname(note.path))
		// Against the category last synced: one renamed on the site is no move.
		const category = safeName(
			str(note.meta.lu_category) || current?.categoryTitle || 'Uncategorized',
			'Uncategorized',
		)
		return client.updateEncyclopediaEntry({
			id,
			expectedVersion,
			changes: {
				relatedRemove: (current?.related ?? [])
					.map((item) => item.name)
					.filter((name) => !related.includes(name)),
				name: str(note.meta.name) || basename(note.path),
				pronunciation: str(note.meta.pronunciation),
				tags: list(note.meta.tags),
				categoryTitle: folder !== category ? folder : undefined,
				parentName: parent || null,
				relatedAdd: related,
				summary,
				fields,
				aiModel,
			},
		})
	}

	/** Chapters whose `sequence` changed locally go where it says; the rest keep their order. */
	async pushOrder() {
		for (const [storyId, chapters] of this.chapterOrder)
			await this.attempt(
				`Chapter order of ${this.storyDirs.get(storyId) || storyId}`,
				() => this.pushStoryOrder(storyId, chapters),
			)
	}

	async pushStoryOrder(storyId: string, chapters: Chapter[]) {
		const notes = chapters.map((chapter) =>
			this.notes.get(this.key('chapter', chapter.id, chapter.language)),
		)
		// A note waiting on its conflict copy neither moves nor is moved.
		const held = (note?: Note) => Boolean(note?.meta.lu_conflict)
		// Moved: a numeric `sequence` other than the chapter's place. A new title is no move.
		const targets = chapters.map((chapter, index) => {
			const sequence = notes[index]?.meta.sequence
			return !held(notes[index]) &&
				typeof sequence === 'number' &&
				Number.isFinite(sequence) &&
				sequence !== chapter.sequence + 1
				? sequence
				: undefined
		})
		const indexes = chapters.map((_, index) => index)
		const moved = indexes
			.filter((index) => targets[index] !== undefined)
			.sort(
				(a, b) => Number(targets[a]) - Number(targets[b]) || a - b,
			)
		if (moved.length) {
			// Fill the places in turn: a moved chapter once its place is reached, else the next unmoved.
			const unmoved = indexes.filter((index) => targets[index] === undefined)
			const order = indexes.map((position) => {
				const next =
					moved.length &&
					(!unmoved.length || Number(targets[moved[0]]) <= position + 1)
						? moved.shift()
						: unmoved.shift()
				return chapters[next as number].id
			})
			if (order.some((id, index) => id !== chapters[index].id)) {
				await this.o.client.reorderChapters({ storyId, chapterIds: order })
				this.report.pushed.push(
					`Chapter order of ${this.storyDirs.get(storyId) || storyId}`,
				)
			}
			order.forEach((id, index) => {
				const note = this.notes.get(
					this.key('chapter', id, chapters[0].language),
				)
				if (note && !held(note)) note.meta.sequence = index + 1
			})
		}
		for (const [index, note] of notes.entries()) {
			// A title the server doesn't have yet (its rename failed) stays pending.
			if (
				!note ||
				held(note) ||
				chapters[index].title !== str(note.meta.title) ||
				!Number.isFinite(note.meta.sequence)
			)
				continue
			const hash = await this.chapterMetaHash(
				note.meta.title,
				note.meta.sequence,
			)
			// A move that left the order as it was still rewrites its `sequence`.
			if (hash === note.meta.lu_meta && targets[index] === undefined) continue
			note.meta.lu_meta = hash
			if (await this.save(note))
				await this.rename(
					note,
					chapterFileName(Number(note.meta.sequence), str(note.meta.title)),
					str(note.meta.lu_id),
				)
		}
	}

	/** A note with `lu_kind` and no `lu_id` becomes a new chapter or entry. */
	async create(note: Note) {
		const { client } = this.o
		const kind = str(note.meta.lu_kind)
		const aiModel = str(note.meta.ai_model) || undefined
		if (kind === 'chapter') {
			const dir = dirname(note.path)
			const storyId = [...this.storyDirs].find(
				([, folder]) => folder === dir,
			)?.[0]
			if (!storyId)
				throw new LiteraryUniverseApiError(
					'BAD_USER_INPUT',
					'A new chapter belongs in a story folder, next to its Story.md',
				)
			const language = this.storyLanguages.get(storyId) ?? ''
			const asked = str(note.meta.lu_language)
			if (asked && asked !== language)
				throw new LiteraryUniverseApiError(
					'BAD_USER_INPUT',
					`A new chapter is created in the story's language (${language}); create it there first, then translate it`,
				)
			if (!this.wanted(language)) return
			const title =
				str(note.meta.title) || basename(note.path).replace(/^\d+\s+/, '')
			const created = await client.createChapter({
				storyId,
				title,
				markdown: note.body,
				aiModel,
				operationId: await sha256(`${storyId}:${note.path}:${note.body}`),
			})
			const draft = await client.draft({
				id: created.id,
				language: created.language,
			})
			note.meta = {
				...note.meta,
				lu_id: created.id,
				lu_story: storyId,
				lu_language: created.language,
				lu_version: created.version,
				lu_hash: await this.chapterHash(note),
				lu_updated: draft.updatedAt,
				title: created.title,
				sequence: created.sequence + 1,
				lu_meta: await this.chapterMetaHash(
					created.title,
					created.sequence + 1,
				),
			}
			if (await this.save(note))
				await this.rename(
					note,
					chapterFileName(created.sequence + 1, created.title),
					created.id,
				)
			this.report.pushed.push(note.path)
			return
		}
		if (kind === 'entry' && this.o.scope.kind === 'universe') {
			// A new entry is written in the universe's language.
			if (this.skipped.has(this.key('universe', this.o.scope.universeId)))
				return
			const parsed = parseEntryBody(note.body)
			refuseNewPrivate(note.body, parsed.fields, new Set())
			const name = str(note.meta.name) || basename(note.path)
			const parent = unlink(note.meta.parent)
			const entry = await client.createEncyclopediaEntry({
				universeId: this.o.scope.universeId,
				name,
				categoryTitle: basename(dirname(note.path)),
				pronunciation: str(note.meta.pronunciation) || undefined,
				tags: list(note.meta.tags),
				parentName: parent || undefined,
				relatedAdd: list(note.meta.related).map(unlink),
				summary: parsed.summary,
				fields: parsed.fields,
				aiModel,
			})
			const pulled = this.entryNote(entry, true)
			const sent = { meta: note.meta, body: note.body }
			note.meta = { ...pulled.meta, lu_version: entry.version }
			note.body = pulled.body
			note.meta.lu_hash = await this.entryHash(note)
			await this.record(note, sent)
			this.report.pushed.push(note.path)
			return
		}
		throw new LiteraryUniverseApiError(
			'BAD_USER_INPUT',
			`Only chapters and, in a universe, encyclopedia entries can be created from a note (lu_kind: ${kind})`,
		)
	}
}
