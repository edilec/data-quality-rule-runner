/**
 * Each rule kind, judged first on data that satisfies it.
 *
 * A finding raised on correct input is the worst defect a checker can have: a
 * miss leaves you where you were, a false positive sends somebody to fix what
 * was already right. So every block below starts with the silent case.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'

import { compareValue, encodeKey, parseInstant, readCell, runRuleset } from '../src/index.mjs'
import { cleanup, dataset, ruleIds, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

async function check(rows, rule, extra = {}) {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', rows))
  if (extra.customers !== undefined) {
    await writeJson(join(directory, 'customers.json'), dataset('customers', extra.customers))
  }
  const datasets = [{ name: 'orders', file: 'orders.json' }]
  if (extra.customers !== undefined) datasets.push({ name: 'customers', file: 'customers.json' })
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({ datasets, rules: [rule] }))
  return runRuleset({ rules: rulesPath, data: directory })
}

test('completeness is silent on populated columns and fires only on empty ones', async () => {
  const rule = { id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }
  assert.deepEqual((await check([{ a: 'x' }, { a: 0 }, { a: false }], rule)).findings, [])
  assert.deepEqual(ruleIds(await check([{ a: '' }], rule)), ['completeness-violation'])
})

test('uniqueness distinguishes a repeated component from a repeated composite key', async () => {
  const rule = { id: 'r', kind: 'uniqueness', dataset: 'orders', columns: ['a', 'b'] }
  assert.deepEqual((await check([{ a: 1, b: 1 }, { a: 1, b: 2 }], rule)).findings, [])
  assert.deepEqual(ruleIds(await check([{ a: 1, b: 1 }, { a: 1, b: 1 }], rule)), ['uniqueness-violation'])
})

test('a composite key does not collide across a separator or across types', () => {
  const ab = encodeKey([{ type: 'string', value: 'a' }, { type: 'string', value: 'b' }])
  const joined = encodeKey([{ type: 'string', value: 'a|b' }])
  assert.notEqual(ab, joined)

  const text = encodeKey([{ type: 'string', value: '7' }])
  const number = encodeKey([{ type: 'number', value: 7 }])
  assert.notEqual(text, number)

  // Which half of the encoding does that? Not the type tag: JSON already writes
  // a string quoted and a number bare, so the untagged forms differ as well.
  // Dropping the tag is therefore an equivalent mutant over scalars, and this
  // assertion is the proof rather than an assurance.
  assert.notEqual(JSON.stringify([['7']]), JSON.stringify([[7]]))
  assert.notEqual(JSON.stringify([['true']]), JSON.stringify([[true]]))
})

test('a relation does not match a string key against a numeric one', async () => {
  const rule = {
    id: 'r',
    kind: 'referential',
    dataset: 'orders',
    columns: ['customer_id'],
    references: { dataset: 'customers', columns: ['id'] },
  }
  const matched = await check([{ customer_id: 7 }], rule, { customers: [{ id: 7 }] })
  assert.deepEqual(matched.findings, [])

  // Coercing "7" to 7 would report a relation as satisfied on the strength of
  // a conversion this tool invented.
  const mistyped = await check([{ customer_id: '7' }], rule, { customers: [{ id: 7 }] })
  assert.deepEqual(ruleIds(mistyped), ['referential-violation'])
})

test('range accepts both endpoints and refuses just outside them', async () => {
  const rule = { id: 'r', kind: 'range', dataset: 'orders', column: 'a', min: 0, max: 10 }
  assert.deepEqual((await check([{ a: 0 }, { a: 10 }, { a: 5 }], rule)).findings, [])
  assert.deepEqual(ruleIds(await check([{ a: -1 }], rule)), ['range-violation'])
  assert.deepEqual(ruleIds(await check([{ a: 11 }], rule)), ['range-violation'])
})

test('range with one bound leaves the other side unbounded', async () => {
  const minOnly = { id: 'r', kind: 'range', dataset: 'orders', column: 'a', min: 0 }
  assert.deepEqual((await check([{ a: 1e9 }], minOnly)).findings, [])
  assert.deepEqual(ruleIds(await check([{ a: -1 }], minOnly)), ['range-violation'])
})

test('every comparison holds on its own boundary', async () => {
  const rows = [{ a: 5, b: 5 }]
  const base = { id: 'r', kind: 'crossField', dataset: 'orders', left: 'a', right: 'b', type: 'number' }
  const silent = ['lte', 'gte', 'eq']
  const fires = ['lt', 'gt', 'neq']

  for (const comparison of silent) {
    assert.deepEqual((await check(rows, { ...base, comparison })).findings, [], comparison)
  }
  for (const comparison of fires) {
    assert.deepEqual(ruleIds(await check(rows, { ...base, comparison })), ['cross-field-violation'], comparison)
  }
})

test('a date comparison is strict UTC, and never Date.parse', () => {
  assert.equal(parseInstant('2026-02-28').ok, true)
  assert.equal(parseInstant('2026-02-29').ok, false, 'not a leap year')
  assert.equal(parseInstant('2024-02-29').ok, true, 'a leap year')
  assert.equal(parseInstant('2026-02-30').ok, false)
  assert.equal(parseInstant('2026-13-01').ok, false)
  assert.equal(parseInstant('2026-01-01T24:00:00Z').ok, false)
  assert.equal(parseInstant('2026-01-01T23:59:60Z').ok, false, 'a leap second has no ordering here')
  assert.equal(parseInstant('2026-01-01T00:00:00').ok, false, 'a local-time instant is refused')
  assert.equal(parseInstant('2026-01-01T00:00:00+05:30').ok, false)
  assert.equal(parseInstant('2026-01-01').ms, Date.UTC(2026, 0, 1))
  assert.equal(parseInstant('2026-01-01T00:00:00.500Z').ms, Date.UTC(2026, 0, 1, 0, 0, 0, 500))
})

test('a date is accepted on the inside of every component bound, not only refused past it', () => {
  // The test above drives the N+1 side of each bound: month 13, hour 24, second
  // 60. These are the N sides, and they are the sides a user notices. Widening
  // any one comparison by a character -- `month > 12` to `month >= 12` -- makes
  // every December date, or every instant in the last hour, minute or second of
  // a day, unevaluable: exit 2 on data that is legal by this tool's own
  // documentation.
  assert.equal(parseInstant('2026-12-25').ms, Date.UTC(2026, 11, 25), 'December')
  assert.equal(parseInstant('2026-01-01T23:00:00Z').ms, Date.UTC(2026, 0, 1, 23), 'hour 23')
  assert.equal(parseInstant('2026-01-01T12:59:00Z').ms, Date.UTC(2026, 0, 1, 12, 59), 'minute 59')
  assert.equal(parseInstant('2026-01-01T12:00:59Z').ms, Date.UTC(2026, 0, 1, 12, 0, 59), 'second 59')
  assert.equal(parseInstant('2026-01-31T23:59:59.999Z').ms, Date.UTC(2026, 0, 31, 23, 59, 59, 999))
  assert.equal(parseInstant('2026-01-01').ms, Date.UTC(2026, 0, 1), 'month 1, day 1, the low bounds')
})

test('a year under 100 is the year the document wrote, and never the 1900s', () => {
  // `Date.UTC(99, 0, 1)` is 1999-01-01. The language remaps years 0000-0099
  // into 1900-1999 (ECMA-262, MakeFullYear), which is the same class of silent
  // roll this tool refuses `Date.parse` for. Reading `0099-01-01` that way made
  // this tool report a cross-field violation on a row that SATISFIED the rule,
  // and report two different dates as equal.
  assert.equal(parseInstant('0099-01-01').ms < parseInstant('1950-01-01').ms, true)
  assert.notEqual(parseInstant('0050-01-01').ms, parseInstant('1950-01-01').ms)
  assert.equal(parseInstant('0001-01-01').ms, -62135596800000)
  assert.equal(parseInstant('0000-02-29').ok, true, 'year 0 is a leap year in the proleptic calendar')
  assert.equal(parseInstant('0100-02-29').ok, false, 'a century that is not a multiple of 400')

  // From 0100 on, the arithmetic has to agree with `Date.UTC` exactly -- over
  // the whole range the two shapes can express, not at three sample points.
  let disagreements = 0
  for (let year = 100; year <= 9999; year += 1) {
    for (const [month, day] of [[1, 1], [2, 28], [3, 1], [12, 31]]) {
      const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const parsed = parseInstant(text)
      if (!parsed.ok || parsed.ms !== Date.UTC(year, month - 1, day)) disagreements += 1
    }
  }
  assert.equal(disagreements, 0)
})

test('a crossField date rule stays silent on a row whose year is under 100', async () => {
  const base = { id: 'r', kind: 'crossField', dataset: 'orders', left: 'a', right: 'b', type: 'date' }
  // 0099-01-01 IS before 1950-01-01. Through `Date.UTC` both sides became 1950
  // and this row -- correct data -- produced an error-severity finding and exit 1.
  const correct = await check([{ a: '0099-01-01', b: '1950-01-01' }], { ...base, comparison: 'lt' })
  assert.deepEqual(correct.findings, [])
  assert.equal(correct.status, 'pass')

  // The mirror case: the same remap made two different dates compare equal, so
  // an `eq` rule over them emitted nothing at all.
  const different = await check([{ a: '0050-01-01', b: '1950-01-01' }], { ...base, comparison: 'eq' })
  assert.deepEqual(ruleIds(different), ['cross-field-violation'])
  assert.equal(different.status, 'fail')
})

test('a date column holding an unparsable date reaches no verdict', async () => {
  const rule = {
    id: 'r',
    kind: 'crossField',
    dataset: 'orders',
    left: 'a',
    right: 'b',
    comparison: 'lte',
    type: 'date',
  }
  assert.deepEqual((await check([{ a: '2026-01-01', b: '2026-01-02' }], rule)).findings, [])

  const bad = await check([{ a: '01/01/2026', b: '2026-01-02' }], rule)
  assert.equal(bad.status, 'incomplete')
  assert.deepEqual(ruleIds(bad), ['value-unevaluable'])
  assert.match(bad.findings[0].message, /does not hold a usable date/u)
})

test('compareValue converts nothing across types', () => {
  assert.deepEqual(compareValue({ usable: true, type: 'string', value: '12' }, 'number'), { ok: false })
  assert.deepEqual(compareValue({ usable: true, type: 'number', value: 12 }, 'string'), { ok: false })
  assert.deepEqual(compareValue({ usable: true, type: 'number', value: 12 }, 'number'), { ok: true, value: 12 })
  assert.throws(() => compareValue({ usable: true, type: 'string', value: 'x' }, 'money'), /Unknown declared type/u)
})

test('readCell separates an absent column from an explicit null', () => {
  assert.equal(readCell({ a: 1 }, 'b', 10).code, 'absent')
  assert.equal(readCell({ b: null }, 'b', 10).code, 'null')
  assert.equal(readCell({ b: 'x'.repeat(11) }, 'b', 10).code, 'tooLong')
  assert.equal(readCell({ b: 'x'.repeat(10) }, 'b', 10).usable, true)
})
