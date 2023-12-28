/**
 * The acceptance criteria, item by item:
 *
 *   "A duplicate composite key and failed relation yield actionable locations;
 *    a broken rule is an execution error, not a data pass."
 *
 * The first test in this file is the GOOD case. A finding raised on correct
 * input is the worst defect a checker can have -- it sends somebody to fix what
 * was already right -- so silence on data that satisfies every rule is checked
 * before anything else.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'

import { runRuleset, statusFor } from '../src/index.mjs'
import { cleanup, dataset, findingsFor, ruleIds, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const CUSTOMERS = [
  { id: 'cust-001', tier: 'standard' },
  { id: 'cust-002', tier: 'standard' },
  { id: 'cust-003', tier: 'priority' },
]

const ORDERS = [
  { order_no: 'A-1001', customer_id: 'cust-001', total: 480.5, ordered_on: '2026-08-03', shipped_on: '2026-08-05' },
  { order_no: 'A-1002', customer_id: 'cust-002', total: 61, ordered_on: '2026-08-04', shipped_on: '2026-08-04' },
  { order_no: 'A-1003', customer_id: 'cust-003', total: 129, ordered_on: '2026-08-09', shipped_on: '2026-08-11' },
]

const ALL_RULES = [
  { id: 'orders-customer-populated', kind: 'completeness', dataset: 'orders', column: 'customer_id' },
  { id: 'orders-key-unique', kind: 'uniqueness', dataset: 'orders', columns: ['customer_id', 'order_no'] },
  { id: 'orders-total-in-range', kind: 'range', dataset: 'orders', column: 'total', min: 0, max: 10000 },
  {
    id: 'orders-customer-known',
    kind: 'referential',
    dataset: 'orders',
    columns: ['customer_id'],
    references: { dataset: 'customers', columns: ['id'] },
  },
  {
    id: 'orders-shipped-after-ordered',
    kind: 'crossField',
    dataset: 'orders',
    left: 'ordered_on',
    right: 'shipped_on',
    comparison: 'lte',
    type: 'date',
  },
]

async function project({ customers = CUSTOMERS, orders = ORDERS, rules = ALL_RULES, limits } = {}) {
  const directory = await workspace()
  await writeJson(join(directory, 'customers.json'), dataset('customers', customers))
  await writeJson(join(directory, 'orders.json'), dataset('orders', orders))
  const rulesPath = join(directory, 'quality.rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'customers', file: 'customers.json' }, { name: 'orders', file: 'orders.json' }],
    rules,
    limits,
  }))
  return { directory, rulesPath }
}

test('data that satisfies every rule produces no findings at all', async () => {
  const { directory, rulesPath } = await project()
  const report = await runRuleset({ rules: rulesPath, data: directory })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 5)
  assert.equal(report.summary.rowsExamined, 6)
})

test('every rule kind stays silent on the value sitting exactly on its boundary', async () => {
  // A range of 0..10000 accepts 0 and 10000; lte accepts two equal dates; a
  // composite key accepts a repeated first component with a distinct second.
  const { directory, rulesPath } = await project({
    orders: [
      { order_no: 'A-1', customer_id: 'cust-001', total: 0, ordered_on: '2026-08-04', shipped_on: '2026-08-04' },
      { order_no: 'A-2', customer_id: 'cust-001', total: 10000, ordered_on: '2026-08-04', shipped_on: '2026-08-04' },
    ],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a duplicate composite key names the row it repeats and the row it first appeared on', async () => {
  const { directory, rulesPath } = await project({
    orders: [
      ...ORDERS,
      { order_no: 'A-1002', customer_id: 'cust-002', total: 61, ordered_on: '2026-08-04', shipped_on: '2026-08-04' },
    ],
    rules: [ALL_RULES[1]],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'fail')
  const duplicates = findingsFor(report, 'uniqueness-violation')
  assert.equal(duplicates.length, 1)
  assert.deepEqual(duplicates[0].location, { file: 'orders.json', pointer: '/rows/3' })
  assert.match(duplicates[0].message, /also appears at \/rows\/1\./u)
  assert.match(duplicates[0].message, /composite key \(customer_id=<string:8>, order_no=<string:6>\)/u)
  assert.equal(duplicates[0].severity, 'error')
})

test('a failed relation names the child row, the child columns and the dataset it did not match', async () => {
  const { directory, rulesPath } = await project({
    orders: [
      ORDERS[0],
      { order_no: 'A-1004', customer_id: 'cust-914', total: 12, ordered_on: '2026-08-12', shipped_on: '2026-08-13' },
    ],
    rules: [ALL_RULES[3]],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'fail')
  const dangling = findingsFor(report, 'referential-violation')
  assert.equal(dangling.length, 1)
  assert.deepEqual(dangling[0].location, { file: 'orders.json', pointer: '/rows/1' })
  assert.match(dangling[0].message, /\(customer_id=<string:8>\) has no matching \(id\) in dataset customers\./u)
})

test('--show-values prints the offending value, and the default does not', async () => {
  const orders = [
    ORDERS[0],
    { order_no: 'A-1004', customer_id: 'cust-914', total: 12, ordered_on: '2026-08-12', shipped_on: '2026-08-13' },
  ]
  const { directory, rulesPath } = await project({ orders, rules: [ALL_RULES[3]] })

  const masked = await runRuleset({ rules: rulesPath, data: directory })
  assert.match(masked.findings[0].message, /customer_id=<string:8>/u)
  assert.doesNotMatch(masked.findings[0].message, /cust-914/u)

  const shown = await runRuleset({ rules: rulesPath, data: directory, showValues: true })
  assert.match(shown.findings[0].message, /customer_id=cust-914/u)
  assert.equal(shown.findings[0].ruleId, 'referential-violation')
  assert.equal(shown.status, 'fail')
})

test('a rule naming a column the export does not have is an execution error, not a pass', async () => {
  const { directory, rulesPath } = await project({
    rules: [{ id: 'orders-region-populated', kind: 'completeness', dataset: 'orders', column: 'region' }],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  // Presence, not just absence: the run says WHY it reached no verdict.
  assert.deepEqual(ruleIds(report), ['no-rules-executed', 'rule-column-absent'])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.match(findingsFor(report, 'rule-column-absent')[0].message, /No row was judged\./u)
})

test('a range rule over a value that is not a number reaches no verdict for that row', async () => {
  const { directory, rulesPath } = await project({
    orders: [{ ...ORDERS[0], total: '480.50' }],
    rules: [ALL_RULES[2]],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('range-violation'), false)
  const unevaluable = findingsFor(report, 'value-unevaluable')
  assert.equal(unevaluable.length, 1)
  assert.match(unevaluable[0].message, /holds a string, and a range rule compares numbers/u)
  assert.match(unevaluable[0].message, /Nothing was converted/u)
  assert.deepEqual(unevaluable[0].location, { file: 'orders.json', pointer: '/rows/0/total' })
})

test('a rule whose dataset was not read is an execution error naming the rule', async () => {
  const { directory, rulesPath } = await project({ rules: [ALL_RULES[1]] })
  const { rm } = await import('node:fs/promises')
  await rm(join(directory, 'orders.json'))

  const report = await runRuleset({ rules: rulesPath, data: directory })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    ruleIds(report).slice().sort(),
    ['dataset-unreadable', 'no-rules-executed', 'rule-execution-failed'],
  )
  assert.match(
    findingsFor(report, 'rule-execution-failed')[0].message,
    /rule orders-key-unique: dataset orders was not read/u,
  )
})

test('an export with no rows establishes nothing and is not a pass', async () => {
  const { directory, rulesPath } = await project({ orders: [], rules: [ALL_RULES[0]] })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['no-rules-executed', 'rule-examined-no-rows'])
  assert.match(
    findingsFor(report, 'rule-examined-no-rows')[0].message,
    /An empty export is not a rule that passed\./u,
  )
})

test('a referential rule whose index dropped a row reports undetermined, never a violation', async () => {
  // This is the sharpest form of "unknown is never a pass". The index of
  // customers keys cannot hold the row whose id is null, so a child value that
  // matches nothing in the index might still match the row that was dropped.
  const { directory, rulesPath } = await project({
    customers: [{ id: 'cust-001', tier: 'standard' }, { id: null, tier: 'standard' }],
    orders: [ORDERS[0], ORDERS[1]],
    rules: [ALL_RULES[3]],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('referential-violation'), false)
  const undetermined = findingsFor(report, 'reference-undetermined')
  assert.equal(undetermined.length, 1)
  assert.deepEqual(undetermined[0].location, { file: 'orders.json', pointer: '/rows/1' })
  assert.match(undetermined[0].message, /matches no key in the partial index of customers/u)
  assert.match(undetermined[0].message, /was not established/u)

  const incomplete = findingsFor(report, 'reference-index-incomplete')
  assert.equal(incomplete.length, 1)
  assert.deepEqual(incomplete[0].location, { file: 'customers.json' })
  assert.match(incomplete[0].message, /holds 1 of 2 row\(s\) \(1 could not be keyed\)/u)
})

test('the identical child value gives a violation once the index is complete', async () => {
  // The mirror of the test above, and the reason it is not vacuous: the only
  // difference between the two runs is one referenced row this tool could key.
  const { directory, rulesPath } = await project({
    customers: [{ id: 'cust-001', tier: 'standard' }, { id: 'cust-777', tier: 'standard' }],
    orders: [ORDERS[0], ORDERS[1]],
    rules: [ALL_RULES[3]],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'fail')
  assert.deepEqual(ruleIds(report), ['referential-violation'])
  assert.deepEqual(report.findings[0].location, { file: 'orders.json', pointer: '/rows/1' })
})

test('an empty referenced export cannot establish that a value matches nothing', async () => {
  const { directory, rulesPath } = await project({
    customers: [],
    orders: [ORDERS[0]],
    rules: [ALL_RULES[3]],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('referential-violation'), false)
  assert.equal(findingsFor(report, 'reference-undetermined').length, 1)
  assert.match(
    findingsFor(report, 'reference-index-incomplete')[0].message,
    /holds 0 of 0 row\(s\)/u,
  )
})

test('a match against a partial index is still a match, and the run is still incomplete', async () => {
  const { directory, rulesPath } = await project({
    customers: [{ id: 'cust-001' }, { id: null }],
    orders: [ORDERS[0]],
    rules: [ALL_RULES[3]],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  // cust-001 IS in the index, so no undetermined finding is raised about it --
  // finding a key is sound whatever else was dropped. The run stays incomplete
  // because the index the clean part rests on is not the whole referenced set.
  assert.equal(ruleIds(report).includes('reference-undetermined'), false)
  assert.equal(report.status, 'incomplete')
  assert.equal(findingsFor(report, 'reference-index-incomplete').length, 1)
})

test('a uniqueness key that cannot be formed leaves the comparison and says so', async () => {
  const { directory, rulesPath } = await project({
    orders: [ORDERS[0], { order_no: 'A-1002', total: 61, ordered_on: '2026-08-04', shipped_on: '2026-08-04' }],
    rules: [ALL_RULES[1]],
  })
  const report = await runRuleset({ rules: rulesPath, data: directory })

  assert.equal(report.status, 'incomplete')
  const dropped = findingsFor(report, 'key-unevaluable')
  assert.equal(dropped.length, 1)
  assert.deepEqual(dropped[0].location, { file: 'orders.json', pointer: '/rows/1/customer_id' })
  assert.match(dropped[0].message, /left out of the uniqueness comparison/u)
})

test('a rule kind no evaluator handles becomes an execution error rather than silence', async () => {
  const { evaluateRules } = await import('../src/evaluate.mjs')
  const datasets = new Map([['orders', {
    name: 'orders',
    file: 'orders.json',
    rows: ORDERS,
    columns: new Set(['order_no', 'customer_id', 'total']),
  }]])
  const result = evaluateRules({
    rules: [{ id: 'invented', kind: 'histogram', dataset: 'orders' }],
    datasets,
    files: new Map([['orders', 'orders.json']]),
    limits: { maxFieldLength: 100, maxSamplesPerRule: 5 },
  })

  assert.equal(result.checked, 0)
  assert.deepEqual(ruleIds({ findings: result.findings }), ['rule-execution-failed'])
  assert.match(result.findings[0].message, /unsupported rule kind "histogram"/u)
  assert.match(result.findings[0].message, /no verdict was reached/u)
})

test('a rule kind that names a prototype member is an execution error too', async () => {
  // `histogram` above is the one class of name that does NOT reach through an
  // object literal. `EVALUATORS['constructor']` resolved
  // `Object.prototype.constructor`, which is callable and returns something
  // truthy, so `checked` was incremented and the run reported `pass` -- a rule
  // kind this tool cannot evaluate counted as one it evaluated successfully,
  // through the very entry point the backstop exists for.
  const { evaluateRules } = await import('../src/evaluate.mjs')
  const datasets = new Map([['orders', {
    name: 'orders',
    file: 'orders.json',
    rows: ORDERS,
    columns: new Set(['order_no', 'customer_id', 'total']),
  }]])
  const limits = { maxFieldLength: 100, maxSamplesPerRule: 5 }

  for (const kind of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const result = evaluateRules({
      rules: [{ id: 'invented', kind, dataset: 'orders' }],
      datasets,
      files: new Map([['orders', 'orders.json']]),
      limits,
    })
    assert.equal(result.checked, 0, kind)
    assert.deepEqual(ruleIds({ findings: result.findings }), ['rule-execution-failed'], kind)
    assert.equal(statusFor(result.findings), 'incomplete', kind)
  }

  // The same hole through the comparison table: `lt` correctly finds 5 is not
  // less than 1, and `constructor` reported every row as satisfying the rule.
  const crossField = (comparison) => evaluateRules({
    rules: [{ id: 'x', kind: 'crossField', dataset: 'orders', left: 'total', right: 'total', comparison, type: 'number' }],
    datasets,
    files: new Map([['orders', 'orders.json']]),
    limits,
  })
  const real = crossField('neq')
  assert.equal(real.checked, 1)
  assert.deepEqual(new Set(ruleIds({ findings: real.findings })), new Set(['cross-field-violation']))
  const hostile = crossField('constructor')
  assert.equal(hostile.checked, 0)
  assert.deepEqual(ruleIds({ findings: hostile.findings }), ['rule-execution-failed'])
  assert.match(hostile.findings[0].message, /unsupported comparison "constructor"/u)
  assert.equal(statusFor(hostile.findings), 'incomplete')
})
