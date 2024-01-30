/**
 * The five rule kinds, and the one decision that governs all of them.
 *
 * Every evaluator answers with exactly one of three things about a row:
 *
 *   - the row satisfies the rule,
 *   - the row violates the rule, which is a VERDICT the run established,
 *   - the row could not be evaluated, which is EVIDENCE the run did not get.
 *
 * There is no fourth answer. A cell this tool cannot read, a column the export
 * does not have, a dataset that was never opened and a rule that threw all land
 * in the third bucket, whose rule ids are in `EVIDENCE_MISSING_RULES`, so the
 * report says `incomplete` and the process exits 2. None of them can be counted
 * as data that passed -- that is this tool's central guarantee and it is
 * enforced here rather than described in the README.
 *
 * The sharpest case is `referential`. Building the index of referenced keys can
 * drop rows whose key cannot be formed, and a run that then says a child value
 * "matches nothing" has asserted something POSITIVE on the strength of evidence
 * it threw away. So a non-match against an incomplete index is
 * `reference-undetermined`, never `referential-violation`. A match against an
 * incomplete index is still a real match -- finding a key is sound whatever
 * else was dropped -- but the run stays incomplete, because the clean part of
 * the comparison is the part the dropped rows could have changed.
 */

import { PRESENT_BUT_UNREADABLE, cellText, compareValue, comparisonFor, encodeKey, readCell } from './cells.mjs'
import { at, differingCodePoints, makeFinding, msg, pointerToken, sanitize } from './rules.mjs'

function rowPointer(index, column) {
  return column === undefined ? `/rows/${index}` : `/rows/${index}/${pointerToken(column)}`
}

/**
 * Collects findings, emitting at most `limit` locations per (rule, rule id)
 * pair and reporting the truncation rather than performing it silently.
 *
 * Truncation here bounds the LOCATION LIST, never the verdict: the rule has
 * already failed, or the run has already been marked incomplete, by the time a
 * sample is dropped. That is why `samples-truncated` is `info` and is not in
 * `EVIDENCE_MISSING_RULES` -- it would be dishonest to treat a bounded list of
 * places as a gap in what the run established.
 */
export class Sampler {
  constructor(limit) {
    this.limit = limit
    this.findings = []
    this.groups = new Map()
  }

  sample(context, ruleId, message, location, extra) {
    const key = JSON.stringify([context.ruleName, ruleId])
    let group = this.groups.get(key)
    if (group === undefined) {
      group = { total: 0, shown: 0, ruleId, ruleName: context.ruleName, file: context.file }
      this.groups.set(key, group)
    }
    group.total += 1
    if (group.shown < this.limit) {
      group.shown += 1
      this.findings.push(makeFinding(ruleId, message, location, extra))
    }
  }

  emit(ruleId, message, location, extra) {
    this.findings.push(makeFinding(ruleId, message, location, extra))
  }

  /** One `samples-truncated` finding per group whose location list was cut. */
  finish() {
    for (const group of this.groups.values()) {
      if (group.total <= this.limit) continue
      this.findings.push(makeFinding(
        'samples-truncated',
        msg`rule ${group.ruleName}: ${String(group.total)} row(s) produced ${group.ruleId};
            ${String(this.limit)} location(s) are reported, as limits.maxSamplesPerRule allows.`,
        at(group.file),
        { suggestion: 'Raise limits.maxSamplesPerRule up to its ceiling to see more locations.' },
      ))
    }
    return this.findings
  }
}

function missingColumns(dataset, columns) {
  return columns.filter((column) => !dataset.columns.has(column))
}

function reportMissingColumns(sampler, rule, dataset, columns, side) {
  const absent = missingColumns(dataset, columns)
  if (absent.length === 0) return false
  sampler.emit(
    'rule-column-absent',
    msg`rule ${rule.id}: ${side} dataset ${dataset.name} has no column named
        ${absent.map((column) => sanitize(column)).join(', ')}, so the rule was not executed
        against it. No row was judged.`,
    at(dataset.file),
    { suggestion: 'Align the column name with the export, or drop the rule.' },
  )
  return true
}

/** A key's cells as this report would show them, for collision detection only. */
function renderCells(cells) {
  return cells.map((cell) => (cell.type === 'string' ? { type: cell.type, value: sanitize(cell.value) } : cell))
}

/** The raw text of a key's cells, for naming the characters that differ. */
function joinValues(cells) {
  return cells.map((cell) => String(cell.value)).join('\u0000')
}

