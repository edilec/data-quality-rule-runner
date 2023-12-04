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

import { COMPARISONS, PRESENT_BUT_UNREADABLE, cellText, compareValue, encodeKey, readCell } from './cells.mjs'
import { at, makeFinding, msg, pointerToken, sanitize } from './rules.mjs'

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
  const compare = COMPARISONS[rule.comparison]
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

function referential(rule, dataset, sampler, limits, showValues, datasets) {
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
    index.add(encodeKey(cells))
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
    if (index.has(encodeKey(cells))) continue
    if (!indexComplete) {
      sampler.sample(
        context,
        'reference-undetermined',
        msg`rule ${rule.id}: (${keyText(rule.columns, cells, showValues)}) matches no key in the
            partial index of ${parent.name}. Whether it matches a key that index is missing was
            not established.`,
        at(dataset.file, rowPointer(childIndex)),
        { suggestion: 'Complete the referenced export, then run again for a verdict.' },
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
 * Run every rule, and count only the ones that reached a verdict.
 *
 * `checked` is the number of rules that examined at least one row without being
 * abandoned. A rule over an empty export examined nothing: reporting it as
 * satisfied would be the vacuous pass this catalog keeps finding, so it is
 * reported as `rule-examined-no-rows` and the run is incomplete.
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
      const evaluator = EVALUATORS[rule.kind]
      if (evaluator === undefined) throw new Error(`unsupported rule kind "${sanitize(rule.kind)}"`)
      if (evaluator(rule, dataset, sampler, limits, showValues, datasets)) checked += 1
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
