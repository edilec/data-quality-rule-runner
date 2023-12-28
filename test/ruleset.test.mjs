/**
 * Ruleset validation: configuration, so every failure throws and nothing here
 * produces a report.
 *
 * Unknown keys are the point. A one-character typo in a limit name silently
 * restoring a default has turned a real failure into a green run in this
 * catalog, so each closed object is checked for refusal AND for accepting the
 * spelling it is meant to accept.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_LIMITS, RULE_KINDS, RulesetError, validateRuleset } from '../src/index.mjs'

const DATASETS = [{ name: 'orders', file: 'orders.json' }, { name: 'customers', file: 'customers.json' }]

function document(rules, extra = {}) {
  return { schemaVersion: '1', datasets: DATASETS, rules, ...extra }
}

const GOOD = Object.freeze({
  completeness: { id: 'a', kind: 'completeness', dataset: 'orders', column: 'c' },
  uniqueness: { id: 'b', kind: 'uniqueness', dataset: 'orders', columns: ['c', 'd'] },
  range: { id: 'c', kind: 'range', dataset: 'orders', column: 'c', min: 0, max: 1 },
  referential: {
    id: 'd',
    kind: 'referential',
    dataset: 'orders',
    columns: ['c'],
    references: { dataset: 'customers', columns: ['id'] },
  },
  crossField: {
    id: 'e',
    kind: 'crossField',
    dataset: 'orders',
    left: 'c',
    right: 'd',
    comparison: 'lte',
    type: 'date',
  },
})

test('a well-formed ruleset of every kind validates', () => {
  const result = validateRuleset(document(Object.values(GOOD)))
  assert.equal(result.rules.length, RULE_KINDS.length)
  assert.deepEqual(result.rules.map((rule) => rule.kind).sort(), [...RULE_KINDS].sort())
  assert.deepEqual(result.limits, { ...DEFAULT_LIMITS })
})

test('a limit given explicitly replaces only itself', () => {
  const result = validateRuleset(document([GOOD.completeness], { limits: { maxRows: 7 } }))
  assert.equal(result.limits.maxRows, 7)
  assert.equal(result.limits.maxColumns, DEFAULT_LIMITS.maxColumns)
})

test('a misspelled limit is refused rather than silently ignored', () => {
  assert.throws(
    () => validateRuleset(document([GOOD.completeness], { limits: { maxRow: 7 } })),
    /unknown key "maxRow"/u,
  )
})

test('an unknown top-level key and an unknown rule key are both refused', () => {
  assert.throws(() => validateRuleset(document([GOOD.completeness], { extra: 1 })), /unknown key "extra"/u)
  assert.throws(
    () => validateRuleset(document([{ ...GOOD.completeness, threshold: 1 }])),
    /unknown key "threshold"/u,
  )
})

test('a rule key belonging to another kind is refused for this kind', () => {
  assert.throws(
    () => validateRuleset(document([{ ...GOOD.completeness, columns: ['c'] }])),
    /unknown key "columns"/u,
  )
})

test('a duplicate rule id is refused, because an id identifies a finding across releases', () => {
  assert.throws(
    () => validateRuleset(document([GOOD.completeness, { ...GOOD.uniqueness, id: 'a' }])),
    /is declared twice/u,
  )
})

test('a duplicate dataset name is refused', () => {
  assert.throws(
    () => validateRuleset({
      schemaVersion: '1',
      datasets: [DATASETS[0], { name: 'orders', file: 'other.json' }],
      rules: [GOOD.completeness],
    }),
    /is declared twice/u,
  )
})

test('a rule naming a dataset the ruleset does not declare is refused', () => {
  assert.throws(
    () => validateRuleset(document([{ ...GOOD.completeness, dataset: 'invoices' }])),
    /is not declared in "datasets"/u,
  )
  assert.throws(
    () => validateRuleset(document([{
      ...GOOD.referential,
      references: { dataset: 'invoices', columns: ['id'] },
    }])),
    /is not declared in "datasets"/u,
  )
})

test('a relation with a different number of columns on each side is refused', () => {
  assert.throws(
    () => validateRuleset(document([{
      ...GOOD.referential,
      columns: ['c', 'd'],
      references: { dataset: 'customers', columns: ['id'] },
    }])),
    /a relation needs the same number on both sides/u,
  )
})

test('a range rule with no bound at all is refused, and one bound is enough', () => {
  const { min, max, ...noBounds } = GOOD.range
  void min
  void max
  assert.throws(() => validateRuleset(document([noBounds])), /must declare "min", "max" or both/u)
  assert.equal(validateRuleset(document([{ ...noBounds, min: 0 }])).rules[0].min, 0)
  assert.equal(validateRuleset(document([{ ...noBounds, max: 0 }])).rules[0].max, 0)
})

test('a range rule whose min is above its max is refused', () => {
  assert.throws(
    () => validateRuleset(document([{ ...GOOD.range, min: 2, max: 1 }])),
    /no value could satisfy it/u,
  )
  // Equal bounds are legal: exactly one value satisfies them.
  assert.equal(validateRuleset(document([{ ...GOOD.range, min: 1, max: 1 }])).rules[0].max, 1)
})

test('an unsupported comparison, type or kind is refused by name', () => {
  assert.throws(() => validateRuleset(document([{ ...GOOD.crossField, comparison: 'like' }])), /supported comparisons are/u)
  assert.throws(() => validateRuleset(document([{ ...GOOD.crossField, type: 'money' }])), /supported types are/u)
  assert.throws(() => validateRuleset(document([{ ...GOOD.completeness, kind: 'histogram' }])), /supported kinds are/u)
})

test('a comparison that is hostile rather than merely wrong is still a RulesetError', () => {
  // Two holes in one line. `Object.hasOwn(COMPARISONS, entry.comparison)`
  // coerces its key through ToPropertyKey, so a document whose "comparison" is
  // {"toString": {}} threw a raw TypeError -- out of a function whose whole
  // contract is to throw RulesetError -- before the sanitize() on the next line
  // could describe the value. And COMPARISONS was an object literal, so it
  // answered for Object.prototype's members: whether "constructor" was refused
  // here was the only thing standing between the CLI and an evaluator that
  // called Object as a comparison.
  assert.throws(
    () => validateRuleset(document([{ ...GOOD.crossField, comparison: { toString: {} } }])),
    (error) => error instanceof RulesetError
      && /"rules\[0\]"\.comparison is "\[object\]"/u.test(error.message),
  )
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.throws(
      () => validateRuleset(document([{ ...GOOD.crossField, comparison: name }])),
      (error) => error instanceof RulesetError && /supported comparisons are/u.test(error.message),
      name,
    )
  }
  // The positive side, so this is not satisfied by a validator that refuses
  // every comparison: each supported name still validates.
  for (const name of ['eq', 'neq', 'lt', 'lte', 'gt', 'gte']) {
    assert.equal(validateRuleset(document([{ ...GOOD.crossField, comparison: name }])).rules[0].comparison, name)
  }
})

test('an empty datasets or rules array is refused', () => {
  assert.throws(() => validateRuleset({ schemaVersion: '1', datasets: [], rules: [] }), /"datasets" must be a non-empty array/u)
  assert.throws(() => validateRuleset(document([])), /"rules" must be a non-empty array/u)
})

test('a name that renders as nothing is refused, however trim reads it', () => {
  const invisible = String.fromCodePoint(0x200e)
  assert.throws(() => validateRuleset(document([{ ...GOOD.completeness, id: invisible }])), RulesetError)
  assert.throws(() => validateRuleset(document([{ ...GOOD.completeness, column: invisible }])), RulesetError)
})

test('a key naming the same column twice is refused', () => {
  assert.throws(
    () => validateRuleset(document([{ ...GOOD.uniqueness, columns: ['c', 'c'] }])),
    /names "c" twice/u,
  )
})

test('the document itself must be an object of the declared version', () => {
  assert.throws(() => validateRuleset([]), /must be a JSON object/u)
  assert.throws(() => validateRuleset(null), /must be a JSON object/u)
  assert.throws(() => validateRuleset(document([GOOD.completeness], { schemaVersion: 1 })), /must be "1"/u)
})