/**
 * Whether two cells hold different values that this report shows identically.
 *
 * The comparison is made on the raw value and the message is written from the
 * sanitised one, and the gap between those two is a defect factory: a report
 * that says "kWh changed to kWh", or that a key has no match in an export that
 * visibly contains it, sends a reader to look for a difference that is not on
 * the screen. Only strings can collide -- two different numbers or booleans
 * never sanitise to the same text -- so a masked `<number>` beside another
 * masked `<number>` is not this, and is not reported as it.
 */
function rendersAlike(left, right) {
  return left.usable && right.usable
    && left.type === 'string' && right.type === 'string'
    && left.value !== right.value
    && sanitize(left.value) === sanitize(right.value)
}

/** The clause that names an invisible difference, or nothing at all. */
function invisibleClause(left, right) {
  const codes = differingCodePoints(left, right)
  return codes === ''
    ? 'The two differ only in characters this report does not display.'
    : `The two differ only in characters this report does not display (${codes}).`
}

function keyText(columns, cells, showValues) {
  return columns.map((column, index) => `${sanitize(column)}=${cellText(cells[index], showValues)}`).join(', ')
}

function completeness(rule, dataset, sampler, limits, showValues) {
  const context = { ruleName: rule.id, file: dataset.file }
  if (reportMissingColumns(sampler, rule, dataset, [rule.column], 'the')) return false
  for (const [index, row] of dataset.rows.entries()) {
    const cell = readCell(row, rule.column, limits.maxFieldLength)
    if (cell.usable) continue
    // A value that is there but that this tool cannot read is a different fact
    // from a value that is not there. An object or an over-long string means
    // the column IS populated and this run could not judge it; absent, null and
    // renders-as-nothing mean the column is not populated, which is exactly
    // what a completeness rule exists to find.
    if (PRESENT_BUT_UNREADABLE.includes(cell.code)) {
      sampler.sample(
        context,
        'value-unevaluable',
        msg`rule ${rule.id}: column ${rule.column} holds a value this run could not read
            (${cell.reason}), so whether it is populated was not established.`,
        at(dataset.file, rowPointer(index, rule.column)),
      )
      continue
    }
    sampler.sample(
      context,
      'completeness-violation',
      msg`rule ${rule.id}: column ${rule.column} is not populated here (${cell.reason}).`,
      at(dataset.file, rowPointer(index, rule.column)),
      { suggestion: 'Populate the column in the source export, or relax the rule.' },
    )
  }
  return true
}

function uniqueness(rule, dataset, sampler, limits, showValues) {
  const context = { ruleName: rule.id, file: dataset.file }
  if (reportMissingColumns(sampler, rule, dataset, rule.columns, 'the')) return false
  const seen = new Map()
  for (const [index, row] of dataset.rows.entries()) {
    const cells = rule.columns.map((column) => readCell(row, column, limits.maxFieldLength))
    const bad = cells.findIndex((cell) => !cell.usable)
    if (bad !== -1) {
      // The row leaves the comparison, and the run says so. Duplicates among
      // the rows that remain are still real duplicates, but "no duplicates"
      // would be a claim about rows this index never held.
      sampler.sample(
        context,
        'key-unevaluable',
        msg`rule ${rule.id}: no composite key could be formed for this row because column
            ${rule.columns[bad]} is unusable (${cells[bad].reason}), so it was left out of the
            uniqueness comparison.`,
        at(dataset.file, rowPointer(index, rule.columns[bad])),
      )
      continue
    }
    const key = encodeKey(cells)
    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, index)
      continue
    }
    sampler.sample(
      context,
      'uniqueness-violation',
      msg`rule ${rule.id}: composite key (${keyText(rule.columns, cells, showValues)}) also appears at
          ${rowPointer(first)}.`,
      at(dataset.file, rowPointer(index)),
      { suggestion: `Deduplicate the export, or widen the key beyond (${rule.columns.map((c) => sanitize(c)).join(', ')}).` },
    )
  }
  return true
}

