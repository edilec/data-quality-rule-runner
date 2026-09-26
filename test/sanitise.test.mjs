/**
 * The sanitisation boundary.
 *
 * Every class below reached output in some shipped tool. The characters are
 * built with `String.fromCodePoint` rather than written into this file, so no
 * editor, transfer or copy-paste can turn an escape into the byte it names --
 * and so this file itself stays free of the things it tests.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'

import {
  EVIDENCE_LIMIT,
  LINE_SEPARATORS,
  describeValue,
  differingCodePoints,
  isRenderableString,
  makeFinding,
  msg,
  runRuleset,
  sanitize,
} from '../src/index.mjs'
import { cleanup, dataset, ruleset, workspace, writeJson } from './helpers.mjs'

after(cleanup)

const CLASSES = [
  ['C0', 0x0001],
  ['C0 newline', 0x000a],
  ['DEL', 0x007f],
  ['C1 NEL', 0x0085],
  ['C1 CSI', 0x009b],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['bidi LRM', 0x200e],
  ['bidi RLM', 0x200f],
  ['bidi LRE', 0x202a],
  ['bidi RLO', 0x202e],
  ['bidi isolate', 0x2066],
  ['bidi pop isolate', 0x2069],
]

test('every unsafe class is stripped from a value that reaches output', () => {
  for (const [name, code] of CLASSES) {
    const value = `a${String.fromCodePoint(code)}b`
    assert.equal(sanitize(value), 'a b', name)
  }
})

test('LINE_SEPARATORS holds exactly U+2028 and U+2029', () => {
  assert.deepEqual([...LINE_SEPARATORS].map((ch) => ch.codePointAt(0)), [0x2028, 0x2029])
})

test('a string of only unsafe characters renders as nothing, and is not renderable', () => {
  for (const [name, code] of CLASSES) {
    const value = String.fromCodePoint(code).repeat(3)
    assert.equal(sanitize(value), '', name)
    // `trim()` accepts U+0001 and U+200E, which is how a "required and
    // non-empty" field reached output as the empty string in a shipped tool.
    assert.equal(isRenderableString(value), false, name)
  }
})

test('trim and the sanitiser disagree in both directions, which is why the sanitiser decides', () => {
  const bidi = String.fromCodePoint(0x200e)
  assert.equal(bidi.trim().length > 0, true)
  assert.equal(isRenderableString(bidi), false)

  const separator = String.fromCodePoint(0x2028)
  assert.equal(separator.trim().length, 0)
  assert.equal(sanitize(separator), '')
})

test('an identifier carries the value through the same boundary as an excerpt', async () => {
  // A shipped tool sanitised its evidence carefully and let a page id
  // containing a newline forge whole lines in the report.
  const directory = await workspace()
  const column = `total${String.fromCodePoint(0x000a)}error: forged`
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ [column]: null }]))
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column }],
  }))

  const report = await runRuleset({ rules: rulesPath, data: directory })
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].message.includes(String.fromCodePoint(0x000a)), false)
  assert.equal(report.findings[0].location.pointer, '/rows/0/total error: forged')
  assert.match(report.findings[0].message, /column total error: forged is not populated/u)
})

test('a value that cannot be converted to a primitive is described, never thrown over', () => {
  assert.equal(describeValue({ toString: {} }), '[object]')
  assert.equal(sanitize({ toString: {} }), '[object]')
  assert.equal(describeValue(['1']), '[array]')
  assert.equal(describeValue(null), 'null')
  assert.equal(describeValue(undefined), 'undefined')
  // `String(['1'])` is '1', which would read like a value rather than an array.
  assert.notEqual(describeValue(['1']), '1')
  // A function converts without throwing, so it reaches the `String` branch and
  // is described by its source. That is only reachable through the library
  // entry points: `readCell` refuses a function as a non-scalar before any
  // value reaches the sanitiser, which the next assertion pins.
  assert.equal(describeValue(() => 1).includes('=>'), true)
})

test('a function in a cell is refused before it can reach the sanitiser', async () => {
  const { readCell } = await import('../src/cells.mjs')
  const cell = readCell({ a: () => 1 }, 'a', 100)
  assert.equal(cell.usable, false)
  assert.equal(cell.code, 'nonScalar')
})

test('a value longer than the evidence limit is cut, and says it was', () => {
  const long = 'x'.repeat(EVIDENCE_LIMIT + 50)
  const cut = sanitize(long)
  assert.equal(cut.length, EVIDENCE_LIMIT)
  assert.equal(cut.endsWith('...'), true)
  // Exactly at the limit nothing is cut: a bound has two sides here too.
  assert.equal(sanitize('y'.repeat(EVIDENCE_LIMIT)), 'y'.repeat(EVIDENCE_LIMIT))
})

test('every mask hides the value and still says what shape it had', async () => {
  // Masking is this tool's redaction: a quality report is routinely pasted
  // into a ticket or a build log, which travel further than the dataset. Only
  // the string mask was pinned anywhere, so a sweep could rewrite the number,
  // boolean and unevaluable masks -- the text a reader sees in place of the
  // value -- with the whole suite green.
  const { cellText, readCell } = await import('../src/cells.mjs')
  const cell = (value) => readCell({ a: value }, 'a', 100)

  assert.equal(cellText(cell('hello'), false), '<string:5>')
  assert.equal(cellText(cell(42), false), '<number>')
  assert.equal(cellText(cell(true), false), '<boolean>')
  assert.equal(cellText(cell(false), false), '<boolean>')
  // A cell this run could not read carries no shape at all, because it has
  // none this tool established.
  assert.equal(cellText(cell(null), false), '<unevaluable>')
  assert.equal(cellText(cell({ deep: 1 }), false), '<unevaluable>')
  assert.equal(cellText(cell(null), true), '<unevaluable>')

  // And with --show-values the value itself appears, so the masks above are
  // not the only thing cellText can say.
  assert.equal(cellText(cell('hello'), true), 'hello')
  assert.equal(cellText(cell(42), true), '42')
  assert.equal(cellText(cell(true), true), 'true')
  // Even then it crosses the sanitisation boundary.
  const bidi = `north${String.fromCodePoint(0x202e)}`
  assert.equal(cellText(cell(bidi), true), 'north')
  assert.equal(cellText(cell(bidi), false), '<string:6>')
})

test('a finding carries its suggestion and its evidence through the boundary', () => {
  // Removing either branch of makeFinding left the suite green: no test
  // asserted that a `suggestion` reaches the report at all, and `evidence` is
  // part of the finding shape the report contract defines and is reachable
  // from this exported function even though no call site in this tool passes
  // one today.
  const nel = String.fromCodePoint(0x0085)
  const finding = makeFinding('completeness-violation', msg`something`, { file: 'a.json' }, {
    suggestion: `Correct the export${nel} upstream.`,
    evidence: `reading${nel} = 1`,
  })
  assert.equal(finding.suggestion, 'Correct the export upstream.')
  assert.equal(finding.evidence, 'reading = 1')
  assert.equal(JSON.parse(JSON.stringify(finding)).suggestion, 'Correct the export upstream.')

  // Neither key is invented when the caller supplies neither: an optional
  // field of the envelope is absent, not empty.
  const bare = makeFinding('completeness-violation', msg`something`, { file: 'a.json' })
  assert.equal(Object.hasOwn(bare, 'suggestion'), false)
  assert.equal(Object.hasOwn(bare, 'evidence'), false)
})

test('differingCodePoints names the characters that account for two values rendering alike', () => {
  const lrm = String.fromCodePoint(0x200e)
  const rlm = String.fromCodePoint(0x200f)
  assert.equal(differingCodePoints('kWh', `kWh `), 'U+0020')
  assert.equal(differingCodePoints(`cust-001${lrm}`, 'cust-001'), 'U+200E')
  assert.equal(differingCodePoints(`a${lrm}b`, `a${rlm}b`), 'U+200E, U+200F')
  // A permutation renders alike with no one character to blame, so nothing is
  // named rather than something false.
  assert.equal(differingCodePoints('ab ', ' ab'), '')
  assert.equal(differingCodePoints(5, 'x'), '')
  // Bounded, and in code-unit order.
  assert.equal(differingCodePoints('abcdefg', ''), 'U+0061, U+0062, U+0063, U+0064, ...')
  // Both sides of that bound: exactly the limit is named in full, one more is
  // cut. Widening the comparison by a character would start cutting a list the
  // limit calls complete.
  assert.equal(differingCodePoints('abcd', ''), 'U+0061, U+0062, U+0063, U+0064')
  assert.equal(differingCodePoints('abcde', ''), 'U+0061, U+0062, U+0063, U+0064, ...')
  assert.equal(differingCodePoints('abc', '', 3), 'U+0061, U+0062, U+0063')
  assert.equal(differingCodePoints('abcd', '', 3), 'U+0061, U+0062, U+0063, ...')
  // Ordered by code point, not by the rendered name: U+005A sorts before
  // U+1F600 as a number, and after it as a string of unequal length.
  assert.equal(differingCodePoints(`Z${String.fromCodePoint(0x1f600)}`, ''), 'U+005A, U+1F600')
  assert.equal(differingCodePoints(`${String.fromCodePoint(0x1f600)}Z`, ''), 'U+005A, U+1F600')
})

test('a report never says two values differ and then prints them identically', async () => {
  // The emblem of this catalog: "column reading changed unit from kWh to kWh",
  // at error severity, because the comparison read the raw value and the
  // message was written from the sanitised one. The difference is REAL and
  // still deserves the finding -- what it needs is to say which difference it
  // is, because a reader cannot act on a sentence that contradicts itself.
  const lrm = String.fromCodePoint(0x200e)
  const nel = String.fromCodePoint(0x0085)
  const directory = await workspace()
  const rulesPath = join(directory, 'rules.json')

  await writeJson(join(directory, 'orders.json'), dataset('orders', [
    { unit_before: 'kWh', unit_after: 'kWh ' },
  ]))
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [{ id: 'unit-stable', kind: 'crossField', dataset: 'orders', left: 'unit_before', right: 'unit_after', comparison: 'gte', type: 'string' }],
  }))
  const cross = await runRuleset({ rules: rulesPath, data: directory, showValues: true })
  assert.equal(cross.status, 'fail')
  assert.deepEqual(cross.findings.map((finding) => finding.ruleId), ['cross-field-violation'])
  assert.equal(cross.findings[0].message.includes('(kWh) is not gte unit_after (kWh)'), true)
  assert.match(cross.findings[0].message, /differ only in characters this report does not display \(U\+0020\)/u)

  // Two strings that genuinely differ must NOT gain the clause: a note that
  // fires on every string comparison would be the false positive this whole
  // class is about, arriving from the other side.
  // 'M' is 0x4D and 'k' is 0x6B, so 'MWh' is below 'kWh' by code unit and gte
  // genuinely fails here.
  await writeJson(join(directory, 'orders.json'), dataset('orders', [
    { unit_before: 'MWh', unit_after: 'kWh' },
  ]))
  const plain = await runRuleset({ rules: rulesPath, data: directory, showValues: true })
  assert.deepEqual(plain.findings.map((finding) => finding.ruleId), ['cross-field-violation'])
  assert.equal(plain.findings[0].message.includes('does not display'), false)
  assert.match(plain.findings[0].suggestion, /Correct one of the two columns upstream/u)

  // And a row that satisfies the rule stays silent.
  await writeJson(join(directory, 'orders.json'), dataset('orders', [
    { unit_before: 'kWh', unit_after: 'MWh' },
  ]))
  const silent = await runRuleset({ rules: rulesPath, data: directory, showValues: true })
  assert.deepEqual(silent.findings, [])
  assert.equal(silent.status, 'pass')

  // A relation, in all three directions the collision can arrive from. The
  // verdict does not change -- the key really has no match -- but the report
  // now says the referenced export holds one that looks the same.
  const relation = [{
    id: 'known-customer',
    kind: 'referential',
    dataset: 'orders',
    columns: ['customer_id'],
    references: { dataset: 'customers', columns: ['id'] },
  }]
  const drive = async (child, parent) => {
    await writeJson(join(directory, 'orders.json'), dataset('orders', [{ customer_id: child }]))
    await writeJson(join(directory, 'customers.json'), dataset('customers', [{ id: parent }]))
    await writeJson(rulesPath, ruleset({
      datasets: [{ name: 'orders', file: 'orders.json' }, { name: 'customers', file: 'customers.json' }],
      rules: relation,
    }))
    return runRuleset({ rules: rulesPath, data: directory, showValues: true })
  }

  for (const [label, child, parent, codes] of [
    ['the child carries it', `cust-001${lrm}`, 'cust-001', /U\+200E/u],
    ['the referenced key carries it', 'cust-001', `cust-001${nel}`, /U\+0085/u],
    ['both carry one', `cust-001${lrm}`, `cust-001${nel}`, /U\+0085, U\+200E/u],
  ]) {
    const report = await drive(child, parent)
    assert.equal(report.status, 'fail', label)
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['referential-violation'], label)
    assert.match(report.findings[0].message, /does hold a key that renders identically to it/u, label)
    assert.match(report.findings[0].message, codes, label)
    assert.match(report.findings[0].suggestion, /invisible characters/u, label)
  }

  // The same collision when the index is INCOMPLETE. The run cannot say the
  // key has no match at all, so the verdict stays undetermined -- and it still
  // has to say that a key which renders identically is in the part of the
  // index it does have.
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ customer_id: 'cust-001' }]))
  await writeJson(join(directory, 'customers.json'), dataset('customers', [
    { id: `cust-001${nel}` },
    { id: null },
  ]))
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }, { name: 'customers', file: 'customers.json' }],
    rules: relation,
  }))
  const partial = await runRuleset({ rules: rulesPath, data: directory, showValues: true })
  assert.equal(partial.status, 'incomplete')
  assert.equal(partial.findings.some((finding) => finding.ruleId === 'reference-undetermined'), true)
  const undetermined = partial.findings.find((finding) => finding.ruleId === 'reference-undetermined')
  assert.match(undetermined.message, /does hold a key that renders identically to it/u)
  assert.match(undetermined.message, /U\+0085/u)
  assert.match(undetermined.message, /not established/u)

  // And an incomplete index with an ordinary non-match must NOT claim a key
  // renders identically, which would be a positive statement about an index
  // this run knows is missing rows.
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ customer_id: 'cust-009' }]))
  const partialPlain = await runRuleset({ rules: rulesPath, data: directory, showValues: true })
  assert.equal(partialPlain.status, 'incomplete')
  const plainUndetermined = partialPlain.findings.find((finding) => finding.ruleId === 'reference-undetermined')
  assert.equal(plainUndetermined.message.includes('renders identically'), false)
  assert.match(plainUndetermined.message, /matches no key in the partial index of customers/u)
  assert.match(plainUndetermined.suggestion, /Complete the referenced export/u)

  // The negative side, and it is the important one: an ordinary dangling key
  // must NOT gain the clause, and a key that matches must stay silent. A note
  // that fires on everything would be the false positive this whole class is
  // about.
  const dangling = await drive('cust-009', 'cust-001')
  assert.deepEqual(dangling.findings.map((finding) => finding.ruleId), ['referential-violation'])
  assert.equal(dangling.findings[0].message.includes('renders identically'), false)
  assert.match(dangling.findings[0].suggestion, /Add the referenced row/u)

  const matching = await drive('cust-001', 'cust-001')
  assert.deepEqual(matching.findings, [])
  assert.equal(matching.status, 'pass')
})

test('a finding message must be built through the checked template', () => {
  assert.throws(
    () => makeFinding('completeness-violation', 'a plain string', {}),
    /must build its message with the msg tagged template/u,
  )
})

test('a literal claiming this tool reached a data store is refused at construction', () => {
  assert.throws(() => msg`the warehouse was queried for this row`, /may not claim/u)
  assert.throws(() => msg`opened a database connection`, /may not claim/u)
  // A line break must not hide a forbidden phrase from the check.
  assert.throws(() => msg`this run
      queried the export`, /may not claim/u)
})

test('a dataset whose own name contains a checked word does not stop the run', () => {
  // The guard scans this tool's own voice, never the input it is describing.
  const built = msg`dataset ${'warehouse_query_log'} was not read.`
  assert.equal(built.text, 'dataset warehouse_query_log was not read.')
})
