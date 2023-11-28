#!/usr/bin/env node

import { exitCodeFor, formatSummary, renderReport, runRuleset } from '../src/index.mjs'

const HELP = `data-quality-rule-runner

Execute declarative completeness, uniqueness, range, referential and cross-field
rules over datasets somebody exported to local JSON files, and say exactly where
each failure is.

This tool reaches nothing. It opens a ruleset document and the dataset documents
that ruleset names, and it evaluates rules over the rows it finds there. It
resolves no host, opens no connection and reads no clock. It writes no file: the
report goes to stdout, so redirect it if you want to keep it.

A broken rule is an execution error, never a data pass. A column the export does
not have, a cell that cannot be compared, a referenced dataset that was not
read, an export with no rows, and a rule that stopped with an error are each
reported as evidence this run did not obtain. The report says "incomplete" and
the exit code is 2. None of them is ever counted as data that passed.

A referential rule whose key index dropped rows reports a non-match as
undetermined rather than as a violation. Evidence dropped while building an
index makes the comparison incomplete; it does not make it clean.

Rule kinds:
  completeness   a column is populated on every row
  uniqueness     a composite key appears at most once
  range          a numeric column stays within declared min and max bounds
  referential    a key exists in another dataset
  crossField     two columns of one row satisfy a declared comparison

Usage:
  data-quality-rule-runner --rules FILE --data DIR [--show-values] [--json]

Options:
  --rules FILE    Ruleset document: datasets, rules and limits (required)
  --data DIR      Directory holding the exported dataset documents (required).
                  Every "datasets[].file" is relative to it, and a path that
                  resolves outside it -- including through a symbolic link --
                  is refused rather than read.
  --show-values   Print cell values in findings. Off by default: a quality
                  report travels further than the data it describes, so values
                  appear as their type and length until you ask for them.
  --json          Suppress the human summary on stderr
  -h, --help      Show this help

Streams:
  stdout  the JSON report and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every rule reached a verdict and every verdict was satisfied
  1  the check completed and at least one rule was violated
  2  invalid configuration, or evidence the check could not obtain.
     On a configuration error -- including any problem with the ruleset
     document -- stdout stays EMPTY and the message goes to stderr. On
     unreadable or incomplete evidence stdout carries an "incomplete" report
     naming exactly what was not established.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { rules: null, data: null, showValues: false, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--show-values') options.showValues = true
    else if (argument === '--rules') options.rules = takeValue('--rules')
    else if (argument === '--data') options.data = takeValue('--data')
    else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.rules === null) throw new Error('--rules is required')
  if (options.data === null) throw new Error('--data is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await runRuleset({
      rules: options.rules,
      data: options.data,
      showValues: options.showValues,
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
