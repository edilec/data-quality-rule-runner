/**
 * Reading one cell out of one row, and deciding whether it can be compared.
 *
 * Everything a rule needs to know about a value is decided here, once, so that
 * the five rule kinds cannot disagree about what "present", "numeric" or
 * "usable as a key" mean. The distinction the whole tool rests on is made here
 * too: a cell is either USABLE, or it is UNEVALUABLE with a reason. There is no
 * third answer in which a value this tool could not read is treated as having
 * satisfied something.
 */

import { isRenderableString, sanitize } from './rules.mjs'

/** How a cell is described in a report when values are masked. */
const MASKS = Object.freeze({
  string: (value) => `<string:${value.length}>`,
  number: () => '<number>',
  boolean: () => '<boolean>',
})

/**
 * Why a cell could not be evaluated.
 *
 * The code is what other modules branch on and the text is what a reader sees.
 * They are kept apart deliberately: a branch that matched on the prose would
 * change behaviour the next time somebody reworded a message.
 */
export const CELL_REASONS = Object.freeze({
  absent: 'the column is not present on this row',
  null: 'the value is null',
  blank: 'the value renders as nothing once control and format characters are removed',
  nonScalar: 'the value is not a scalar (a string, a finite number or a boolean)',
  tooLong: 'the value is longer than limits.maxFieldLength',
})

/**
 * Codes for which a value IS present and this run could not read it, as
 * opposed to codes that mean nothing is there. A completeness rule needs the
 * difference: an object in the column means the column is populated with
 * something unreadable, which is missing evidence, while an absent or null
 * column is the very thing the rule exists to find.
 */
export const PRESENT_BUT_UNREADABLE = Object.freeze(['nonScalar', 'tooLong'])

function unusable(code) {
  return { usable: false, code, reason: CELL_REASONS[code] }
}

/**
 * Read a cell.
 *
 * `Object.hasOwn` rather than `row[column] !== undefined`, because a JSON
 * document can carry an explicit `null` and an absent column, and the two are
 * different evidence: one says "there is no value here", the other says "this
 * export does not have that field". Both are unevaluable, and the report says
 * which.
 *
 * The blank check asks about the RENDERED form. `value.trim().length > 0` is
 * the wrong question -- a string of U+0001 or U+200E passes it and then reaches
 * the report as nothing at all -- and a completeness rule that accepted such a
 * value would be reporting a column as populated while handing a consumer an
 * empty string.
 */
export function readCell(row, column, maxFieldLength) {
  if (!Object.hasOwn(row, column)) return unusable('absent')
  const value = row[column]
  if (value === null) return unusable('null')
  if (typeof value === 'string') {
    if (value.length > maxFieldLength) return unusable('tooLong')
    if (!isRenderableString(value, maxFieldLength)) return unusable('blank')
    return { usable: true, type: 'string', value }
  }
  if (typeof value === 'number') {
    // `JSON.parse` never produces NaN or an Infinity from valid JSON, so this
    // arm is reached only through the library entry points, where a consumer
    // supplies rows directly. It is kept because "unreachable from the CLI" is
    // not the same as "unreachable".
    if (!Number.isFinite(value)) return unusable('nonScalar')
    return { usable: true, type: 'number', value }
  }
  if (typeof value === 'boolean') return { usable: true, type: 'boolean', value }
  return unusable('nonScalar')
}

/**
 * How a usable cell appears in a report.
 *
 * Masked by default. A data quality report is routinely pasted into a ticket, a
 * chat channel or a build log, all of which travel further than the dataset it
 * describes, so a value only appears when the caller asks for it with
 * `--show-values`. The mask still carries the shape -- type, and length for a
 * string -- which is what makes a type mismatch across a relation readable
 * without printing either side.
 */
export function cellText(cell, showValues) {
  if (!cell.usable) return '<unevaluable>'
  if (showValues) return cell.type === 'string' ? sanitize(cell.value) : String(cell.value)
  return MASKS[cell.type](cell.value)
}

/**
 * Encode a tuple of usable cells as one key string.
 *
 * The type tag is not decoration. Without it `"7"` and `7` encode identically,
 * so a string foreign key would silently match a numeric primary key and this
 * tool would report a relation as satisfied on the strength of a coercion it
 * invented. `JSON.stringify` over the tagged tuple is injective for scalars,
 * which is what a composite key needs: `["a","b"]` and `["a|b"]` must not
 * collide, and a separator character would let them.
 */
export function encodeKey(cells) {
  return JSON.stringify(cells.map((cell) => [cell.type, cell.value]))
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/**
 * Parse an instant strictly, as UTC.
 *
 * `Date.parse` is not used anywhere in this tool. It accepts implementation
 * defined formats, treats a bare `YYYY-MM-DD` as UTC but `YYYY-MM-DDTHH:MM:SS`
 * as local time, and silently rolls `2026-02-30` forward into March. A rule
 * that compared two dates would then depend on the host's zone. Only the two
 * shapes below are accepted and every component is range checked, so an invalid
 * date is unevaluable rather than quietly moved.
 */
export function parseInstant(text) {
  if (typeof text !== 'string') return { ok: false }
  const match = DATE_TIME.exec(text) ?? DATE_ONLY.exec(text)
  if (match === null) return { ok: false }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const [hour, minute, second] = [Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)]
  const milli = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'))
  if (month < 1 || month > 12) return { ok: false }
  if (day < 1 || day > daysInMonth(year, month)) return { ok: false }
  // 24:00:00 and a leap second are both refused: neither is a point this tool
  // can order against another without inventing what the exporter meant.
  if (hour > 23 || minute > 59 || second > 59) return { ok: false }
  return { ok: true, ms: Date.UTC(year, month - 1, day, hour, minute, second, milli) }
}

/**
 * Coerce a usable cell into the type a rule declared, or say it cannot be.
 *
 * Nothing is converted across types. A string in a column a rule declared
 * numeric is NOT parsed as a number: a rule that did that would turn `"12abc"`
 * into a verdict and `"0x10"` into a different verdict depending on which
 * parser it reached for. The comparison this tool cannot make is reported as
 * one it did not make.
 */
export function compareValue(cell, declaredType) {
  if (declaredType === 'number') {
    return cell.type === 'number' ? { ok: true, value: cell.value } : { ok: false }
  }
  if (declaredType === 'string') {
    return cell.type === 'string' ? { ok: true, value: cell.value } : { ok: false }
  }
  if (declaredType === 'date') {
    if (cell.type !== 'string') return { ok: false }
    const instant = parseInstant(cell.value)
    return instant.ok ? { ok: true, value: instant.ms } : { ok: false }
  }
  throw new Error(`Unknown declared type "${declaredType}"`)
}

export const COMPARISONS = Object.freeze({
  lt: (left, right) => left < right,
  lte: (left, right) => left <= right,
  gt: (left, right) => left > right,
  gte: (left, right) => left >= right,
  eq: (left, right) => left === right,
  neq: (left, right) => left !== right,
})

export const COMPARISON_NAMES = Object.freeze(Object.keys(COMPARISONS).sort())
export const DECLARED_TYPES = Object.freeze(['date', 'number', 'string'])
