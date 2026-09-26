/**
 * Reading one exported dataset document, with every bound enforced before the
 * work it bounds.
 *
 * A problem here is EVIDENCE, not configuration: the run had a subject and
 * failed to obtain facts about it. So nothing in this file throws. Each failure
 * becomes a finding whose rule id is in `EVIDENCE_MISSING_RULES`, which makes
 * the whole report `incomplete` and the process exit 2. A dataset that was not
 * read is never a dataset whose rules passed.
 *
 * The size bound is taken from `stat` BEFORE the file is opened, because a
 * bound checked after the read has already spent the memory it was there to
 * protect. A tool in this catalog died of heap exhaustion at a size its own
 * documentation called legal.
 *
 * Per-dataset bytes are not the whole of the work. Every dataset a ruleset
 * declares is held in memory at once -- a referential rule needs two of them
 * simultaneously and a rule may name any of them -- so the cost of a run is the
 * SUM, and a per-file bound leaves that sum to be worked out by multiplying two
 * numbers from different rows of the limits table. `limits.maxTotalDatasetBytes`
 * makes it a declared bound instead, taken from the same `stat` and spent
 * before the file is opened.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { DATASET_SCHEMA_VERSION } from './ruleset.mjs'
import { MAX_ID_LENGTH, at, makeFinding, msg, parseFailureDetail, sanitize } from './rules.mjs'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Confinement, done against the real filesystem.
 *
 * Refusing `..` and an absolute path is lexical and is not confinement: a
 * symbolic link planted inside the declared root passes every string test and
 * leads straight out of the tree, and a shipped tool in this catalog echoed
 * out-of-root content into its report that way. The real path is resolved and
 * compared against the real root, so a link is followed only when it lands back
 * inside.
 */
function insideRoot(realRoot, realPath) {
  return realPath === realRoot || realPath.startsWith(realRoot + sep)
}

/**
 * Read and shape-check one dataset.
 *
 * Returns `{ ok: true, rows, columns }`, or `{ ok: false, findings }` with at
 * least one finding naming exactly what was not established.
 */
