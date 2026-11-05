import {
	type AuthorChapterCreateInput,
	type AuthorChapterPublishInput,
	type AuthorChapterRemoveInput,
	type AuthorChapterRenameInput,
	type AuthorChapterReorderInput,
	type AuthorDraftSaveInput,
	type AuthorEncyclopediaEntryCreateInput,
	type AuthorEncyclopediaEntryTranslationInput,
	type AuthorSeriesSaveInput,
	LuChaptersDocument,
	type LuChaptersQuery,
	type LuChaptersQueryVariables,
	LuCreateChapterDocument,
	type LuCreateChapterMutation,
	LuCreateEncyclopediaEntryDocument,
	type LuCreateEncyclopediaEntryMutation,
	LuCreateUniverseTranslationDocument,
	type LuCreateUniverseTranslationMutation,
	type LuCreateUniverseTranslationMutationVariables,
	LuDeleteEncyclopediaEntryDocument,
	type LuDeleteEncyclopediaEntryMutation,
	type LuDeleteEncyclopediaEntryMutationVariables,
	LuDraftDocument,
	type LuDraftQuery,
	type LuDraftQueryVariables,
	LuDraftRecoveryDocument,
	type LuDraftRecoveryQuery,
	type LuDraftRecoveryQueryVariables,
	LuEncyclopediaEntriesDocument,
	type LuEncyclopediaEntriesQuery,
	type LuEncyclopediaEntriesQueryVariables,
	LuEncyclopediaEntryDocument,
	type LuEncyclopediaEntryQuery,
	type LuEncyclopediaEntryQueryVariables,
	LuIdentityDocument,
	type LuIdentityQuery,
	LuImagePolicyDocument,
	type LuImagePolicyQuery,
	LuProfileDocument,
	type LuProfileQuery,
	LuPublishChapterDocument,
	type LuPublishChapterMutation,
	LuRemoveChapterDocument,
	type LuRemoveChapterMutation,
	LuRenameChapterDocument,
	type LuRenameChapterMutation,
	LuReorderChaptersDocument,
	type LuReorderChaptersMutation,
	LuSaveDraftDocument,
	type LuSaveDraftMutation,
	LuSaveSeriesDocument,
	type LuSaveSeriesMutation,
	LuSeriesDocument,
	type LuSeriesQuery,
	type LuSeriesQueryVariables,
	LuSetEncyclopediaEntryPublicationDocument,
	type LuSetEncyclopediaEntryPublicationMutation,
	type LuSetEncyclopediaEntryPublicationMutationVariables,
	LuSetStoryVisibilityDocument,
	type LuSetStoryVisibilityMutation,
	type LuSetStoryVisibilityMutationVariables,
	LuStoriesDocument,
	type LuStoriesQuery,
	type LuStoriesQueryVariables,
	LuStoryDocument,
	type LuStoryQuery,
	type LuStoryQueryVariables,
	LuTranslateEncyclopediaEntryDocument,
	type LuTranslateEncyclopediaEntryMutation,
	LuUniverseDocument,
	type LuUniverseQuery,
	type LuUniverseQueryVariables,
	LuUniversesDocument,
	type LuUniversesQuery,
	type LuUniversesQueryVariables,
	LuUpdateEncyclopediaEntryDocument,
	type LuUpdateEncyclopediaEntryMutation,
	type LuUpdateEncyclopediaEntryMutationVariables,
	LuUpdateStoryDocument,
	type LuUpdateStoryMutation,
	type LuUpdateStoryMutationVariables,
	LuUpdateUniverseDocument,
	type LuUpdateUniverseMutation,
	type LuUpdateUniverseMutationVariables,
	LuUpdateUniverseTranslationDocument,
	type LuUpdateUniverseTranslationMutation,
	type LuUpdateUniverseTranslationMutationVariables,
	LuValidateDraftDocument,
	type LuValidateDraftQuery,
} from './generated.js'

export type * from './generated.js'
export type { JsonValue } from './json.js'

import type { ImagePolicy, ImagePurpose } from './imagePolicy.js'

