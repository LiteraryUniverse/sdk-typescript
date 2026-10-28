import { IMAGE_POLICY, type ImagePurpose } from './imagePolicy.js'
import type {
	ImagePreparationOptions,
	PreparedImage,
} from './imageProcessing.js'
import { runImageWorker } from './imageWorker.cjs'
import { LiteraryUniverseApiError } from './index.js'

export {
	IMAGE_POLICY,
	type ImagePolicy,
	type ImagePurpose,
} from './imagePolicy.js'
export type {
	ImageCrop,
	ImagePreparationOptions,
	PreparedImage,
} from './imageProcessing.js'

function workerFailure(error: unknown): never {
	const failure = error as { code?: string }
	throw new LiteraryUniverseApiError(
		failure.code ?? 'INVALID_IMAGE',
		'Image preparation stopped',
	)
}
function processingTime(options: ImagePreparationOptions) {
	const seconds =
		options.policy?.processingSeconds ?? IMAGE_POLICY.processingSeconds
	if (!Number.isSafeInteger(seconds) || seconds < 1)
		throw new LiteraryUniverseApiError(
			'INVALID_POLICY',
			'Image policy contains an invalid deadline',
		)
	return Math.min(seconds, IMAGE_POLICY.processingSeconds) * 1000
}
function preparedResult(response: unknown): PreparedImage {
	const message = response as {
		result?: Omit<PreparedImage, 'bytes'> & { bytes: string }
		error?: { code: string; message: string }
	}
	if (message.error)
		throw new LiteraryUniverseApiError(
			message.error.code,
			message.error.message,
		)
	if (!message.result)
		throw new LiteraryUniverseApiError(
			'INVALID_IMAGE',
			'Image preparation returned no result',
		)
	return {
		...message.result,
		bytes: Buffer.from(message.result.bytes, 'base64'),
	}
}
/** A killable subprocess bounds metadata parsing as well as native image processing. */
export async function prepareImage(
	source: Uint8Array,
	purpose: ImagePurpose,
	options: ImagePreparationOptions = {},
): Promise<PreparedImage> {
	if (!source.byteLength || source.byteLength > IMAGE_POLICY.maxSourceBytes)
		throw new LiteraryUniverseApiError(
			'PAYLOAD_TOO_LARGE',
			'Source exceeds the image preparation byte limit',
		)
	const { signal, ...settings } = options
	const payload = {
		source: new Uint8Array(source),
		purpose,
		options: structuredClone(settings),
	}
	return preparedResult(
		await runImageWorker(payload, processingTime(options), signal).catch(
			workerFailure,
		),
	)
}
