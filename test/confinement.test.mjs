/**
 * Path confinement, tested against the filesystem rather than against strings.
 *
 * Refusing `..` and an absolute path is lexical and is not confinement: a
 * symbolic link planted inside the declared root passes every string test and
 * leads straight out of the tree, and a shipped tool in this catalog echoed
 * out-of-root content into its report exactly that way.
 *
 * The allowed cases matter as much as the refusals. A guard that refuses
 * everything passes a confinement test while making the tool useless, and on
 * macOS the system temporary directory is itself reached through a link, so a
 * guard that compared paths lexically would refuse every run.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { RulesetError, runRuleset, validateRuleset } from '../src/index.mjs'
import { cleanup, dataset, ruleIds, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const RULE = { id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }

async function runWith(root, file) {
  const rulesPath = join(root, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file }],
    rules: [RULE],
  }))
  return runRuleset({ rules: rulesPath, data: root })
}

test('a symbolic link inside the root that leaves it is refused, not read', async () => {
  const outside = await workspace()
  const secret = join(outside, 'elsewhere.json')
  await writeJson(secret, dataset('orders', [{ a: 'OUT-OF-ROOT-CONTENT' }]))

  const root = await workspace()
  await symlink(secret, join(root, 'orders.json'))

  const report = await runWith(root, 'orders.json')
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report).sort(), ['dataset-outside-root', 'no-rules-executed', 'rule-execution-failed'])
  // Presence beside absence: the refusal is named, and nothing from the
  // out-of-root document reached the report.
  assert.equal(JSON.stringify(report).includes('OUT-OF-ROOT-CONTENT'), false)
  const refusal = report.findings.find((finding) => finding.ruleId === 'dataset-outside-root')
  assert.deepEqual(refusal.location, { file: 'orders.json' })
  assert.match(refusal.message, /resolves outside --data/u)
})

test('a symbolic link inside the root that stays inside it is followed', async () => {
  const root = await workspace()
  await writeJson(join(root, 'real.json'), dataset('orders', [{ a: 'present' }]))
  await symlink(join(root, 'real.json'), join(root, 'orders.json'))

  const report = await runWith(root, 'orders.json')
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a dataset in a subdirectory of the root is read normally', async () => {
  const root = await workspace()
  await mkdir(join(root, 'exports'))
  await writeJson(join(root, 'exports', 'orders.json'), dataset('orders', [{ a: 'present' }]))

  const report = await runWith(root, 'exports/orders.json')
  assert.deepEqual(report.findings, [])
})

test('the lexical check refuses an escape spelled out in the ruleset', () => {
  const base = { schemaVersion: '1', rules: [RULE] }
  for (const file of ['../orders.json', '/etc/orders.json', 'a/../../orders.json', './orders.json']) {
    assert.throws(
      () => validateRuleset({ ...base, datasets: [{ name: 'orders', file }] }),
      RulesetError,
      file,
    )
  }
  assert.equal(
    validateRuleset({ ...base, datasets: [{ name: 'orders', file: 'a/b/orders.json' }] }).datasets[0].file,
    'a/b/orders.json',
  )
})

test('a dataset path that names a directory is reported, not read', async () => {
  const root = await workspace()
  await mkdir(join(root, 'orders.json'))
  const report = await runWith(root, 'orders.json')
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('dataset-unreadable'), true)
})

test('--data that is not a directory is a configuration error', async () => {
  const root = await workspace()
  const file = join(root, 'not-a-directory')
  await writeFile(file, 'x', 'utf8')
  const rulesPath = join(root, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [RULE],
  }))
  await assert.rejects(
    () => runRuleset({ rules: rulesPath, data: file }),
    (error) => error instanceof RulesetError && /must name a directory/u.test(error.message),
  )
})
