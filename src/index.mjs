/**
 * data-quality-rule-runner
 *
 * Execute declarative completeness, uniqueness, range, referential and
 * cross-field rules over datasets somebody exported to local files, and report
 * where each failure is.
 *
 * Three rules govern the design, and they matter more than the rule kinds:
 *
 * 1. THE DATA IS AN INPUT. This tool opens no connection, resolves no host and
 *    reaches no data store. A row is an object in a JSON document; a verdict is
 *    a comparison over the cells of that object. Nothing here observes a live
 *    system, so no finding may be phrased as though it had.
 * 2. A BROKEN RULE IS AN EXECUTION ERROR, NEVER A DATA PASS. A column the
 *    export does not have, a cell that cannot be compared, a referenced dataset
 *    that was not read, an empty export, a rule that threw -- each one is
 *    reported as evidence the run did not obtain, makes the report
 *    `incomplete`, and exits 2. None of them satisfies a rule.
 * 3. AN INDEX BUILT FROM PARTIAL EVIDENCE MAKES THE COMPARISON INCOMPLETE, NOT
 *    CLEAN. A referential rule whose key index dropped rows reports a non-match
 *    as undetermined, never as a violation, because "matches nothing" would be
 *    a positive claim about rows the index never held.
 *
 * The ruleset is configuration: a problem with it means the run never had a
 * subject, so stdout stays empty and the message goes to stderr. A dataset is
 * evidence: a problem with it is a finding inside an `incomplete` report,
 * because a consumer needs to know which export was not read.
 */

import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { evaluateRules } from './evaluate.mjs'
import { readDataset, resolveRoot } from './dataset.mjs'
import {
  MAX_RULESET_BYTES,
  RulesetError,
  validateRuleset,
} from './ruleset.mjs'
import {
  RULE_IDS,
  at,
  makeFinding,
  marksEvidenceMissing,
  msg,
  parseFailureDetail,
  sortFindings,
  statusFor,
} from './rules.mjs'

export { CELL_REASONS, COMPARISONS, COMPARISON_NAMES, DECLARED_TYPES, PRESENT_BUT_UNREADABLE, cellText, compareValue, encodeKey, parseInstant, readCell } from './cells.mjs'
export { Sampler, evaluateRules } from './evaluate.mjs'
export { readDataset, resolveRoot } from './dataset.mjs'
export {
  DATASET_SCHEMA_VERSION,
  DEFAULT_LIMITS,
  LIMIT_CEILINGS,
  LIMIT_NAMES,
  MAX_DATASETS,
  MAX_KEY_COLUMNS,
  MAX_RULES,
  MAX_RULESET_BYTES,
  RULESET_SCHEMA_VERSION,
  RULE_KINDS,
  RulesetError,
  validateRuleset,
} from './ruleset.mjs'
export {
  EVIDENCE_MISSING_RULES,
  EVIDENCE_LIMIT,
  FORBIDDEN_CLAIMS,
  LINE_SEPARATORS,
  MAX_ID_LENGTH,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  SafeMessage,
  assertNoForbiddenClaim,
  byCodeUnit,
  compareFindings,
  describeValue,
  findForbiddenClaim,
  isRenderableString,
  makeFinding,
  marksEvidenceMissing,
  msg,
  num,
  parseFailureDetail,
  pointerToken,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
} from './rules.mjs'

export const TOOL_ID = 'data-quality-rule-runner'
export const REPORT_SCHEMA_VERSION = '1'

/** The rule catalog a consumer can read without running anything. */
export const CATALOG = Object.freeze({
  tool: TOOL_ID,
  ruleIds: RULE_IDS,
  evidenceMissing: Object.freeze(RULE_IDS.filter((id) => marksEvidenceMissing(id))),
})

