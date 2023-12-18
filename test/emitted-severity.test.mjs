/**
 * Severity as a consumer sees it, over every rule id in the catalog.
 *
 * A sweep over the severity freeze found thirteen ids where flipping `error` to
 * `warning` left the whole suite green: those ids all mark the run incomplete,
 * so the exit code is dominated by incompleteness and never notices. The
 * severity still changes what is emitted -- the `severity` field, and the
 * `summary.errors` and `summary.warnings` counts a dashboard adds up.
 *
 * So the expected values here are not copied from the table. Each scenario is
 * driven through the real entry point, the severities are read back OUT of the
 * emitted reports, and they are judged against one stated property: everything
 * this tool reports is an error except a notice that a location list was cut.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { RULE_IDS, runRuleset } from '../src/index.mjs'
import { cleanup, dataset, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const ORDERS = [{ name: 'orders', file: 'orders.json' }]
const BOTH = [...ORDERS, { name: 'customers', file: 'customers.json' }]

const RELATION = {
  id: 'known-customer',
  kind: 'referential',
  dataset: 'orders',
  columns: ['customer_id'],
  references: { dataset: 'customers', columns: ['id'] },
}

/** Each entry writes a workspace and returns the ruleset to run over it. */
const SCENARIOS = [
  ['completeness-violation and value-unevaluable', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ a: null }, { a: { deep: 1 } }]))
    return ruleset({ datasets: ORDERS, rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }] })
  }],
  ['cross-field-violation', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ a: 2, b: 1 }]))
    return ruleset({
      datasets: ORDERS,
      rules: [{ id: 'r', kind: 'crossField', dataset: 'orders', left: 'a', right: 'b', comparison: 'lt', type: 'number' }],
    })
  }],
  ['range-violation and samples-truncated', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ a: 9 }, { a: 9 }]))
    return ruleset({
      datasets: ORDERS,
      limits: { maxSamplesPerRule: 1 },
      rules: [{ id: 'r', kind: 'range', dataset: 'orders', column: 'a', max: 1 }],
    })
  }],
  ['uniqueness-violation and key-unevaluable', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ a: 1 }, { a: 1 }, { b: 2 }]))
    return ruleset({ datasets: ORDERS, rules: [{ id: 'r', kind: 'uniqueness', dataset: 'orders', columns: ['a'] }] })
  }],
  ['referential-violation', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ customer_id: 'cust-9' }]))
    await writeJson(join(root, 'customers.json'), dataset('customers', [{ id: 'cust-1' }]))
    return ruleset({ datasets: BOTH, rules: [RELATION] })
  }],
  ['reference-undetermined and reference-index-incomplete', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ customer_id: 'cust-9' }]))
    await writeJson(join(root, 'customers.json'), dataset('customers', [{ id: 'cust-1' }, { id: null }]))
    return ruleset({ datasets: BOTH, rules: [RELATION] })
  }],
  ['rule-column-absent and no-rules-executed', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ a: 1 }]))
    return ruleset({ datasets: ORDERS, rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'gone' }] })
  }],
  ['rule-examined-no-rows', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', []))
    return ruleset({ datasets: ORDERS, rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }] })
  }],
  ['dataset-unreadable and rule-execution-failed', async () => ruleset({
    datasets: ORDERS,
    rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }],
  })],
  ['dataset-not-utf8', async (root) => {
    await writeFile(join(root, 'orders.json'), Buffer.from([0x7b, 0xff, 0x7d]))
    return ruleset({ datasets: ORDERS, rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }] })
  }],
  ['dataset-unparsable', async (root) => {
    await writeFile(join(root, 'orders.json'), 'not json', 'utf8')
    return ruleset({ datasets: ORDERS, rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }] })
  }],
  ['dataset-invalid', async (root) => {
    await writeJson(join(root, 'orders.json'), [])
    return ruleset({ datasets: ORDERS, rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }] })
  }],
  ['dataset-schema-unsupported', async (root) => {
    await writeJson(join(root, 'orders.json'), { schemaVersion: '9', dataset: 'orders', rows: [] })
    return ruleset({ datasets: ORDERS, rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }] })
  }],
  ['dataset-too-large', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ a: 1 }]))
    return ruleset({
      datasets: ORDERS,
      limits: { maxDatasetBytes: 1 },
      rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }],
    })
  }],
  ['dataset-too-many-rows', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ a: 1 }, { a: 2 }]))
    return ruleset({
      datasets: ORDERS,
      limits: { maxRows: 1 },
      rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }],
    })
  }],
  ['dataset-too-many-columns', async (root) => {
    await writeJson(join(root, 'orders.json'), dataset('orders', [{ a: 1, b: 2 }]))
    return ruleset({
      datasets: ORDERS,
      limits: { maxColumns: 1 },
      rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }],
    })
  }],
  ['dataset-outside-root', async (root) => {
    const outside = await workspace()
    await writeJson(join(outside, 'elsewhere.json'), dataset('orders', [{ a: 1 }]))
    await symlink(join(outside, 'elsewhere.json'), join(root, 'orders.json'))
    return ruleset({ datasets: ORDERS, rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }] })
  }],
]

test('every rule id is emitted at least once, and at the severity the tool claims', async () => {
  const observed = new Map()
  for (const [label, build] of SCENARIOS) {
    const directory = await workspace()
    const document = await build(directory)
    const rulesPath = join(directory, 'rules.json')
    await writeJson(rulesPath, document)
    const report = await runRuleset({ rules: rulesPath, data: directory })

    // The counts a consumer adds up must agree with the findings it can see.
    assert.equal(
      report.summary.errors,
      report.findings.filter((finding) => finding.severity === 'error').length,
      label,
    )
    assert.equal(
      report.summary.warnings,
      report.findings.filter((finding) => finding.severity === 'warning').length,
      label,
    )
    for (const finding of report.findings) {
      const previous = observed.get(finding.ruleId)
      assert.equal(previous ?? finding.severity, finding.severity, `${label}: ${finding.ruleId}`)
      observed.set(finding.ruleId, finding.severity)
    }
  }

  // The scenario list must keep up with the catalog. A new rule id with no
  // scenario fails here rather than shipping with no severity ever observed.
  assert.deepEqual([...observed.keys()].sort(), [...RULE_IDS])

  for (const [ruleId, severity] of observed) {
    const expected = ruleId === 'samples-truncated' ? 'info' : 'error'
    assert.equal(severity, expected, ruleId)
  }
})
