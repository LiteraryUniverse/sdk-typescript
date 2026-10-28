import { createHash } from 'node:crypto'
import sharp, { type Metadata, type Sharp } from 'sharp'
import {
	IMAGE_POLICY,
	type ImagePolicy,
	type ImagePurpose,
} from './imagePolicy.js'
import { LiteraryUniverseApiError } from './index.js'

export {
	IMAGE_POLICY,
	type ImagePolicy,
	type ImagePurpose,
} from './imagePolicy.js'

export type ImageCrop = {
	left: number
	top: number
	width: number
	height: number
}
export type ImagePreparationOptions = {
	crop?: ImageCrop
	format?: 'jpeg' | 'png' | 'webp'
	policy?: ImagePolicy
	signal?: AbortSignal
}
export type PreparedImage = {
	bytes: Uint8Array
	purpose: ImagePurpose
	policyVersion: string
	sha256: string
	type: string
	width: number
	height: number
	warnings: { code: string; message: string }[]
}
type Preparation = {
	policy: ImagePolicy
	purpose: ImagePurpose
	options: ImagePreparationOptions
	bytes: Buffer
	meta: Metadata
	deadline: number
	warnings: PreparedImage['warnings']
}
function fail(code: string, message: string): never {
	throw new LiteraryUniverseApiError(code, message)
}
function finiteLimit(value: number, ceiling: number) {
	if (!Number.isSafeInteger(value) || value < 1)
		fail('INVALID_POLICY', 'Image policy contains an invalid limit')
	return Math.min(value, ceiling)
}
function selectedPolicy(policy: ImagePolicy, purpose: ImagePurpose) {
	const limits = policy?.purposes?.[purpose]
	if (
		!limits ||
		typeof policy.version !== 'string' ||
		!policy.version ||
		policy.version.length > 30
	)
		fail('INVALID_POLICY', 'Image policy does not define the selected purpose')
	return limits
}
function validateOutputLimits(limits: ImagePolicy['purposes'][ImagePurpose]) {
	if (
		!Array.isArray(limits.allowedTypes) ||
		!limits.allowedTypes.length ||
		limits.allowedTypes.some(
			(type) => !['image/jpeg', 'image/png', 'image/webp'].includes(type),
		)
	)
		fail('INVALID_POLICY', 'Image policy contains unsupported output formats')
	if (
		limits.aspectRatio !== null &&
		(!Number.isFinite(limits.aspectRatio) || limits.aspectRatio <= 0)
	)
		fail('INVALID_POLICY', 'Image policy contains an invalid aspect ratio')
}
function globalLimits(policy: ImagePolicy) {
	const max = IMAGE_POLICY
	return {
		maxSourceBytes: finiteLimit(policy.maxSourceBytes, max.maxSourceBytes),
		maxDecodedPixels: finiteLimit(
			policy.maxDecodedPixels,
			max.maxDecodedPixels,
		),
		maxUploadPixels: finiteLimit(policy.maxUploadPixels, max.maxUploadPixels),
		processingSeconds: finiteLimit(
			policy.processingSeconds,
			max.processingSeconds,
		),
	}
}
function purposeLimits(limits: ImagePolicy['purposes'][ImagePurpose]) {
	validateOutputLimits(limits)
	return {
		...limits,
		maxBytes: finiteLimit(limits.maxBytes, 5 * 1024 * 1024),
		maxWidth: finiteLimit(limits.maxWidth, 8192),
		maxHeight: finiteLimit(limits.maxHeight, 8192),
	}
}
function preparationPolicy(
	policy: ImagePolicy,
	purpose: ImagePurpose,
): ImagePolicy {
	const limits = purposeLimits(selectedPolicy(policy, purpose))
	return {
		...policy,
		...globalLimits(policy),
		purposes: { ...policy.purposes, [purpose]: limits },
	}
}
function boundedPipeline(
	context: Pick<Preparation, 'bytes' | 'policy' | 'deadline'>,
) {
	const seconds = Math.ceil((context.deadline - Date.now()) / 1000)
	if (seconds < 1) fail('TIMEOUT', 'Image preparation timed out')
	return sharp(context.bytes, {
		limitInputPixels: context.policy.maxDecodedPixels,
		failOn: 'warning',
	}).timeout({ seconds })
}
const dimensions = (meta: Metadata) =>
	meta.autoOrient ?? { width: meta.width ?? 0, height: meta.height ?? 0 }
