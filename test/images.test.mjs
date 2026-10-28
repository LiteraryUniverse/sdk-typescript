import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { IMAGE_POLICY, prepareImage } from '../dist/esm/images.js'

test('prepares an oriented transparent image without changing its source bytes', async () => {
	const source = await sharp({
		create: {
			width: 90,
			height: 60,
			channels: 4,
			background: { r: 100, g: 50, b: 30, alpha: 0.25 },
		},
	})
		.png()
		.withMetadata({ orientation: 6 })
		.toBuffer()
	const original = Buffer.from(source)
	const prepared = await prepareImage(source, 'story-cover')
	const decoded = await sharp(prepared.bytes).metadata()
	assert.equal(decoded.width, 60)
	assert.equal(decoded.height, 90)
	assert.equal(decoded.hasAlpha, true)
	assert.equal((await sharp(prepared.bytes).raw().toBuffer())[3], 64)
	assert.equal(decoded.orientation, undefined)
	assert.equal(prepared.policyVersion, '1')
	assert.deepEqual(source, original)
})

test('requires an explicit crop for covers and preserves larger recommended-resolution images', async () => {
	const source = await sharp({
		create: { width: 1200, height: 1800, channels: 3, background: '#4070aa' },
	})
		.png()
		.toBuffer()
	const cover = await prepareImage(source, 'story-cover')
	assert.equal(cover.width, 1200)
	assert.equal(cover.height, 1800)
	await assert.rejects(prepareImage(source, 'universe-cover'), {
		code: 'CROP_REQUIRED',
	})
	const cropped = await prepareImage(source, 'universe-cover', {
		crop: { left: 0, top: 300, width: 1200, height: 1200 },
	})
	assert.equal(cropped.width, 1200)
	assert.equal(cropped.height, 1200)
	assert.ok(cropped.warnings.some((warning) => warning.code === 'CROPPED'))
	await assert.rejects(
		prepareImage(source, 'universe-cover', {
			crop: { left: 0, top: 0, width: 1800, height: 1800 },
		}),
		{ code: 'BAD_USER_INPUT' },
	)
})

test('rejects active or animated sources and refuses an explicitly lossy transparency conversion', async () => {
	await assert.rejects(
		prepareImage(
			Buffer.from(
				'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
			),
			'chapter-image',
		),
		{ code: 'UNSUPPORTED_IMAGE' },
	)
	const transparent = await sharp({
		create: { width: 10, height: 10, channels: 4, background: '#00000000' },
	})
		.png()
		.toBuffer()
	await assert.rejects(
		prepareImage(transparent, 'chapter-image', { format: 'jpeg' }),
		{ code: 'TRANSPARENCY_LOSS' },
	)
	await assert.rejects(
		prepareImage(transparent, 'chapter-image', { signal: AbortSignal.abort() }),
		{ code: 'CANCELLED' },
	)
})

test('resizes to enforced limits and compresses to a finite byte ceiling with transparency', async () => {
	const source = await sharp({
		create: {
			width: 200,
			height: 200,
			channels: 4,
			background: { r: 70, g: 20, b: 250, alpha: 0.4 },
		},
	})
		.png()
		.toBuffer()
	const policy = structuredClone(IMAGE_POLICY)
	Object.assign(policy.purposes['universe-cover'], {
		maxWidth: 80,
		maxHeight: 80,
		maxBytes: 150,
	})
	const prepared = await prepareImage(source, 'universe-cover', { policy })
	assert.ok(prepared.bytes.length <= 150)
	assert.ok(prepared.width <= 80 && prepared.height <= 80)
	assert.equal((await sharp(prepared.bytes).metadata()).hasAlpha, true)
	assert.ok(prepared.warnings.some((warning) => warning.code === 'RESIZED'))
})

test('rounded resize dimensions stay inside the decoded output ceiling', async () => {
	const source = await sharp({
		create: { width: 60, height: 90, channels: 3, background: '#567890' },
	})
		.png()
		.toBuffer()
	const policy = structuredClone(IMAGE_POLICY)
	policy.maxUploadPixels = 1600
	const output = await prepareImage(source, 'story-cover', { policy })
	assert.ok(output.width * output.height <= 1600)
	assert.ok(Math.abs(output.width - (output.height * 2) / 3) <= 1)
})

test('cancels image preparation while its subprocess is running', async () => {
	const source = await sharp({
		create: { width: 100, height: 100, channels: 4, background: '#40709050' },
	})
		.png()
		.toBuffer()
	const controller = new AbortController()
	const prepared = prepareImage(source, 'universe-cover', {
		signal: controller.signal,
	})
	controller.abort()
	await assert.rejects(prepared, { code: 'CANCELLED' })
})
