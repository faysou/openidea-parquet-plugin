const numericTypes = new Set(["INT32", "INT64", "FLOAT", "DOUBLE"]);
export const chartSeriesLimit = 6;

export const scalarColumn = ({ element, children }) => !children.length && element.repetition_type !== "REPEATED";
export const temporalColumn = ({ element }) =>
  element.type === "INT96" || ["TIMESTAMP", "DATE"].includes(element.logical_type?.type) ||
  ["TIMESTAMP_MILLIS", "TIMESTAMP_MICROS", "DATE"].includes(element.converted_type);
export const numericColumn = node =>
  scalarColumn(node) && !temporalColumn(node) &&
  !["TIME", "TIMESTAMP", "DATE"].includes(node.element.logical_type?.type) &&
  !["TIME_MILLIS", "TIME_MICROS"].includes(node.element.converted_type) &&
  (numericTypes.has(node.element.type) || node.element.logical_type?.type === "DECIMAL" || node.element.converted_type === "DECIMAL");

export function chartQuery(type, column, measure, bins, { group } = {}) {
  const x = identifier(column);
  if (type === "histogram") return histogramQuery(x, bins);
  if (["line", "area", "scatter"].includes(type)) {
    return coordinateQuery(type, x, measure, group);
  }
  return `SELECT cast(${x} AS VARCHAR) AS label, count(*) AS value FROM parquet_data
    WHERE ${x} IS NOT NULL GROUP BY ${x} ORDER BY value DESC, label LIMIT 20`;
}

function coordinateQuery(type, x, measure, group) {
  const multiple = Array.isArray(measure);
  const measures = multiple ? measure : [measure];
  if (!measures.length || measures.length > chartSeriesLimit) {
    throw new Error(`Choose between 1 and ${chartSeriesLimit} Y-axis columns.`);
  }

  const scatter = type === "scatter";
  const values = measures.map(name => `cast(${identifier(name)} AS DOUBLE)`);
  const groupLimit = Math.floor(chartSeriesLimit / measures.length);
  const grouped = group !== undefined;
  const packed = multiple || grouped;
  const source = `WITH source AS NOT MATERIALIZED (
      SELECT ${scatter ? `cast(${x} AS DOUBLE)` : `epoch_ms(${x})`} AS label,
        unnest([${values.join(", ")}]) AS value,
        unnest(range(${measures.length})) AS series_number,
        ${grouped ? `cast(${identifier(group)} AS VARCHAR)` : "NULL::VARCHAR"} AS group_label
        ${scatter ? ", row_number() OVER () AS source_row" : ""}
      FROM parquet_data
    ), observations AS NOT MATERIALIZED (
      SELECT * FROM source WHERE ${scatter ? "isfinite(label)" : "label IS NOT NULL"} AND isfinite(value)
    ), groups AS (${grouped ? `
      SELECT group_label, row_number() OVER (ORDER BY count(*) DESC, group_label NULLS LAST) AS group_number,
        count(*) OVER () AS group_count
      FROM observations GROUP BY group_label QUALIFY group_number <= ${groupLimit}` : `
      SELECT NULL::VARCHAR AS group_label, 1 AS group_number, 1 AS group_count`}
    ), data AS NOT MATERIALIZED (
      ${grouped ? `SELECT observations.*, groups.group_number FROM observations
        JOIN groups ON observations.group_label IS NOT DISTINCT FROM groups.group_label`
        : "SELECT observations.*, 1 AS group_number FROM observations"}
    )`;
  if (!packed) {
    return scatter ? `${source} SELECT label, value FROM data ORDER BY hash(source_row, 42), source_row LIMIT 200`
      : `${source}, ${timeSeriesPoints()} SELECT label, value FROM points ORDER BY label`;
  }

  // Pack each series into one row to keep it whole across the bridge's row limit
  const point = "[cast(label AS VARCHAR), cast(value AS VARCHAR)]";
  const points = scatter
    ? `arg_min(${point}, struct_pack(hash := hash(source_row, 42), ordinal := source_row), 200)`
    : `list(${point} ORDER BY label)`;
  return `${source}${scatter ? "" : `, ${timeSeriesPoints()}`}
    SELECT series_number, groups.group_label, group_count, ${points} AS points
    FROM ${scatter ? "data" : "points"} JOIN groups USING (group_number)
    GROUP BY group_number, groups.group_label, series_number, group_count ORDER BY series_number, group_number`;
}

