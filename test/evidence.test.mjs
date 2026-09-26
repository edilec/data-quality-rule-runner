/**
 * Evidence about a dataset: everything that makes a run incomplete rather than
 * clean, and the allowed cases that must stay silent beside each refusal.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runRuleset } from '../src/index.mjs'
import { cleanup, dataset, findingsFor, ruleIds, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const RULE = { id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }

async function runOver(write) {
  const directory = await workspace()
  await write(directory)
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [RULE],
  }))
  return runRuleset({ rules: rulesPath, data: directory })
}

test('a dataset that is not valid UTF-8 is not decoded, and is not a pass', async () => {
  const report = await runOver((directory) => writeFile(
    join(directory, 'orders.json'),
    Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]),
  ))
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('dataset-not-utf8'), true)
})

test('a document holding a literal replacement character still decodes and is checked', async () => {
  // Encoding validity is never inferred from decoded content. A tool in this
  // catalog disabled its own encoding guard file-wide because a document
  // legitimately contained U+FFFD.
  const report = await runOver((directory) => writeJson(
    join(directory, 'orders.json'),
    dataset('orders', [{ a: `value${String.fromCodePoint(0xfffd)}` }]),
  ))
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a dataset declaring an unsupported schema version is refused', async () => {
  const report = await runOver((directory) => writeJson(join(directory, 'orders.json'), {
    schemaVersion: '2',
    dataset: 'orders',
    rows: [{ a: 'present' }],
  }))
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('dataset-schema-unsupported'), true)
  assert.match(
    findingsFor(report, 'dataset-schema-unsupported')[0].message,
    /declares schemaVersion 2; this tool reads 1/u,
  )
})

test('an export whose own name disagrees with the ruleset is not used', async () => {
  const report = await runOver((directory) => writeJson(
    join(directory, 'orders.json'),
    dataset('invoices', [{ a: 'present' }]),
  ))
  assert.equal(report.status, 'incomplete')
  assert.match(
    findingsFor(report, 'dataset-invalid')[0].message,
    /names dataset invoices, but the ruleset expects orders/u,
  )
})

test('a row that is not an object stops the dataset rather than being skipped', async () => {
  const report = await runOver((directory) => writeJson(
    join(directory, 'orders.json'),
    dataset('orders', [{ a: 'present' }, 'not-an-object']),
  ))
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('dataset-invalid'), true)
})

test('a dataset with no rows array is refused', async () => {
  const report = await runOver((directory) => writeJson(join(directory, 'orders.json'), {
    schemaVersion: '1',
    dataset: 'orders',
  }))
  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'dataset-invalid')[0].message, /has no "rows" array/u)
})

test('a cell holding an object is unevaluable, and a cell holding a boolean is not', async () => {
  const nested = await runOver((directory) => writeJson(
    join(directory, 'orders.json'),
    dataset('orders', [{ a: { nested: true } }]),
  ))
  assert.equal(nested.status, 'incomplete')
  assert.match(
    findingsFor(nested, 'value-unevaluable')[0].message,
    /holds a value this run could not read \(the value is not a scalar/u,
  )

  const scalar = await runOver((directory) => writeJson(
    join(directory, 'orders.json'),
    dataset('orders', [{ a: false }, { a: 0 }]),
  ))
  // `false` and `0` are populated values. A completeness rule that called them
  // missing would be raising a finding on correct data.
  assert.deepEqual(scalar.findings, [])
})

test('a value that renders as nothing is not populated, however trim reads it', async () => {
  const report = await runOver((directory) => writeJson(
    join(directory, 'orders.json'),
    dataset('orders', [{ a: String.fromCodePoint(0x200e) }]),
  ))
  assert.equal(report.status, 'fail')
  assert.deepEqual(ruleIds(report), ['completeness-violation'])
  assert.match(
    report.findings[0].message,
    /renders as nothing once control and format characters are removed/u,
  )
})

test('an absent column on one row differs from a null on another, and both are reported', async () => {
  const report = await runOver((directory) => writeJson(
    join(directory, 'orders.json'),
    dataset('orders', [{ a: null }, { b: 1 }, { a: 'present' }]),
  ))
  assert.equal(report.status, 'fail')
  const messages = findingsFor(report, 'completeness-violation').map((finding) => finding.message)
  assert.equal(messages.some((text) => /the value is null/u.test(text)), true)
  assert.equal(messages.some((text) => /the column is not present on this row/u.test(text)), true)
})

test('a run that reaches no verdict at all says so in the report', async () => {
  const report = await runOver((directory) => writeJson(
    join(directory, 'orders.json'),
    dataset('orders', []),
  ))
  assert.equal(report.summary.checked, 0)
  const vacuous = findingsFor(report, 'no-rules-executed')
  assert.equal(vacuous.length, 1)
  assert.deepEqual(vacuous[0].location, { pointer: '/rules' })
  assert.match(vacuous[0].message, /establishes nothing about the data/u)
})

test('a run that reaches a verdict never raises the vacuous-pass finding', async () => {
  const report = await runOver((directory) => writeJson(
    join(directory, 'orders.json'),
    dataset('orders', [{ a: 'present' }]),
  ))
  assert.equal(ruleIds(report).includes('no-rules-executed'), false)
  assert.equal(report.summary.checked, 1)
})
