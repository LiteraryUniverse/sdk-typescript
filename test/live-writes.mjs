import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LiteraryUniverseClient } from '@literary-universe/sdk'

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const client = (token) =>
	new LiteraryUniverseClient({
		baseUrl: fixture.baseUrl,
		token,
		clientName: 'sdk-contract',
	})
const writer = client(fixture.tokens.writeScoped)
const readonly = client(fixture.tokens.story)
const before = await writer.draft({ id: fixture.chapterId })
const content = {
	type: 'doc',
	content: [
		{
			type: 'heading',
			attrs: { level: 2 },
			content: [{ type: 'text', text: 'SDK write' }],
		},
		{
			type: 'paragraph',
			content: [
				{ type: 'text', text: 'Rich text.', marks: [{ type: 'bold' }] },
			],
		},
	],
}
const runtime = process.versions.bun ? 'bun' : 'node'
const input = {
	id: fixture.chapterId,
	expectedVersion: before.version,
	operationId: `integration-write-once-${runtime}`,
	content,
}
const denied = (call, code) =>
	assert.rejects(
		call,
		(error) => error.code === code && Boolean(error.requestId),
	)
await denied(readonly.saveDraft(input), 'FORBIDDEN')
await denied(client(fixture.tokens.otherUser).saveDraft(input), 'FORBIDDEN')
const saved = await writer.saveDraft(input)
assert.notEqual(saved.version, before.version)
assert.equal(
	(await writer.draft({ id: fixture.chapterId })).version,
	saved.version,
)
assert.match(saved.draft.markdown, /## SDK write/)
assert.match(saved.draft.markdown, /\*\*Rich text\.\*\*/)
assert.deepEqual(
	(
		await writer.draftRecovery({
			id: fixture.chapterId,
			recoveryId: saved.recoveryId,
		})
	).content,
	before.content,
)
const retry = await writer.saveDraft(input)
assert.equal(retry.version, saved.version)
await denied(
	writer.saveDraft({
		...input,
		content: { type: 'doc', content: [{ type: 'paragraph' }] },
	}),
	'IDEMPOTENCY_CONFLICT',
)
await denied(
	writer.saveDraft({ ...input, operationId: `integration-stale-${runtime}` }),
	'VERSION_CONFLICT',
)
const newer = await writer.saveDraft({
	...input,
	operationId: `integration-newer-${runtime}`,
	expectedVersion: saved.version,
	content: {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				content: [{ type: 'text', text: 'One two three four five.' }],
			},
		],
	},
})
const codeText = '<div class="name">literal code</div>'
const code = await writer.saveDraft({
	...input,
	expectedVersion: newer.version,
	operationId: `integration-code-${runtime}`,
	content: {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				content: [{ type: 'text', text: codeText, marks: [{ type: 'code' }] }],
			},
		],
	},
})
assert.equal(code.draft.content.content[0].content[0].text, codeText)
assert.match(code.draft.text, /class="name"/)
assert.match(code.draft.markdown, /class="name"/)
const final = await writer.saveDraft({
	...input,
	expectedVersion: code.version,
	operationId: `integration-final-${runtime}`,
	content: {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				content: [{ type: 'text', text: 'One two three four five.' }],
			},
		],
	},
})
assert.equal((await writer.saveDraft(input)).version, saved.version)
assert.equal(
	(await writer.draft({ id: fixture.chapterId })).version,
	final.version,
)
console.log(
	'PASS restricted draft writes, read-only denial, canonical JSON, Markdown, recovery, stale versions and idempotent replay',
)