function range(rule, dataset, sampler, limits, showValues) {
  const context = { ruleName: rule.id, file: dataset.file }
  if (reportMissingColumns(sampler, rule, dataset, [rule.column], 'the')) return false
  for (const [index, row] of dataset.rows.entries()) {
    const cell = readCell(row, rule.column, limits.maxFieldLength)
    const location = at(dataset.file, rowPointer(index, rule.column))
    if (!cell.usable) {
      sampler.sample(
        context,
        'value-unevaluable',
        msg`rule ${rule.id}: column ${rule.column} could not be compared against the declared
            bounds (${cell.reason}).`,
        location,
      )
      continue
    }
    if (cell.type !== 'number') {
      // Not a violation. A string in a numeric column is a comparison this
      // tool did not make, and calling it out of range would be inventing one.
      sampler.sample(
        context,
        'value-unevaluable',
        msg`rule ${rule.id}: column ${rule.column} holds a ${cell.type}, and a range rule compares
            numbers. Nothing was converted, so no verdict was reached for this row.`,
        location,
        { suggestion: 'Fix the exported type, or check the column with a different rule kind.' },
      )
      continue
    }
    const below = rule.min !== undefined && cell.value < rule.min
    const above = rule.max !== undefined && cell.value > rule.max
    if (!below && !above) continue
    const bound = below ? `min ${rule.min}` : `max ${rule.max}`
    sampler.sample(
      context,
      'range-violation',
      msg`rule ${rule.id}: column ${rule.column} is ${cellText(cell, showValues)}, outside ${bound}.`,
      location,
      { suggestion: 'Correct the value upstream, or widen the declared bound.' },
    )
  }
  return true
}

function crossField(rule, dataset, sampler, limits, showValues) {
  const context = { ruleName: rule.id, file: dataset.file }
  if (reportMissingColumns(sampler, rule, dataset, [rule.left, rule.right], 'the')) return false
  const compare = comparisonFor(rule.comparison)
  // The validator refuses an unsupported comparison, so this is reachable only
  // through the exported library entry point. It throws rather than defaulting,
  // and `evaluateRules` turns the throw into `rule-execution-failed`: a
  // comparison this tool cannot make is never a row that satisfied one.
  if (compare === undefined) throw new Error(`unsupported comparison "${sanitize(rule.comparison)}"`)
  for (const [index, row] of dataset.rows.entries()) {
    const left = readCell(row, rule.left, limits.maxFieldLength)
    const right = readCell(row, rule.right, limits.maxFieldLength)
    const unusable = !left.usable ? rule.left : !right.usable ? rule.right : null
    if (unusable !== null) {
      const cell = unusable === rule.left ? left : right
      sampler.sample(
        context,
        'value-unevaluable',
        msg`rule ${rule.id}: column ${unusable} could not be compared (${cell.reason}).`,
        at(dataset.file, rowPointer(index, unusable)),
      )
      continue
    }
    const leftValue = compareValue(left, rule.type)
    const rightValue = compareValue(right, rule.type)
    const mistyped = !leftValue.ok ? rule.left : !rightValue.ok ? rule.right : null
    if (mistyped !== null) {
      sampler.sample(
        context,
        'value-unevaluable',
        msg`rule ${rule.id}: column ${mistyped} does not hold a usable ${rule.type}, so the two
            columns were not compared for this row.`,
        at(dataset.file, rowPointer(index, mistyped)),
        { suggestion: 'Fix the exported value, or declare the type the export actually uses.' },
      )
      continue
    }
    if (compare(leftValue.value, rightValue.value)) continue
    if (rendersAlike(left, right)) {
      // A real violation, reported so a reader can act on it. Without this the
      // sentence reads "a (north) is not gte b (north)", which is the shape
      // that makes somebody stop trusting a checker.
      sampler.sample(
        context,
        'cross-field-violation',
        msg`rule ${rule.id}: ${rule.left} (${cellText(left, showValues)}) is not ${rule.comparison}
            ${rule.right} (${cellText(right, showValues)}).
            ${invisibleClause(left.value, right.value)}`,
        at(dataset.file, rowPointer(index)),
        { suggestion: 'Correct the invisible characters in one of the two columns upstream.' },
      )
      continue
    }
    sampler.sample(
      context,
      'cross-field-violation',
      msg`rule ${rule.id}: ${rule.left} (${cellText(left, showValues)}) is not ${rule.comparison}
          ${rule.right} (${cellText(right, showValues)}).`,
      at(dataset.file, rowPointer(index)),
      { suggestion: 'Correct one of the two columns upstream.' },
    )
  }
  return true
}