export async function readDataset(realRoot, entry, limits, budget) {
  const file = entry.file
  const refuse = (ruleId, message, extra) => ({
    ok: false,
    findings: [makeFinding(ruleId, message, at(file), extra)],
  })

  let realPath
  try {
    realPath = await realpath(resolve(realRoot, file))
  } catch (error) {
    return refuse(
      'dataset-unreadable',
      msg`dataset ${entry.name} could not be resolved under --data (${error?.code ?? 'unknown error'}).`,
      { suggestion: 'Check the path in "datasets" against what the export actually produced.' },
    )
  }

  if (!insideRoot(realRoot, realPath)) {
    return refuse(
      'dataset-outside-root',
      msg`dataset ${entry.name} resolves outside --data, so it was not read. A link or a ".."
          segment on the way there does not widen the root.`,
      { suggestion: 'Move the export inside the declared root, or point --data at the tree that holds it.' },
    )
  }

  let stats
  try {
    stats = await stat(realPath)
  } catch (error) {
    // NOT COVERED BY A TEST, and named rather than claimed. `realpath` has just
    // succeeded on this path, so reaching here means the file went away or
    // became unreadable between the two calls -- a race this suite cannot
    // construct without an injectable filesystem, which would be a surface
    // change made for a test rather than for a caller. A mutation sweep reports
    // removing this arm as SURVIVING and that is a missing test, not an
    // equivalent mutant: without it `stats` is undefined and the next line
    // throws, which is a crash rather than a finding.
    return refuse(
      'dataset-unreadable',
      msg`dataset ${entry.name} could not be inspected (${error?.code ?? 'unknown error'}).`,
    )
  }
  if (!stats.isFile()) {
    return refuse('dataset-unreadable', msg`dataset ${entry.name} is not a regular file.`)
  }
  if (stats.size > limits.maxDatasetBytes) {
    return refuse(
      'dataset-too-large',
      msg`dataset ${entry.name} is ${String(stats.size)} bytes, above limits.maxDatasetBytes
          (${String(limits.maxDatasetBytes)}). It was not opened.`,
      { suggestion: 'Split the export, or raise limits.maxDatasetBytes up to its ceiling.' },
    )
  }
  // Spent before the open, in the order the ruleset declares its datasets, so
  // which datasets are read is a property of the document rather than of the
  // filesystem. A dataset that does not fit is reported and not opened; it is
  // never truncated and never counted as a dataset whose rules passed.
  if (stats.size > budget.remaining) {
    return refuse(
      'datasets-too-large-together',
      msg`dataset ${entry.name} is ${String(stats.size)} bytes and only
          ${String(budget.remaining)} of the limits.maxTotalDatasetBytes budget
          (${String(budget.total)}) is left, so it was not opened. Every declared dataset is held
          in memory at once, so the bound is on their total.`,
      { suggestion: 'Split the run across rulesets, or raise limits.maxTotalDatasetBytes up to its ceiling.' },
    )
  }
  budget.remaining -= stats.size

  let bytes
  try {
    bytes = await readFile(realPath)
  } catch (error) {
    return refuse(
      'dataset-unreadable',
      msg`dataset ${entry.name} could not be read (${error?.code ?? 'unknown error'}).`,
    )
  }

  let text
  try {
    // Strict decoding. Validity is never inferred from decoded content: a
    // document may legitimately contain U+FFFD, and a tool in this catalog
    // disabled its own encoding guard file-wide because of exactly that.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return refuse('dataset-not-utf8', msg`dataset ${entry.name} is not valid UTF-8, so it was not decoded.`)
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return refuse(
      'dataset-unparsable',
      msg`dataset ${entry.name} could not be parsed: ${parseFailureDetail(error)}.`,
    )
  }

  if (!isPlainObject(document)) {
    return refuse('dataset-invalid', msg`dataset ${entry.name} is not a JSON object.`)
  }
  if (document.schemaVersion !== DATASET_SCHEMA_VERSION) {
    return refuse(
      'dataset-schema-unsupported',
      msg`dataset ${entry.name} declares schemaVersion
          ${sanitize(document.schemaVersion, MAX_ID_LENGTH)}; this tool reads
          ${DATASET_SCHEMA_VERSION}.`,
    )
  }
  if (document.dataset !== entry.name) {
    return refuse(
      'dataset-invalid',
      msg`the document at this path names dataset
          ${sanitize(document.dataset, MAX_ID_LENGTH)}, but the ruleset expects ${entry.name}.
          The wrong export may have been placed here, so it was not used.`,
      { suggestion: 'Align "datasets[].file" with the export it is meant to describe.' },
    )
  }
  if (!Array.isArray(document.rows)) {
    return refuse('dataset-invalid', msg`dataset ${entry.name} has no "rows" array.`)
  }
  if (document.rows.length > limits.maxRows) {
    return refuse(
      'dataset-too-many-rows',
      msg`dataset ${entry.name} holds ${String(document.rows.length)} rows, above limits.maxRows
          (${String(limits.maxRows)}). No rule was executed against it.`,
      { suggestion: 'Split the export, or raise limits.maxRows up to its ceiling.' },
    )
  }

  const columns = new Set()
  for (const [index, row] of document.rows.entries()) {
    if (!isPlainObject(row)) {
      return refuse(
        'dataset-invalid',
        msg`dataset ${entry.name} has a row that is not a JSON object.`,
        { suggestion: 'Every entry of "rows" must be an object of column name to scalar value.' },
      )
    }
    for (const key of Object.keys(row)) columns.add(key)
    if (columns.size > limits.maxColumns) {
      return refuse(
        'dataset-too-many-columns',
        msg`dataset ${entry.name} has more than ${String(limits.maxColumns)} distinct columns by
            row ${String(index)}, above limits.maxColumns. No rule was executed against it.`,
        { suggestion: 'Project the export down to the columns the rules name, or raise limits.maxColumns.' },
      )
    }
  }

  return { ok: true, rows: document.rows, columns }
}

/** Resolve the declared data root once, so every dataset is compared against the same real path. */
export async function resolveRoot(root) {
  return realpath(resolve(root))
}
