# Literary Universe SDK

TypeScript and JavaScript client for the [Literary Universe](https://literaryuniverse.com)
authoring API. Use it to read your writing, save versioned drafts, create and
publish chapters, manage universe translations, and prepare or upload images.
The [CLI](https://github.com/LiteraryUniverse/cli) uses this SDK; Obsidian and local
MCP integrations can use the same client.

Read the [documentation in our feedback knowledge base](https://literaryuniverse.com/feedback/help)
for Literary Universe help. This README describes the SDK's current API contract.
Report SDK bugs in [this repository](https://github.com/LiteraryUniverse/sdk-typescript/issues).

The client uses the deployment's `/graphql` endpoint. The core client has no runtime dependencies and exports ESM and CommonJS builds. Local image preparation uses the optional Sharp dependency through the `/images` entry point; `/project` manages a folder of chapter files, and `/mcp` registers the API as tools on an MCP server through the optional `@modelcontextprotocol/sdk` and `zod` peers. Node 22 or later and Bun are targets; see CI and local verification for tested versions. `/graphql` sends no CORS headers, so code running on another origin, including an Obsidian plugin, must pass a `fetch` that is not subject to CORS, for example one built on Obsidian's `requestUrl`.

## Install

The source is MIT licensed. The package is still marked private and has not been
released to npm. Build a tarball from this repository with Node 22 or later:

```sh
git clone https://github.com/LiteraryUniverse/sdk-typescript.git
cd sdk-typescript
npm ci
npm pack
```

Install that tarball in your application:

```sh
npm install /path/to/sdk-typescript/literary-universe-sdk-0.1.0.tgz
```

The package includes its schema, generated types and image policy. Building or
packing it does not require the Literary Universe monorepo. Git dependencies
also build through the package's `prepare` script.

## Quickstart

Create a personal API key in your Literary Universe account and grant only the
scopes your integration needs. The read example below needs `story:read`.
Provide the raw key through `LU_TOKEN` or your host application's secret store.

```ts
import { LiteraryUniverseClient, LiteraryUniverseApiError } from '@literary-universe/sdk'

const client = new LiteraryUniverseClient({
  baseUrl: 'https://literaryuniverse.com',
  token: process.env.LU_TOKEN!,
})

const identity = await client.identity()
const page = await client.stories({ first: 25 })
const story = page.nodes[0]
if (story) {
  const chapters = await client.chapters({ storyId: story.id })
  const chapter = chapters.nodes.find((chapter) => chapter.hasDraft)
  if (chapter) {
    const draft = await client.draft({ id: chapter.id })
    console.log(draft)
  }
}

try {
  await client.story({ id: 'another-story-id' })
} catch (error) {
  if (error instanceof LiteraryUniverseApiError) {
    console.error(error.code, error.requestId)
  }
}
```

`baseUrl` identifies the deployment, including any mount prefix. Use the raw API token without `Bearer`. Cookies are omitted. Redirects are not followed and fail with `REDIRECTED`, so use the final URL: `https://www.literaryuniverse.com` redirects to `https://literaryuniverse.com`. HTTPS is required except on loopback addresses; a private HTTP deployment can explicitly set `allowInsecureHttp: true`. Token prefixes describe generation conditions and do not create an isolated database or sandbox.

## Supported reads

| Method | Scope | Result |
| --- | --- | --- |
| `identity()` | Any valid credential | API version, deployment label/URL, credential identity, granted scopes/restrictions and limits |
| `profile()` | `user:read` | Your user ID and optional username |
| `universes({first, after})` | `universe:read` | Paginated author/team universe headers |
| `universe({id})` | `universe:read` | Universe metadata and its translations, each with its `revision` |
| `stories({first, after})` | `story:read` | Paginated author/team story headers |
| `story({id})` | `story:read` | Story metadata and author notes |
| `chapters({storyId, language, first, after})` | `story:read` | Chapter headers without bodies |
| `draft({id, language})` | `story:read` | Stored working draft, including JSON, HTML/text/legacy representations and notes/counters |
| `encyclopediaEntries({universeId, first, after})` | `universe:read` | Paginated entry headers of a universe, drafts included |
| `encyclopediaEntry({id, language})` | `universe:read` | An entry with its summary, links and fields as plain text, in the original or a translated edition |
| `series({universeId})` | `universe:read` | The universe's saved series, each with its `version` and its stories in reading order |

Read access requires the person's current `draft.read` capability on the work or inherited universe. Personal credentials use current organization roles, including read-only view-all; removing a role affects subsequent requests. Organization keys are described under [Organization keys](#organization-keys). Fan fiction is readable by its author and that story's own team; the team of the universe it is set in does not inherit it.

Draft language defaults to the chapter's original language. An explicit translation returns that stored edition; a missing edition or unavailable permission returns `NOT_FOUND`. Draft JSON preserves editor nodes and marks without conversion. Titles, descriptions and `html` are returned as the app displays them, with the stored entity encoding removed. `text` and `markdown` are returned as stored, where a literal `<` or `>` is `&lt;` or `&gt;`. `updatedAt` is existing metadata, not an atomic write-precondition version. Draft reads return a server version. Versioned content saves, validation, recovery, chapter creation, publication, universe translations, story and universe details, chapter structure, encyclopedia entries and series are available.

Chapter headers include `hasDraft` for the requested edition. When a translation has not been created, its header retains the source title as a label, has `hasDraft: false`, and does not inherit the original's publication timestamp.

Lists default to 25 rows and accept 1–100. Follow `pageInfo.endCursor` while `hasNextPage` is true. Cursors are bound to the catalogue, credential restrictions and filters. They are ordered by stable IDs; chapter sequence is provided separately for writing order. Start a new traversal when changing credentials or catalogue inputs. Lists are live reads, not a database snapshot.

## Universe translations

| Method | Scope | Result |
| --- | --- | --- |
| `createUniverseTranslation({universeId, language, input?})` | `universe:translate` or `universe:write` | `{created, translation}`; an already open language returns `created: false` and the stored translation |
| `updateUniverseTranslation({universeId, language, expectedRevision, input})` | `universe:translate` or `universe:write` | The saved translation with its new `revision` |

A translation is the universe's title and description in another language. Who may write one follows the workshop: the owner, an organization admin, a team member who edits the universe, or a translator of that language. Opening a language copies the original title and description unless `input` provides them, and opens the language for the universe's encyclopedia and universe blog as the workshop does. The original language is refused with `BAD_USER_INPUT`. Send plain text: the title holds up to 100 characters and the description up to 800. A `null` or omitted field stays as it is.

`expectedRevision` is the `revision` you read from `universe({id})`. Every change advances it, including saves in the browser workshop, which overwrite without a revision. When the translation is no longer at `expectedRevision` the update changes nothing and fails with `VERSION_CONFLICT`; the error's `currentRevision` says where it is now, so read it again and decide what to write. Translations saved before revisions existed are at revision 0.

Writes are never retried, whatever `maxRetries` says: a lost response to an applied update would come back from a retry as a conflict. A resource-restricted credential can write to the universes it selects.

## Organization keys

An organization admin creates organization keys in the organization's settings, on the API keys tab, which the organization's `api` add-on opens. With `organization:read` alone a key reads the organization's public catalogue as a guest, for display on another site. With work scopes (`story:read`, `story:write`, `story:publish`, `universe:read`, `universe:write`, `universe:translate`) it acts as the organization itself: it has an organization admin's rights over the stories and universes the organization owns, and over the stories set in those universes, and over nothing else. It keeps working when the admin who created it leaves; revoke it to stop it. `identity()` reports it as `ORGANIZATION_API_KEY` with its `organizationId` and no `userId`. What it creates is recorded under the owner of the work it writes into, and the audit log names the key.

Organization keys cannot upload covers or chapter images yet; use a personal key for those.

## Story details and visibility

| Method | Scope | Result |
| --- | --- | --- |
| `updateStory({storyId, input})` | `story:write` | The story header after the change |
| `setStoryVisibility({storyId, visibility})` | `story:write` | The story header; `privateAt` is set while it is hidden |

`input` takes `title`, `description`, `genres`, `tags`, `rating`, `license`, `language` and `universeId`; only the fields you give change. Moving a story to another universe takes the story owner's rights (the owner or an admin of the owning organization) and edit rights on the target universe, as the workshop does; `universeId: null` makes it standalone. A rating under staff review stays as it is (`FAILED_PRECONDITION`).

`PRIVATE` hides a published story from readers and its universe's story count; `PUBLIC` shows it again. A story that was never published fails with `BAD_USER_INPUT`.

## Chapter structure

| Method | Scope | Result |
| --- | --- | --- |
| `renameChapter({id, language?, title})` | `story:write` | The chapter header with its new title |
| `reorderChapters({storyId, chapterIds})` | `story:write` | `{storyId, chapterIds}` in the new order |
| `removeChapter({id})` | `story:write` | `{id, storyId}` of the removed unpublished chapter |

Renaming and reordering apply to published chapters too, and readers see the change at once. A `language` renames that translation's title; without it the original is renamed, together with the story's list of chapters. `chapterIds` names every chapter of the story exactly once. Only a chapter never published, in any language or to beta readers, can be removed (`FAILED_PRECONDITION` otherwise); the chapters after it are renumbered. The only chapter of a story cannot be removed. A story whose arcs or free preview chapters count chapters keeps its structure: removal and reordering fail with `FAILED_PRECONDITION`. `removeChapter` is never retried.

## Universe details

| Method | Scope | Result |
| --- | --- | --- |
| `updateUniverse({universeId, input})` | `universe:write` | The universe header after the change |

`input` takes `title`, `slug`, `description`, `genre`, `rating`, `license` and `language`. A `slug` is lowercase letters, digits and single hyphens; one in use by another universe fails with `CONFLICT`. `genre` is a genre value such as `fantasy`. A rating under staff review does not change (`FAILED_PRECONDITION`). Translations of the title and description go through `updateUniverseTranslation`.

## Encyclopedia

| Method | Scope | Result |
| --- | --- | --- |
| `createEncyclopediaEntry({universeId, name, categoryTitle, ...})` | `universe:write` | The new draft entry |
| `updateEncyclopediaEntry({id, changes})` | `universe:write` | The entry after the change |
| `translateEncyclopediaEntry({id, language, ...})` | `universe:translate` or `universe:write` | The entry's edition in that language |
| `setEncyclopediaEntryPublication({id, published})` | `universe:write` | The entry, published or back to draft |
| `deleteEncyclopediaEntry({id})` | `universe:write` | `{id, universeId}` of the deleted entry |

A new entry is a draft in a category the universe offers, named by its title, and starts with the category's template fields. It can carry its first text right away: `pronunciation`, `tags`, `summary`, `parentName`, `relatedAdd`, and `fields` and `timeFields` by title. Other entries are named by their names. A name the universe already has fails with `CONFLICT`, and the error's `resourceId` is the existing entry. The plan of the universe's owner caps the number of entries (`FAILED_PRECONDITION`). Creation and deletion are never retried.

`changes` sets the same values in the original language and may also change `name` and `categoryTitle`, remove links with `relatedRemove`, and clear the parent with `parentName: null`. Text is plain; the server turns it into the editor's format. A text field of a new title is added; a field that holds something other than text is refused. `translateEncyclopediaEntry` writes an edition in a language the universe is translated into (`FAILED_PRECONDITION` otherwise): `name`, `pronunciation`, `summary` and `fields`, each named by its original title with an optional `translatedTitle`. A new edition starts as a copy of the original.

Publishing shows the entry to readers; unpublishing returns it to a draft. Deletion can be undone by staff and removes the entry from the parent and related links of the universe's other entries.

## Series

| Method | Scope | Result |
| --- | --- | --- |
| `saveSeries({universeId, seriesId?, expectedVersion, title, storyIds})` | `universe:write` | The saved series with its new `version` |

A series is the reading order of stories in a universe. `storyIds` lists stories of the universe, not fan fiction, in order; the series workshop shows them in a row. Leave out `seriesId` and pass `expectedVersion: 0` to create one; to replace one, pass the `version` read from `series({universeId})`. A series changed since then fails with `VERSION_CONFLICT` and changes nothing. Saves are never retried. A universe holds up to 50 series.

## Resource restrictions

Restricted credentials can be issued through the existing authenticated browser method; the resource picker belongs to the later developer-settings milestone:

```js
await Meteor.callAsync('apiKeys.create', {
  name: 'Obsidian reads',
  scopes: ['story:read', 'universe:read'],
  resourceRestrictions: { universeIds: ['SELECTED_UNIVERSE_ID'] },
})
```

The method returns the token once. Keep it in your local secret store; never write it into an Obsidian vault or commit it. Existing expiry choices/default remain unchanged; the method still supports omitted expiry.

A selected universe covers its current and future descendant stories/chapters for these reads. A selected story covers itself and its chapters, without granting its parent universe. Containment comes from stored data and is checked again after moves. Selections supplement scopes and current user rights. Each category accepts at most 100 IDs; empty/malformed selections and inaccessible resources are rejected during issuance.

Restricted credentials are denied on legacy GraphQL operations and HTTP text exports that do not enforce these boundaries. Supported draft and universe-translation mutations enforce their stored resource boundaries. Protected media and AI remain session-only. Named SDK operations are client conveniences; server authorization applies to the GraphQL fields themselves.

## Errors and limits

`LiteraryUniverseApiError` provides `code`, a safe message, optional `requestId`, HTTP `status`, `retryAfterSeconds`, `currentRevision` with `VERSION_CONFLICT`, and `resourceId` with `CONFLICT`. Partial GraphQL data is rejected whenever the response contains errors. Missing and inaccessible resources both return `NOT_FOUND`. Common server codes include `UNAUTHENTICATED`, `FORBIDDEN`, `BAD_USER_INPUT`, `GRAPHQL_VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `FAILED_PRECONDITION`, `VERSION_CONFLICT`, `PAYLOAD_TOO_LARGE`, and `INTERNAL_SERVER_ERROR`. Client/transport codes include `INVALID_CONFIGURATION`, `INVALID_RESPONSE`, `REDIRECTED`, `NETWORK_ERROR`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `TIMEOUT` and `CANCELLED`. An HTTP failure without a GraphQL error, such as a 404 from a wrong mount prefix, is `INVALID_RESPONSE`.

Requests retain the 1 MiB JSON ceiling. A draft pull is limited to 8 MiB; requests containing author operations have a 16 MiB response ceiling. The SDK also stops reading at 16 MiB. IP/batch protection remains. Deployed API-key traffic also consumes atomic per-key and owner budgets shared across instances. GraphQL development skips limits except in E2E mode; image transfers always consume shared credential quotas. Top-level aliases are charged as operations; a single query is limited to 20 roots.

Timeout defaults to 30 seconds for the entire request, including retries; valid values are 1–120,000 milliseconds. Pass `{signal, timeoutMs}` as the final method argument to cancel or override it. Retries default to zero and can be configured with `maxRetries: 1` or `2` for network failures and transparent HTTP 429/503 responses. Authentication/permission failures are never retried. Retry-After waits above ten seconds return the throttle error to the caller.

## Development and verification

```sh
npm ci
npm run generate
npm run check:generated
npm run typecheck
npm test
```

`operations.graphql` is validated against the package-local `schema.graphql` artifact. LU CI checks that export against the app contract. Operation types/documents are generated from the supported server contract. When changing the server contract in the monorepo, regenerate `app/graphql.schema.json`, run `node app/scripts/exportSdkSchema.mjs`, then run `npm run generate --prefix sdk`. Commit the updated schema and generated files in this repository before advancing the monorepo submodule pointer. Generation/build/pack work without a sibling app. No generated runtime code depends on Meteor, Mongo, React or GraphQL libraries.

Live acceptance tests belong to the [Literary Universe monorepo](https://github.com/StorytellerCZ/Literary-Universe). With its `sdk` submodule initialized, start the app with tracked `settings.ci.json`, `ENABLE_E2E=1`, its own `.meteor/e2e` build and an isolated local Mongo replica-set database ending in `_test`. Draft and recovery records commit together in a transaction. Set `LU_API_TEST_MONGO_URL` and optionally `LU_API_TEST_BASE_URL`, then run `node --experimental-strip-types app/scripts/testApiReadContract.mjs` from the monorepo root. It issues credentials through real DDP methods, installs the tarball into a clean Node consumer, checks GraphQL/HTTP boundaries, and removes only its own credentials/fixtures and temporary files. The test fixture provisioner uses the app's Mongo dependency; the external consumer imports only Node built-ins and this packed SDK.

## Versioned draft writes

Use story:read and story:write to validate, save and consume the returned draft.
validateDraft accepts the same input as saveDraft, runs current permissions,
version and content checks, and returns warnings without changing content.

```ts
const draft = await client.draft({ id: chapterId })
const input = { id: chapterId, language: draft.language, expectedVersion: draft.version,
  operationId: crypto.randomUUID(), content: changedTiptapJson }
await client.validateDraft(input)
const saved = await client.saveDraft(input)
const before = await client.draftRecovery({ id: chapterId, recoveryId: saved.recoveryId })
```

The input takes exactly one of `content` (Tiptap JSON) and `markdown`, a string in
the form the draft's `markdown` field returns; the server converts it with the
editor's own Markdown extension. Content without a Markdown form (ruby, play
nodes, text alignment, initial letters, emoji, video and work cards, see
`MARKDOWN_LOSSY_TYPES` in /project) round-trips only through `content`; a
`markdown` save of such a draft fails with MARKDOWN_UNSUPPORTED. createChapter
accepts `markdown` the same way.

Retry an interrupted save with the same input and operation ID. A reused ID with
changed input yields IDEMPOTENCY_CONFLICT; a changed draft yields VERSION_CONFLICT.
The mutation changes body representations/counters only. Titles, notes, financial
settings and publication state are preserved. Supported browser nodes share one
schema; unsupported nodes become readable fallback with structured warnings.
The previous draft and saved response remain in a private recovery record for
30 days, after which MongoDB's TTL cleanup removes them. Replay saves within that
window. An expired retry may return VERSION_CONFLICT; pull the current draft and
reconcile it before starting a new operation. Creation and publication receipts
do not expire with draft recovery.

The version covers the whole chapter, including its translations. A translation
body save can therefore conflict with an original-language edit. Title-only and
settings-only edits do not advance it.

The initial write ceiling is 900,000 serialized UTF-8 bytes. In deployed builds,
set server settings authorApi.draftWritesEnabled to true. Optional
 authorApi.allowedUserIds limits rollout to selected accounts. Development builds
allow it by default; setting draftWritesEnabled false disables it there too.
Production publication also requires authorApi.publicationEnabled to be true.

## Chapter lifecycle

```ts
const created = await client.createChapter({ storyId, operationId: crypto.randomUUID(),
  title: 'New chapter', content: tiptapJson })
const released = await client.publishChapter({ id: created.id, expectedVersion: created.version,
  operationId: crypto.randomUUID(), publishAt: '2027-01-01T12:00:00Z' })
```

createChapter requires story:write, appends in LU's chapter order, and returns
its ID/version, localized title and content warnings. Omitted content creates
an empty draft. It preserves story commercial settings and uses the normal
chapter defaults; isAIGenerated can be supplied explicitly. It does not publish.

publishChapter requires story:publish, separately issued by LU. READERS is the
default audience; BETA creates a private revision without changing reader release
dates. Existing translations can be selected by language. Missing publishAt means
now; an explicit timezone-bearing timestamp schedules that revision. Account/work
publication restrictions and course rules apply. A new Tiptap document is required
for canonical publication; save legacy drafts into that format first.

The matching draft, revision, listing changes, retry result and sjobs notification
jobs commit atomically. Publishing advances the draft version. publishedAt is the
revision's release time; chapterPublishedAt retains or advances the chapter's first
release time, matching LU's existing earlier-release behavior. The first original
chapter publishes its story; moving its scheduled release earlier also moves an
existing later story opening earlier. Universe visibility remains a separate LU operation;
a selected story does not implicitly grant publication of its parent universe.

Operation IDs are scoped to the credential owner and operation target, rather
than being globally unique. Saves use the chapter and resolved language; creation
uses the story; publication uses the chapter; image uploads use the purpose and
target. Reusing an ID for another target or action starts a separate operation.
Within that scope, changed input returns IDEMPOTENCY_CONFLICT. Use a fresh random
ID for each new operation and keep it unchanged for retries. Key rotation does
not create duplicates. Replays return the committed result after
current authorization, before new-write constraints. Creation metadata remains
durable after later deletion; retrying returns the original ID and does not recreate
the chapter. Recovery bodies are removed when the corresponding chapter is erased.

Browser creation/deletion use the shared transaction boundary. Browser/offline draft
saves retain their current UX; counters are recalculated from persisted editions.
API saves record challenge progress from that same transaction's word count, so
retrying an old save cannot move newer progress into an earlier day.
The legacy browser revision adapter remains separate from this API publication path.

Credential quotas default to 300 operations/minute/key for regular/staff keys,
600 for premium keys, and three times the respective limit across the owner.
Server settings apiRateLimits.user and apiRateLimits.premium can tune the finite
key limit; owner limits scale with it. A failed shared store returns a retryable
503. Rate diagnostics include Retry-After, remaining and reset headers.

Use the /project entry point for managed filesystem projects, or supply a
credential provider when the host owns storage/rotation:

```ts
const client = new LiteraryUniverseClient({ baseUrl,
  credentials: async signal => ({ kind: 'api-key', token: await getCurrentKey(signal) }),
  clientName: 'my-integration/0.1' })
```

The provider is covered by the request deadline. API keys remain the only
supported credential kind; the provider interface leaves room for deliberate
OAuth support later. Client names are bounded reported metadata for server audit.
There are no automatic telemetry providers or exporters.

## Local projects

```ts
import { pullLocalProject, localProjectStatus, pushLocalProject, refreshLocalProject }
  from '@literary-universe/sdk/project'

await pullLocalProject(client, { directory: 'my-story', baseUrl, storyId })
localProjectStatus('my-story')   // [{ id, language, file, version, changed, source, pending }]
await pushLocalProject(client, { directory: 'my-story', baseUrl })
await refreshLocalProject(client, { directory: 'my-story', baseUrl })   // { added, updated, removed }
```

A pull writes every draft twice: `chapters/chapter-<id>.<lang>.json` holds the
Tiptap document and `chapters/<seq>-<slug>.<lang>.md` mirrors it as Markdown.
`seq` is the chapter sequence zero-padded to three digits and `slug` the title
lower-cased with runs of other characters turned into hyphens, at most 60
characters, `chapter` when nothing is left, numbered `-2`, `-3` on a collision.
The Markdown file starts with YAML frontmatter (`id`, `title`, `language`,
`version`, `editable`) followed by a blank line and the body; only the body is
hashed and sent. A chapter whose content has no Markdown form gets
`editable: false` and a `# Edit chapters/chapter-<id>.<lang>.json instead` line
under the frontmatter. The manifest `.lu/project.json` stays at version 1;
manifests without the `markdown` entry still load and gain the mirror on the
next save.

`localProjectStatus` reports `source` per chapter: `none`, `json`, `markdown` or
`both`. A push sends `content` for `json` and `markdown` for `markdown`, then
rewrites both files from the server's normalized draft. A chapter changed in
both files fails locally with AMBIGUOUS_CHANGE, a Markdown edit of a chapter
marked `editable: false` with MARKDOWN_UNSUPPORTED; nothing is sent for either.
Revert one file to the manifest form to continue. Pending intents record which
form was sent and replay unchanged after an interruption.

`refreshLocalProject` re-pulls every chapter of an existing project. It refuses
with LOCAL_CHANGES while any chapter is changed or pending; otherwise it rewrites
files and manifest, renames Markdown mirrors whose title or sequence changed,
deletes the files of chapters the server no longer has, and reports the chapter
IDs added, updated and removed. `pullLocalProject` with `refresh: true` is the
same call.

## Images

Install the existing supported image engine with `npm install sharp@0.35.5` in a
consumer that uses /images. The CLI installs it automatically. Core API calls and
policy reads do not load Sharp.

```ts
import { readFile } from 'node:fs/promises'
import { prepareImage } from '@literary-universe/sdk/images'

const policy = await client.imagePolicy()
const image = await prepareImage(await readFile('scene.png'), 'chapter-image', { policy })
const asset = await client.uploadImage({ ...image, targetId: chapterId,
  operationId: crypto.randomUUID() })

const cover = await prepareImage(await readFile('cover.png'), 'story-cover', { policy })
await client.setCover({ kind: 'story', id: storyId, bytes: cover.bytes, type: cover.type })
```

Preparation runs locally in a killable subprocess. It accepts single-frame raster
images, corrects EXIF orientation, strips metadata, preserves transparency, and
resizes/compresses to the selected purpose's finite limits. A forced JPEG output
is rejected when it would discard transparency. SVG, document and multi-frame
inputs require an explicit raster/single-frame export. Originals remain untouched;
no remote references are fetched. A crop must be explicit: `{crop: {left, top,
width, height}}` uses pixels after orientation. A wrong enforced ratio returns
CROP_REQUIRED. Recommended cover dimensions do not impose a resize.

The versioned policy is packaged for offline use and available from imagePolicy.
LU and the SDK consume exported copies of the same policy data. The initial
processing bounds are 50 MiB source bytes, 40 million source pixels, 16 million
output pixels and ten seconds, including metadata parsing. Smaller server limits
apply; larger remote limits never raise the SDK's local processing ceilings.
Story/universe covers, chapter and encyclopedia images, blog images and headers
have a 5 MiB upload ceiling; blog logos have 2 MiB. Covers enforce 2:3 and 1:1;
blog post images use 16:9 with a consistent 1200×675 recommendation.

uploadImage creates a public asset in LU's existing ImagesCollection/storage. It
returns an ID, URL, digest, size and dimensions. It does not attach, replace or
publish content. Use story:write for chapter images, universe:write for
encyclopedia illustrations, and blog:write for blog assets. It refuses cover
purposes: setCover replaces a story's (story:write) or universe's
(universe:write) cover through `PUT /api/{stories,universes}/:id/cover`, which
crops to the cover shape and stores WebP. It takes no operation ID; retrying sets
the same cover again. Prepare with the cover purposes to stay within 5 MiB.
Current target capabilities, course rules, plan restrictions and selected-resource
boundaries still apply. Chapter uploads target a chapter, encyclopedia uploads
an entry, and blog purposes target their blog. Chapter
images currently target the original edition; translation-specific asset writes
remain to add. Restricted story/universe keys cannot target blogs. Universe/blog
write scopes currently enable asset creation; broader editing contracts are later.

Binary transfers use /api/author/images, bypassing the GraphQL JSON ceiling. LU
checks the actual format, full decode, bytes, geometry and ratio. Requests cost ten
ordinary operations against shared key/owner quotas. Concurrent transfers are
bounded to one per key, three per owner and eight per deployment, with four
decoders per server process. Body transfer has a twenty-second deadline; decoding
has a killable ten-second deadline. Unavailable enforcement/storage fails closed.
Transfer and intent leases renew while work is active; renewal calls are bounded
to ten seconds and the final asset/result transaction to twenty-five seconds.
Production uses the existing authorApi.draftWritesEnabled/allowedUserIds rollout.

Keep the prepared bytes and operation ID for retry. Changed input yields
IDEMPOTENCY_CONFLICT; committed replay returns the original asset after current
authorization, including after credential rotation or a smaller current purpose
limit, within the fixed 5 MiB transport ceiling. New input using an old policy
returns POLICY_CHANGED. An ambiguous storage/commit failure may require waiting
for its 90-second lease; retry checks the deterministic storage key's digest
before creating bytes again. Safe API/client attribution uses LU's existing audit
collection. Storage remains public; protected comic/audio files use other contracts.

For live image checks, configure an isolated local S3-compatible test endpoint in
the test server's Backblaze settings, then run `node app/scripts/testApiImageContract.mjs` from the monorepo root with the same
local _test database variables as test:integration. Real Backblaze verification
remains a separate rollout check.

Platform CI runs the package checks on Windows and macOS, including both Intel
and Apple Silicon Macs. These checks cover extracted builds, packed consumers,
image preparation/cancellation and CLI credential storage. Local project and
source JSON files accept UTF-8 BOM and CRLF; chapter filenames must be distinct
ignoring case so moving a project between these filesystems cannot overwrite a
different chapter.

The monorepo provides a local storage fixture: run
`node app/scripts/serveApiImageTestStorage.mjs /tmp/lu-image-settings.json`, start
the isolated Meteor test server with that settings file, and stop both owned
processes after verification. The fixture uses synthetic credentials and checks
real S3 transport without contacting Backblaze. It is not a production server.

## MCP server

`@literary-universe/sdk/mcp` registers the authoring API as tools on a
`McpServer` from `@modelcontextprotocol/sdk` (install it and `zod` in the host;
the core client does not load them). The CLI's `lu mcp` and the hosted
`https://literaryuniverse.com/mcp` endpoint use it.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFile } from 'node:fs/promises'
import { LiteraryUniverseClient } from '@literary-universe/sdk'
import { registerLiteraryUniverseTools } from '@literary-universe/sdk/mcp'

const token = process.env.LU_TOKEN
const client = token ? new LiteraryUniverseClient({ baseUrl, token }) : null
const server = new McpServer({ name: 'literary-universe', version: '0.2.0' })
registerLiteraryUniverseTools(server, { client: () => client, readLocalFile: readFile })
await server.connect(new StdioServerTransport())
```

`client` is called per tool call so a host can refresh credentials; `null` makes
every tool that needs an account answer `Not signed in to Literary Universe`.
Tools are grouped in categories; `tools` selects categories and/or tool names
(`'all'` for every tool) and replaces the default selection, which leaves out
`publish`: `account`, `stories` (`list-stories`, `get-story`, `list-chapters`,
`get-chapter-draft`), `stories-write` (`save-chapter-draft`, `create-chapter`,
`update-story`, `set-story-visibility`, `rename-chapter`, `reorder-chapters`,
`remove-chapter`), `publish` (`publish-chapter`, which does nothing without
`confirm: true`), `universes`, `universes-write`, `images` (`set-cover` only with
`readLocalFile`) and `docs` (`search-lu-docs`, `fetch-lu-docs`, usable without
login; they read the site's `llms.txt` pages under `docsBaseUrl`). `selectTools`
validates a selection without a server. Every tool carries a title, a zod input
schema and the four MCP annotations; results carry `structuredContent` and a
text form; API errors come back as `isError` text `CODE: message (request id)`,
with the input schema appended for BAD_USER_INPUT. Resources `lu://story/{id}`
and `lu://chapter/{id}/draft` return the same data as the tools.
