# Parquet Exploration Design

## Feature review and priorities

| Source | Behavior studied | Plugin application |
| ------ | ---------------- | ------------------ |
| [IntelliJ data editor](https://www.jetbrains.com/help/idea/data-editor-and-viewer.html) | Column management, sorting, filtering, transpose, record inspection, charts, and export | Keep quick layout controls in Rows and whole-file operations in Explore. |
| [YData Profiling](https://github.com/ydataai/ydata-profiling/tree/c27f8dcf) | Variable summaries, missingness, distributions, duplicates, alerts, and offline reports | Profile the file once requested and export the resulting report. |
| [skimpy](https://github.com/aeturrell/skimpy/tree/18693a6) | Compact summaries by type, quantiles, and histograms | Put counts and type-specific statistics together. |
| [D-Tale](https://github.com/man-group/dtale/tree/d34f0a57) | Filters, sorting, hiding columns, group aggregation, pivots, derived values | Provide controls for whole-file operations and editable SQL for further analysis. |
| [Sweetviz](https://github.com/fbdesignpro/sweetviz/tree/4697e18) | Target analysis, mixed-type associations, and comparison between populations | Choose a target or a second file, with metric labels and denominators. |
| [AutoViz](https://github.com/AutoViML/AutoViz/tree/63f4b3c) | Type-driven plots, target-conditioned charts, and data-quality recommendations | Recommend charts and provide read-only diagnostics and outlier-capping previews. |

## Execution

Keep the existing reader for basic navigation. Run analytical SQL through the optional DuckDB
grant. Quote column names, preserve exact counts and identifiers in results, and disclose limits
on matrices, previews, samples, and group counts. A user-selected second file enters through the
native file dialog. Show when an analysis has too little data or exceeds DuckDB's resource budget.

## Scope

Prioritize inspection, descriptive statistics, and non-destructive transformations. Training predictive
models, running a Python web service, editing source data, and automatic repairs require a different
execution or write model. Derived values can be exported through the existing query export.

## Resource and interpretation limits

Explore previews contain up to 200 rows and 4,096 cells. Pivots offer up to 20 categories.
Relationships accepts up to ten columns and analyzes a sample of up to 10,000 rows. It reports the
contributing pair count. A categorical score is unavailable above the supported category count.
Population comparisons share a scale and report relative frequencies so unequal file sizes are meaningful.

The profile counts duplicates beyond the first copy of each full row. Counts and bounds retain their
native precision where provided. Means and sample standard deviations are approximate. Outlier
counts use the interquartile range. A failed statistic or capped result must be visible in the viewer.
