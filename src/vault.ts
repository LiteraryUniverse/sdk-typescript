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
				if (story.universeId === scope.universeId)
					await this.attempt(story.title, () =>
						this.pullStory(
							story.id,
							join('Stories', safeName(story.title, story.id)),
						),
					)
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
			const note = { path, meta, body }
			if (!meta.lu_id) this.fresh.push(note)
			else
				this.notes.set(
					this.key(kind, str(meta.lu_id), str(meta.lu_language)),
					note,
				)
		}
	}

	async save(note: Note) {
		await this.o.files.write(
			note.path,
			render(this.o.yaml, note.meta, note.body),
		)
	}
	/** A path not taken yet; two items can share a title. */
	async freePath(folder: string, name: string, id: string) {
		const path = join(folder, `${name}.md`)
		return (await this.o.files.exists(path))
			? join(folder, `${name} (${id.slice(0, 6)}).md`)
			: path
	}
	/** Keeps the note's file name in line with its title, in its own folder. */
	async rename(note: Note, name: string, id: string) {
		if (basename(note.path) === name) return
		const target = await this.freePath(dirname(note.path), name, id)
		await this.o.files.rename(note.path, target)
		note.path = target
	}

	/**
	 * The shared rule for a note backed by a versioned item: create it, keep a
	 * local edit, take the server's, or keep both on a conflict.
	 */
	async merge(
		key: string,
		label: string,
		server: { meta: Meta; body: string; version: string; path?: string },
		edit: (note: Note) => Promise<string>,
		place: () => Promise<string>,
	) {
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
			return
		}
		const local = await edit(note)
		const edited = local !== note.meta.lu_hash && local !== serverHash
		if (str(note.meta.lu_version) === server.version && edited) return
		if (!edited) {
			if (local === serverHash && str(note.meta.lu_version) === server.version)
				return
			note.meta = { ...note.meta, ...state }
			delete note.meta.lu_conflict
			note.body = server.body
			await this.save(note)
			this.report.updated.push(note.path)
			return
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

	/** Whether the note changed since its last sync. */
	async edited(kind: string, note: Note) {
		if (kind === 'chapter') {
			const original = note.meta.sequence !== undefined
			const meta = await this.chapterMetaHash(
				note.meta.title,
				original ? note.meta.sequence : 0,
			)
			return (
				(await sha256(note.body)) !== note.meta.lu_hash ||
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
		if (this.wanted(universe.language))
			await this.merge(
				this.key('universe', id),
				'Universe',
				{
					meta: this.universeMeta(universe),
					body: universe.description ?? '',
					version: universe.version,
				},
				this.universeHash,
				async () => 'Universe.md',
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
					async () => `Universe.${translation.language}.md`,
				)
	}

	async pullStory(id: string, folder: string) {
		const story = await this.o.client.story({ id })
		if (!story)
			throw new LiteraryUniverseApiError('NOT_FOUND', 'Story not found')
		const key = this.key('story', id)
		const existing = this.notes.get(key)
		const dir = existing ? dirname(existing.path) : folder
		this.storyDirs.set(id, dir)
		await this.merge(
			key,
			story.title,
			{
				meta: {
					lu_kind: 'story',
					lu_id: id,
					title: story.title,
					genres: story.genres,
					tags: story.tags,
					rating: story.rating ?? undefined,
					license: story.license ?? undefined,
					ai_model: story.aiModel ?? undefined,
				},
				body: story.description ?? '',
				version: story.version,
			},
			this.storyHash,
			async () => join(dir, 'Story.md'),
		)
		for (const language of [story.language, ...story.translations])
			if (this.wanted(language)) await this.pullChapters(story, language, dir)
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
				await this.save(note)
				await this.rename(note, name, chapter.id)
			}
		}
		const fresh =
			!note ||
			!note.meta.lu_updated ||
			note.meta.lu_updated !== chapter.updatedAt
		if (!fresh) return
		const draft = await this.o.client.draft({ id: chapter.id, language })
		await this.merge(
			key,
			`${story.title} / ${chapter.title}`,
			{
				meta: {
					...(note?.meta ?? {}),
					lu_kind: 'chapter',
					lu_id: draft.id,
					lu_story: story.id,
					lu_language: draft.language,
					lu_updated: chapter.updatedAt,
					title: note?.meta.title ?? draft.title,
					sequence: original ? (note?.meta.sequence ?? sequence) : undefined,
					lu_meta: note?.meta.lu_meta ?? serverMeta,
					lu_conflict: undefined,
				},
				body: draft.markdown ?? '',
				version: draft.version,
			},
			async (n) => sha256(n.body),
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
		for (const header of headers)
			for (const edition of header.editions) {
				if (!this.wanted(edition.language)) continue
				const original = edition.language === header.language
				const key = this.key(
					'entry',
					header.id,
					original ? '' : edition.language,
				)
				const note = this.notes.get(key)
				if (note && str(note.meta.lu_version) === edition.version) continue
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
					await this.merge(
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
					const merged = this.notes.get(key)
					if (
						original &&
						merged &&
						!merged.meta.lu_conflict &&
						dirname(merged.path) !== folder
					) {
						const target = await this.freePath(
							folder,
							basename(merged.path),
							entry.id,
						)
						await this.o.files.rename(merged.path, target)
						merged.path = target
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
			'Series.md',
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

	async push() {
		for (const note of [...this.notes.values()]) {
			const kind = str(note.meta.lu_kind) || 'chapter'
			if (['series', 'comic'].includes(kind)) continue
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
				if (!header || header.title !== title || !original)
					await client.renameChapter({
						id,
						title,
						language: original ? undefined : str(note.meta.lu_language),
					})
				if (!original) {
					note.meta.lu_meta = metaHash
					await this.save(note)
				}
				// The original's new sequence is saved after the reorder.
			}
			const hash = await sha256(note.body)
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
		const hash = await hasher(note)
		if (hash === note.meta.lu_hash) return
		const expectedVersion = str(note.meta.lu_version) || undefined
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
			note.meta.lu_version = (await client.story({ id }))?.version
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
			note.meta.lu_version = (await client.universe({ id }))?.version
		} else if (kind === 'universe-translation') {
			const saved = await client.updateUniverseTranslation({
				universeId: id,
				language: str(note.meta.lu_language),
				expectedRevision: Number(note.meta.lu_version),
				input: { title: str(note.meta.title), description: note.body },
			})
			note.meta.lu_version = String(saved.revision)
		} else if (kind === 'entry') {
			note.meta.lu_version = (
				await this.pushEntry(note, id, expectedVersion, aiModel)
			).version
		}
		note.meta.lu_hash = hash
		await this.save(note)
		this.report.pushed.push(note.path)
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
		if (language) {
			const titles = (note.meta.lu_fields ?? {}) as Record<string, string>
			return client.translateEncyclopediaEntry({
				id,
				language,
				expectedVersion,
				name: str(note.meta.name) || undefined,
				pronunciation: str(note.meta.pronunciation),
				summary: parsed.summary,
				fields: parsed.fields.map((field) => ({
					title: titles[field.title] ?? field.title,
					translatedTitle: field.title,
					text: field.text,
				})),
			})
		}
		const parent = unlink(note.meta.parent)
		const related = list(note.meta.related).map(unlink)
		const current = await client.encyclopediaEntry({ id })
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
				categoryTitle: basename(dirname(note.path)),
				parentName: parent || null,
				relatedAdd: related,
				summary: parsed.summary,
				fields: parsed.fields,
				aiModel,
			},
		})
	}

	/** Chapters whose `sequence` changed locally go where it says; the rest keep their order. */
	async pushOrder() {
		for (const [storyId, chapters] of this.chapterOrder) {
			const notes = chapters.map((chapter) =>
				this.notes.get(this.key('chapter', chapter.id, chapter.language)),
			)
			const moved = await Promise.all(
				notes.map(async (note) =>
					note?.meta.lu_meta
						? (await this.chapterMetaHash(
								note.meta.title,
								note.meta.sequence,
							)) !== note.meta.lu_meta
						: false,
				),
			)
			const changed = chapters.some(
				(chapter, index) =>
					moved[index] &&
					Number(notes[index]?.meta.sequence) !== chapter.sequence + 1,
			)
			if (changed) {
				const order = chapters
					.map((chapter, index) => ({
						id: chapter.id,
						at: moved[index]
							? Number(notes[index]?.meta.sequence) - 1.5
							: index,
					}))
					.sort((a, b) => a.at - b.at)
					.map((item) => item.id)
				await this.o.client.reorderChapters({ storyId, chapterIds: order })
				this.report.pushed.push(
					`Chapter order of ${this.storyDirs.get(storyId) || storyId}`,
				)
				order.forEach((id, index) => {
					const note = this.notes.get(
						this.key('chapter', id, chapters[0].language),
					)
					if (note) note.meta.sequence = index + 1
				})
			}
			for (const note of notes) {
				if (!note) continue
				const hash = await this.chapterMetaHash(
					note.meta.title,
					note.meta.sequence,
				)
				if (hash === note.meta.lu_meta) continue
				note.meta.lu_meta = hash
				await this.save(note)
				await this.rename(
					note,
					chapterFileName(Number(note.meta.sequence), str(note.meta.title)),
					str(note.meta.lu_id),
				)
			}
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
				lu_hash: await sha256(note.body),
				lu_updated: draft.updatedAt,
				title: created.title,
				sequence: created.sequence + 1,
				lu_meta: await this.chapterMetaHash(
					created.title,
					created.sequence + 1,
				),
			}
			await this.save(note)
			await this.rename(
				note,
				chapterFileName(created.sequence + 1, created.title),
				created.id,
			)
			this.report.pushed.push(note.path)
			return
		}
		if (kind === 'entry' && this.o.scope.kind === 'universe') {
			const parsed = parseEntryBody(note.body)
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
			note.meta = { ...pulled.meta, lu_version: entry.version }
			note.body = pulled.body
			note.meta.lu_hash = await this.entryHash(note)
			await this.save(note)
			this.report.pushed.push(note.path)
			return
		}
		throw new LiteraryUniverseApiError(
			'BAD_USER_INPUT',
			`Only chapters and, in a universe, encyclopedia entries can be created from a note (lu_kind: ${kind})`,
		)
	}
}
