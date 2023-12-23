/**
 * The rule catalog, the severity table, and everything that turns findings into
 * a status.
 *
 * Four defences live here, and each exists because its absence produced a green
 * build over a real failure somewhere in this catalog:
 *
 * 1. Severity is declared exactly once, in `RULE_SEVERITY`. Every finding takes
 *    its severity from that table and an unknown rule id throws rather than
 *    defaulting to something harmless.
 * 2. `status` is derived from the findings, not from a mutable flag. A rule
 *    that could not be executed -- a column the data does not have, a cell that
 *    cannot be compared, a referenced dataset that was never read -- makes the
 *    whole run `incomplete`, and there is no single assignment whose deletion
 *    would let it pass.
 * 3. A finding's message is built with the `msg` tagged template. The literals
 *    are this tool's own voice and are checked against claims it is not
 *    entitled to make -- it reads documents somebody exported and never reaches
 *    a data store -- while the interpolated values come from those documents
 *    and are sanitised.
 * 4. `sanitize` is the single boundary every untrusted string crosses, so it
 *    has to survive a value that cannot be converted to a primitive at all.
 */

/**
 * Deterministic order: UTF-16 code unit, never locale collation.
 *
 * `<` and `<=` are the same comparison here, because the equal case is already
 * answered on the line above, so a sweep that shifts the operator one step
 * reports this as surviving. That is an EQUIVALENT MUTANT and not a gap.
 */
export function byCodeUnit(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/** The one place a severity is written down. */
export const RULE_SEVERITY = Object.freeze({
  'completeness-violation': 'error',
  'cross-field-violation': 'error',
  'dataset-invalid': 'error',
  'dataset-not-utf8': 'error',
  'dataset-outside-root': 'error',
  'dataset-schema-unsupported': 'error',
  'dataset-too-large': 'error',
  'dataset-too-many-columns': 'error',
  'dataset-too-many-rows': 'error',
  'dataset-unparsable': 'error',
  'dataset-unreadable': 'error',
  'key-unevaluable': 'error',
  'no-rules-executed': 'error',
  'range-violation': 'error',
  'reference-index-incomplete': 'error',
  'reference-undetermined': 'error',
  'referential-violation': 'error',
  'rule-column-absent': 'error',
  'rule-examined-no-rows': 'error',
  'rule-execution-failed': 'error',
  'samples-truncated': 'info',
  'uniqueness-violation': 'error',
  'value-unevaluable': 'error',
})

/**
 * The catalog, in code-unit order.
 *
 * A mutation sweep flags this sort as SURVIVING and it is an EQUIVALENT MUTANT
 * for a reason a reader can check rather than take on trust: every id here is
 * lower-case kebab-case, and over THIS set code-unit order and ICU collation
 * are the same permutation, so substituting a collator produces an identical
 * array. That property is asserted over every pair of ids in the test suite, so
 * the next id that breaks it fails a test instead of drifting, and `byCodeUnit`
 * stays because that id may well be added. The ordering that IS observable --
 * the order findings are emitted in -- is pinned behaviourally, on inputs where
 * the two orders genuinely disagree.
 */
export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY).sort(byCodeUnit))

/**
 * Rules that mean the run did not obtain the evidence a verdict would need.
 * Any one of them makes the whole report `incomplete` and the process exit 2,
 * whatever the rule's own severity happens to be.
 *
 * This list is the honesty clause of this tool expressed as behaviour: a rule
 * that could not be executed lands here, so it can never be counted as data
 * that passed. The three violation ids and `samples-truncated` are deliberately
 * absent -- a violation is a verdict the run did establish, and a bounded
 * sample list bounds the locations reported, not the verdict itself.
 */
export const EVIDENCE_MISSING_RULES = Object.freeze([
  'dataset-invalid',
  'dataset-not-utf8',
  'dataset-outside-root',
  'dataset-schema-unsupported',
  'dataset-too-large',
  'dataset-too-many-columns',
  'dataset-too-many-rows',
  'dataset-unparsable',
  'dataset-unreadable',
  'key-unevaluable',
  'no-rules-executed',
  'reference-index-incomplete',
  'reference-undetermined',
  'rule-column-absent',
  'rule-examined-no-rows',
  'rule-execution-failed',
  'value-unevaluable',
].sort(byCodeUnit))

const EVIDENCE_MISSING_SET = new Set(EVIDENCE_MISSING_RULES)

export const EVIDENCE_LIMIT = 200
export const MAX_ID_LENGTH = 128

