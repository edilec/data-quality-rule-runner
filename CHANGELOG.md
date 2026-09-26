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
  dataset bytes, total dataset bytes, rows, columns, field length and reported
  samples, each enforced before the work it bounds and each tested from both
  sides.
- `limits.maxTotalDatasetBytes` and `datasets-too-large-together`: every
  declared dataset is held in memory at once, so the cost of a run is their sum
  rather than the largest of them. The ceiling is the product of the two bounds
  that already governed that sum, so nothing legal without it is illegal with
  it, and a ruleset may lower it to cap what a run will cost.
- Cell values masked by default in findings, with `--show-values` to print them.
- A finding that names two values which render identically says which
  difference it is and names the code points, instead of printing one value
  twice: the comparison reads the exported value and the message is written
  from the rendered one, and a trailing space or an invisible format character
  is real in the first and absent from the second.
