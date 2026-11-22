# Parquet exploration

## Why

A paged grid shows individual records well, but a page can hide missing data, skew, duplicate rows,
and differences between datasets. Readers should be able to investigate the entire file while
keeping row data on their machine.

## What Changes

- P1: Add typed filters, sorting, projection, grouping, pivoting, and read-only derived values.
- P1: Profile columns and duplicate rows, inspect distributions, flag quality issues, and save a standalone HTML report.
- P2: Explore relationships with a target, group summaries, and chart recommendations.
- P2: Compare the distribution and missingness of a selected column across files of different sizes.
- P2: Manage columns and read records as a table, tree, text, or transposed grid.
- P2: Inspect physical row groups, export charts as PNG, and compare category shares or time-series areas.
- P2: Insert editable diagnostic SQL for missingness patterns, duplicates, text, time gaps, moving averages, and outliers.

## Impact

The Parquet plugin uses existing range reads, the approved local DuckDB executable, and the file picker.
Statistics must state their population, units, and any limits. The source files stay read-only.
