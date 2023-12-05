/**
 * Severity, pinned BEHAVIOURALLY.
 *
 * A severity table asserted against a hand-written expected map in the tests is
 * three declarations agreeing with each other, and a coordinated edit of all
 * three passes. An exit code cannot be edited at all, so each rule id below is
 * driven through the real entry point and judged by what the process does.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'

import {
  EVIDENCE_MISSING_RULES,
  RULE_IDS,
  exitCodeFor,
  runRuleset,
  severityFor,
  statusFor,
} from '../src/index.mjs'
import { cleanup, dataset, ruleIds, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

async function project(rows, rules, limits) {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', rows))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules,
    limits,
  }))
  return runRuleset({ rules: rulesPath, data: directory })
}

test('a violation at error severity makes the run fail and exit 1', async () => {
  const report = await project(
    [{ a: 5 }],
    [{ id: 'r', kind: 'range', dataset: 'orders', column: 'a', max: 1 }],
  )
  assert.deepEqual(ruleIds(report), ['range-violation'])
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('an evidence-missing rule outranks a violation and exits 2', async () => {
  // Both findings are present: one rule failed outright, another could not be
  // executed. The run must not settle for "fail" -- that would report a partial
  // check as a complete one.
  const report = await project(
    [{ a: 5 }],
    [
      { id: 'over', kind: 'range', dataset: 'orders', column: 'a', max: 1 },
      { id: 'absent', kind: 'completeness', dataset: 'orders', column: 'missing' },
    ],
  )
  assert.deepEqual(ruleIds(report).sort(), ['range-violation', 'rule-column-absent'])
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('an info finding on its own never changes the exit code', async () => {
  const report = await project(
    [{ a: 5 }, { a: 6 }],
    [{ id: 'r', kind: 'range', dataset: 'orders', column: 'a', max: 1 }],
    { maxSamplesPerRule: 1 },
  )
  assert.equal(ruleIds(report).includes('samples-truncated'), true)
  assert.equal(severityFor('samples-truncated'), 'info')
  // The exit code comes from the violation, not from the truncation notice.
  assert.equal(exitCodeFor(report), 1)
})

test('exit 0 is reachable only with no findings at all', async () => {
  const report = await project([{ a: 5 }], [{ id: 'r', kind: 'range', dataset: 'orders', column: 'a', max: 10 }])
  assert.deepEqual(report.findings, [])
  assert.equal(exitCodeFor(report), 0)
})

test('every evidence-missing id would exit 2 if it were the only finding', () => {
  for (const id of EVIDENCE_MISSING_RULES) {
    const findings = [{ ruleId: id, severity: severityFor(id), message: '', location: {} }]
    const report = { status: statusFor(findings), findings }
    assert.equal(report.status, 'incomplete', id)
    assert.equal(exitCodeFor(report), 2, id)
  }
})

test('every id outside that list gives fail or pass, never incomplete', () => {
  for (const id of RULE_IDS.filter((candidate) => !EVIDENCE_MISSING_RULES.includes(candidate))) {
    const findings = [{ ruleId: id, severity: severityFor(id), message: '', location: {} }]
    const report = { status: statusFor(findings), findings }
    assert.notEqual(report.status, 'incomplete', id)
    assert.equal(exitCodeFor(report), severityFor(id) === 'error' ? 1 : 0, id)
  }
})
