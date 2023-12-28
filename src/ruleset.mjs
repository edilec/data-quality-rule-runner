/**
 * The ruleset document: configuration, and therefore never a finding.
 *
 * A problem here means the run never had a subject. Per the report contract
 * that is a configuration error: stdout stays EMPTY, the message goes to
 * stderr, and the process exits 2. Nothing in this file produces a report.
 *
 * Unknown keys are refused everywhere. A one-character typo in a limit name
 * must not silently restore the default and turn a real failure into a green
 * run -- that has happened in this catalog and it is why every object below is
 * closed rather than open.
 */

import { MAX_ID_LENGTH, isRenderableString, sanitize } from './rules.mjs'
import { COMPARISON_NAMES, DECLARED_TYPES, comparisonFor } from './cells.mjs'

export class RulesetError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RulesetError'
  }
}

export const RULESET_SCHEMA_VERSION = '1'
export const DATASET_SCHEMA_VERSION = '1'

/**
 * Bounds that are not configurable, because they bound the ruleset document
 * itself. A limit a document could raise would be no limit at all.
 */
export const MAX_RULESET_BYTES = 1048576
export const MAX_RULES = 256
export const MAX_DATASETS = 32
export const MAX_KEY_COLUMNS = 8

/** Bounds a ruleset may lower. It may never raise one past its ceiling. */
export const LIMIT_CEILINGS = Object.freeze({
  maxDatasetBytes: 16777216,
  maxRows: 200000,
  maxColumns: 512,
  maxFieldLength: 8192,
  maxSamplesPerRule: 50,
})

export const DEFAULT_LIMITS = Object.freeze({
  maxDatasetBytes: 4194304,
  maxRows: 50000,
  maxColumns: 128,
  maxFieldLength: 4096,
  maxSamplesPerRule: 5,
})

export const LIMIT_NAMES = Object.freeze(Object.keys(LIMIT_CEILINGS).sort())

export const RULE_KINDS = Object.freeze([
  'completeness',
  'crossField',
  'range',
  'referential',
  'uniqueness',
])

const RULE_KEYS = Object.freeze({
  completeness: ['id', 'kind', 'dataset', 'column'],
  crossField: ['id', 'kind', 'dataset', 'left', 'right', 'comparison', 'type'],
  range: ['id', 'kind', 'dataset', 'column', 'min', 'max'],
  referential: ['id', 'kind', 'dataset', 'columns', 'references'],
  uniqueness: ['id', 'kind', 'dataset', 'columns'],
})

const REQUIRED_KEYS = Object.freeze({
  completeness: ['id', 'kind', 'dataset', 'column'],
  crossField: ['id', 'kind', 'dataset', 'left', 'right', 'comparison', 'type'],
  range: ['id', 'kind', 'dataset', 'column'],
  referential: ['id', 'kind', 'dataset', 'columns', 'references'],
  uniqueness: ['id', 'kind', 'dataset', 'columns'],
})

/** U+0000, written as escape text so no raw byte can land in this source. */
const NUL = '\u0000'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuseUnknownKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RulesetError(`${where} has an unknown key "${sanitize(key, MAX_ID_LENGTH)}".`)
    }
  }
}

function requireName(value, where) {
  if (!isRenderableString(value, MAX_ID_LENGTH)) {
    throw new RulesetError(
      `${where} must be a non-empty string of at most ${MAX_ID_LENGTH} characters that still `
      + 'renders as something once control and format characters are removed.',
    )
  }
  return value
}

/**
 * A dataset file path, checked lexically here and again against the real
 * filesystem later.
 *
 * This check is NOT confinement. Refusing `..` and an absolute path is a
 * lexical test, and a symbolic link planted inside the root passes it while
 * leading straight out of the tree. The real check resolves the path and
 * compares real paths; this one exists so an obviously wrong path is refused as
 * configuration rather than reported as evidence.
 */
function requireRelativePath(value, where) {
  requireName(value, where)
  if (value.includes(NUL)) throw new RulesetError(`${where} contains a NUL character.`)
  if (value.startsWith('/')) throw new RulesetError(`${where} must be relative to --data.`)
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new RulesetError(`${where} must not contain an empty, "." or ".." segment.`)
    }
  }
  return value
}

