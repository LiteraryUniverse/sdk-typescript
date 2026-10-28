# Contributing

The source is public and MIT licensed. npm publication remains a separate release step.
Use TypeScript and named exports. Keep the HTTP client independent of Meteor,
React, Mongo and application configuration. Heavier preparation and filesystem
helpers belong in separate SDK entry points.

Run npm ci, npm run check:generated, npm run typecheck and npm test in this folder.
Run bun test test for runtime compatibility. Changes to SDK operations must be
validated against schema.graphql and regenerated with npm run generate.

In the LU monorepo, update the server schema and run node
app/scripts/exportSdkSchema.mjs before regenerating SDK operations. The exported
contract is the package-local input; build and pack scripts must remain independent of a sibling application.

Test through public methods and packed consumers. Include relevant scope,
resource, concurrency and lost-response cases for writes. Never include real
keys, user manuscripts or private settings in fixtures, documentation or reports.

The standalone package workflow checks Node 24 and Bun on Linux, Windows,
macOS on Apple Silicon, and macOS on Intel. The monorepo also checks Node 22
on Windows/Apple Silicon and Node 22/26 on Linux. Image preparation and
cancellation must work in both ESM and CommonJS packages, including installation
paths containing spaces and Unicode.