function referential(rule, dataset, sampler, limits, showValues, datasets, files) {
  const context = { ruleName: rule.id, file: dataset.file }
  const parent = datasets.get(rule.references.dataset)
  if (parent === undefined) {
    sampler.emit(
      'rule-execution-failed',
      msg`rule ${rule.id}: the referenced dataset ${rule.references.dataset} was not read, so the
          relation was not checked. No row of ${dataset.name} was judged against it.`,
      at(files?.get(rule.references.dataset) ?? dataset.file),
      { suggestion: 'Resolve the finding reported against the referenced dataset and run again.' },
    )
    return false
  }
  if (reportMissingColumns(sampler, rule, dataset, rule.columns, 'the')) return false
  // An empty referenced export has no columns to be missing. Asking about them
  // first would report a column name as wrong when the real fact is that the
  // export holds nothing, which is a finding raised on a correct rule.
  const parentEmpty = parent.rows.length === 0
  if (!parentEmpty && reportMissingColumns(sampler, rule, parent, rule.references.columns, 'the referenced')) {
    return false
  }

  const index = new Set()
  // Parent keys whose RENDERED form differs from their raw form, keyed by that
  // rendered form. A clean export puts nothing in here, so this costs no memory
  // on the runs that do not need it, and it is what lets a non-match say which
  // difference it is rather than leaving a reader staring at a key the
  // referenced export visibly contains.
  const renderedIndex = new Map()
  let dropped = 0
  for (const [parentIndex, row] of parent.rows.entries()) {
    const cells = rule.references.columns.map((column) => readCell(row, column, limits.maxFieldLength))
    const bad = cells.findIndex((cell) => !cell.usable)
    if (bad !== -1) {
      dropped += 1
      sampler.sample(
        context,
        'value-unevaluable',
        msg`rule ${rule.id}: the referenced key of dataset ${parent.name} could not be formed here
            because column ${rule.references.columns[bad]} is unusable
            (${cells[bad].reason}), so this row is not in the index the rule compares against.`,
        at(parent.file, rowPointer(parentIndex, rule.references.columns[bad])),
      )
      continue
    }
    const key = encodeKey(cells)
    index.add(key)
    const rendered = encodeKey(renderCells(cells))
    if (rendered !== key) renderedIndex.set(rendered, joinValues(cells))
  }

  // Evidence dropped while building an index makes the comparison INCOMPLETE.
  // It does not make it clean, and it does not license a positive claim that a
  // value matches nothing. An empty referenced export is the same situation
  // arriving by a different route: there is nothing to have matched, so
  // "matches nothing" would be a statement about an export, not about a value.
  const indexComplete = dropped === 0 && !parentEmpty
  if (!indexComplete) {
    sampler.emit(
      'reference-index-incomplete',
      msg`rule ${rule.id}: the index of ${parent.name} keys holds ${String(index.size)} of
          ${String(parent.rows.length)} row(s) (${String(dropped)} could not be keyed), so this run
          cannot establish that a value has no match. Non-matches are reported as undetermined.`,
      at(parent.file),
      { suggestion: 'Complete the referenced export so every key row can be read.' },
    )
  }

  for (const [childIndex, row] of dataset.rows.entries()) {
    const cells = rule.columns.map((column) => readCell(row, column, limits.maxFieldLength))
    const bad = cells.findIndex((cell) => !cell.usable)
    if (bad !== -1) {
      sampler.sample(
        context,
        'value-unevaluable',
        msg`rule ${rule.id}: column ${rule.columns[bad]} is unusable (${cells[bad].reason}), so the
            relation was not checked for this row.`,
        at(dataset.file, rowPointer(childIndex, rule.columns[bad])),
      )
      continue
    }
    const childKey = encodeKey(cells)
    if (index.has(childKey)) continue
    // The referenced export may hold a key that a reader cannot tell apart from
    // this one: same text on the screen, different bytes in the document. That
    // is a real difference and it still has no match, so the verdict does not
    // change -- but the message has to say WHICH difference it is.
    const childRendered = encodeKey(renderCells(cells))
    // Two ways to collide, and the second is easy to get wrong: when the
    // REFERENCED key is the clean one, the key it holds is this child's own
    // rendered form, so that is what the difference has to be named against --
    // naming it against the child itself compares a value with itself and finds
    // nothing to report.
    const alike = childRendered !== childKey && index.has(childRendered)
      ? joinValues(renderCells(cells))
      : renderedIndex.get(childRendered)
    if (!indexComplete) {
      sampler.sample(
        context,
        'reference-undetermined',
        msg`rule ${rule.id}: (${keyText(rule.columns, cells, showValues)}) matches no key in the
            partial index of ${parent.name}. Whether it matches a key that index is missing was
            not established.${alike === undefined ? '' : ` A key of ${parent.name} renders
            identically to it. ${invisibleClause(joinValues(cells), alike)}`}`,
        at(dataset.file, rowPointer(childIndex)),
        { suggestion: 'Complete the referenced export, then run again for a verdict.' },
      )
      continue
    }
    if (alike !== undefined) {
      sampler.sample(
        context,
        'referential-violation',
        msg`rule ${rule.id}: (${keyText(rule.columns, cells, showValues)}) has no matching
            (${rule.references.columns.map((c) => sanitize(c)).join(', ')}) in dataset
            ${parent.name}, which does hold a key that renders identically to it.
            ${invisibleClause(joinValues(cells), alike)}`,
        at(dataset.file, rowPointer(childIndex)),
        { suggestion: 'Correct the invisible characters on one side, rather than adding a row.' },
      )
      continue
    }
    sampler.sample(
      context,
      'referential-violation',
      msg`rule ${rule.id}: (${keyText(rule.columns, cells, showValues)}) has no matching
          (${rule.references.columns.map((c) => sanitize(c)).join(', ')}) in dataset ${parent.name}.`,
      at(dataset.file, rowPointer(childIndex)),
      { suggestion: 'Add the referenced row, or remove the dangling value.' },
    )
  }
  return true
}

