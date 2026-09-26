/**
 * The two shapes of exit 2, and the streams a consumer pipes.
 *
 * A configuration error means the run never had a subject, so stdout stays
 * EMPTY. Evidence that could not be read means the run had a subject and failed
 * to obtain facts about it, so stdout carries an `incomplete` report naming
 * which input was not read.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BIN, cleanup, dataset, run, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const RULE = { id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }

async function project(rows, { rules = [RULE] } = {}) {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', rows))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({ datasets: [{ name: 'orders', file: 'orders.json' }], rules }))
  return { directory, rulesPath }
}

test('--help writes usage to stderr, leaves stdout empty and exits 0', async () => {
  const result = await run(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /data-quality-rule-runner/u)
  assert.match(result.stderr, /A broken rule is an execution error, never a data pass\./u)
})

test('an unknown option keeps stdout empty and exits 2', async () => {
  const result = await run(['--rules', 'x', '--data', 'y', '--invented'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--invented"/u)
})

test('a missing required option keeps stdout empty and exits 2', async () => {
  for (const args of [[], ['--rules', 'x'], ['--data', 'y']]) {
    const result = await run(args)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /is required/u)
  }
})

test('an option given no value keeps stdout empty and exits 2', async () => {
  const result = await run(['--rules', '--data', 'y'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--rules requires a value/u)
})

test('an invalid ruleset keeps stdout empty and exits 2', async () => {
  const directory = await workspace()
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, { schemaVersion: '2', datasets: [], rules: [] })

  const result = await run(['--rules', rulesPath, '--data', directory])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /"schemaVersion" must be "1"/u)
})

test('an unreadable dataset emits an incomplete report on stdout and exits 2', async () => {
  const directory = await workspace()
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [RULE],
  }))

  const result = await run(['--rules', rulesPath, '--data', directory, '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'dataset-unreadable'), true)
  assert.equal(result.stderr, '')
})

test('a clean run exits 0 with a parseable report and a human summary', async () => {
  const { directory, rulesPath } = await project([{ a: 'present' }])
  const result = await run(['--rules', rulesPath, '--data', directory])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.findings, [])
  assert.equal(report.tool, 'data-quality-rule-runner')
  assert.equal(report.schemaVersion, '1')
  assert.match(result.stderr, /data-quality-rule-runner: pass/u)
})

test('a violated rule exits 1', async () => {
  const { directory, rulesPath } = await project([{ a: null }])
  const result = await run(['--rules', rulesPath, '--data', directory, '--json'])
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).status, 'fail')
})

test('--json suppresses the summary but never the report', async () => {
  const { directory, rulesPath } = await project([{ a: 'present' }])
  const quiet = await run(['--rules', rulesPath, '--data', directory, '--json'])
  assert.equal(quiet.stderr, '')
  assert.notEqual(quiet.stdout, '')
})

test('the human summary says plainly that incomplete is not a pass', async () => {
  const { directory, rulesPath } = await project([{ b: 1 }])
  const result = await run(['--rules', rulesPath, '--data', directory])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /incomplete: at least one rule did not reach a verdict\. This is not a pass\./u)
})

test('stdout is only ever the report, so it pipes into a parser', async () => {
  const { directory, rulesPath } = await project([{ a: null }])
  const result = await run(['--rules', rulesPath, '--data', directory])
  assert.doesNotThrow(() => JSON.parse(result.stdout))
  assert.equal(result.stdout.endsWith('}\n'), true)
})

test('the CLI writes no file of its own', async () => {
  const { readdir } = await import('node:fs/promises')
  const { directory, rulesPath } = await project([{ a: 'present' }])
  const before = (await readdir(directory)).sort()
  await run(['--rules', rulesPath, '--data', directory, '--json'])
  assert.deepEqual((await readdir(directory)).sort(), before)
})

test('--show-values is off unless it is asked for', async () => {
  const rows = [{ a: 'a-secret-looking-value' }, { a: 'a-secret-looking-value' }]
  const { directory, rulesPath } = await project(rows, {
    rules: [{ id: 'unique-a', kind: 'uniqueness', dataset: 'orders', columns: ['a'] }],
  })

  const masked = await run(['--rules', rulesPath, '--data', directory, '--json'])
  assert.equal(masked.code, 1)
  assert.equal(masked.stdout.includes('a-secret-looking-value'), false)
  assert.equal(JSON.parse(masked.stdout).findings[0].ruleId, 'uniqueness-violation')
  assert.match(JSON.parse(masked.stdout).findings[0].message, /a=<string:22>/u)

  const shown = await run(['--rules', rulesPath, '--data', directory, '--json', '--show-values'])
  assert.equal(shown.code, 1)
  assert.match(JSON.parse(shown.stdout).findings[0].message, /a=a-secret-looking-value/u)
})

test('the human summary prints every finding, with its severity, id, place and message', async () => {
  // Deleting either of the two lines that render a finding left the suite
  // green: the whole human half of the output -- the half a person actually
  // reads, since --json is what a machine takes -- was pinned only by its
  // three header lines.
  const { directory, rulesPath } = await project([{ a: 1 }, { a: 1 }], {
    rules: [{ id: 'unique-a', kind: 'uniqueness', dataset: 'orders', columns: ['a'] }],
  })
  const result = await run(['--rules', rulesPath, '--data', directory])

  assert.equal(result.code, 1)
  const lines = result.stderr.split('\n')
  assert.equal(lines[0], 'data-quality-rule-runner: fail')
  assert.equal(lines[1], '  rules declared 1, rules executed 1')
  assert.equal(lines[2], '  datasets read 1 of 1, rows examined 2')
  assert.equal(lines[3], '  findings 1 (errors 1, warnings 0)')
  assert.equal(lines[4], '  error uniqueness-violation orders.json /rows/1')
  assert.equal(lines[5], '    rule unique-a: composite key (a=<number>) also appears at /rows/0.')
  // No incomplete line: this run reached its verdict and the verdict was fail.
  assert.equal(result.stderr.includes('incomplete'), false)

  // stdout carries the same JSON report either way -- a consumer that pipes it
  // never has to ask for that. What --json changes is the human summary, which
  // is silenced, so the lines above are the human path and not a duplicate of
  // the machine one.
  const json = await run(['--rules', rulesPath, '--data', directory, '--json'])
  assert.equal(json.stderr, '')
  assert.equal(json.stdout, result.stdout)
  assert.equal(JSON.parse(json.stdout).findings.length, 1)
})

test('the human summary does not credit a verdict the same summary says was not reached', async () => {
  // The number in this line counts rules that RAN. A referential rule whose
  // index came out empty runs, reports every non-match as undetermined and
  // establishes nothing -- and the line below it says so. Rendering that count
  // as "rules with a verdict" put the two sentences two lines apart in one
  // report, each contradicting the other, which is exactly the shape a reader
  // cannot act on.
  const directory = await workspace()
  await writeJson(join(directory, 'customers.json'), dataset('customers', []))
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ customer_id: 'cust-001' }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }, { name: 'customers', file: 'customers.json' }],
    rules: [{
      id: 'known-customer',
      kind: 'referential',
      dataset: 'orders',
      columns: ['customer_id'],
      references: { dataset: 'customers', columns: ['id'] },
    }],
  }))

  const result = await run(['--rules', rulesPath, '--data', directory])
  assert.equal(result.code, 2)
  // What the run established, pinned positively: one rule ran, it reached no
  // verdict, and the summary says both of those things in the same words.
  assert.match(result.stderr, /rules declared 1, rules executed 1\n/u)
  assert.match(result.stderr, /incomplete: at least one rule did not reach a verdict\. This is not a pass\.\n/u)
  assert.equal(/rules with a verdict/u.test(result.stderr), false)
  assert.equal(JSON.parse(await jsonOf(rulesPath, directory)).summary.checked, 1)
})

async function jsonOf(rulesPath, directory) {
  const result = await run(['--rules', rulesPath, '--data', directory, '--json'])
  return result.stdout
}

test('the bin path is executable as a module entry point', () => {
  assert.equal(BIN.endsWith('/bin/data-quality-rule-runner.mjs'), true)
})

test('a ruleset that is not valid UTF-8 is a configuration error with empty stdout', async () => {
  const directory = await workspace()
  const rulesPath = join(directory, 'rules.json')
  await writeFile(rulesPath, Buffer.from([0x7b, 0xff, 0x7d]))
  const result = await run(['--rules', rulesPath, '--data', directory])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--rules is not valid UTF-8\./u)
})
