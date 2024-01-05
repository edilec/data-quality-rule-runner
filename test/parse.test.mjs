/**
 * The parse-failure helper.
 *
 * V8 embeds raw input in its parse error message, and the shape that quotes the
 * document must be recognised BEFORE the shape that carries an offset.
 * Nineteen of thirty-eight tools in this catalog shipped the branches the other
 * way round, and every group that wrote the "at position 1" case found it. That
 * case is the first test below, and it is the one this file exists for.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { join } from 'node:path'

import { parseFailureDetail, runRuleset } from '../src/index.mjs'
import { cleanup, dataset, ruleset, workspace, writeJson } from './helpers.mjs'
import { writeFile } from 'node:fs/promises'

after(cleanup)

function failureFor(text) {
  try {
    JSON.parse(text)
  } catch (error) {
    return { message: error.message, detail: parseFailureDetail(error) }
  }
  throw new Error('that document parsed')
}

test('a document whose own text reads "at position 1" is not sliced back out', () => {
  const { message, detail } = failureFor('at position 1')
  assert.equal(message, `Unexpected token 'a', "at position 1" is not valid JSON`)
  assert.equal(detail, "unexpected token 'a' at the start of the document")
  assert.equal(detail.includes('at position 1'), false)
})

test('a document that is only a credential is never reproduced', () => {
  const { detail } = failureFor('NOTAREALTOKEN0000EXAMPLE')
  assert.equal(detail, "unexpected token 'N' at the start of the document")
  assert.equal(detail.includes('NOTAREAL'), false)
  assert.equal(detail.includes('"'), false)
})

test('a long document with a sensitive prefix loses the prefix, not just the tail', () => {
  const { message, detail } = failureFor(`password=NOTAREAL${'z'.repeat(200)}`)
  assert.equal(message.includes('password=N'), true)
  assert.equal(detail, "unexpected token 'p' at the start of the document")
  assert.equal(detail.includes('password'), false)
})

test('a short document quoted whole is reported as quoted from its start', () => {
  // V8 quotes a short document ENTIRELY, with no leading ellipsis, whatever the
  // offset of the offence inside it -- so this is the "at the start" branch,
  // not the middle-of-document one. This test was named for the middle case and
  // then asserted the start wording, which left the branch it claimed to cover
  // with no test at all in this suite; the test below is that branch.
  const { message, detail } = failureFor('{"alpha":ZQXJVBMP7W}')
  assert.equal(message, `Unexpected token 'Z', "{"alpha":ZQXJVBMP7W}" is not valid JSON`)
  assert.equal(detail, "unexpected token 'Z' at the start of the document")
  assert.equal(detail.includes('ZQXJVBMP7W'), false)
})

test('a quoted span reported from the middle of the document says so, and shows none of it', () => {
  // Long enough that V8 takes its window from around the offence instead of
  // from the start, which it marks with a leading ellipsis. That ellipsis is
  // the only thing that distinguishes the two wordings, and the document body
  // must not survive into either.
  const document = `{"alpha": "${'x'.repeat(200)}", "beta": ZQXJVBMP7W}`
  const { message, detail } = failureFor(document)
  assert.equal(message.startsWith(`Unexpected token 'Z', ..."`), true, message)
  assert.equal(message.includes('ZQXJVBMP7W'), true)
  assert.equal(detail, "unexpected token 'Z' inside the document")
  assert.equal(detail.includes('ZQXJVBMP7W'), false)
  assert.equal(detail.includes('xxx'), false)
  assert.equal(detail.includes('"'), false)
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  // Without the `s` flag the pattern silently fails to match here and the
  // document falls through to the offset branch, which is exactly the shape
  // this guard exists to catch.
  const { message, detail } = failureFor('line one\nline two')
  assert.equal(message.includes('line one\nline two'), true)
  assert.equal(detail, "unexpected token 'l' at the start of the document")
  assert.equal(detail.includes('line two'), false)
})

test('the safe positional form still yields a position', () => {
  const { detail } = failureFor('{"a": 1,}')
  assert.equal(detail, 'Expected double-quoted property name in JSON at position 8 (line 1 column 9)')
})

test('a truncated document keeps its own wording', () => {
  assert.equal(failureFor('{"a":').detail, 'Unexpected end of JSON input')
})

test('a message this helper has never seen, but that quotes something, falls back', () => {
  // The backstop does not depend on the branch logic being right: V8 quotes
  // JSON punctuation with apostrophes, so a surviving double quote means a
  // snippet survived whatever the branches concluded.
  const detail = parseFailureDetail({ message: 'Some future wording about "SECRETVALUE" here' })
  assert.equal(detail, 'the document could not be parsed as JSON')
  assert.equal(detail.includes('SECRETVALUE'), false)
})

test('a quoted snippet that survives a branch is caught by the closing guard', () => {
  // The generic fallback inside `describeParseFailure` is NOT what makes this
  // safe: a wording that reaches the offset branch keeps everything before the
  // offset, snippet included. Only the closing check sees that.
  const detail = parseFailureDetail({
    message: 'Bad value "NOTAREALTOKEN0000EXAMPLE" in JSON at position 5',
  })
  assert.equal(detail, 'the document could not be parsed as JSON')
  assert.equal(detail.includes('NOTAREAL'), false)
})

test('an error with no message at all is described rather than thrown over', () => {
  assert.equal(parseFailureDetail({}), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(null), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail({ message: { toString: {} } }), 'the document could not be parsed as JSON')
})

test('an unparsable dataset reports incomplete and reproduces nothing of the document', async () => {
  const directory = await workspace()
  await writeFile(join(directory, 'orders.json'), 'NOTAREALTOKEN0000EXAMPLE', 'utf8')
  const rulesPath = join(directory, 'rules.json')
  await writeJson(rulesPath, ruleset({
    datasets: [{ name: 'orders', file: 'orders.json' }],
    rules: [{ id: 'r', kind: 'completeness', dataset: 'orders', column: 'a' }],
  }))

  const report = await runRuleset({ rules: rulesPath, data: directory })
  assert.equal(report.status, 'incomplete')
  const unparsable = report.findings.find((finding) => finding.ruleId === 'dataset-unparsable')
  assert.notEqual(unparsable, undefined)
  assert.match(unparsable.message, /unexpected token 'N' at the start of the document/u)
  assert.equal(JSON.stringify(report).includes('NOTAREALTOKEN'), false)
})

test('an unparsable ruleset is a configuration error that reproduces nothing either', async () => {
  const directory = await workspace()
  await writeJson(join(directory, 'orders.json'), dataset('orders', [{ a: 1 }]))
  const rulesPath = join(directory, 'rules.json')
  await writeFile(rulesPath, 'NOTAREALTOKEN0000EXAMPLE', 'utf8')

  await assert.rejects(
    () => runRuleset({ rules: rulesPath, data: directory }),
    (error) => {
      assert.match(error.message, /--rules could not be parsed: unexpected token 'N'/u)
      assert.equal(error.message.includes('NOTAREALTOKEN'), false)
      return true
    },
  )
})