function timeSeriesPoints() {
  return `bounds AS (SELECT min(label) AS lo, (max(label) - min(label)) // 120 + 1 AS step FROM data),
    bucketed AS NOT MATERIALIZED (
      SELECT lo + ((label - lo) // step) * step AS label, value, series_number, group_number
      FROM data CROSS JOIN bounds
    ), scales AS (
      SELECT label, series_number, group_number, min(value) AS lo, max(value) AS hi,
        CASE WHEN max(abs(value)) >= 1.7976931348623157e308 / count(*)
             THEN pow(2, ceil(log2(count(*)))) ELSE 1.0 END AS scale
      FROM bucketed GROUP BY label, series_number, group_number
    ), points AS (
      SELECT label, greatest(lo, least(hi, favg(value / scale) * scale)) AS value, series_number, group_number
      FROM bucketed JOIN scales USING (label, series_number, group_number)
      GROUP BY label, series_number, group_number, lo, hi, scale
    )`;
}

function histogramQuery(column, bins) {
  if (!Number.isInteger(bins) || bins < 2 || bins > 100) {
    throw new Error("Choose a histogram bin count between 2 and 100.");
  }

  // Preserve fixed-point precision with unscaled units, dividing before weighting the bounds
  // so that intermediate values fit in HUGEINT.
  return `WITH source AS (SELECT ${column} AS x FROM parquet_data),
    data AS NOT MATERIALIZED (
      SELECT cast(x AS DOUBLE) AS x,
        CASE WHEN typeof(x) NOT IN ('FLOAT', 'DOUBLE')
             THEN cast(replace(cast(x AS VARCHAR), '.', '') AS HUGEINT) END AS units,
        CASE WHEN typeof(x) NOT IN ('FLOAT', 'DOUBLE')
             THEN length(split_part(cast(x AS VARCHAR), '.', 2)) END AS scale
      FROM source WHERE isfinite(cast(x AS DOUBLE))
    ), bounds AS (
      SELECT min(x) AS lo, max(x) AS hi, min(units) AS lo_units, max(units) AS hi_units,
        CASE WHEN lo_units IS NULL THEN lo = hi ELSE lo_units = hi_units END AS single_bin,
        max(scale) AS scale
      FROM data
    ), grid AS (
      SELECT i, bounds.*,
        (lo_units % ${bins}) * (${bins} - i) + (hi_units % ${bins}) * i AS remainder,
        CASE WHEN isinf(hi - lo) THEN lo * (1 - i / ${bins}) + hi * (i / ${bins})
             ELSE lo + (hi - lo) * (i / ${bins}) END AS start
      FROM bounds CROSS JOIN range(${bins}) AS grid(i)
    ), cuts AS (
      SELECT *, (lo_units // ${bins}) * (${bins} - i) + (hi_units // ${bins}) * i +
        (remainder // ${bins}) + cast(remainder % ${bins} > 0 AS INTEGER) AS unit_start
      FROM grid
    ), edges AS (
      SELECT *, lead(unit_start) OVER (ORDER BY i) AS next_units,
        lead(start) OVER (ORDER BY i) AS next_start,
        cast(abs(unit_start) AS VARCHAR) AS digits
      FROM cuts
    ), estimates AS (
      SELECT x, units, CASE WHEN single_bin THEN 0 ELSE least(${bins} - 1, greatest(0, floor(${bins} *
        CASE WHEN units IS NOT NULL THEN cast(cast(units AS BIGNUM) - cast(lo_units AS BIGNUM) AS DOUBLE) /
          cast(cast(hi_units AS BIGNUM) - cast(lo_units AS BIGNUM) AS DOUBLE)
        WHEN isinf(hi - lo) THEN (x / 2 - lo / 2) / (hi / 2 - lo / 2)
        ELSE (x - lo) / (hi - lo) END))) END AS guess
      FROM data CROSS JOIN bounds
    ), counts AS (
      SELECT CASE WHEN single_bin THEN 0
                  WHEN coalesce(units < unit_start, x < start) THEN i - 1
                  WHEN coalesce(units >= next_units, units IS NULL AND x >= next_start) THEN i + 1
                  ELSE i END AS bin, count(*) AS n
      FROM estimates JOIN edges ON guess = i GROUP BY bin
    ), labeled AS (
      SELECT i, coalesce(n, 0) AS n, CASE WHEN unit_start IS NULL THEN cast(start AS VARCHAR)
        WHEN scale = 0 THEN cast(unit_start AS VARCHAR)
        ELSE concat(if(unit_start < 0, '-', ''),
                    if(length(digits) > scale, left(digits, length(digits) - scale), '0'),
                    '.', right(lpad(digits, cast(greatest(length(digits), scale + 1) AS INTEGER), '0'), scale))
        END AS label
      FROM edges LEFT JOIN counts ON i = bin
      WHERE lo IS NOT NULL AND (NOT single_bin OR i = 0)
    )
    SELECT label, sum(n) AS value FROM labeled GROUP BY label ORDER BY min(i)`;
}

export function identifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}