export {
	IMAGE_POLICY,
	type ImagePolicy,
	type ImagePurpose,
} from './imagePolicy.js'
export type ImageUploadInput = {
	bytes: Uint8Array
	purpose: ImagePurpose
	targetId: string
	operationId: string
	policyVersion: string
	type: string
}
export type UploadedImage = {
	fileId: string
	url: string
	purpose: ImagePurpose
	targetId: string
	width: number
	height: number
	size: number
	type: string
	sha256: string
	policyVersion: string
}
type Transfer = {
	endpoint: URL
	type: string
	bytes: Uint8Array
	/** A REST route answering `{ error }` or its JSON result instead of GraphQL. */
	rest?: true
}

export class LiteraryUniverseApiError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly requestId?: string,
		public readonly status?: number,
		public readonly retryAfterSeconds?: number,
		/** With VERSION_CONFLICT: the revision the resource is at now. */
		public readonly currentRevision?: number,
		/** With CONFLICT: the resource already holding the name. */
		public readonly resourceId?: string,
	) {
		super(message)
		this.name = 'LiteraryUniverseApiError'
	}
}
export type RequestOptions = { signal?: AbortSignal; timeoutMs?: number }
export type CredentialProvider = (
	signal: AbortSignal,
) =>
	| { kind: 'api-key'; token: string }
	| Promise<{ kind: 'api-key'; token: string }>
