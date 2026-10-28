import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LiteraryUniverseApiError,
  LiteraryUniverseClient,
} from '@literary-universe/sdk'

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const client = (token) =>
  new LiteraryUniverseClient({ baseUrl: fixture.baseUrl, token })
const deny = async (promise, code) =>
  assert.rejects(
    promise,
    (error) =>
      error instanceof LiteraryUniverseApiError &&
      error.code === code &&
      Boolean(error.requestId),
  )
let checks = 0
const check = async (name, run) => {
  await run()
  checks++
  console.log(`PASS ${name}`)
}
const scoped = client(fixture.tokens.universe)
const story = client(fixture.tokens.story)
const full = client(fixture.tokens.full)

if (fixture.stage === 'initial') {
  await check('identity and optional self-profile', async () => {
    const identity = await full.identity()
    assert.equal(identity.version, '1')
    assert.equal(identity.userId, fixture.writerId)
    assert.equal(identity.limits.maxPageSize, 100)
    assert.equal((await full.profile()).username, 'storyteller')
  })
  await check('restricted private universe and author catalogue', async () => {
    assert.equal(
      (await scoped.universe({ id: fixture.universeId })).title,
      'SDK private world',
    )
    assert.deepEqual(
      (await scoped.stories()).nodes.map((node) => node.id),
      [fixture.storyId],
    )
  })
  await check('standalone draft fidelity and chapter metadata', async () => {
    const draft = await scoped.draft({ id: fixture.chapterId })
    assert.deepEqual(draft.content, {
      type: 'doc',
      content: [{ type: 'extensionNode', attrs: { value: 'preserve' } }],
    })
    assert.equal(draft.html, '<p>Private draft</p>')
    assert.equal(draft.oldHtml, '<p>Legacy draft</p>')
    assert.deepEqual(draft.translatorsNotes, { html: '<p>Translator note</p>' })
    assert.equal(draft.updatedAt, '2026-10-01T00:00:00.000Z')
    assert.equal(
      (await scoped.chapters({ storyId: fixture.storyId })).nodes[0].id,
      fixture.chapterId,
    )
  })
  await check('story boundary excludes its parent universe', async () => {
    assert.equal(
      (await story.draft({ id: fixture.chapterId })).storyId,
      fixture.storyId,
    )
    await deny(story.universe({ id: fixture.universeId }), 'NOT_FOUND')
  })
  await check('scope and user boundaries', async () => {
    await deny(
      client(fixture.tokens.wrongScope).story({ id: fixture.storyId }),
      'FORBIDDEN',
    )
    await deny(
      client(fixture.tokens.otherUser).draft({ id: fixture.chapterId }),
      'NOT_FOUND',
    )
    await deny(scoped.story({ id: fixture.foreignStoryId }), 'NOT_FOUND')
    await deny(scoped.story({ id: 'missing-resource' }), 'NOT_FOUND')
  })
  await check(
    'validation and expired authentication carry request IDs',
    async () => {
      await deny(scoped.stories({ first: 101 }), 'BAD_USER_INPUT')
      await deny(client(fixture.tokens.expired).identity(), 'UNAUTHENTICATED')
    },
  )
  await check(
    'personal credentials use current organization read roles',
    async () => {
      assert.equal(
        (await full.draft({ id: fixture.orgChapterId })).title,
        'Organization draft',
      )
    },
  )
  await check(
    'restricted keys cannot escape through legacy GraphQL or HTTP exports',
    async () => {
      const graph = await fetch(`${fixture.baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.tokens.universe}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: `{story(id:"${fixture.storyId}"){_id}}`,
        }),
      })
      assert.equal((await graph.json()).errors[0].extensions.code, 'FORBIDDEN')
      const exported = await fetch(
        `${fixture.baseUrl}/story/${fixture.storySlug}/llms.txt`,
        { headers: { Authorization: `Bearer ${fixture.tokens.universe}` } },
      )
      assert.equal(exported.status, 403)
    },
  )
  await check(
    'CommonJS consumer uses the same standalone package',
    async () => {
      const { createRequire } = await import('node:module')
      assert.equal(
        typeof createRequire(import.meta.url)('@literary-universe/sdk')
          .LiteraryUniverseClient,
        'function',
      )
    },
  )
} else {
  await check('organization role removal revokes subsequent draft reads', () =>
    deny(full.draft({ id: fixture.orgChapterId }), 'NOT_FOUND'),
  )
  await check(
    'universe restriction rechecks moved stories from stored data',
    () => deny(scoped.draft({ id: fixture.chapterId }), 'NOT_FOUND'),
  )
  await check(
    'explicit story restriction follows that story without granting its new parent',
    async () => {
      assert.equal(
        (await story.draft({ id: fixture.chapterId })).storyId,
        fixture.storyId,
      )
      await deny(story.universe({ id: fixture.foreignUniverseId }), 'NOT_FOUND')
    },
  )
  await check('revoked credential fails on the next real request', () =>
    deny(client(fixture.tokens.revoke).identity(), 'UNAUTHENTICATED'),
  )
}
console.log(`Live SDK checks passed: ${checks}`)