const EVALUATORS = Object.freeze({
  completeness,
  crossField,
  range,
  referential,
  uniqueness,
})

/**
 * The evaluator table as a Map, because a property lookup is not a table
 * lookup. `EVALUATORS['constructor']` and `EVALUATORS['toString']` resolve
 * members of `Object.prototype`: both are callable, both return something
 * truthy, so the `undefined` check below did not fire, `checked` was
 * incremented and the run reported `pass` -- a rule kind this tool cannot
 * evaluate counted as a rule it evaluated successfully, which is the one thing
 * the backstop below exists to prevent. A Map answers for its own entries and
 * nothing else.
 */
const EVALUATOR_BY_KIND = new Map(Object.entries(EVALUATORS))

/**
 * Run every rule, and count the ones that were executed.
 *
 * `checked` is the number of rules that examined at least one row without being
 * abandoned. That is NOT the same as the number of rules that reached a
 * verdict, and the two must not be conflated: a referential rule whose index
 * came out incomplete is executed, reports every non-match as undetermined, and
 * establishes nothing about those rows. The CLI summary used to render this
 * number as "rules with a verdict" and then print "at least one rule did not
 * reach a verdict" two lines below it, about the same rule. Whether a verdict
 * was reached is what `status` and the evidence-missing findings say; `checked`
 * says only that the rule ran.
 *
 * A rule over an empty export examined nothing: reporting it as satisfied would
 * be the vacuous pass this catalog keeps finding, so it is reported as
 * `rule-examined-no-rows` and the run is incomplete.
 *
 * The catch-all is a backstop, not decoration. It is reachable through this
 * exported entry point -- a library caller can hand it a rule kind the ruleset
 * validator would have refused -- and a rule whose evaluation threw must be an
 * execution error rather than a rule that quietly found nothing wrong.
 */
export function evaluateRules({ rules, datasets, files, limits, showValues = false }) {
  const sampler = new Sampler(limits.maxSamplesPerRule)
  let checked = 0

  for (const rule of rules) {
    const dataset = datasets.get(rule.dataset)
    if (dataset === undefined) {
      sampler.emit(
        'rule-execution-failed',
        msg`rule ${rule.id}: dataset ${rule.dataset} was not read, so the rule was not executed.
            Its rows were neither judged nor passed.`,
        at(files?.get(rule.dataset) ?? null, `/rules/${pointerToken(rule.id)}`),
        { suggestion: 'Resolve the finding reported against that dataset and run again.' },
      )
      continue
    }
    if (dataset.rows.length === 0) {
      sampler.emit(
        'rule-examined-no-rows',
        msg`rule ${rule.id}: dataset ${dataset.name} holds no rows, so the rule established
            nothing. An empty export is not a rule that passed.`,
        at(dataset.file),
        { suggestion: 'Confirm the export ran, then run this check again.' },
      )
      continue
    }
    try {
      const evaluator = EVALUATOR_BY_KIND.get(rule.kind)
      if (evaluator === undefined) throw new Error(`unsupported rule kind "${sanitize(rule.kind)}"`)
      if (evaluator(rule, dataset, sampler, limits, showValues, datasets, files)) checked += 1
    } catch (error) {
      sampler.emit(
        'rule-execution-failed',
        msg`rule ${rule.id}: evaluation stopped with an error
            (${sanitize(error?.message ?? 'unknown error')}), so no verdict was reached.`,
        at(dataset.file),
        { suggestion: 'Report the rule and the shape of the row it stopped on.' },
      )
    }
  }

  return { findings: sampler.finish(), checked }
}
