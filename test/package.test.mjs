import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('SDK generation and build work after extraction without the application', {
	timeout: 30_000,
}, () => {
	const root = fileURLToPath(new URL('../', import.meta.url))
	const folder = mkdtempSync(join(tmpdir(), 'lu SDK Ω & extracted-'))
	try {
		cpSync(root, folder, {
			recursive: true,
			filter: (path) => !/[/\\](node_modules|dist)([/\\]|$)/.test(path),
		})
		symlinkSync(
			join(root, 'node_modules'),
			join(folder, 'node_modules'),
			'junction',
		)
		for (const script of ['generate.mjs', 'build.mjs']) {
			const result = spawnSync(
				process.execPath,
				[join(folder, 'scripts', script)],
				{ cwd: folder, encoding: 'utf8' },
			)
			assert.equal(result.status, 0, result.stderr || result.stdout)
		}
	} finally {
		rmSync(folder, { recursive: true, force: true })
	}
})
