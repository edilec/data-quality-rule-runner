# Data Quality Rule Runner documentation

The design, the input and output contracts, the limits and the verification
command are documented in [the README](../README.md), which is the single place
they are kept so the two cannot drift apart.

Two notes that belong beside the code rather than in the README:

## Why an unevaluable cell is not a violation

A range rule declares that a column holds numbers within bounds. When the cell
holds a string, there are three things the tool could do: parse the string,
report the row as out of range, or report that no comparison was made.

The first invents a conversion — `"12abc"` and `"0x10"` have different answers
in different parsers, and the tool would be reporting its own choice as the
data's property. The second asserts a comparison that never happened. Only the
third is true, so `value-unevaluable` is what the run emits, the report is
`incomplete` and the exit code is `2`.

The same reasoning governs a uniqueness key that cannot be formed, a referenced
key row that cannot be read, and a column the export does not have.

## Why a partial index cannot produce a violation

`referential` builds a set of keys from the referenced dataset and asks whether
each child key is in it. A row of the referenced dataset whose key cannot be
formed is not in that set.

A positive answer is still sound: a key that was found was found, whatever else
was dropped. A negative answer is not: the key that would have matched may be
one of the rows the index never held. So a non-match against an incomplete index
is `reference-undetermined` and the run exits `2`, while a non-match against a
complete index is `referential-violation` and the run exits `1`.

An empty referenced export reaches the same branch by a different route. There
is nothing there to have matched, so "matches nothing" would be a statement
about the export rather than about the value.
