# Data Quality Rule Runner

Execute declarative completeness, uniqueness, range, referential and cross-field
rules over datasets somebody exported to local JSON files, and say exactly where
each failure is.

- **Repository:** [edilec/data-quality-rule-runner](https://github.com/edilec/data-quality-rule-runner)
- **Area:** Data & Analytics
- **License:** MIT

## Why it exists

Most quality checks answer "did the data pass?" with two values, and put
everything they could not evaluate into the same bucket as everything that was
fine. That is the failure mode this tool is built against.

A rule whose column the export does not have, a cell that cannot be compared, a
referenced dataset that was never read, an export with no rows, a rule that
stopped with an error — none of those is data that passed. Each one is reported
as evidence the run did not obtain, the report says `incomplete`, and the
process exits `2`. There is no path through this tool in which something it
could not evaluate is counted as something it evaluated successfully.

The sharpest case is a relation. Building the index of referenced keys can drop
rows whose key cannot be formed, and a tool that then reports a child value as
"matching nothing" has made a **positive** claim on the strength of evidence it
threw away. Here, a non-match against an incomplete index is
`reference-undetermined`, never `referential-violation`. Evidence dropped while
building an index makes the comparison incomplete; it does not make it clean.

## What it does not do

- It **reaches nothing**. No connection is opened, no host resolved, no store
  contacted. Every input is a document somebody exported to a local file.
- It **reads no clock**. Two runs over the same inputs produce byte-identical
  stdout; dates are compared as strict UTC instants parsed from the documents.
- It **writes no file**. The report goes to stdout. Redirect it if you want to
  keep it. There is no `--out` and no auto-fix.
- It **parses no SQL and no CSV**. Datasets are JSON documents in the shape
  below. Converting an export into that shape is somebody else's job.
- It **converts nothing across types**. A string in a column a rule declares
  numeric is not parsed as a number, and a string key does not match a numeric
  one. A comparison this tool cannot make is reported as one it did not make.
- It **is not a profiler**. It answers the rules you declare and invents none.

## Quick start

```sh
node bin/data-quality-rule-runner.mjs \
  --rules examples/clean/quality.rules.json \
  --data examples/clean
```

That run exits `0` with an empty `findings` array. The other two examples show
the other two exit codes:

```sh
# a duplicate composite key, a dangling relation, an out-of-range total and a
# shipment dated before its order: status "fail", exit 1
node bin/data-quality-rule-runner.mjs \
  --rules examples/failing/quality.rules.json --data examples/failing

# one referenced row whose key is null: the index is incomplete, so a
# non-matching child value is undetermined rather than a violation. Exit 2.
node bin/data-quality-rule-runner.mjs \
  --rules examples/undetermined/quality.rules.json --data examples/undetermined
```

## Inputs

### The ruleset (`--rules`)

Configuration. A problem with it means the run never had a subject, so stdout
stays empty and the message goes to stderr.

```json
{
  "schemaVersion": "1",
  "limits": { "maxRows": 10000, "maxSamplesPerRule": 5 },
  "datasets": [
    { "name": "customers", "file": "customers.json" },
    { "name": "orders", "file": "orders.json" }
  ],
  "rules": [
    { "id": "orders-customer-populated", "kind": "completeness", "dataset": "orders", "column": "customer_id" },
    { "id": "orders-key-unique", "kind": "uniqueness", "dataset": "orders", "columns": ["customer_id", "order_no"] },
    { "id": "orders-total-in-range", "kind": "range", "dataset": "orders", "column": "total", "min": 0, "max": 10000 },
    {
      "id": "orders-customer-known",
      "kind": "referential",
      "dataset": "orders",
      "columns": ["customer_id"],
      "references": { "dataset": "customers", "columns": ["id"] }
    },
    {
      "id": "orders-shipped-after-ordered",
      "kind": "crossField",
      "dataset": "orders",
      "left": "ordered_on",
      "right": "shipped_on",
      "comparison": "lte",
      "type": "date"
    }
  ]
}
```

Every object is closed against unknown keys, including `limits`. A
one-character typo in a limit name is refused rather than silently restoring the
default.

Rule ids are yours and are stable across runs, so a finding can be tracked
between releases. They are required to be unique.

### The datasets (`--data`)

Evidence. A problem with one is a finding inside an `incomplete` report, because
a consumer needs to know which export was not read.

```json
{
  "schemaVersion": "1",
  "dataset": "orders",
  "rows": [
    { "order_no": "A-1001", "customer_id": "cust-001", "total": 480.5 }
  ]
}
```

Each `datasets[].file` is relative to `--data`. The real path is resolved and
compared against the real root, so a symbolic link planted inside the root that
leads out of it is refused rather than read; a link that stays inside is
followed normally. The document's own `dataset` name must match the ruleset, so
the wrong export placed at a known path is caught rather than used.

Cell values must be scalars: a string, a finite number, a boolean, or `null`.
Anything else is a cell this tool could not read, which is missing evidence.

### A null is not a value, and that will surprise you once

A cell that is absent, `null`, or renders as nothing is **unevaluable** for every
rule except `completeness`, which exists to find exactly that. So a `referential`
rule over a nullable foreign key reports `value-unevaluable` for each null row
and the run comes back `incomplete` — it does **not** treat the null as
satisfying the relation, and it does not treat it as violating one either.

That is deliberate and it is uniform: this tool has no SQL semantics to appeal
to, and choosing either answer would be inventing one. If your column is
genuinely nullable and you want a verdict, the honest shape is two rules — a
`completeness` rule you expect to fail on those rows, or an export that omits
them — rather than a flag here that decides on your behalf.

## Rule kinds

| Kind | Fields | Satisfied when |
| --- | --- | --- |
| `completeness` | `column` | the column holds a value that still renders as something |
| `uniqueness` | `columns` | the composite key appears at most once |
| `range` | `column`, `min` and/or `max` | the numeric value is within the inclusive bounds |
| `referential` | `columns`, `references` | the key exists in the referenced dataset |
| `crossField` | `left`, `right`, `comparison`, `type` | the two columns satisfy the comparison |

Comparisons: `eq`, `gt`, `gte`, `lt`, `lte`, `neq`. Declared types: `date`,
`number`, `string`. A `date` is a strict UTC `YYYY-MM-DD` or
`YYYY-MM-DDTHH:MM:SS[.sss]Z`; `Date.parse` is not used anywhere, because it
accepts implementation-defined formats, reads a bare date-time as local time and
rolls `2026-02-30` forward into March.

A value that renders as nothing once control and format characters are removed
counts as **not populated**. `value.trim().length > 0` is the wrong question: it
accepts a string of U+0001 or U+200E that reaches a report as the empty string.

## Findings

| Rule id | Severity | Means the run did not reach a verdict |
| --- | --- | --- |
| `completeness-violation` | error | no |
| `cross-field-violation` | error | no |
| `dataset-invalid` | error | yes |
| `dataset-not-utf8` | error | yes |
| `dataset-outside-root` | error | yes |
| `dataset-schema-unsupported` | error | yes |
| `dataset-too-large` | error | yes |
| `dataset-too-many-columns` | error | yes |
| `dataset-too-many-rows` | error | yes |
| `dataset-unparsable` | error | yes |
| `dataset-unreadable` | error | yes |
| `datasets-too-large-together` | error | yes |
| `key-unevaluable` | error | yes |
| `no-rules-executed` | error | yes |
| `range-violation` | error | no |
| `reference-index-incomplete` | error | yes |
| `reference-undetermined` | error | yes |
| `referential-violation` | error | no |
| `rule-column-absent` | error | yes |
| `rule-examined-no-rows` | error | yes |
| `rule-execution-failed` | error | yes |
| `samples-truncated` | info | no |
| `uniqueness-violation` | error | no |
| `value-unevaluable` | error | yes |

Any finding in the right-hand column makes the whole report `incomplete` and the
process exit `2`, whatever that finding's own severity is. The four ids outside
it are the three violation kinds — verdicts the run did establish — and
`samples-truncated`, which bounds the list of **places** rather than the verdict.

Findings sort by `(location.file, location.pointer, ruleId, message)`, each
compared by UTF-16 code unit. `localeCompare` and `Intl.Collator` are not used:
their collation depends on ICU data that varies between Node builds.

Cell values are **masked by default** — `<string:12>`, `<number>`, `<boolean>` —
because a quality report is routinely pasted into a ticket or a build log, which
travel further than the data they describe. Pass `--show-values` to print them.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every rule reached a verdict and every verdict was satisfied |
| `1` | the check completed and at least one rule was violated |
| `2` | invalid configuration, or evidence the check could not obtain |

Exit `2` has two shapes, and the difference is deliberate:

| Situation | stdout | stderr |
| --- | --- | --- |
| invalid configuration, unknown option, bad ruleset | **empty** | the message |
| a dataset that could not be read, decoded, parsed or evaluated | an `incomplete` report | optional diagnostics |

A consumer that pipes stdout must handle an empty stdout on exit `2`. Emitting a
fake report for a run that never started would be worse.

## Limits

Every bound is enforced **before** the work it bounds, not after. A dataset's
size is taken from `stat` before the file is opened.

| Limit | Default | Ceiling | Configurable |
| --- | ---: | ---: | --- |
| ruleset document bytes | 1048576 | 1048576 | no |
| rules per ruleset | 256 | 256 | no |
| datasets per ruleset | 32 | 32 | no |
| columns in one key | 8 | 8 | no |
| identifier length | 128 | 128 | no |
| `limits.maxDatasetBytes` | 4194304 | 16777216 | yes |
| `limits.maxTotalDatasetBytes` | 536870912 | 536870912 | yes |
| `limits.maxRows` | 50000 | 200000 | yes |
| `limits.maxColumns` | 128 | 512 | yes |
| `limits.maxFieldLength` | 4096 | 8192 | yes |
| `limits.maxSamplesPerRule` | 5 | 50 | yes |

A ruleset may **lower** a configurable bound and may never raise one past its
ceiling: a limit a document could raise would be no limit at all. Exceeding a
bound is an `incomplete` result with a finding naming the limit, never a silent
truncation and never a pass.

`limits.maxSamplesPerRule` is the one exception to that sentence, and it is
narrow: it bounds how many **locations** are reported for a rule that has
already reached its verdict. Exceeding it adds a `samples-truncated` finding
naming the real total.

`limits.maxTotalDatasetBytes` bounds the work rather than one file. Every
declared dataset is held in memory at once — a referential rule needs two of
them at the same time, and a rule may name any of them — so the cost of a run is
the sum of the datasets, not the largest of them. Its ceiling is the product of
the two bounds that already governed that sum (32 datasets at 16777216 bytes
each), so no ruleset that is legal without it becomes illegal with it; what it
adds is a bound a ruleset can **lower** to cap what a run will cost on a machine
whose limit is smaller than that.

Measured at the documented maximum rather than generalised from a smaller run.
Two runs of each, `/usr/bin/time -l`, Node 22 on macOS arm64:

| Input at the ceiling | CPU | Wall | Peak RSS | Result |
| --- | ---: | ---: | ---: | --- |
| 32 datasets × 16776938 bytes, 5217824 rows, 64 rules | 15.3–15.9 s | 44–100 s | 1.35–1.47 GiB | exit 0, `pass` |
| 1 dataset, 200000 rows, 256 rules | 28.1–30.3 s | 132–186 s | 496–512 MiB | exit 0, `pass` |

The machine was under other load, so the wall-clock spread is the machine's and
not the tool's — the CPU figures are the stable ones. **Size a host by the
resident figures**: the first row is what `limits.maxTotalDatasetBytes` at its
ceiling costs, and a host whose heap cannot hold that should lower the bound
rather than discover it as an out-of-memory kill, which would be a dead process
rather than a report.

## Verification

```sh
npm run check
```

That runs `node --check` over every source and test file, the `node:test` suite,
all three examples with their expected exit codes, and `npm pack --dry-run`.

## Approach

The declarative-rule shape, stable rule identity and JSON Pointer locations
follow the conventions of [ajv](https://github.com/ajv-validator/ajv); the
record-and-bounded-sample model follows
[node-csv](https://github.com/adaltas/node-csv). Neither is a dependency: this
package has no runtime and no development dependencies at all.

## License

MIT. See [LICENSE](./LICENSE).