function requireColumns(value, where) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RulesetError(`${where} must be a non-empty array of column names.`)
  }
  if (value.length > MAX_KEY_COLUMNS) {
    throw new RulesetError(
      `${where} names ${value.length} columns; at most ${MAX_KEY_COLUMNS} are supported.`,
    )
  }
  const seen = new Set()
  for (const [index, column] of value.entries()) {
    requireName(column, `${where}[${index}]`)
    if (seen.has(column)) {
      throw new RulesetError(`${where} names "${sanitize(column, MAX_ID_LENGTH)}" twice.`)
    }
    seen.add(column)
  }
  return [...value]
}

function validateLimits(raw) {
  if (raw === undefined) return { ...DEFAULT_LIMITS }
  if (!isPlainObject(raw)) throw new RulesetError('"limits" must be an object.')
  refuseUnknownKeys(raw, LIMIT_NAMES, '"limits"')
  const limits = { ...DEFAULT_LIMITS }
  for (const name of LIMIT_NAMES) {
    if (!Object.hasOwn(raw, name)) continue
    const value = raw[name]
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RulesetError(`"limits.${name}" must be an integer of at least 1.`)
    }
    if (value > LIMIT_CEILINGS[name]) {
      throw new RulesetError(
        `"limits.${name}" is ${value}, above the ceiling of ${LIMIT_CEILINGS[name]}. `
        + 'A ruleset may lower a bound and may never raise one.',
      )
    }
    limits[name] = value
  }
  return limits
}

function validateDatasets(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RulesetError('"datasets" must be a non-empty array.')
  }
  if (raw.length > MAX_DATASETS) {
    throw new RulesetError(
      `"datasets" holds ${raw.length} entries; at most ${MAX_DATASETS} are supported.`,
    )
  }
  const datasets = []
  const names = new Set()
  for (const [index, entry] of raw.entries()) {
    const where = `"datasets[${index}]"`
    if (!isPlainObject(entry)) throw new RulesetError(`${where} must be an object.`)
    refuseUnknownKeys(entry, ['name', 'file'], where)
    const name = requireName(entry.name, `${where}.name`)
    const file = requireRelativePath(entry.file, `${where}.file`)
    if (names.has(name)) {
      throw new RulesetError(`${where}.name "${sanitize(name, MAX_ID_LENGTH)}" is declared twice.`)
    }
    names.add(name)
    datasets.push({ name, file })
  }
  return datasets
}

