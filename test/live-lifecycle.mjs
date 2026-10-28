import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LiteraryUniverseClient } from '@literary-universe/sdk'

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const client = (token) =>
	new LiteraryUniverseClient({
		baseUrl: fixture.baseUrl,
		token,
		clientName: 'sdk-lifecycle',
	})
const writer = client(fixture.tokens.writeScoped)
const denied = (promise, code) =>
	assert.rejects(
		promise,
		(error) => error.code === code && Boolean(error.requestId),
	)
const runtime = process.versions.bun ? 'bun' : 'node'
const input = {
	storyId: fixture.storyId,
	title: `Lifecycle ${runtime}`,
	operationId: `lifecycle-create-${runtime}`,
	content: {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				content: [{ type: 'text', text: 'One two three.' }],
			},
		],
	},
}
if (fixture.lifecycleStage !== 'deleted') {
	await denied(client(fixture.tokens.story).createChapter(input), 'FORBIDDEN')
	const created = await writer.createChapter(input)
	assert.equal(created.title, `Lifecycle ${runtime}`)
	assert.equal((await writer.draft({ id: created.id })).publishedAt, null)
	assert.equal((await writer.createChapter(input)).id, created.id)
	await denied(
		writer.createChapter({ ...input, title: 'Changed input' }),
		'IDEMPOTENCY_CONFLICT',
	)
	const simultaneous = await Promise.all([
		writer.createChapter(input),
		writer.createChapter(input),
	])
	assert.ok(simultaneous.every((chapter) => chapter.id === created.id))
	const next = await writer.createChapter({
		...input,
		operationId: `lifecycle-append-${runtime}`,
	})
	assert.equal(next.sequence, created.sequence + 1)
	console.log(
		'PASS draft creation, stable retries, duplicate requests and append order',
	)

	const publisher = client(fixture.tokens.publishScoped)
	const publication = {
		id: created.id,
		expectedVersion: created.version,
		operationId: `lifecycle-publish-${runtime}`,
		publishAt: '2027-01-01T12:00:00Z',
	}
	await denied(writer.publishChapter(publication), 'FORBIDDEN')
	const published = await publisher.publishChapter(publication)
	assert.equal(published.audience, 'READERS')
	assert.equal(published.publishedAt, '2027-01-01T12:00:00.000Z')
	assert.notEqual(published.version, created.version)
	assert.equal(
		(await writer.draft({ id: created.id })).publishedAt,
		published.publishedAt,
	)
	assert.equal(
		(await publisher.publishChapter(publication)).revisionId,
		published.revisionId,
	)
	await denied(
		publisher.publishChapter({
			...publication,
			publishAt: '2028-01-01T12:00:00Z',
		}),
		'IDEMPOTENCY_CONFLICT',
	)
	await denied(
		publisher.publishChapter({
			...publication,
			operationId: `lifecycle-stale-${runtime}`,
		}),
		'VERSION_CONFLICT',
	)
	const beta = await publisher.publishChapter({
		id: created.id,
		expectedVersion: published.version,
		audience: 'BETA',
		operationId: `lifecycle-beta-${runtime}`,
	})
	assert.equal(beta.audience, 'BETA')
	assert.equal(beta.chapterPublishedAt, published.chapterPublishedAt)
	assert.equal(
		(await writer.draft({ id: created.id })).publishedAt,
		published.chapterPublishedAt,
	)
	console.log(
		'PASS explicit publication scope, scheduled release, stable revision retries, beta isolation and stale versions',
	)
}
const deletedInput = {
	...input,
	operationId: `lifecycle-deleted-${runtime}`,
	title: 'Deleted after creation',
}
if (fixture.lifecycleStage === 'deleted') {
	const replay = await writer.createChapter(deletedInput)
	assert.equal(replay.id, fixture.deletedChapterId)
	await denied(writer.draft({ id: replay.id }), 'NOT_FOUND')
	console.log(
		'PASS deleted creation replays its original result without recreating a chapter',
	)
}