export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown ruleId "${ruleId}"`)
  return severity
}

export function marksEvidenceMissing(ruleId) {
  severityFor(ruleId)
  return EVIDENCE_MISSING_SET.has(ruleId)
}

/**
 * Words this tool is not entitled to use about its own work.
 *
 * It opens two kinds of local document -- a ruleset somebody wrote and a
 * dataset somebody exported -- and evaluates declared rules over the rows it
 * finds there. It resolves no host, opens no connection and reaches no data
 * store, so a finding phrased as though it had queried something would describe
 * a capability this tool does not have. The phrasing is checked where the
 * message is built rather than where it is reviewed.
 */
export const FORBIDDEN_CLAIMS = Object.freeze([
  'query', 'queries', 'queried', 'querying',
  'database', 'databases', 'warehouse', 'warehouses', 'sql',
  'connect', 'connects', 'connected', 'connection',
  'network', 'fetch', 'fetches', 'fetched', 'downloaded',
  'crawl', 'crawled', 'live data', 'production data', 'the source system',
])

const FORBIDDEN_PATTERN = new RegExp(
  `\\b(?:${FORBIDDEN_CLAIMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})\\b`,
  'iu',
)

export function findForbiddenClaim(text) {
  const match = FORBIDDEN_PATTERN.exec(describeValue(text))
  return match === null ? null : match[0]
}

export function assertNoForbiddenClaim(text, what) {
  const term = findForbiddenClaim(text)
  if (term !== null) {
    throw new Error(
      `${what} may not claim this tool reached a data store: "${term}". `
      + 'It reads a ruleset document and exported dataset documents, and nothing else.',
    )
  }
}

/**
 * U+2028 and U+2029, written as escape text so that no editor, transfer or
 * copy-paste can quietly turn the escape into the character it names.
 */
export const LINE_SEPARATORS = '\u2028\u2029'

/**
 * Everything stripped from an untrusted string before it reaches output.
 *
 * `\p{Cc}` is C0, DEL and C1 -- U+0085 and U+009B forge lines in a human report
 * just as a newline does. `\p{Cf}` is the bidi controls and the other invisible
 * format characters, which reorder or hide displayed text. The two separators
 * are in neither class and have to be named.
 */
const UNSAFE_CHARACTERS = new RegExp(`[\\p{Cc}\\p{Cf}${LINE_SEPARATORS}]`, 'gu')

/**
 * Describe any value as a string without ever letting it stop the run.
 *
 * `String({ toString: {} })` throws `Cannot convert object to primitive value`,
 * and a dataset is JSON this tool did not write: `{"name": {"toString": {}}}`
 * parses into exactly that. A value that will not convert is described by its
 * shape and never reproduced.
 *
 * Only the array branch changes an answer. A sweep reports the first three as
 * SURVIVING and they are EQUIVALENT MUTANTS for a checkable reason: with any of
 * them deleted the value falls through to `String(value)`, and `String` of a
 * primitive string is that same string, `String(null)` is `'null'` and
 * `String(undefined)` is `'undefined'` -- the identical three answers, none of
 * which can throw on the way. They are the fast path for the case that
 * dominates, since every identifier this tool sanitises is already a string.
 *
 * `Array.isArray` is the one that earns a test, because `String(['1'])` is
 * `'1'`, which reads like a value rather than like an array.
 */
export function describeValue(value) {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return '[array]'
  try {
    return String(value)
  } catch {
    return typeof value === 'function' ? '[function]' : '[object]'
  }
}

/**
 * A bounded, control-character-free rendering of an untrusted string.
 *
 * Dataset names, rule ids, column names and file paths all arrive from input
 * documents and all reach the report and the human summary, so every one of
 * them passes through here -- not only the `evidence` field. A shipped tool in
 * this catalog sanitised its evidence carefully and let an identifier carrying
 * a newline forge whole lines in the report.
 */
export function sanitize(value, limit = EVIDENCE_LIMIT) {
  const flat = describeValue(value)
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat
}

/**
 * Whether a value is a string that still says something once sanitised.
 *
 * `value.trim().length > 0` is the wrong question and has shipped as a bug:
 * `trim` removes the ECMAScript `WhiteSpace` and `LineTerminator` productions
 * and nothing else, so a string of U+0001 or U+200E passes it and then reaches
 * output as nothing at all. Validate the form that will be emitted.
 *
 * The two productions are named separately because the difference bites both
 * ways: U+2028 and U+2029 are `LineTerminator` rather than `WhiteSpace`, and
 * `trim` removes them, so "trim keeps everything the sanitiser strips" would be
 * false about exactly those two.
 */
export function isRenderableString(value, limit = MAX_ID_LENGTH) {
  return typeof value === 'string' && value.length <= limit && sanitize(value, limit) !== ''
}

/** A number as the report prints it: finite, bounded, no exponent surprises. */
export function num(value) {
  if (!Number.isFinite(value)) return describeValue(value)
  const rounded = Math.round(value * 10000) / 10000
  // `String(-0)` is already `'0'` in ECMAScript, so this arm changes no byte
  // today and a sweep reports removing it as surviving -- an EQUIVALENT MUTANT.
  // It stays as the one thing that would keep a negative zero out of a report
  // if the rounding step above were ever replaced with something that formats
  // it differently, which is how `-0` reaches output in other languages.
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/u

/**
 * The shape that quotes the input. Recognised FIRST, and the order is the whole
 * guard: a document whose own text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so looking for the
 * offset first finds that phrase INSIDE the quoted span and slices the document
 * straight back out. The `s` flag matters too -- the quoted span can carry a
 * newline, and a non-dotAll pattern silently fails to recognise the shape it is
 * there to catch. A leading ellipsis means the quoted run came from the middle
 * of the document rather than from its start.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/su

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what a `JSON.parse` failure was, without reproducing the document.
 *
 * V8 reports a parse failure two ways and one of them quotes the input back:
 * `Unexpected token 'N', "NOTAREALTOKEN0000EXAMPLE" is not valid JSON`. A document
 * short enough to be only a credential is therefore reproduced in full by its
 * own error message, and `sanitize` does not stop that -- it strips control
 * characters and cuts from the end, while the quoted input sits at the front.
 *
 * The closing guard is deliberate belt and braces and is why this function is
 * safe against wordings it has never seen: across the measured corpus of V8
 * parse messages, every message carrying no quoted snippet carries no double
 * quote at all, because V8 quotes JSON punctuation with apostrophes. A double
 * quote surviving to the end therefore means a snippet survived, whatever the
 * branches above concluded, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = describeValue(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

/** A message whose literals have been checked and whose values are sanitised. */
export class SafeMessage {
  constructor(text) {
    this.text = text
    Object.freeze(this)
  }

  toString() {
    return this.text
  }
}

/**
 * Build a finding message.
 *
 * The tagged-template split is the point: `strings` is this tool's own voice
 * and is checked for claims it is not entitled to make, while `values` come
 * from input documents and are only sanitised. A dataset literally named
 * `warehouse_query_log` must not stop the run, and a sentence this tool wrote
 * claiming it reached a data store must not ship.
 */
export function msg(strings, ...values) {
  let out = ''
  for (let index = 0; index < strings.length; index += 1) {
    // Runs of whitespace in the tool's own literals collapse to one space, so a
    // sentence may be wrapped across source lines without wrapping the report,
    // and so a phrase this tool may not use cannot be hidden by a line break.
    const literal = strings[index].replace(/\s+/gu, ' ')
    assertNoForbiddenClaim(literal, 'A finding message')
    out += literal
    if (index < values.length) out += sanitize(values[index])
  }
  return new SafeMessage(out)
}

export function at(file, pointer) {
  const location = {}
  if (file !== null && file !== undefined) location.file = file
  if (pointer !== null && pointer !== undefined) location.pointer = pointer
  return location
}

/**
 * JSON Pointer escaping, applied to an already sanitised token.
 *
 * RFC 6901 section 3: inside a reference token `~` is written `~0` and `/` is
 * written `~1`, and the order matters -- `~` first, then `/`. Escaping `/`
 * first would turn a literal `~1` in the name into a second-class `/` when a
 * consumer decodes it, because decoding is specified to replace `~1` before
 * `~0`.
 */
export function pointerToken(value) {
  return sanitize(value, MAX_ID_LENGTH).replace(/~/gu, '~0').replace(/\//gu, '~1')
}

export function makeFinding(ruleId, message, location, extra = {}) {
  if (!(message instanceof SafeMessage)) {
    throw new Error(`Finding "${ruleId}" must build its message with the msg tagged template`)
  }
  const finding = { ruleId, severity: severityFor(ruleId), message: message.text, location }
  if (extra.evidence !== undefined) finding.evidence = sanitize(extra.evidence)
  if (extra.suggestion !== undefined) {
    assertNoForbiddenClaim(extra.suggestion, 'A finding suggestion')
    // The suggestion crosses the same boundary as everything else that reaches
    // output. Every call site builds it from this tool's own literals today, so
    // sanitising changes no byte of any current report -- which is exactly why
    // it is the string most likely to skip the boundary, and exactly the shape
    // of an invariant that is true only by accident.
    finding.suggestion = sanitize(extra.suggestion)
  }
  return finding
}

/** Findings sort by (file, pointer, ruleId, message), each by code unit. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file ?? '', b.location.file ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}

/**
 * Status is a function of the findings alone.
 *
 * Missing evidence outranks everything, including an error: a run in which one
 * rule could not be executed has not established that the rules that did run
 * are the whole story. There is no flag to delete.
 */
export function statusFor(findings) {
  for (const finding of findings) {
    if (EVIDENCE_MISSING_SET.has(finding.ruleId)) return 'incomplete'
  }
  for (const finding of findings) {
    if (finding.severity === 'error') return 'fail'
  }
  return 'pass'
}
