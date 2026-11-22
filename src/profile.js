import { duckdb } from "./duckdb.js";
import { identifier, numericColumn, scalarColumn, temporalColumn } from "./chart-query.js";

const batchSize = 12;
const bins = 12;
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 });

export function mountProfile(panel, file) {
  panel.innerHTML = `<div class="analysis-controls">
    <button type="button">Run profile</button>
    <label>Distribution <select disabled></select></label>
    <label class="report-scope"><input type="checkbox">Include all columns in report charts</label>
    <button type="button" disabled>Save HTML report</button>
    <span role="status">Profile the entire file with DuckDB.</span>
  </div><div class="analysis-results"><div></div><div></div></div>`;
  const [run, save] = panel.querySelectorAll("button");
  const select = panel.querySelector("select");
  const status = panel.querySelector('[role="status"]');
  const [summary, plot] = panel.querySelector(".analysis-results").children;
  let report;
  let distribution;
  let request = 0;
  const query = sql => duckdb({ sql });

  run.addEventListener("click", async () => {
    ++request;
    run.disabled = select.disabled = save.disabled = true;
    summary.replaceChildren();
    plot.replaceChildren();
    status.textContent = "Profiling the file…";
    try {
      const [data, document] = await Promise.all([
        profileData(file, query), window.openidea.document?.get?.().catch(() => undefined),
      ]);
      report = { ...data, name: document?.name };
      summary.innerHTML = summaryHtml(report);
      select.replaceChildren(...report.columns.map(({ name }, index) => new Option(name, index)));
      select.disabled = !report.columns.length;
      if (report.columns.length) await showDistribution();
      else {
        distribution = undefined;
        save.disabled = false;
        status.textContent = "";
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      run.disabled = false;
    }
  });

  select.addEventListener("change", () => void showDistribution());
  save.addEventListener("click", async () => {
    const id = request;
    save.disabled = true;
    run.disabled = true;
    select.disabled = true;
    try {
      let distributions = distribution;
      if (panel.querySelector('input[type="checkbox"]').checked) {
        distributions = [];
        for (const [i, column] of report.columns.entries()) {
          status.textContent = `Preparing distribution ${i + 1} of ${report.columns.length}…`;
          if (column.name === distribution?.name) {
            distributions.push(distribution);
          } else {
            try {
              distributions.push(await profileDistribution(column, query));
            } catch (error) {
              distributions.push({ name: column.name, error: error.message });
            }
          }
        }
      }
      const saved = await window.openidea.saveFile({
        name: "parquet-profile.html",
        filters: [{ name: "HTML", extensions: ["html"] }],
        data: profileHtml(report, distributions),
      });
      if (id === request) status.textContent = saved ? "Saved HTML report." : "";
    } catch (error) {
      if (id === request) status.textContent = error.message;
    } finally {
      if (id === request) {
        run.disabled = save.disabled = false;
        select.disabled = !report.columns.length;
      }
    }
  });

  async function showDistribution() {
    const id = ++request;
    const column = report.columns[Number(select.value)];
    save.disabled = true;
    status.textContent = "Reading the distribution…";
    plot.replaceChildren();
    try {
      const result = await profileDistribution(column, query);
      if (id !== request) return;
      distribution = result;
      plot.innerHTML = distributionHtml(distribution);
      status.textContent = "";
    } catch (error) {
      if (id !== request) return;
      distribution = { name: column.name, error: error.message };
      plot.innerHTML = distributionHtml(distribution);
      status.textContent = "";
    } finally {
      if (id === request) save.disabled = false;
    }
  }
}

export async function profileData(file, query) {
  const columns = [];
  for (let i = 0; i < file.schema.length; i += batchSize) {
    const fields = file.schema.slice(i, i + batchSize).map(profileColumn);
    const input = fields.map(({ name }, index) => `${identifier(name)} AS c${index}`);
    const scales = fields.flatMap((column, index) => {
      if (column.kind !== "numeric") return [];
      const x = `c${index}`;
      const finite = `CASE WHEN isfinite(${x}::DOUBLE) THEN ${x} END`;
      return [`max(abs((${finite})::DOUBLE)) AS scale_${x}`, `min(${finite}) AS base_${x}`];
    });
    const structs = fields.map((column, index) => `struct_pack(${summaryFields(`c${index}`, column).join(", ")})`);
    const { rows } = await query(`WITH data AS NOT MATERIALIZED (SELECT ${input.join(", ")} FROM parquet_data)
      ${scales.length ? `, bounds AS (SELECT ${scales.join(", ")} FROM data)` : ""}
      SELECT to_json([${structs.join(", ")}]) AS profiles FROM data ${scales.length ? "CROSS JOIN bounds" : ""}`);
    const stats = JSON.parse(rows[0][0]);
    columns.push(...fields.map((column, index) => ({ ...column, ...stats[index] })));
  }
  let duplicates;
  let duplicateError;
  if (file.total > 1) {
    try {
      const result = await query(`SELECT ${file.total} - count(*) FROM (SELECT DISTINCT * FROM parquet_data)`);
      duplicates = Number(result.rows[0][0]);
    } catch (error) {
      duplicateError = error.message;
    }
  } else duplicates = 0;
  return { rows: file.total, columns, duplicates, duplicateError };
}

function profileColumn(node) {
  const { element } = node;
  const type = element.logical_type?.type ?? element.converted_type ?? element.type ?? "STRUCT";
  let kind = "other";
  if (numericColumn(node)) kind = "numeric";
  else if (scalarColumn(node)) {
    if (temporalColumn(node) || ["TIME", "TIME_MILLIS", "TIME_MICROS"].includes(type)) kind = "temporal";
    else if (element.type === "BOOLEAN") kind = "boolean";
  }
  const integral = kind === "numeric" && type !== "DECIMAL" && ["INT32", "INT64"].includes(element.type);
  if (type === "DECIMAL") {
    const precision = element.logical_type?.precision ?? element.precision;
    const scale = element.logical_type?.scale ?? element.scale;
    if (Number.isInteger(scale) && scale >= 0 && scale <= precision && precision <= 18) {
      return { name: element.name, type, kind, integral, decimalScale: scale };
    }
  }
  return { name: element.name, type, kind, integral };
}

function summaryFields(x, { kind, integral, decimalScale }) {
  const finite = integral ? x : `CASE WHEN isfinite(${x}::DOUBLE) THEN ${x} END`;
  const numeric = kind === "numeric";
  const average = `avg(${finite})`;
  const scale = `coalesce(nullif(scale_${x}, 0), 1)`;
  // Center integers and short decimals before conversion to preserve differences above 2^53.
  const deviation = integral
    ? `stddev_samp((${x}::HUGEINT - base_${x}::HUGEINT)::DOUBLE)`
    : decimalScale != null
      ? `stddev_samp((${x}::DECIMAL(38,${decimalScale}) - base_${x}::DECIMAL(38,${decimalScale}))::DOUBLE)`
      : `stddev_samp((${finite})::DOUBLE / ${scale}) * first(${scale})`;

  // An ordinary floating-point average can overflow before it divides by the count
  const mean = integral ? average
    : `CASE WHEN isfinite(${average}) THEN ${average} ELSE avg((${finite})::DOUBLE / pow(2, 512)) * pow(2, 512) END`;
  return [
    `missing := count(*) - count(${x})`,
    `distinct_values := count(DISTINCT ${x})`,
    `minimum := ${numeric || kind === "temporal" ? `min(${numeric ? finite : x})::VARCHAR` : "NULL::VARCHAR"}`,
    `maximum := ${numeric || kind === "temporal" ? `max(${numeric ? finite : x})::VARCHAR` : "NULL::VARCHAR"}`,
    `mean := ${numeric ? `(${mean})::VARCHAR` : "NULL::VARCHAR"}`,
    `sd := ${numeric ? `(CASE WHEN isfinite(${deviation}) THEN ${deviation} END)::VARCHAR` : "NULL::VARCHAR"}`,
    `quartiles := ${numeric ? `quantile_disc(${finite}, [0.25, 0.5, 0.75])::VARCHAR[]` : "NULL::VARCHAR[]"}`,
    `zeros := ${numeric ? `count(*) FILTER (WHERE ${x} = 0)` : "NULL::BIGINT"}`,
    `non_finite := ${numeric ? `count(${x}) - count(${finite})` : "NULL::BIGINT"}`,
    `true_values := ${kind === "boolean" ? `count(*) FILTER (WHERE ${x})` : "NULL::BIGINT"}`,
  ];
}

export async function profileDistribution(column, query) {
  const { name, kind, integral, decimalScale } = column;
  const x = identifier(name);
  const numeric = kind === "numeric";
  const discrete = integral || decimalScale != null;
  const sql = numeric ? histogramQuery(x, discrete, decimalScale) : `
    SELECT left(source_value::VARCHAR, 160) AS label,
      length(source_value::VARCHAR) > 160 AS shortened, count(*) AS n
    FROM (SELECT ${x} AS source_value FROM parquet_data) WHERE source_value IS NOT NULL
    GROUP BY source_value ORDER BY n DESC, source_value LIMIT ${bins}`;
  const result = await query(sql);
  let outliers = 0;
  const values = result.rows.map(row => {
    const fields = Object.fromEntries(result.columns.map((key, index) => [key, row[index]]));
    let label = `${fields.label ?? ""}${fields.shortened === "true" ? "…" : ""}`;
    if (numeric) {
      outliers = Number(fields.outliers);
      const start = discrete || fields.first_bin === "true" ? "[" : "(";
      label = fields.lo === fields.hi ? fields.lo : `${start}${fields.lo}, ${fields.hi}]`;
    }
    return { label, count: Number(fields.n) };
  });
  const approximate = column.type === "DECIMAL" && !discrete;
  return { name, numeric, values, outliers, ...(approximate ? { approximate } : {}) };
}

function histogramQuery(x, discrete, decimalScale) {
  let value = discrete ? "source_value::HUGEINT" : "source_value::DOUBLE";
  if (decimalScale > 0) value = `(source_value * ${10n ** BigInt(decimalScale)}::HUGEINT)::HUGEINT`;
  const lower = discrete ? "coalesce(previous_endpoint + 1, lo)" : "coalesce(previous_endpoint, lo)";
  const upper = discrete ? `least(hi, lo + step * ((hi - lo + ${bins}) // ${bins}) - 1)`
    : `CASE WHEN step = ${bins} THEN hi
        ELSE least(hi, greatest(lo, (lo / scale + (hi / scale - lo / scale) * (step / ${bins})) * scale)) END`;
  const outlier = discrete
    ? "2 * (q1 - value) > 3 * (q3 - q1) OR 2 * (value - q3) > 3 * (q3 - q1)"
    : "(q1 / scale - value / scale) > 1.5 * (q3 / scale - q1 / scale) OR (value / scale - q3 / scale) > 1.5 * (q3 / scale - q1 / scale)";
  const edge = expression => decimalScale > 0
    ? `((${expression}) * 0.${"0".repeat(decimalScale - 1)}1::DECIMAL(${decimalScale + 1}, ${decimalScale}))::VARCHAR`
    : `(${expression})::VARCHAR`;
  return `WITH source AS (SELECT ${x} AS source_value FROM parquet_data),
    data AS (SELECT ${value} AS value FROM source WHERE isfinite(source_value::DOUBLE)),
    bounds AS (SELECT min(value) AS lo, max(value) AS hi,
      quantile_disc(value, 0.25) AS q1, quantile_disc(value, 0.75) AS q3 FROM data),
    scaled AS (SELECT *, CASE WHEN isfinite(hi - lo) THEN 1 ELSE 2 END AS scale FROM bounds),
    edges AS (SELECT DISTINCT ${upper} AS endpoint
      FROM scaled CROSS JOIN range(1, ${bins + 1}) AS grid(step) WHERE lo IS NOT NULL),
    spec AS (SELECT list(endpoint ORDER BY endpoint) AS endpoints FROM edges),
    counts AS (SELECT histogram(value, endpoints) AS frequencies,
      count(*) FILTER (WHERE ${outlier}) AS outliers FROM data CROSS JOIN scaled CROSS JOIN spec),
    intervals AS (SELECT endpoint, lag(endpoint) OVER (ORDER BY endpoint) AS previous_endpoint FROM edges)
    SELECT ${edge(lower)} AS lo, ${edge("endpoint")} AS hi,
      coalesce(map_extract_value(frequencies, endpoint), 0) AS n,
      outliers, previous_endpoint IS NULL AS first_bin
    FROM intervals CROSS JOIN bounds CROSS JOIN counts ORDER BY endpoint`;
}

export function profileHtml(report, distribution) {
  const sections = (Array.isArray(distribution) ? distribution : [distribution]).filter(Boolean).map(distributionHtml).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parquet profile</title><style>
:root { color-scheme: light dark; font: 16px system-ui, sans-serif; }
body { margin: 2rem auto; max-width: 78rem; padding: 0 1rem; }
section { margin-block: 2rem; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: .5rem; text-align: left; vertical-align: top; border-bottom: 1px solid GrayText; }
td, th { overflow-wrap: anywhere; }
dl { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; }
dd { margin: .25rem 0 0; font-weight: 600; }
small { color: GrayText; }
meter { width: 100%; min-width: 5rem; }
</style></head><body><h1>Parquet profile</h1>${summaryHtml(report)}${sections}</body></html>`;
}

function summaryHtml(report) {
  const missing = report.columns.reduce((sum, column) => sum + BigInt(column.missing), 0n);
  const duplicate = report.duplicates == null ? "Unavailable" : formatCount(report.duplicates);
  const columns = report.columns.map(column => columnHtml(column, report.rows)).join("");
  return `<section><h2>Dataset overview</h2>${report.name ? `<p>${escapeHtml(report.name)}</p>` : ""}<dl>
    <div><dt>Rows</dt><dd>${formatCount(report.rows)}</dd></div>
    <div><dt>Columns</dt><dd>${formatCount(report.columns.length)}</dd></div>
    <div><dt>Missing cells</dt><dd>${formatCount(missing)}</dd></div>
    <div><dt>Duplicate rows</dt><dd>${duplicate}</dd></div>
  </dl><p>Duplicate rows count each occurrence after the first identical full row.</p>
  ${report.duplicateError ? `<p>${escapeHtml(report.duplicateError)}</p>` : ""}</section>
  <section><h2>Column profiles</h2><table><thead><tr>
    <th scope="col">Column</th><th scope="col">Type</th><th scope="col">Missing</th>
    <th scope="col">Distinct</th><th scope="col">Statistics</th><th scope="col">Quality alerts</th>
  </tr></thead><tbody>${columns}</tbody></table>
  <p><small>Missing counts include nulls. Distinct counts exclude nulls. Numeric ranges, means, and quartiles use finite values. Quartiles use observed values.</small></p></section>`;
}

function columnHtml(column, rowCount) {
  const present = rowCount - column.missing;
  const alerts = [];
  if (column.missing) alerts.push(column.missing === rowCount ? "All values missing" : "Missing values");
  if (present > 1 && column.distinct_values === 1) alerts.push("Constant");
  if (present > 1 && present === column.distinct_values) alerts.push("All present values distinct");
  if (column.zeros) alerts.push(`${formatCount(column.zeros)} zero values`);
  if (column.non_finite) alerts.push(`${formatCount(column.non_finite)} non-finite values`);
  const stats = [];
  if (column.kind === "numeric" || column.kind === "temporal") {
    stats.push(["Min", column.minimum], ["Max", column.maximum]);
  }
  if (column.kind === "numeric") {
    const [q1, median, q3] = column.quartiles ?? [];
    const mean = Number.isFinite(Number(column.mean)) ? column.mean : null;
    stats.push(["Mean (approx.)", mean], ["Sample SD (approx.)", column.sd], ["Q1", q1], ["Median", median], ["Q3", q3]);
  }
  if (column.kind === "boolean") {
    stats.push(["True", formatCount(column.true_values)], ["False", formatCount(present - column.true_values)]);
  }
  const details = stats.map(([label, value]) => `${label} ${escapeHtml(value ?? "unavailable")}`).join("<br>");
  const missing = rowCount ? ` (${percent.format(column.missing / rowCount)})` : "";
  return `<tr><th scope="row">${escapeHtml(column.name)}</th><td>${escapeHtml(column.type)}</td>
    <td>${formatCount(column.missing)}${missing}</td><td>${formatCount(column.distinct_values)}</td>
    <td>${details || "None"}</td><td>${alerts.join("<br>") || "None"}</td></tr>`;
}

function distributionHtml(distribution) {
  const { name, numeric, values, outliers, error, approximate } = distribution;
  const heading = `<h2>Distribution of ${escapeHtml(name)}</h2>`;
  if (error) return `<section>${heading}<p>${escapeHtml(error)}</p></section>`;
  if (!values.length) return `<section>${heading}<p>${numeric ? "No finite values." : "No present values."}</p></section>`;
  const max = Math.max(...values.map(({ count }) => count));
  const rows = values.map(({ label, count }) => `<tr><th scope="row">${escapeHtml(label || "(empty string)")}</th>
    <td>${formatCount(count)}</td><td><meter min="0" max="${max}" value="${count}" aria-label="Count"></meter></td></tr>`).join("");
  const note = numeric ? `${formatCount(outliers)} outliers beyond 1.5 times the interquartile range from Q1 or Q3.`
    : `Up to ${bins} most frequent non-null values.`;
  return `<section>${heading}<p>${note}</p>${approximate ? "<p>Bins and outlier counts use floating-point approximations.</p>" : ""}
    <table><thead><tr><th scope="col">${numeric ? "Bin" : "Value"}</th>
    <th scope="col">Count</th><th scope="col">Frequency</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function formatCount(value) {
  return value.toLocaleString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
