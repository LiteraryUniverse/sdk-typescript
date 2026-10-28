import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// A reused dist would keep shipping modules that src no longer has.
rmSync('dist', { recursive: true, force: true })
for (const args of [
  [],
  [
    '--module',
    'CommonJS',
    '--moduleResolution',
    'Node',
    '--outDir',
    'dist/cjs',
  ],
]) {
  const result = spawnSync(
    process.execPath,
    [resolve('node_modules/typescript/bin/tsc'), ...args],
    { stdio: 'inherit' },
  )
  // status is null when a signal killed the compiler.
  if (result.status !== 0) process.exit(result.status ?? 1)
}
mkdirSync('dist/cjs', { recursive: true })
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n')
