import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { join } from 'node:path'

const MAX_OUTPUT = Math.ceil((5 * 1024 * 1024) / 3) * 4 + 32_768
const failure = (code: string) =>
	Object.assign(new Error('Image preparation stopped'), { code })
function collectOutput(child: ChildProcessWithoutNullStreams) {
	const chunks: Buffer[] = []
	let size = 0
	child.stdout.on('data', (chunk: Buffer) => {
		size += chunk.length
		if (size > MAX_OUTPUT) child.kill('SIGKILL')
		else chunks.push(chunk)
	})
	return () => {
		if (size > MAX_OUTPUT) throw failure('PAYLOAD_TOO_LARGE')
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
	}
}
function completeWorker(
	code: number | null,
	result: () => unknown,
	resolve: (value: unknown) => void,
	reject: (error: unknown) => void,
) {
	try {
		if (code !== 0) throw failure('INVALID_IMAGE')
		resolve(result())
	} catch (error) {
		reject(error)
	}
}
function observeWorker(
	child: ChildProcessWithoutNullStreams,
	signal: AbortSignal,
	resolve: (value: unknown) => void,
	reject: (error: unknown) => void,
) {
	const result = collectOutput(child)
	const abort = () => {
		child.kill('SIGKILL')
		reject(
			failure(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED'),
		)
	}
	child.once('error', () => reject(failure('INVALID_IMAGE')))
	child.stdin.on('error', () => {})
	child.once('close', (code) => {
		signal.removeEventListener('abort', abort)
		completeWorker(code, result, resolve, reject)
	})
	signal.addEventListener('abort', abort, { once: true })
	if (signal.aborted) abort()
}
const workerEnvironment = () => ({
	PATH: process.env.PATH,
	SystemRoot: process.env.SystemRoot,
	TEMP: process.env.TEMP,
	TMP: process.env.TMP,
})
function startWorker(payload: { purpose: string; options: unknown }) {
	const args = [
		join(__dirname, 'imageProcessing.js'),
		'lu-image-prepare',
		JSON.stringify({ purpose: payload.purpose, options: payload.options }),
	]
	return spawn(process.execPath, args, {
		stdio: 'pipe',
		windowsHide: true,
		env: workerEnvironment(),
	})
}
export function runImageWorker(
	payload: { source: Uint8Array; purpose: string; options: unknown },
	timeoutMs: number,
	signal?: AbortSignal,
) {
	if (signal?.aborted) return Promise.reject(failure('CANCELLED'))
	const child = startWorker(payload)
	const deadline = AbortSignal.any([
		AbortSignal.timeout(timeoutMs),
		...(signal ? [signal] : []),
	])
	const result = new Promise((resolve, reject) =>
		observeWorker(child, deadline, resolve, reject),
	)
	child.stdin.end(payload.source)
	return result
}
