/**
 * Guards a mutation sweep found nothing defending.
 *
 * Each test here exists because removing one statement left the whole suite
 * green. Several of them pin a MESSAGE rather than an error class, because two
 * guards in sequence often refuse the same document for different reasons: the
 * suite still saw a `RulesetError`, so deleting the first guard changed the
 * report and nothing noticed.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { RulesetError, runRuleset, validateRuleset } from '../src/index.mjs'
import { cleanup, dataset, findingsFor, ruleIds, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const RULE = { id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }
const DATASETS = [{ name: 'orders', file: 'orders.json' }]

function base(overrides = {}) {
  return { schemaVersion: '1', datasets: DATASETS, rules: [RULE], ...overrides }
}

async function project(write) {
  const directory = await workspace()
  await write(directory)
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({ datasets: DATASETS, rules: [RULE] }))
  return { directory, rulesPath }
}

test('a dataset path naming a directory says so, rather than blaming the read', async () => {
  const { directory, rulesPath } = await project((root) => mkdir(join(root, 'orders.json')))
  const report = await runRuleset({ rules: rulesPath, data: directory })
  // Without the isFile guard the read fails with EISDIR and reports the same
  // rule id, so only the message distinguishes the two paths.
  assert.match(findingsFor(report, 'dataset-unreadable')[0].message, /is not a regular file\./u)
})

test('a dataset that stats but cannot be read is reported as unread', async () => {
  const { directory, rulesPath } = await project(async (root) => {
    const file = join(root, 'orders.json')
    await writeJson(file, dataset('orders', [{ a: 1 }]))
    await chmod(file, 0o000)
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })
  await chmod(join(directory, 'orders.json'), 0o644)

  assert.equal(report.status, 'incomplete')
  assert.match(findingsFor(report, 'dataset-unreadable')[0].message, /could not be read \(EACCES\)\./u)
})

test('a dataset document that is not an object is invalid, not merely mis-versioned', async () => {
  for (const document of [[], 'a string', 7, null]) {
    const { directory, rulesPath } = await project((root) => writeJson(join(root, 'orders.json'), document))
    const report = await runRuleset({ rules: rulesPath, data: directory })
    assert.deepEqual(
      ruleIds(report).filter((id) => id.startsWith('dataset-')),
      ['dataset-invalid'],
      JSON.stringify(document),
    )
    assert.match(findingsFor(report, 'dataset-invalid')[0].message, /is not a JSON object\./u)
  }
})

test('a --rules path that does not exist is a configuration error naming the code', async () => {
  const directory = await workspace()
  await assert.rejects(
    () => runRuleset({ rules: join(directory, 'absent.json'), data: directory }),
    (error) => error instanceof RulesetError && /--rules could not be inspected: ENOENT\./u.test(error.message),
  )
})

test('a --rules path naming a directory says so, rather than blaming the read', async () => {
  const directory = await workspace()
  await mkdir(join(directory, 'rules.json'))
  await assert.rejects(
    () => runRuleset({ rules: join(directory, 'rules.json'), data: directory }),
    (error) => error instanceof RulesetError && /--rules must name a regular file\./u.test(error.message),
  )
})

test('a --rules file that stats but cannot be read says so, rather than blaming the parse', async () => {
  const directory = await workspace()
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, base())
  await chmod(rulesPath, 0o000)
  await assert.rejects(
    () => runRuleset({ rules: rulesPath, data: directory }),
    (error) => error instanceof RulesetError && /--rules could not be read: EACCES\./u.test(error.message),
  )
  await chmod(rulesPath, 0o644)
})

test('a --data path that does not exist is a configuration error naming the code', async () => {
  const directory = await workspace()
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, base())
  await assert.rejects(
    () => runRuleset({ rules: rulesPath, data: join(directory, 'absent') }),
    (error) => error instanceof RulesetError && /--data could not be resolved: ENOENT\./u.test(error.message),
  )
})

test('a range rule over a cell that is not there reaches no verdict', async () => {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ a: null }, { b: 1 }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: DATASETS,
    rules: [{ id: 'bounded', kind: 'range', dataset: 'orders', column: 'a', max: 10 }],
  }))
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'incomplete')
  const unevaluable = findingsFor(report, 'value-unevaluable')
  assert.equal(unevaluable.length, 2)
  assert.match(unevaluable[0].message, /could not be compared against the declared bounds \(the value is null\)/u)
})

test('a cross-field rule over a cell that is not there reaches no verdict', async () => {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ a: 1 }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: DATASETS,
    rules: [{
      id: 'ordered',
      kind: 'crossField',
      dataset: 'orders',
      left: 'a',
      right: 'a',
      comparison: 'lt',
      type: 'number',
    }, {
      id: 'partial',
      kind: 'crossField',
      dataset: 'orders',
      left: 'a',
      right: 'b',
      comparison: 'lt',
      type: 'number',
    }],
  }))
  const report = await runRuleset({ rules: rulesPath, data: directory })

  // The second rule names a column the export does have on no row, so the run
  // abandons it before the row loop; the first rule reaches a real verdict.
  assert.equal(ruleIds(report).includes('cross-field-violation'), true)
  assert.equal(ruleIds(report).includes('rule-column-absent'), true)
})

test('a cross-field rule whose column is absent only on some rows reports each row', async () => {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ a: 1, b: 2 }, { a: 1 }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: DATASETS,
    rules: [{
      id: 'ordered',
      kind: 'crossField',
      dataset: 'orders',
      left: 'a',
      right: 'b',
      comparison: 'lt',
      type: 'number',
    }],
  }))
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'incomplete')
  const unevaluable = findingsFor(report, 'value-unevaluable')
  assert.equal(unevaluable.length, 1)
  assert.deepEqual(unevaluable[0].location, { file: 'orders.json', pointer: '/rows/1/b' })
  assert.match(unevaluable[0].message, /column b could not be compared \(the column is not present on this row\)/u)
})

test('a relation whose referenced dataset was not read names the rule and the dataset', async () => {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ customer_id: 'cust-001' }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [...DATASETS, { name: 'customers', file: 'customers.json' }],
    rules: [{
      id: 'known-customer',
      kind: 'referential',
      dataset: 'orders',
      columns: ['customer_id'],
      references: { dataset: 'customers', columns: ['id'] },
    }],
  }))
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'incomplete')
  const failed = findingsFor(report, 'rule-execution-failed')
  assert.equal(failed.length, 1)
  assert.match(failed[0].message, /the referenced dataset customers was not read/u)
  assert.match(failed[0].message, /No row of orders was judged against it\./u)
  assert.deepEqual(failed[0].location, { file: 'customers.json' })
})

test('a relation whose child key is unusable reports that row and does not judge it', async () => {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ customer_id: null }]))
  await writeJson(join(directory, 'customers.json'), dataset('customers', [{ id: 'cust-001' }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [...DATASETS, { name: 'customers', file: 'customers.json' }],
    rules: [{
      id: 'known-customer',
      kind: 'referential',
      dataset: 'orders',
      columns: ['customer_id'],
      references: { dataset: 'customers', columns: ['id'] },
    }],
  }))
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('referential-violation'), false)
  const unevaluable = findingsFor(report, 'value-unevaluable')
  assert.equal(unevaluable.length, 1)
  assert.deepEqual(unevaluable[0].location, { file: 'orders.json', pointer: '/rows/0/customer_id' })
  assert.match(unevaluable[0].message, /the relation was not checked for this row/u)
})

test('a dataset path carrying a NUL is refused as configuration', () => {
  const file = `orders${String.fromCodePoint(0)}.json`
  assert.throws(
    () => validateRuleset(base({ datasets: [{ name: 'orders', file }] })),
    /contains a NUL character\./u,
  )
})

test('an absolute dataset path is refused for being absolute, not for its segments', () => {
  assert.throws(
    () => validateRuleset(base({ datasets: [{ name: 'orders', file: '/etc/orders.json' }] })),
    /must be relative to --data\./u,
  )
})

test('an empty column list is refused rather than becoming a key that matches everything', () => {
  assert.throws(
    () => validateRuleset(base({
      rules: [{ id: 'k', kind: 'uniqueness', dataset: 'orders', columns: [] }],
    })),
    /must be a non-empty array of column names\./u,
  )
  assert.throws(
    () => validateRuleset(base({
      rules: [{ id: 'k', kind: 'uniqueness', dataset: 'orders', columns: 'a' }],
    })),
    /must be a non-empty array of column names\./u,
  )
})

test('limits that are not an object are refused rather than silently ignored', () => {
  for (const limits of [[], 'none', 7]) {
    assert.throws(
      () => validateRuleset(base({ limits })),
      /"limits" must be an object\./u,
      JSON.stringify(limits),
    )
  }
})

test('a limit that is not a positive integer is refused rather than disabling the bound', () => {
  for (const value of [0, -1, 1.5, '10', null, Number.NaN]) {
    assert.throws(
      () => validateRuleset(base({ limits: { maxRows: value } })),
      /"limits.maxRows" must be an integer of at least 1\./u,
      JSON.stringify(value),
    )
  }
  assert.equal(validateRuleset(base({ limits: { maxRows: 1 } })).limits.maxRows, 1)
})

test('a range bound that is not a finite number is refused', () => {
  for (const min of ['0', null, true]) {
    assert.throws(
      () => validateRuleset(base({
        rules: [{ id: 'b', kind: 'range', dataset: 'orders', column: 'a', min }],
      })),
      /"rules\[0\]".min must be a finite number\./u,
      JSON.stringify(min),
    )
  }
})

test('a datasets entry that is not an object is refused for being the wrong shape', () => {
  assert.throws(
    () => validateRuleset(base({ datasets: ['orders.json'] })),
    /"datasets\[0\]" must be an object\./u,
  )
})

test('a rules entry that is not an object is refused for being the wrong shape', () => {
  assert.throws(() => validateRuleset(base({ rules: ['r'] })), /"rules\[0\]" must be an object\./u)
})

test('a rule missing a required key is refused by naming the key', () => {
  const { column, ...noColumn } = RULE
  void column
  assert.throws(
    () => validateRuleset(base({ rules: [noColumn] })),
    /\(kind "completeness"\) is missing "column"\./u,
  )
})

test('a references block that is not an object is refused for being the wrong shape', () => {
  assert.throws(
    () => validateRuleset(base({
      datasets: [...DATASETS, { name: 'customers', file: 'customers.json' }],
      rules: [{ id: 'f', kind: 'referential', dataset: 'orders', columns: ['a'], references: [] }],
    })),
    /\.references must be an object\./u,
  )
})

test('a referenced key row that cannot be keyed is reported at its own location', async () => {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ customer_id: 'cust-001' }]))
  await writeJson(join(directory, 'customers.json'), dataset('customers', [{ id: 'cust-001' }, { id: null }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [...DATASETS, { name: 'customers', file: 'customers.json' }],
    rules: [{
      id: 'known-customer',
      kind: 'referential',
      dataset: 'orders',
      columns: ['customer_id'],
      references: { dataset: 'customers', columns: ['id'] },
    }],
  }))
  const report = await runRuleset({ rules: rulesPath, data: directory })

  const unevaluable = findingsFor(report, 'value-unevaluable')
  assert.equal(unevaluable.length, 1)
  assert.deepEqual(unevaluable[0].location, { file: 'customers.json', pointer: '/rows/1/id' })
  assert.match(unevaluable[0].message, /not in the index the rule compares against/u)
})
