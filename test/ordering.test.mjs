/**
 * Ordering, pinned BEHAVIOURALLY.
 *
 * A source scan for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text. So the inputs below are chosen because the two orders genuinely
 * disagree, and the assertion is the exact emitted order.
 *
 *   'Z-orders.json' < 'a-customers.json'   by code unit  (0x5A before 0x61)
 *   'a-customers.json' < 'Z-orders.json'   by ICU collation
 *   '/rows/0/a-b' < '/rows/0/a_b'          by code unit  (0x2D before 0x5F)
 *   '/rows/0/a_b' < '/rows/0/a-b'          by ICU collation (hyphen ignorable)
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'

import { runRuleset } from '../src/index.mjs'
import { cleanup, dataset, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

test('findings sort by file in code-unit order, not collation order', async () => {
  const collator = new Intl.Collator()
  assert.equal(collator.compare('Z-orders.json', 'a-customers.json') > 0, true)

  const directory = await workspace()
  await writeJson(join(directory, 'Z-orders.json'), dataset('zeta', [{ a: null }]))
  await writeJson(join(directory, 'a-customers.json'), dataset('alpha', [{ a: null }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [
      { name: 'alpha', file: 'a-customers.json' },
      { name: 'zeta', file: 'Z-orders.json' },
    ],
    rules: [
      { id: 'alpha-a', kind: 'completeness', dataset: 'alpha', column: 'a' },
      { id: 'zeta-a', kind: 'completeness', dataset: 'zeta', column: 'a' },
    ],
  }))

  const report = await runRuleset({ rules: rulesPath, data: directory })
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    ['Z-orders.json', 'a-customers.json'],
  )
})

test('findings sort by pointer in code-unit order, not collation order', async () => {
  const collator = new Intl.Collator()
  assert.equal(collator.compare('/rows/0/a-b', '/rows/0/a_b') > 0, true)

  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ 'a-b': null, a_b: null }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [
      { id: 'underscore', kind: 'completeness', dataset: 'orders', column: 'a_b' },
      { id: 'hyphen', kind: 'completeness', dataset: 'orders', column: 'a-b' },
    ],
  }))

  const report = await runRuleset({ rules: rulesPath, data: directory })
  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    ['/rows/0/a-b', '/rows/0/a_b'],
  )
})

test('two runs over identical inputs produce byte-identical stdout', async () => {
  const { renderReport } = await import('../src/index.mjs')
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ a: null }, { a: 3 }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [
      { id: 'populated', kind: 'completeness', dataset: 'orders', column: 'a' },
      { id: 'bounded', kind: 'range', dataset: 'orders', column: 'a', max: 1 },
    ],
  }))

  const first = renderReport(await runRuleset({ rules: rulesPath, data: directory }))
  const second = renderReport(await runRuleset({ rules: rulesPath, data: directory }))
  assert.equal(first, second)
  assert.equal(first.includes('"ruleId"'), true)
})

test('a JSON Pointer escapes a column name containing a slash or a tilde', async () => {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ 'a/b~c': null }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [{ id: 'weird', kind: 'completeness', dataset: 'orders', column: 'a/b~c' }],
  }))

  const report = await runRuleset({ rules: rulesPath, data: directory })
  assert.equal(report.findings[0].location.pointer, '/rows/0/a~1b~0c')
})
