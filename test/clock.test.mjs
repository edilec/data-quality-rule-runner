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

import { formatSummary, renderReport, runRuleset } from '../src/index.mjs'
import { cleanup, dataset, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

/**
 * Everything that could tell this process what time it is, made to throw --
 * for as long as the body runs, INCLUDING after it awaits.
 *
 * This helper was synchronous, and the run it guards is not. `finally` fired
 * the moment the body RETURNED ITS PROMISE, so `globalThis.Date` was restored
 * before the first await inside readRuleset resumed and everything after that
 * point ran against the real clock. Injecting `Date.now()` as the first
 * statement of `evaluateRules` -- the core of every run -- left the whole suite
 * green. Awaiting the body is the whole fix, and the self-check below drives an
 * async body so the hole cannot come back unnoticed.
 */
async function withNoClock(body) {
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
    return await body()
  } finally {
    globalThis.Date = RealDate
  }
}

test('the guard itself catches a clock read, so the test below is not vacuous', async () => {
  for (const read of [() => Date.now(), () => new Date(), () => Date.parse('2026-09-18')]) {
    await assert.rejects(withNoClock(read), /a clock was read/u)
    // The case the synchronous version of this helper could not see: a body
    // that reads the clock only AFTER it has awaited something, which is every
    // read inside an async run. The guard has to still be in place there.
    await assert.rejects(
      withNoClock(async () => {
        await Promise.resolve()
        return read()
      }),
      /a clock was read/u,
    )
  }
  // Arithmetic over supplied numbers is untouched, before and after an await.
  assert.equal(await withNoClock(() => Date.UTC(2026, 8, 18)), Date.UTC(2026, 8, 18))
  assert.equal(
    await withNoClock(async () => {
      await Promise.resolve()
      return Date.UTC(2026, 8, 18)
    }),
    Date.UTC(2026, 8, 18),
  )
  // And the real Date is back afterwards, whichever way the body ended.
  assert.equal(typeof Date.now(), 'number')
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

  const report = await runRuleset({ rules: rulesPath, data: directory })
  const normal = { json: renderReport(report), human: formatSummary(report) }

  // Rendering is inside the guard too. A clock read on the way OUT of a run is
  // still a clock read, and it would put a wall-clock value in front of a user.
  const guarded = await withNoClock(async () => {
    const produced = await runRuleset({ rules: rulesPath, data: directory })
    return { report: produced, json: renderReport(produced), human: formatSummary(produced) }
  })

  assert.equal(guarded.json, normal.json)
  assert.equal(guarded.human, normal.human)
  assert.equal(guarded.report.status, 'fail')
  assert.deepEqual(
    guarded.report.findings.map((finding) => finding.ruleId).sort(),
    ['cross-field-violation', 'referential-violation'],
  )
})