function validateRule(entry, index, datasetNames) {
  const where = `"rules[${index}]"`
  if (!isPlainObject(entry)) throw new RulesetError(`${where} must be an object.`)
  const kind = entry.kind
  if (!RULE_KINDS.includes(kind)) {
    throw new RulesetError(
      `${where}.kind is "${sanitize(kind, MAX_ID_LENGTH)}"; `
      + `supported kinds are ${RULE_KINDS.join(', ')}.`,
    )
  }
  refuseUnknownKeys(entry, RULE_KEYS[kind], `${where} (kind "${kind}")`)
  for (const key of REQUIRED_KEYS[kind]) {
    if (!Object.hasOwn(entry, key)) {
      throw new RulesetError(`${where} (kind "${kind}") is missing "${key}".`)
    }
  }
  const id = requireName(entry.id, `${where}.id`)
  const dataset = requireName(entry.dataset, `${where}.dataset`)
  if (!datasetNames.has(dataset)) {
    throw new RulesetError(
      `${where}.dataset "${sanitize(dataset, MAX_ID_LENGTH)}" is not declared in "datasets".`,
    )
  }
  const rule = { id, kind, dataset }

  if (kind === 'completeness') {
    rule.column = requireName(entry.column, `${where}.column`)
  } else if (kind === 'uniqueness') {
    rule.columns = requireColumns(entry.columns, `${where}.columns`)
  } else if (kind === 'range') {
    rule.column = requireName(entry.column, `${where}.column`)
    for (const bound of ['min', 'max']) {
      if (!Object.hasOwn(entry, bound)) continue
      if (typeof entry[bound] !== 'number' || !Number.isFinite(entry[bound])) {
        throw new RulesetError(`${where}.${bound} must be a finite number.`)
      }
      rule[bound] = entry[bound]
    }
    if (rule.min === undefined && rule.max === undefined) {
      throw new RulesetError(`${where} (kind "range") must declare "min", "max" or both.`)
    }
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) {
      throw new RulesetError(`${where} has min above max, so no value could satisfy it.`)
    }
  } else if (kind === 'referential') {
    rule.columns = requireColumns(entry.columns, `${where}.columns`)
    const references = entry.references
    if (!isPlainObject(references)) throw new RulesetError(`${where}.references must be an object.`)
    refuseUnknownKeys(references, ['dataset', 'columns'], `${where}.references`)
    const target = requireName(references.dataset, `${where}.references.dataset`)
    if (!datasetNames.has(target)) {
      throw new RulesetError(
        `${where}.references.dataset "${sanitize(target, MAX_ID_LENGTH)}" `
        + 'is not declared in "datasets".',
      )
    }
    const targetColumns = requireColumns(references.columns, `${where}.references.columns`)
    if (targetColumns.length !== rule.columns.length) {
      throw new RulesetError(
        `${where} compares ${rule.columns.length} column(s) against ${targetColumns.length}; `
        + 'a relation needs the same number on both sides.',
      )
    }
    rule.references = { dataset: target, columns: targetColumns }
  } else {
    rule.left = requireName(entry.left, `${where}.left`)
    rule.right = requireName(entry.right, `${where}.right`)
    // `Object.hasOwn` was the wrong test twice over: it coerces its key through
    // ToPropertyKey, so `{"toString": {}}` here threw a raw TypeError out of a
    // function whose contract is to throw RulesetError, before the sanitiser on
    // the next line could describe the value at all.
    if (comparisonFor(entry.comparison) === undefined) {
      throw new RulesetError(
        `${where}.comparison is "${sanitize(entry.comparison, MAX_ID_LENGTH)}"; `
        + `supported comparisons are ${COMPARISON_NAMES.join(', ')}.`,
      )
    }
    if (!DECLARED_TYPES.includes(entry.type)) {
      throw new RulesetError(
        `${where}.type is "${sanitize(entry.type, MAX_ID_LENGTH)}"; `
        + `supported types are ${DECLARED_TYPES.join(', ')}.`,
      )
    }
    rule.comparison = entry.comparison
    rule.type = entry.type
  }
  return rule
}

function validateRules(raw, datasetNames) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RulesetError('"rules" must be a non-empty array.')
  }
  if (raw.length > MAX_RULES) {
    throw new RulesetError(`"rules" holds ${raw.length} entries; at most ${MAX_RULES} are supported.`)
  }
  const rules = []
  const ids = new Set()
  for (const [index, entry] of raw.entries()) {
    const rule = validateRule(entry, index, datasetNames)
    if (ids.has(rule.id)) {
      throw new RulesetError(
        `"rules[${index}]".id "${sanitize(rule.id, MAX_ID_LENGTH)}" is declared twice. `
        + 'A rule id identifies a finding across releases, so it has to be unique.',
      )
    }
    ids.add(rule.id)
    rules.push(rule)
  }
  return rules
}

export function validateRuleset(document) {
  if (!isPlainObject(document)) throw new RulesetError('The ruleset document must be a JSON object.')
  refuseUnknownKeys(
    document,
    ['schemaVersion', 'limits', 'datasets', 'rules'],
    'The ruleset document',
  )
  if (document.schemaVersion !== RULESET_SCHEMA_VERSION) {
    throw new RulesetError(
      `"schemaVersion" must be "${RULESET_SCHEMA_VERSION}"; this document says `
      + `"${sanitize(document.schemaVersion, MAX_ID_LENGTH)}".`,
    )
  }
  const limits = validateLimits(document.limits)
  const datasets = validateDatasets(document.datasets)
  const datasetNames = new Set(datasets.map((entry) => entry.name))
  const rules = validateRules(document.rules, datasetNames)
  return { limits, datasets, rules }
}
