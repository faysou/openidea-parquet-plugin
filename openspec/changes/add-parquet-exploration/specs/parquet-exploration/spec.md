## ADDED Requirements

### Requirement: Explore the whole file

The viewer SHALL support column selection, typed filters, ordered sorting, group aggregates, pivots,
and read-only derived values through controls that run against the whole file.

#### Scenario: A match occurs beyond the first page

- **WHEN** a user filters a column and sorts the matches
- **THEN** the result includes matching records beyond the preview page and indicates any output limit.

### Requirement: Profile the data

The viewer SHALL report missingness, duplicate rows, typed descriptive statistics, quality alerts,
and selected column distributions. It SHALL offer standalone HTML export.

#### Scenario: Missing or constant data

- **WHEN** a user profiles a column with missing or constant values
- **THEN** the viewer shows counts and clearly distinguishes unavailable statistics from zero.

### Requirement: Analyze relationships

The viewer SHALL offer numeric correlations, categorical associations, mixed associations, target
selection, group summaries, and chart suggestions appropriate to the selected types.

#### Scenario: A pair has incomplete observations

- **WHEN** a relationship is calculated
- **THEN** its metric and the number of contributing observations are visible.

### Requirement: Compare populations

The viewer SHALL compare one selected column across two user-selected Parquet files, including size,
missingness, and frequencies on a shared scale for compatible types.

#### Scenario: The files have different numbers of rows

- **WHEN** a user compares numeric or categorical distributions
- **THEN** the viewer reports counts and normalized frequencies with their population identified.

### Requirement: Transpose the displayed data

The viewer SHALL offer a reversible transpose control for displayed rows.

#### Scenario: Inspect a wide page

- **WHEN** the user toggles transpose
- **THEN** columns become row headings and record numbers become column headings for the current page.

### Requirement: Inspect and reuse analysis queries

The viewer SHALL provide editable SQL for missing-value patterns, duplicate records, text lengths,
time gaps, moving averages, and a preview of outlier capping. It SHALL let the reader choose the
source columns where needed.

#### Scenario: Investigate an outlier warning

- **WHEN** the reader chooses a numeric column and the capping query
- **THEN** the editor shows a read-only query with the original and capped values.

### Requirement: Manage displayed columns

The viewer SHALL allow the user to hide, show, reorder, and pin grid columns.

#### Scenario: Keep a key visible while reading a wide record

- **WHEN** the reader pins a column and scrolls the grid horizontally
- **THEN** the pinned column stays visible.

### Requirement: Inspect physical storage

The schema view SHALL display the selected Parquet row group's row count and per-column storage
metadata, including compression and available footer statistics, without decoding records.

#### Scenario: Inspect a compressed column

- **WHEN** the reader selects a row group
- **THEN** the viewer shows its column chunks, compressed sizes, and stored statistics.