function validateSource(meta: Metadata, policy: ImagePolicy) {
	if (
		!['jpeg', 'png', 'webp', 'gif', 'heif', 'tiff'].includes(meta.format ?? '')
	)
		fail(
			'UNSUPPORTED_IMAGE',
			'Use a raster JPEG, PNG, WebP, GIF, AVIF or TIFF source',
		)
	if ((meta.pages ?? 1) !== 1)
		fail(
			'UNSUPPORTED_IMAGE',
			'Animated and multi-page images require a single-frame export',
		)
	const { width, height } = dimensions(meta)
	if (!width || !height || width * height > policy.maxDecodedPixels)
		fail('PAYLOAD_TOO_LARGE', 'Image exceeds the decoded pixel limit')
}
function validateCrop(
	crop: ImageCrop,
	full: { width: number; height: number },
) {
	if (
		![crop.left, crop.top, crop.width, crop.height].every(
			Number.isSafeInteger,
		) ||
		crop.left < 0 ||
		crop.top < 0 ||
		crop.width < 1 ||
		crop.height < 1 ||
		crop.left + crop.width > full.width ||
		crop.top + crop.height > full.height
	)
		fail('BAD_USER_INPUT', 'Crop must fit inside the oriented source image')
}
function cropDimensions(context: Preparation) {
	const full = dimensions(context.meta),
		crop = context.options.crop
	if (!crop) return full
	validateCrop(crop, full)
	context.warnings.push({
		code: 'CROPPED',
		message: 'Applied the explicit crop rectangle',
	})
	return crop
}
function scaledDimensions(
	size: { width: number; height: number },
	scale: number,
	ratio: number | null,
	maxPixels: number,
) {
	let height = Math.max(1, Math.floor(size.height * scale))
	const widthCeiling = Math.max(1, Math.floor(size.width * scale))
	let width = Math.min(
		widthCeiling,
		Math.max(1, ratio ? Math.round(height * ratio) : widthCeiling),
	)
	while (width * height > maxPixels && height > 1) {
		height--
		width = Math.min(
			widthCeiling,
			Math.max(1, ratio ? Math.round(height * ratio) : width),
		)
	}
	if (width * height > maxPixels)
		fail('INVALID_POLICY', 'Image policy geometry cannot fit this image')
	return { width, height }
}
function requiredRatio(
	size: { width: number; height: number },
	ratio: number | null,
) {
	if (ratio && Math.abs(size.width - size.height * ratio) > 1)
		fail(
			'CROP_REQUIRED',
			`This purpose requires aspect ratio ${ratio}; provide an explicit crop`,
		)
}
function resizeScale(
	context: Preparation,
	size: { width: number; height: number },
) {
	const limits = context.policy.purposes[context.purpose]
	return Math.min(
		1,
		limits.maxWidth / size.width,
		limits.maxHeight / size.height,
		Math.sqrt(context.policy.maxUploadPixels / (size.width * size.height)),
	)
}
function outputDimensions(context: Preparation) {
	const size = cropDimensions(context),
		ratio = context.policy.purposes[context.purpose].aspectRatio
	requiredRatio(size, ratio)
	return scaledDimensions(
		size,
		resizeScale(context, size),
		ratio,
		context.policy.maxUploadPixels,
	)
}
function encode(pipeline: Sharp, format: string, quality: number) {
	if (format === 'png') return pipeline.png({ compressionLevel: 9 })
	if (format === 'jpeg') return pipeline.jpeg({ quality, mozjpeg: true })
	return pipeline.webp({ quality, alphaQuality: 100 })
}
async function render(
	context: Preparation,
	size: { width: number; height: number },
	format: string,
	quality: number,
) {
	if (context.options.signal?.aborted)
		fail('CANCELLED', 'Image preparation cancelled')
	let image = boundedPipeline(context).autoOrient()
	if (context.options.crop) image = image.extract(context.options.crop)
	const output = await encode(
		image.resize({ ...size, fit: 'fill', withoutEnlargement: true }),
		format,
		quality,
	).toBuffer({ resolveWithObject: true })
	if (context.options.signal?.aborted)
		fail('CANCELLED', 'Image preparation cancelled')
	return output
}
function outputFormat(context: Preparation) {
	const requested = context.options.format,
		source = context.meta.format ?? ''
	if (requested && !['jpeg', 'png', 'webp'].includes(requested))
		fail('BAD_USER_INPUT', 'Output must be JPEG, PNG or WebP')
	if (requested === 'jpeg' && context.meta.hasAlpha)
		fail(
			'TRANSPARENCY_LOSS',
			'JPEG cannot preserve transparency; use PNG or WebP',
		)
	const format =
		requested ?? (['jpeg', 'png', 'webp'].includes(source) ? source : 'webp')
	if (
		!context.policy.purposes[context.purpose].allowedTypes.includes(
			`image/${format}`,
		)
	)
		fail('INVALID_POLICY', 'Policy does not allow this output format')
	return format
}
function smallerImage(
	context: Preparation,
	size: { width: number; height: number },
) {
	return scaledDimensions(
		size,
		0.5,
		context.policy.purposes[context.purpose].aspectRatio,
		context.policy.maxUploadPixels,
	)
}
async function compress(context: Preparation) {
	let size = outputDimensions(context),
		format = outputFormat(context)
	const limits = context.policy.purposes[context.purpose]
	for (let attempt = 0; attempt < 10; attempt++) {
		const output = await render(context, size, format, attempt > 1 ? 70 : 90)
		if (output.data.length <= limits.maxBytes) return { ...output, format }
		if (
			context.options.format ||
			attempt > 1 ||
			!limits.allowedTypes.includes('image/webp')
		)
			size = smallerImage(context, size)
		else format = 'webp'
	}
	fail('PAYLOAD_TOO_LARGE', 'Image could not fit within the upload byte limit')
}
function preparationWarnings(
	context: Preparation,
	info: { width: number; height: number },
	format: string,
) {
	const source = context.options.crop ?? dimensions(context.meta)
	if (info.width !== source.width || info.height !== source.height)
		context.warnings.push({
			code: 'RESIZED',
			message: 'Resized the image to meet upload limits',
		})
	if (format !== context.meta.format)
		context.warnings.push({
			code: 'CONVERTED',
			message: `Converted the image to ${format}`,
		})
	return context.warnings
}
async function prepare(context: Preparation): Promise<PreparedImage> {
	const output = await compress(context)
	return {
		bytes: output.data,
		purpose: context.purpose,
		policyVersion: context.policy.version,
		sha256: createHash('sha256').update(output.data).digest('hex'),
		type: `image/${output.format}`,
		width: output.info.width,
		height: output.info.height,
		warnings: preparationWarnings(context, output.info, output.format),
	}
}
function isRasterSource(bytes: Buffer) {
	return (
		bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
		(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
		(bytes.toString('ascii', 0, 4) === 'RIFF' &&
			bytes.toString('ascii', 8, 12) === 'WEBP') ||
		/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) ||
		['49492a00', '4d4d002a'].includes(bytes.subarray(0, 4).toString('hex')) ||
		(bytes.toString('ascii', 4, 8) === 'ftyp' &&
			/avif|avis|heic|heix|mif1/.test(bytes.toString('ascii', 8, 64)))
	)
}
async function sourceContext(
	source: Uint8Array,
	purpose: ImagePurpose,
	input: ImagePreparationOptions,
): Promise<Preparation> {
	const options = input
	const policy = preparationPolicy(
		structuredClone(input.policy ?? IMAGE_POLICY),
		purpose,
	)
	if (!source.byteLength || source.byteLength > policy.maxSourceBytes)
		fail('PAYLOAD_TOO_LARGE', 'Source exceeds the image preparation byte limit')
	if (options.signal?.aborted) fail('CANCELLED', 'Image preparation cancelled')
	const bytes = Buffer.from(source),
		deadline = Date.now() + policy.processingSeconds * 1000
	if (!isRasterSource(bytes))
		fail('UNSUPPORTED_IMAGE', 'Use a supported raster image source')
	const meta = await boundedPipeline({ bytes, policy, deadline }).metadata()
	validateSource(meta, policy)
	return { bytes, meta, deadline, policy, purpose, options, warnings: [] }
}
/** Prepare local bytes; originals are untouched and no external URLs are fetched. */
async function prepareImage(
	source: Uint8Array,
	purpose: ImagePurpose,
	options: ImagePreparationOptions = {},
): Promise<PreparedImage> {
	try {
		return await prepare(await sourceContext(source, purpose, options))
	} catch (error) {
		if (error instanceof LiteraryUniverseApiError) throw error
		fail(
			'INVALID_IMAGE',
			'Image could not be decoded within the preparation limits',
		)
	}
}

async function sourceFromStdin() {
	const parts: Buffer[] = []
	let size = 0
	for await (const part of process.stdin) {
		size += part.length
		if (size > IMAGE_POLICY.maxSourceBytes)
			fail('PAYLOAD_TOO_LARGE', 'Source exceeds the preparation limit')
		parts.push(Buffer.from(part))
	}
	return Buffer.concat(parts, size)
}
function sendImageResult(result: PreparedImage) {
	process.stdout.write(
		JSON.stringify({
			result: {
				...result,
				bytes: Buffer.from(result.bytes).toString('base64'),
			},
		}),
	)
}
function sendWorkerError(error: unknown) {
	const failure = error instanceof LiteraryUniverseApiError ? error : undefined
	process.stdout.write(
		JSON.stringify({
			error: {
				code: failure?.code ?? 'INVALID_IMAGE',
				message: failure?.message ?? 'Image preparation failed',
			},
		}),
	)
}
async function processImageWorker() {
	try {
		const { purpose, options } = JSON.parse(process.argv[3])
		sendImageResult(
			await prepareImage(await sourceFromStdin(), purpose, options),
		)
	} catch (error) {
		sendWorkerError(error)
	}
}
if (process.argv[2] === 'lu-image-prepare') void processImageWorker()