async function readRuleset(path) {
  const target = resolve(path)
  let stats
  try {
    stats = await stat(target)
  } catch (error) {
    throw new RulesetError(`--rules could not be inspected: ${error?.code ?? 'unknown error'}.`)
  }
  if (!stats.isFile()) throw new RulesetError('--rules must name a regular file.')
  // Bounded before the read, not after it. A limit checked once the bytes are
  // already resident has spent the memory it exists to protect.
  if (stats.size > MAX_RULESET_BYTES) {
    throw new RulesetError(
      `--rules is ${stats.size} bytes, above the ${MAX_RULESET_BYTES} byte limit, so it was not opened.`,
    )
  }

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(target))
  } catch (error) {
    if (error instanceof TypeError) throw new RulesetError('--rules is not valid UTF-8.')
    throw new RulesetError(`--rules could not be read: ${error?.code ?? 'unknown error'}.`)
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new RulesetError(`--rules could not be parsed: ${parseFailureDetail(error)}.`)
  }
  return validateRuleset(document)
}

/**
 * Run every rule in a ruleset over the datasets a data root holds.
 *
 * Throws `RulesetError` for a configuration problem -- the caller turns that
 * into an empty stdout and exit 2. Everything else comes back as a report.
 */
export async function runRuleset({ rules: rulesPath, data: dataPath, showValues = false }) {
  const ruleset = await readRuleset(rulesPath)

  let realRoot
  try {
    realRoot = await resolveRoot(dataPath)
  } catch (error) {
    throw new RulesetError(`--data could not be resolved: ${error?.code ?? 'unknown error'}.`)
  }
  const rootStats = await stat(realRoot)
  if (!rootStats.isDirectory()) throw new RulesetError('--data must name a directory.')

  const findings = []
  const datasets = new Map()
  const files = new Map(ruleset.datasets.map((entry) => [entry.name, entry.file]))
  let rows = 0

  for (const entry of ruleset.datasets) {
    const result = await readDataset(realRoot, entry, ruleset.limits)
    if (!result.ok) {
      findings.push(...result.findings)
      continue
    }
    datasets.set(entry.name, {
      name: entry.name,
      file: entry.file,
      rows: result.rows,
      columns: result.columns,
    })
    rows += result.rows.length
  }

  const evaluated = evaluateRules({
    rules: ruleset.rules,
    datasets,
    files,
    limits: ruleset.limits,
    showValues,
  })
  findings.push(...evaluated.findings)

  // A pass over nothing is the vacuous green this catalog keeps finding. If no
  // rule reached a verdict the run says so, in the report, at error severity.
  if (evaluated.checked === 0) {
    findings.push(makeFinding(
      'no-rules-executed',
      msg`none of the ${String(ruleset.rules.length)} declared rule(s) reached a verdict, so this
          run establishes nothing about the data.`,
      at(null, '/rules'),
      { suggestion: 'Resolve the findings above, then run the check again.' },
    ))
  }

  const sorted = sortFindings(findings)
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: statusFor(sorted),
    summary: {
      checked: evaluated.checked,
      errors: sorted.filter((finding) => finding.severity === 'error').length,
      warnings: sorted.filter((finding) => finding.severity === 'warning').length,
      rules: ruleset.rules.length,
      datasetsDeclared: ruleset.datasets.length,
      datasetsRead: datasets.size,
      rowsExamined: rows,
    },
    findings: sorted,
  }
}

export function renderReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}

export function formatSummary(report) {
  const { summary } = report
  const lines = [
    `${TOOL_ID}: ${report.status}`,
    `  rules declared ${summary.rules}, rules executed ${summary.checked}`,
    `  datasets read ${summary.datasetsRead} of ${summary.datasetsDeclared}, rows examined ${summary.rowsExamined}`,
    `  findings ${report.findings.length} (errors ${summary.errors}, warnings ${summary.warnings})`,
  ]
  for (const finding of report.findings) {
    const where = [finding.location.file, finding.location.pointer].filter(Boolean).join(' ')
    lines.push(`  ${finding.severity} ${finding.ruleId} ${where}`)
    lines.push(`    ${finding.message}`)
  }
  if (report.status === 'incomplete') {
    lines.push('  incomplete: at least one rule did not reach a verdict. This is not a pass.')
  }
  return `${lines.join('\n')}\n`
}
