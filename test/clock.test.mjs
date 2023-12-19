/**
 * The clock, pinned BEHAVIOURALLY.
 *
 * The README says this tool reads no clock. A source scan for `Date.now` would
 * be a declaration about the behaviour rather than the behaviour -- and it
 * would miss `new Date()` with no argument, `Date.parse`, and anything a future
 * edit reaches for instead.
 *
 * So every clock read is made to THROW for the duration of the run, and the run
 * is required to complete and produce the same report it produces normally.
 * `Date.UTC` stays available, because it is arithmetic over numbers parsed out
 * of the dataset and reads nothing.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'

import { renderReport, runRuleset } from '../src/index.mjs'
import { cleanup, dataset, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

/** Everything that could tell this process what time it is, made to throw. */
function withNoClock(body) {
  const RealDate = globalThis.Date
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) throw new Error('a clock was read: new Date()')
      return Reflect.construct(target, args, newTarget)
    },
    get(target, property, receiver) {
      if (property === 'now' || property === 'parse') {
        return () => {
          throw new Error(`a clock was read: Date.${String(property)}`)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  try {
    return body()
  } finally {
    globalThis.Date = RealDate
  }
}

test('the guard itself catches a clock read, so the test below is not vacuous', () => {
  assert.throws(() => withNoClock(() => Date.now()), /a clock was read: Date\.now/u)
  assert.throws(() => withNoClock(() => new Date()), /a clock was read: new Date/u)
  assert.throws(() => withNoClock(() => Date.parse('2026-09-18')), /a clock was read: Date\.parse/u)
  // Arithmetic over supplied numbers is untouched.
  assert.equal(withNoClock(() => Date.UTC(2026, 8, 18)), Date.UTC(2026, 8, 18))
})

test('a full run completes with every clock read made to throw', async () => {
  // The cross-field date rule is the only place this tool handles an instant,
  // and it is the place a lenient `Date.parse` would otherwise be reached for.
  const directory = await workspace()
  await writeJson(join(directory, 'customers.json'), dataset('customers', [{ id: 'cust-001' }]))
  await writeJson(join(directory, 'orders.json'), dataset('orders', [
    { order_no: 'A-1', customer_id: 'cust-001', total: 5, ordered_on: '2026-08-03', shipped_on: '2026-08-05' },
    { order_no: 'A-2', customer_id: 'cust-009', total: 5, ordered_on: '2026-08-09', shipped_on: '2026-08-04' },
  ]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'customers', file: 'customers.json' }, { name: 'orders', file: 'orders.json' }],
    rules: [
      { id: 'dates', kind: 'crossField', dataset: 'orders', left: 'ordered_on', right: 'shipped_on', comparison: 'lte', type: 'date' },
      { id: 'known', kind: 'referential', dataset: 'orders', columns: ['customer_id'], references: { dataset: 'customers', columns: ['id'] } },
    ],
  }))

  const normal = renderReport(await runRuleset({ rules: rulesPath, data: directory }))
  const guarded = await withNoClock(() => runRuleset({ rules: rulesPath, data: directory }))

  assert.equal(renderReport(guarded), normal)
  assert.equal(guarded.status, 'fail')
  assert.deepEqual(
    guarded.findings.map((finding) => finding.ruleId).sort(),
    ['cross-field-violation', 'referential-violation'],
  )
})
