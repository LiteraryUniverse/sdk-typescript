import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LiteraryUniverseClient } from '@literary-universe/sdk'

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const client = (token) =>
	new LiteraryUniverseClient({ baseUrl: fixture.baseUrl, token })
const writer = client(fixture.tokens.writeScoped)
const input = {
	id: fixture.chapterId,
	expectedVersion: fixture.replayExpectedVersion,
	operationId: 'replay-after-short-story-toggle',
	content: {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				content: [{ type: 'text', text: 'word '.repeat(9001).trim() }],
			},
		],
	},
}
if (fixture.replayStage === 'before') {
	const saved = await writer.saveDraft(input)
	assert.equal(saved.draft.counters.words, 9001)
} else if (fixture.replayStage === 'after') {
	const saved = await writer.saveDraft(input)
	assert.equal(saved.version, fixture.replayCommittedVersion)
	assert.equal(saved.draft.counters.words, 9001)
} else {
	const creation = {
		storyId: fixture.storyId,
		operationId: 'credential-rotation-create',
		title: 'Stable across keys',
	}
	const first = await writer.createChapter(creation)
	const rotated = await client(fixture.tokens.writeRotated).createChapter(
		creation,
	)
	assert.equal(first.id, rotated.id)
}
console.log(
	'PASS committed operation replay across mutable validation and credential rotation',
)
