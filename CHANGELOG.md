# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface. Renaming or removing one is a
breaking change and is recorded here.

## [0.1.0] - 2026-09-19

### Added

- Five declarative rule kinds — `completeness`, `uniqueness`, `range`,
  `referential` and `crossField` — executed over exported JSON datasets.
- A frozen `ruleId -> severity` table, and a separate list of rule ids that mean
  the run did not reach a verdict. Any one of those makes the report
  `incomplete` and the process exit `2`, whatever the finding's own severity is.
- `reference-undetermined`: a non-match against a key index that dropped rows is
  reported as undetermined rather than as a violation, because evidence dropped
  while building an index makes the comparison incomplete, not clean.
- `rule-examined-no-rows` and `no-rules-executed`, so a run that established
  nothing cannot report a pass.
- Path confinement against the resolved real path, so a symbolic link inside
  `--data` that leads out of it is refused rather than read.
- Bounds on ruleset bytes, rules, datasets, key columns, identifier length,
  dataset bytes, rows, columns, field length and reported samples, each enforced
  before the work it bounds and each tested from both sides.
- Cell values masked by default in findings, with `--show-values` to print them.
