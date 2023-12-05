/**
 * Every declared limit, driven from BOTH sides.
 *
 * "Fires at N+1" and "stays silent at exactly N" are two assertions, and across
 * this catalog only the first was ever written. Widening any comparison by one
 * then starts refusing documents sitting exactly on a limit the documentation
 * calls legal, with the whole suite green. Each test below pins both.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LIMIT_CEILINGS,
  LIMIT_NAMES,
  MAX_DATASETS,
  MAX_ID_LENGTH,
  MAX_KEY_COLUMNS,
  MAX_RULES,
  MAX_RULESET_BYTES,
  RulesetError,
  runRuleset,
  validateRuleset,
} from '../src/index.mjs'
import { cleanup, dataset, ruleIds, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const COMPLETENESS = { id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }

async function project(rows, limits, rules = [COMPLETENESS]) {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', rows))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules,
    limits,
  }))
  return { directory, rulesPath }
}

function baseRuleset(overrides = {}) {
  return {
    schemaVersion: '1',
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [COMPLETENESS],
    ...overrides,
  }
}

test('limits.maxDatasetBytes: silent at exactly the file size, fires one byte below it', async () => {
  const rows = [{ a: 'one' }, { a: 'two' }]
  const { directory, rulesPath } = await project(rows, {})
  const size = (await stat(join(directory, 'orders.json'))).size

  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [COMPLETENESS],
    limits: { maxDatasetBytes: size },
  }))
  const atLimit = await runRuleset({ rules: rulesPath, data: directory })
  assert.deepEqual(atLimit.findings, [])
  assert.equal(atLimit.status, 'pass')

  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [COMPLETENESS],
    limits: { maxDatasetBytes: size - 1 },
  }))
  const over = await runRuleset({ rules: rulesPath, data: directory })
  assert.equal(over.status, 'incomplete')
  assert.equal(ruleIds(over).includes('dataset-too-large'), true)
})

test('limits.maxRows: silent at exactly the row count, fires one row below it', async () => {
  const rows = [{ a: '1' }, { a: '2' }, { a: '3' }]

  const atLimit = await project(rows, { maxRows: 3 })
  const ok = await runRuleset({ rules: atLimit.rulesPath, data: atLimit.directory })
  assert.deepEqual(ok.findings, [])

  const over = await project(rows, { maxRows: 2 })
  const refused = await runRuleset({ rules: over.rulesPath, data: over.directory })
  assert.equal(refused.status, 'incomplete')
  assert.equal(ruleIds(refused).includes('dataset-too-many-rows'), true)
})

test('limits.maxColumns: silent at exactly the column count, fires one below it', async () => {
  const rows = [{ a: '1', b: '2', c: '3' }]

  const atLimit = await project(rows, { maxColumns: 3 })
  const ok = await runRuleset({ rules: atLimit.rulesPath, data: atLimit.directory })
  assert.deepEqual(ok.findings, [])

  const over = await project(rows, { maxColumns: 2 })
  const refused = await runRuleset({ rules: over.rulesPath, data: over.directory })
  assert.equal(refused.status, 'incomplete')
  assert.equal(ruleIds(refused).includes('dataset-too-many-columns'), true)
})

test('limits.maxFieldLength: a value of exactly the limit is usable, one longer is not', async () => {
  const rows = [{ a: 'x'.repeat(16) }]

  const atLimit = await project(rows, { maxFieldLength: 16 })
  const ok = await runRuleset({ rules: atLimit.rulesPath, data: atLimit.directory })
  assert.deepEqual(ok.findings, [])

  const over = await project(rows, { maxFieldLength: 15 })
  const refused = await runRuleset({ rules: over.rulesPath, data: over.directory })
  assert.equal(refused.status, 'incomplete')
  assert.equal(ruleIds(refused).includes('value-unevaluable'), true)
})

test('limits.maxSamplesPerRule: no truncation at exactly the violation count, one below truncates', async () => {
  const rows = [{ a: null }, { a: null }, { a: null }]

  const atLimit = await project(rows, { maxSamplesPerRule: 3 })
  const ok = await runRuleset({ rules: atLimit.rulesPath, data: atLimit.directory })
  assert.deepEqual(ruleIds(ok), [
    'completeness-violation',
    'completeness-violation',
    'completeness-violation',
  ])
  assert.equal(ruleIds(ok).includes('samples-truncated'), false)

  const over = await project(rows, { maxSamplesPerRule: 2 })
  const cut = await runRuleset({ rules: over.rulesPath, data: over.directory })
  assert.equal(ruleIds(cut).filter((id) => id === 'completeness-violation').length, 2)
  const truncation = cut.findings.filter((finding) => finding.ruleId === 'samples-truncated')
  assert.equal(truncation.length, 1)
  assert.match(truncation[0].message, /3 row\(s\) produced completeness-violation; 2 location\(s\)/u)
  assert.equal(truncation[0].severity, 'info')
})

test('a bounded location list does not turn a failure into an incomplete run', async () => {
  // samples-truncated is deliberately NOT evidence-missing: the verdict was
  // established, only the list of places was cut.
  const { directory, rulesPath } = await project([{ a: 1 }, { a: 2 }, { a: 3 }], {
    maxSamplesPerRule: 1,
  }, [{ id: 'r', kind: 'range', dataset: 'orders', column: 'a', max: 0 }])
  const report = await runRuleset({ rules: rulesPath, data: directory })
  assert.equal(report.status, 'fail')
  assert.equal(ruleIds(report).includes('samples-truncated'), true)
})

test('MAX_RULES: a ruleset of exactly the maximum validates, one more is refused', () => {
  const make = (count) => baseRuleset({
    rules: Array.from({ length: count }, (unused, index) => ({ ...COMPLETENESS, id: `r${index}` })),
  })
  assert.equal(validateRuleset(make(MAX_RULES)).rules.length, MAX_RULES)
  assert.throws(() => validateRuleset(make(MAX_RULES + 1)), RulesetError)
})

test('MAX_DATASETS: exactly the maximum validates, one more is refused', () => {
  const make = (count) => baseRuleset({
    datasets: Array.from({ length: count }, (unused, index) => ({ name: `d${index}`, file: `d${index}.json` })),
    rules: [{ ...COMPLETENESS, dataset: 'd0' }],
  })
  assert.equal(validateRuleset(make(MAX_DATASETS)).datasets.length, MAX_DATASETS)
  assert.throws(() => validateRuleset(make(MAX_DATASETS + 1)), RulesetError)
})

test('MAX_KEY_COLUMNS: a key of exactly the maximum validates, one more is refused', () => {
  const make = (count) => baseRuleset({
    rules: [{
      id: 'k',
      kind: 'uniqueness',
      dataset: 'orders',
      columns: Array.from({ length: count }, (unused, index) => `c${index}`),
    }],
  })
  assert.equal(validateRuleset(make(MAX_KEY_COLUMNS)).rules[0].columns.length, MAX_KEY_COLUMNS)
  assert.throws(() => validateRuleset(make(MAX_KEY_COLUMNS + 1)), RulesetError)
})

test('MAX_ID_LENGTH: a name of exactly the maximum validates, one longer is refused', () => {
  const make = (length) => baseRuleset({ rules: [{ ...COMPLETENESS, id: 'i'.repeat(length) }] })
  assert.equal(validateRuleset(make(MAX_ID_LENGTH)).rules[0].id.length, MAX_ID_LENGTH)
  assert.throws(() => validateRuleset(make(MAX_ID_LENGTH + 1)), RulesetError)
})

test('every configurable limit accepts its ceiling and refuses one above it', () => {
  for (const name of LIMIT_NAMES) {
    const ceiling = LIMIT_CEILINGS[name]
    assert.equal(
      validateRuleset(baseRuleset({ limits: { [name]: ceiling } })).limits[name],
      ceiling,
      `${name} should accept its ceiling`,
    )
    assert.throws(
      () => validateRuleset(baseRuleset({ limits: { [name]: ceiling + 1 } })),
      RulesetError,
      `${name} should refuse one above its ceiling`,
    )
  }
})

test('MAX_RULESET_BYTES: a file of exactly the limit is read, one byte more is refused', async () => {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ a: 'x' }]))

  // JSON permits trailing whitespace, so the document is padded to an exact
  // byte count without changing what it says.
  const body = JSON.stringify(baseRuleset())
  const pad = (size) => body + ' '.repeat(size - Buffer.byteLength(body))

  const atLimit = join(directory, 'at-limit.json')
  await writeFile(atLimit, pad(MAX_RULESET_BYTES), 'utf8')
  assert.equal((await stat(atLimit)).size, MAX_RULESET_BYTES)
  const ok = await runRuleset({ rules: atLimit, data: directory })
  assert.deepEqual(ok.findings, [])

  const over = join(directory, 'over-limit.json')
  await writeFile(over, pad(MAX_RULESET_BYTES + 1), 'utf8')
  await assert.rejects(
    () => runRuleset({ rules: over, data: directory }),
    (error) => error instanceof RulesetError && /was not opened/u.test(error.message),
  )
})
