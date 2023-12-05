import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(HERE)
export const BIN = join(ROOT, 'bin', 'data-quality-rule-runner.mjs')

const trash = []

export async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'dqrr-'))
  trash.push(directory)
  return directory
}

export async function cleanup() {
  while (trash.length > 0) {
    await rm(trash.pop(), { recursive: true, force: true })
  }
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

export function dataset(name, rows) {
  return { schemaVersion: '1', dataset: name, rows }
}

/** A ruleset that declares one dataset and one rule, with sensible defaults. */
export function ruleset({ datasets, rules, limits }) {
  const document = { schemaVersion: '1', datasets, rules }
  if (limits !== undefined) document.limits = limits
  return document
}

/**
 * Run the CLI and capture everything a consumer can see.
 *
 * `execFile` rejects on a non-zero exit, and the rejection carries the streams,
 * so both paths are normalised into one shape. Tests assert on `code`,
 * `stdout` and `stderr` -- an exit code is the one thing three agreeing
 * declarations cannot be edited into.
 */
export function run(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { ...options }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

export function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}