export type ClientOptions = {
	baseUrl: string
	token?: string
	credentials?: CredentialProvider
	clientName?: string
	fetch?: typeof globalThis.fetch
	timeoutMs?: number
	maxRetries?: number
	allowInsecureHttp?: boolean
}
type Result<T extends { result: unknown }> = NonNullable<T['result']>
type Envelope = {
	data?: { result?: unknown }
	errors?: {
		message?: string
		extensions?: {
			code?: string
			requestId?: string
			currentRevision?: number
			entryId?: string
		}
	}[]
	extensions?: { requestId?: string }
}
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export class LiteraryUniverseClient {
	private readonly endpoint: URL
	readonly #token?: string
	readonly #credentials?: CredentialProvider
	private readonly fetcher: typeof globalThis.fetch
	private readonly timeoutMs: number
	private readonly maxRetries: number
	private readonly clientName?: string

	constructor(options: ClientOptions) {
		const invalid = () =>
			new LiteraryUniverseApiError(
				'INVALID_CONFIGURATION',
				'Provide a deployment base URL and an API token',
			)
		let base: URL
		try {
			base = new URL(options.baseUrl)
		} catch {
			throw invalid()
		}
		if (
			!['http:', 'https:'].includes(base.protocol) ||
			base.username ||
			base.password ||
			base.search ||
			base.hash
		)
			throw invalid()
		if (
			base.protocol === 'http:' &&
			!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) &&
			!options.allowInsecureHttp
		) {
			throw new LiteraryUniverseApiError(
				'INVALID_CONFIGURATION',
				'Use HTTPS or explicitly allow HTTP for this deployment',
			)
		}
		if (
			options.credentials
				? typeof options.credentials !== 'function' ||
					options.token !== undefined
				: typeof options.token !== 'string' ||
					!/^lu_(?:live|dev|test)_[a-zA-Z0-9_-]+$/.test(options.token)
		)
			throw invalid()
		this.endpoint = new URL(
			`${base.origin}${base.pathname.replace(/\/+$/, '')}/graphql`,
		)
		this.#token = options.token
		this.#credentials = options.credentials
		this.clientName = options.clientName
			?.replace(/lu_(?:live|test|dev)_[a-zA-Z0-9_-]+/gi, 'redacted')
			.replace(/[^a-zA-Z0-9 ._/-]/g, '')
			.slice(0, 100)
		// Native fetch throws "Illegal invocation" when called as a method of this client.
		const fetcher = options.fetch ?? globalThis.fetch
		this.fetcher = (input, init) => fetcher(input, init)
		this.timeoutMs = options.timeoutMs ?? 30_000
		this.maxRetries = options.maxRetries ?? 0
		if (
			!Number.isInteger(this.maxRetries) ||
			this.maxRetries < 0 ||
			this.maxRetries > 2 ||
			!Number.isFinite(this.timeoutMs) ||
			this.timeoutMs < 1 ||
			this.timeoutMs > 120_000
		)
			throw new LiteraryUniverseApiError(
				'INVALID_CONFIGURATION',
				'Timeout must be between 1 and 120000 milliseconds and retries between 0 and 2',
			)
	}

	identity(options?: RequestOptions) {
		return this.read<LuIdentityQuery>(
			LuIdentityDocument,
			'LuIdentity',
			{},
			options,
		)
	}
	profile(options?: RequestOptions) {
		return this.read<LuProfileQuery>(
			LuProfileDocument,
			'LuProfile',
			{},
			options,
		)
	}
	stories(input: LuStoriesQueryVariables = {}, options?: RequestOptions) {
		return this.read<LuStoriesQuery>(
			LuStoriesDocument,
			'LuStories',
			input,
			options,
		)
	}
	story(input: LuStoryQueryVariables, options?: RequestOptions) {
		return this.read<LuStoryQuery>(LuStoryDocument, 'LuStory', input, options)
	}
	universes(input: LuUniversesQueryVariables = {}, options?: RequestOptions) {
		return this.read<LuUniversesQuery>(
			LuUniversesDocument,
			'LuUniverses',
			input,
			options,
		)
	}
	universe(input: LuUniverseQueryVariables, options?: RequestOptions) {
		return this.read<LuUniverseQuery>(
			LuUniverseDocument,
			'LuUniverse',
			input,
			options,
		)
	}
	chapters(input: LuChaptersQueryVariables, options?: RequestOptions) {
		return this.read<LuChaptersQuery>(
			LuChaptersDocument,
			'LuChapters',
			input,
			options,
		)
	}
	draft(input: LuDraftQueryVariables, options?: RequestOptions) {
		return this.read<LuDraftQuery>(LuDraftDocument, 'LuDraft', input, options)
	}
	/** Opens a language for a universe; returns the existing one when it is already open. */
	createUniverseTranslation(
		input: LuCreateUniverseTranslationMutationVariables,
		options?: RequestOptions,
	) {
		return this.read<LuCreateUniverseTranslationMutation>(
			LuCreateUniverseTranslationDocument,
			'LuCreateUniverseTranslation',
			input,
			options,
			undefined,
			0,
		)
	}
	/** Fails with VERSION_CONFLICT and `currentRevision` when expectedRevision is stale. */
	updateUniverseTranslation(
		input: LuUpdateUniverseTranslationMutationVariables,
		options?: RequestOptions,
	) {
		return this.read<LuUpdateUniverseTranslationMutation>(
			LuUpdateUniverseTranslationDocument,
			'LuUpdateUniverseTranslation',
			input,
			options,
			undefined,
			0,
		)
	}

	/** Changes a story's details; only the given fields change. */
	updateStory(input: LuUpdateStoryMutationVariables, options?: RequestOptions) {
		return this.read<LuUpdateStoryMutation>(
			LuUpdateStoryDocument,
			'LuUpdateStory',
			input,
			options,
		)
	}
	/** Hides a published story from readers (`PRIVATE`) or shows it again (`PUBLIC`). */
	setStoryVisibility(
		input: LuSetStoryVisibilityMutationVariables,
		options?: RequestOptions,
	) {
		return this.read<LuSetStoryVisibilityMutation>(
			LuSetStoryVisibilityDocument,
			'LuSetStoryVisibility',
			input,
			options,
		)
	}
	renameChapter(input: AuthorChapterRenameInput, options?: RequestOptions) {
		return this.read<LuRenameChapterMutation>(
			LuRenameChapterDocument,
			'LuRenameChapter',
			{ input },
			options,
		)
	}
	/** Removes a chapter never published and renumbers the rest. Not retried: a repeat finds nothing to remove. */
	removeChapter(input: AuthorChapterRemoveInput, options?: RequestOptions) {
		return this.read<LuRemoveChapterMutation>(
			LuRemoveChapterDocument,
			'LuRemoveChapter',
			{ input },
			options,
			undefined,
			0,
		)
	}
	/** Puts every chapter of a story in the given order. */
	reorderChapters(input: AuthorChapterReorderInput, options?: RequestOptions) {
		return this.read<LuReorderChaptersMutation>(
			LuReorderChaptersDocument,
			'LuReorderChapters',
			{ input },
			options,
		)
	}
	updateUniverse(
		input: LuUpdateUniverseMutationVariables,
		options?: RequestOptions,
	) {
		return this.read<LuUpdateUniverseMutation>(
			LuUpdateUniverseDocument,
			'LuUpdateUniverse',
			input,
			options,
		)
	}
	encyclopediaEntries(
		input: LuEncyclopediaEntriesQueryVariables,
		options?: RequestOptions,
	) {
		return this.read<LuEncyclopediaEntriesQuery>(
			LuEncyclopediaEntriesDocument,
			'LuEncyclopediaEntries',
			input,
			options,
		)
	}
	encyclopediaEntry(
		input: LuEncyclopediaEntryQueryVariables,
		options?: RequestOptions,
	) {
		return this.read<LuEncyclopediaEntryQuery>(
			LuEncyclopediaEntryDocument,
			'LuEncyclopediaEntry',
			input,
			options,
		)
	}
	/** Adds a draft entry. Fails with CONFLICT and `resourceId` when the name is taken; not retried. */
	createEncyclopediaEntry(
		input: AuthorEncyclopediaEntryCreateInput,
		options?: RequestOptions,
	) {
		return this.read<LuCreateEncyclopediaEntryMutation>(
			LuCreateEncyclopediaEntryDocument,
			'LuCreateEncyclopediaEntry',
			{ input },
			options,
			undefined,
			0,
		)
	}
	updateEncyclopediaEntry(
		input: LuUpdateEncyclopediaEntryMutationVariables,
		options?: RequestOptions,
	) {
		return this.read<LuUpdateEncyclopediaEntryMutation>(
			LuUpdateEncyclopediaEntryDocument,
			'LuUpdateEncyclopediaEntry',
			input,
			options,
		)
	}
	translateEncyclopediaEntry(
		input: AuthorEncyclopediaEntryTranslationInput,
		options?: RequestOptions,
	) {
		return this.read<LuTranslateEncyclopediaEntryMutation>(
			LuTranslateEncyclopediaEntryDocument,
			'LuTranslateEncyclopediaEntry',
			{ input },
			options,
		)
	}
	setEncyclopediaEntryPublication(
		input: LuSetEncyclopediaEntryPublicationMutationVariables,
		options?: RequestOptions,
	) {
		return this.read<LuSetEncyclopediaEntryPublicationMutation>(
			LuSetEncyclopediaEntryPublicationDocument,
			'LuSetEncyclopediaEntryPublication',
			input,
			options,
		)
	}
	/** Not retried: a repeat finds nothing to delete. */
	deleteEncyclopediaEntry(
		input: LuDeleteEncyclopediaEntryMutationVariables,
		options?: RequestOptions,
	) {
		return this.read<LuDeleteEncyclopediaEntryMutation>(
			LuDeleteEncyclopediaEntryDocument,
			'LuDeleteEncyclopediaEntry',
			input,
			options,
			undefined,
			0,
		)
	}
	series(input: LuSeriesQueryVariables, options?: RequestOptions) {
		return this.read<LuSeriesQuery>(
			LuSeriesDocument,
			'LuSeries',
			input,
			options,
		)
	}
	/** Fails with VERSION_CONFLICT when the series changed since `expectedVersion`. */
	saveSeries(input: AuthorSeriesSaveInput, options?: RequestOptions) {
		return this.read<LuSaveSeriesMutation>(
			LuSaveSeriesDocument,
			'LuSaveSeries',
			{ input },
			options,
			undefined,
			0,
		)
	}

	saveDraft(input: AuthorDraftSaveInput, options?: RequestOptions) {
		return this.read<LuSaveDraftMutation>(
			LuSaveDraftDocument,
			'LuSaveDraft',
			{ input },
			options,
		)
	}

	createChapter(input: AuthorChapterCreateInput, options?: RequestOptions) {
		return this.read<LuCreateChapterMutation>(
			LuCreateChapterDocument,
			'LuCreateChapter',
			{ input },
			options,
		)
	}

	publishChapter(input: AuthorChapterPublishInput, options?: RequestOptions) {
		return this.read<LuPublishChapterMutation>(
			LuPublishChapterDocument,
			'LuPublishChapter',
			{ input },
			options,
		)
	}

	validateDraft(input: AuthorDraftSaveInput, options?: RequestOptions) {
		return this.read<LuValidateDraftQuery>(
			LuValidateDraftDocument,
			'LuValidateDraft',
			{ input },
			options,
		)
	}

	draftRecovery(
		input: LuDraftRecoveryQueryVariables,
		options?: RequestOptions,
	) {
		return this.read<LuDraftRecoveryQuery>(
			LuDraftRecoveryDocument,
			'LuDraftRecovery',
			input,
			options,
		)
	}

	async imagePolicy(options?: RequestOptions): Promise<ImagePolicy> {
		return (await this.read<LuImagePolicyQuery>(
			LuImagePolicyDocument,
			'LuImagePolicy',
			{},
			options,
		)) as unknown as ImagePolicy
	}

	/** Create a public image asset. Attaching it to content is a separate write. */
	uploadImage(input: ImageUploadInput, options?: RequestOptions) {
		const { bytes, type, purpose, targetId, operationId, policyVersion } = input
		const metadata = { purpose, targetId, operationId, policyVersion }
		if (purpose === 'story-cover' || purpose === 'universe-cover')
			throw new LiteraryUniverseApiError(
				'BAD_USER_INPUT',
				'Set covers with setCover',
			)
		if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024)
			throw new LiteraryUniverseApiError(
				'PAYLOAD_TOO_LARGE',
				'Image exceeds the upload byte ceiling',
			)
		const endpoint = new URL('api/author/images', new URL('.', this.endpoint))
		for (const [name, value] of Object.entries(metadata))
			endpoint.searchParams.set(name, value)
		return this.read<{ result: UploadedImage }>('', '', {}, options, {
			endpoint,
			type,
			bytes: new Uint8Array(bytes),
		})
	}

	/**
	 * Replace a story's or universe's cover. The server crops it to the cover
	 * shape and stores WebP; prepare it with prepareImage first to stay under 5 MB.
	 */
	async setCover(
		input: {
			kind: 'story' | 'universe'
			id: string
			bytes: Uint8Array
			/** image/jpeg, image/png or image/webp, as PreparedImage.type reports. */
			type: string
		},
		options?: RequestOptions,
	): Promise<{ url: string; handle: string; size: number }> {
		if (!input.bytes.byteLength || input.bytes.byteLength > 5 * 1024 * 1024)
			throw new LiteraryUniverseApiError(
				'PAYLOAD_TOO_LARGE',
				'Cover exceeds the upload byte ceiling',
			)
		const kind = input.kind === 'story' ? 'stories' : 'universes'
		const endpoint = new URL(
			`api/${kind}/${encodeURIComponent(input.id)}/cover`,
			new URL('.', this.endpoint),
		)
		const { cover } = await this.read<{
			result: { cover: { url: string; handle: string; size: number } }
		}>('', '', {}, options, {
			endpoint,
			type: input.type,
			bytes: new Uint8Array(input.bytes),
			rest: true,
		})
		return cover
	}

	private async read<T extends { result: unknown }>(
		query: string,
		operationName: string,
		variables: object,
		options: RequestOptions = {},
		transfer?: Transfer,
		maxRetries = this.maxRetries,
	): Promise<Result<T>> {
		const timeoutMs = options.timeoutMs ?? this.timeoutMs
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
			throw new LiteraryUniverseApiError(
				'INVALID_CONFIGURATION',
				'Timeout must be between 1 and 120000 milliseconds',
			)
		if (options.signal?.aborted)
			throw new LiteraryUniverseApiError('CANCELLED', 'API request cancelled')
		let body: string | Uint8Array
		try {
			body =
				transfer?.bytes ?? JSON.stringify({ query, operationName, variables })
		} catch {
			throw new LiteraryUniverseApiError(
				'BAD_USER_INPUT',
				'API input must be serializable JSON',
			)
		}
		const controller = new AbortController()
		let timedOut = false
		const abort = () => controller.abort()
		if (options.signal?.aborted) abort()
		options.signal?.addEventListener('abort', abort, { once: true })
		const timer = setTimeout(() => {
			if (!controller.signal.aborted) timedOut = true
			controller.abort()
		}, timeoutMs)
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					return await this.request<T>(body, controller.signal, transfer)
				} catch (error) {
					if (controller.signal.aborted)
						throw new LiteraryUniverseApiError(
							timedOut ? 'TIMEOUT' : 'CANCELLED',
							timedOut ? 'API request timed out' : 'API request cancelled',
						)
					const failure =
						error instanceof LiteraryUniverseApiError
							? error
							: new LiteraryUniverseApiError(
									'NETWORK_ERROR',
									'API request failed',
								)
					const retryable = [
						'NETWORK_ERROR',
						'RATE_LIMITED',
						'SERVICE_UNAVAILABLE',
					].includes(failure.code)
					if (
						!retryable ||
						attempt >= maxRetries ||
						(failure.retryAfterSeconds ?? 0) > 10
					)
						throw failure
					const delay = Math.max(
						(failure.retryAfterSeconds ?? 0) * 1000,
						100 * 2 ** attempt,
					)
					await new Promise<void>((resolve, reject) => {
						const cancel = () => {
							clearTimeout(wait)
							reject(
								new LiteraryUniverseApiError(
									'CANCELLED',
									'API request cancelled',
								),
							)
						}
						const wait = setTimeout(() => {
							controller.signal.removeEventListener('abort', cancel)
							resolve()
						}, delay)
						controller.signal.addEventListener('abort', cancel, { once: true })
					})
				}
			}
		} catch (error) {
			if (controller.signal.aborted)
				throw new LiteraryUniverseApiError(
					timedOut ? 'TIMEOUT' : 'CANCELLED',
					timedOut ? 'API request timed out' : 'API request cancelled',
				)
			throw error
		} finally {
			clearTimeout(timer)
			options.signal?.removeEventListener('abort', abort)
		}
	}

	private async request<T extends { result: unknown }>(
		requestBody: string | Uint8Array,
		signal: AbortSignal,
		transfer?: Transfer,
	): Promise<Result<T>> {
		const token = await this.credential(signal)
		if (signal.aborted)
			throw new LiteraryUniverseApiError('CANCELLED', 'API request cancelled')
		const response = await this.fetcher(transfer?.endpoint ?? this.endpoint, {
			method: transfer?.rest ? 'PUT' : 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': transfer?.type ?? 'application/json',
				...(this.clientName ? { 'X-LU-Client': this.clientName } : {}),
			},
			body: requestBody as BodyInit,
			signal,
			credentials: 'omit',
			redirect: 'manual',
		})
		const headerId = response.headers.get('x-request-id') ?? undefined
		if (
			response.type === 'opaqueredirect' ||
			(response.status >= 300 && response.status < 400)
		) {
			await response.body?.cancel().catch(() => {})
			const location = response.headers
				.get('location')
				?.replaceAll(token, '[redacted]')
				.slice(0, 200)
			throw new LiteraryUniverseApiError(
				'REDIRECTED',
				`The deployment redirected this request${location ? ` to ${location}` : ''}; use its final base URL`,
				headerId,
				response.status,
			)
		}
		const retryHeader = response.headers.get('retry-after')
		const retryAfter = retryHeader
			? /^\d+$/.test(retryHeader)
				? Number(retryHeader)
				: Math.max(0, Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000))
			: undefined
		const body = await readResponseBytes(response, headerId)
		let envelope: Envelope | undefined
		try {
			envelope = JSON.parse(new TextDecoder().decode(body)) as Envelope
		} catch {
			/* Non-JSON HTTP failures still receive a typed status error. */
		}
		if (transfer?.rest && envelope)
			envelope = restEnvelope(envelope, response.status)
		const firstError = envelope?.errors?.[0]
		const requestId =
			firstError?.extensions?.requestId ??
			envelope?.extensions?.requestId ??
			headerId
		if (firstError || !response.ok) {
			const code =
				firstError?.extensions?.code ??
				(response.status === 401
					? 'UNAUTHENTICATED'
					: response.status === 403
						? 'FORBIDDEN'
						: response.status === 413
							? 'PAYLOAD_TOO_LARGE'
							: response.status === 429
								? 'RATE_LIMITED'
								: response.status === 503
									? 'SERVICE_UNAVAILABLE'
									: response.status >= 500
										? 'INTERNAL_SERVER_ERROR'
										: response.status === 400
											? 'BAD_USER_INPUT'
											: 'INVALID_RESPONSE')
			const message = String(firstError?.message ?? 'API request was rejected')
				.replaceAll(token, '[redacted]')
				.slice(0, 500)
			const currentRevision = firstError?.extensions?.currentRevision
			throw new LiteraryUniverseApiError(
				code,
				message,
				requestId,
				response.status,
				Number.isFinite(retryAfter) ? retryAfter : undefined,
				Number.isInteger(currentRevision) ? currentRevision : undefined,
				typeof firstError?.extensions?.entryId === 'string'
					? firstError.extensions.entryId
					: undefined,
			)
		}
		const result = envelope?.data?.result
		if (!result || typeof result !== 'object')
			throw new LiteraryUniverseApiError(
				'INVALID_RESPONSE',
				'API response does not contain the requested result',
				requestId,
				response.status,
			)
		return result as Result<T>
	}

	private async credential(signal: AbortSignal) {
		if (this.#token) return this.#token
		const credential = await providedCredential(this.#credentials, signal)
		if (
			credential?.kind !== 'api-key' ||
			typeof credential.token !== 'string' ||
			!/^lu_(?:live|dev|test)_[a-zA-Z0-9_-]+$/.test(credential.token)
		)
			throw new LiteraryUniverseApiError(
				'INVALID_CONFIGURATION',
				'Credential provider must return a valid API key',
			)
		return credential.token
	}
}

const tooLarge = (response: Response, requestId?: string) =>
	new LiteraryUniverseApiError(
		'PAYLOAD_TOO_LARGE',
		'API response exceeds the read size limit',
		requestId,
		response.status,
	)

/** Streams when the body has a reader; a polyfilled Response without one is read whole. */
async function readResponseBytes(response: Response, requestId?: string) {
	if (typeof response.body?.getReader !== 'function') {
		const whole = new Uint8Array(await response.arrayBuffer())
		if (whole.byteLength > MAX_RESPONSE_BYTES)
			throw tooLarge(response, requestId)
		return whole
	}
	const reader = response.body.getReader()
	let bytes = 0
	const chunks: Uint8Array[] = []
	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			bytes += chunk.value.byteLength
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel()
				throw tooLarge(response, requestId)
			}
			chunks.push(chunk.value)
		}
	} finally {
		reader.releaseLock()
	}
	const body = new Uint8Array(bytes)
	let offset = 0
	for (const chunk of chunks) {
		body.set(chunk, offset)
		offset += chunk.byteLength
	}
	return body
}

/** REST routes answer `{ error }`; a JSON 404 there is a missing resource, not a wrong mount. */
function restEnvelope(parsed: unknown, status: number): Envelope {
	const { error } = parsed as { error?: unknown }
	if (typeof error !== 'string') return { data: { result: parsed } }
	const code =
		status === 404 ? 'NOT_FOUND' : status === 415 ? 'BAD_USER_INPUT' : undefined
	return { errors: [{ message: error, extensions: { code } }] }
}

function providedCredential(
	provider: CredentialProvider | undefined,
	signal: AbortSignal,
) {
	return new Promise<Awaited<ReturnType<CredentialProvider>> | undefined>(
		(resolve, reject) => {
			const cancel = () =>
				reject(
					new LiteraryUniverseApiError('CANCELLED', 'API request cancelled'),
				)
			if (signal.aborted) return cancel()
			signal.addEventListener('abort', cancel, { once: true })
			Promise.resolve()
				.then(() => provider?.(signal))
				.then(resolve, reject)
				.finally(() => signal.removeEventListener('abort', cancel))
		},
	)
}
