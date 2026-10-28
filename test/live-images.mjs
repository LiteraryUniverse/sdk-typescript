import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LiteraryUniverseClient } from '@literary-universe/sdk'
import { prepareImage } from '@literary-universe/sdk/images'
import sharp from 'sharp'

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const client = new LiteraryUniverseClient({
	baseUrl: fixture.baseUrl,
	token: fixture.token,
	clientName: 'lu-cli/0.1.0',
})
const policy = await client.imagePolicy()
assert.equal(policy.version, '1')
const source = await sharp({
	create: {
		width: 120,
		height: 180,
		channels: 4,
		background: { r: 180, g: 100, b: 70, alpha: 0.5 },
	},
})
	.png()
	.withMetadata({ orientation: 1 })
	.toBuffer()
const targets = {
	'chapter-image': fixture.chapterId,
	'encyclopedia-image': fixture.entryId,
	'blog-image': fixture.blogId,
	'blog-logo': fixture.blogId,
	'blog-header': fixture.blogId,
}
for (const [purpose, targetId] of Object.entries(targets)) {
	const crop =
		purpose === 'blog-image'
				? { left: 0, top: 50, width: 112, height: 63 }
				: purpose === 'blog-header'
					? { left: 0, top: 60, width: 120, height: 40 }
					: undefined
	const prepared = await prepareImage(source, purpose, { policy, crop })
	const input = {
		...prepared,
		targetId,
		operationId: `images-${fixture.runId ?? 'test'}-${process.versions.bun ? 'bun' : 'node'}-${purpose}`,
	}
	const uploaded = await client.uploadImage(input)
	assert.equal(uploaded.sha256, prepared.sha256)
	const downloaded = await fetch(uploaded.url)
	assert.equal(downloaded.status, 200)
	assert.deepEqual(
		Buffer.from(await downloaded.arrayBuffer()),
		Buffer.from(prepared.bytes),
	)
	assert.equal(
		(await sharp(Buffer.from(prepared.bytes)).metadata()).hasAlpha,
		true,
	)
	assert.deepEqual(await client.uploadImage(input), uploaded)
	await assert.rejects(
		client.uploadImage({ ...input, bytes: new Uint8Array([1, 2, 3]) }),
		{ code: 'IDEMPOTENCY_CONFLICT' },
	)
}
const prepared = await prepareImage(source, 'chapter-image', { policy })
const input = {
	...prepared,
	targetId: fixture.chapterId,
	operationId: `images-lost-${fixture.runId ?? 'test'}-${process.versions.bun ? 'bun' : 'node'}`,
}
let lose = true
const lostReply = new LiteraryUniverseClient({
	baseUrl: fixture.baseUrl,
	token: fixture.token,
	clientName: 'lu-cli/0.1.0',
	maxRetries: 1,
	fetch: async (...args) => {
		const response = await fetch(...args)
		if (lose) {
			lose = false
			await response.arrayBuffer()
			throw new TypeError('lost reply')
		}
		return response
	},
})
const recovered = await lostReply.uploadImage(input)
assert.equal((await client.uploadImage(input)).fileId, recovered.fileId)
await assert.rejects(
	client.uploadImage({
		...input,
		operationId: `bad-policy-${fixture.runId ?? 'test'}`,
		policyVersion: 'future',
	}),
	{ code: 'POLICY_CHANGED' },
)
await assert.rejects(
	client.uploadImage({
		...input,
		operationId: `bad-mime-${fixture.runId ?? 'test'}`,
		type: 'image/jpeg',
	}),
	{ code: 'INVALID_IMAGE' },
)
await assert.rejects(
	client.uploadImage({
		...input,
		operationId: `wrong-ratio-${fixture.runId ?? 'test'}`,
		purpose: 'blog-header',
		targetId: fixture.blogId,
	}),
	{ code: 'INVALID_IMAGE' },
)
await assert.rejects(
	client.uploadImage({
		...input,
		operationId: 'missing-target',
		targetId: 'missing',
	}),
	{ code: 'NOT_FOUND' },
)
if (fixture.deniedToken) {
	const denied = new LiteraryUniverseClient({
		baseUrl: fixture.baseUrl,
		token: fixture.deniedToken,
	})
	await assert.rejects(
		denied.uploadImage({ ...input, operationId: 'denied' }),
		{ code: 'FORBIDDEN' },
	)
}
console.log(
	`Live image preparation, five purposes, byte verification and lost-response replay passed (${process.versions.bun ? 'Bun' : 'Node'})`,
)
