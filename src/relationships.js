import { duckdb } from "./duckdb.js";
import { chartQuery, identifier, numericColumn, scalarColumn, temporalColumn } from "./chart-query.js";

const MAX_COLUMNS = 10;
const PAIRS_PER_QUERY = 8;
const SAMPLE_ROWS = 10_000;
const MAX_CATEGORIES = 50;
const MAX_GROUPS = 20;

export function relationshipColumns(schema) {
  const columns = [];
  for (const node of schema.filter(scalarColumn)) {
    const { name, type, logical_type, converted_type } = node.element;
    if (temporalColumn(node)) columns.push({ name, type: "time" });
    else if (numericColumn(node)) {
      const exact = type === "INT64" || logical_type?.type === "DECIMAL" || converted_type === "DECIMAL";
      columns.push(exact ? { name, type: "number", exact } : { name, type: "number" });
    }
    else if (type === "BOOLEAN" || ["STRING", "ENUM"].includes(logical_type?.type) ||
      ["UTF8", "ENUM"].includes(converted_type)) columns.push({ name, type: "category" });
  }
  return columns;
}

export function relationshipPlan(columns, target) {
  const selected = columns.filter(column => column !== target);
  if (columns.length > MAX_COLUMNS) throw new Error(`Choose up to ${MAX_COLUMNS} columns.`);
  const pairs = [];
  for (const [index, left] of selected.entries()) {
    for (const right of target ? [target] : selected.slice(index + 1)) {
      const types = [left.type, right.type].sort().join("/");
      const kind = {
        "number/number": "pearson",
        "category/category": "theil",
        "category/number": "eta",
        "number/time": "time",
      }[types];
      if (kind) pairs.push({ left, right, kind });
    }
  }
  const queries = [];
  for (let offset = 0; offset < pairs.length; offset += PAIRS_PER_QUERY) {
    const batch = pairs.slice(offset, offset + PAIRS_PER_QUERY);
    const sources = [...new Set(batch.flatMap(({ left, right }) => [left, right]))];
    const statements = batch.map((pair, index) => {
      const left = `c${sources.indexOf(pair.left)}`;
      const right = `c${sources.indexOf(pair.right)}`;
      return `SELECT ${offset + index} AS pair, estimates.* FROM (${association(pair, left, right)}) AS estimates`;
    });
    queries.push(`${sample(sources, true)} ${statements.join(" UNION ALL ")}`);
  }
  return { pairs, queries };
}

export function relationshipRows(responses, pairs, target) {
  return responses.flatMap(({ columns, rows }) => {
    const positions = Object.fromEntries(columns.map((column, index) => [column, index]));
    return rows.map(row => ({
      ...pairs[Number(row[positions.pair])],
      count: Number(row[positions.complete]),
      score: numericResult(row[positions.score]),
      reverse: numericResult(row[positions.reverse]),
      reason: row[positions.reason],
    }));
  }).sort((left, right) => rank(right, target) - rank(left, target));
}

export function relationshipDetail({ left, right, kind }) {
  if (kind === "pearson") {
    return { type: "scatter", title: `${right.name} by ${left.name}`, sql: chartQuery("scatter", left.name, right.name) };
  }
  const [group, measure] = left.type === "number" ? [right, left] : [left, right];
  if (kind === "time") {
    return { type: "line", title: `Average ${measure.name} by ${group.name}`, sql: chartQuery("line", group.name, measure.name) };
  }
  if (kind === "eta") {
    return {
      type: "bar",
      title: `Average ${measure.name} by ${group.name}`,
      fields: [group.name, "Rows", "Mean", "Min", "Max"],
      keys: ["label", "count", "mean", "minimum", "maximum"],
      sql: `${sample([group, measure])}
        SELECT left(c0, 160) AS label, count(*) AS count, avg(c1) AS mean, min(c1) AS minimum, max(c1) AS maximum
        FROM sampled WHERE c0 IS NOT NULL AND isfinite(c1) GROUP BY c0 ORDER BY count DESC, c0 LIMIT ${MAX_GROUPS}`,
    };
  }
  return {
    type: "bar",
    title: `Counts by ${left.name} and ${right.name}`,
    fields: [left.name, right.name, "Rows", "Share of complete pairs"],
    keys: ["first_value", "second_value", "count", "share"],
    sql: `${sample([left, right])}
      SELECT left(c0, 160) AS first_value, left(c1, 160) AS second_value, count(*) AS count,
             count(*)::DOUBLE / sum(count(*)) OVER () AS share
      FROM sampled WHERE c0 IS NOT NULL AND c1 IS NOT NULL GROUP BY c0, c1 ORDER BY count DESC, c0, c1 LIMIT ${MAX_GROUPS}`,
  };
}

export function mountRelationships(container, file) {
  const columns = relationshipColumns(file.schema);
  const form = element("form");
  form.className = "relationship-options";
  const target = element("select");
  target.append(new Option("No target", ""));
  const selected = element("select");
  selected.multiple = true;
  selected.size = Math.max(2, Math.min(6, columns.length));
  for (const [index, { name }] of columns.entries()) {
    target.append(new Option(name, index));
    selected.append(new Option(name, index, index < MAX_COLUMNS, index < MAX_COLUMNS));
  }
  const analyze = element("button", "Analyze");
  analyze.type = "submit";
  form.append(field("Target column", target), field(`Columns to compare (up to ${MAX_COLUMNS})`, selected), analyze);
  const status = element("p");
  status.setAttribute("role", "status");
  const results = element("div");
  const detail = element("div");
  detail.className = "relationship-detail";
  container.replaceChildren(form, status, results, detail);

  let detailVersion = 0;
  let disposeChart;
  let running = false;
  if (columns.length < 2) {
    analyze.disabled = true;
    status.textContent = "Relationships need at least two numeric, categorical, or time columns.";
    return;
  }
  status.textContent = "Choose columns to find associations and recommended plots.";

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (running) return;
    const targetColumn = target.value === "" ? undefined : columns[Number(target.value)];
    const chosenColumns = Array.from(selected.selectedOptions, option => columns[Number(option.value)]);
    clearDetail();
    results.replaceChildren();
    try {
      const { pairs, queries } = relationshipPlan(chosenColumns, targetColumn);
      if (!pairs.length) {
        status.textContent = "Choose a numeric pair, a categorical pair, or a numeric column with a category or time column.";
        return;
      }
      running = true;
      target.disabled = selected.disabled = analyze.disabled = true;
      status.textContent = "Analyzing relationships…";
      const responses = [];
      let completed = 0;
      for (const sql of queries) {
        const response = await query(sql);
        responses.push(response);
        completed += response.rows.length;
        if (completed < pairs.length) status.textContent = `Analyzed ${completed} of ${pairs.length} relationships…`;
      }
      const rows = relationshipRows(responses, pairs, targetColumn);
      results.append(relationshipTable(rows, Boolean(targetColumn), showDetail));
      const sampleLabel = file.total > SAMPLE_ROWS ? `${SAMPLE_ROWS.toLocaleString()} sampled rows per pair` : `${file.total.toLocaleString()} rows`;
      status.textContent = `Analyzed ${sampleLabel}. Each score uses complete pairs.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      running = false;
      target.disabled = selected.disabled = analyze.disabled = false;
    }
  });

  function clearDetail() {
    detailVersion += 1;
    disposeChart?.();
    disposeChart = undefined;
    detail.replaceChildren();
  }

  async function showDetail(pair) {
    clearDetail();
    const version = detailVersion;
    const { title, sql, type, fields, keys } = relationshipDetail(pair);
    const caption = element("p", "Building plot…");
    caption.setAttribute("role", "status");
    const plot = element("div");
    plot.className = "relationship-plot";
    plot.setAttribute("role", "img");
    plot.setAttribute("aria-label", title);
    const heading = element("h3", title);
    heading.tabIndex = -1;
    detail.append(heading, caption);
    heading.focus();
    try {
      const response = await query(sql);
      if (version !== detailVersion) return;
      if (!response.rows.length) {
        caption.textContent = "No complete pairs to plot.";
        return;
      }
      const positions = Object.fromEntries(response.columns.map((column, index) => [column, index]));
      const values = response.rows.map(row => (keys ?? ["label", "value"]).map(key => row[positions[key]]));
      if (fields) detail.append(groupTable(fields, values, pair.kind === "theil"));
      const points = pair.kind === "eta" ? values.map(([label, , mean]) => [label, mean]) :
        pair.kind === "theil" ? values.map(([first, second, count]) => [`${first} / ${second}`, count]) : values;
      const { renderChart } = await import("./charts.js");
      if (version !== detailVersion) return;
      detail.append(plot);
      disposeChart = renderChart(plot, type, points);
      caption.textContent = fields ? `Up to ${MAX_GROUPS} groups with the most complete pairs${file.total > SAMPLE_ROWS ? " in a row sample" : ""}.` :
        type === "scatter" ? `${points.length.toLocaleString()} complete pairs sampled from the file.` : "Averages by time bucket.";
      if (pair.left.exact || pair.right.exact) caption.textContent += " Plot values use double precision.";
    } catch (error) {
      if (version === detailVersion) caption.textContent = error.message;
    }
  }
}

function sample(columns, preserveExact = false) {
  const expressions = columns.map(({ name, type, exact }, index) => {
    const value = identifier(name);
    const cast = { number: "DOUBLE", time: "TIMESTAMP", category: "VARCHAR" }[type];
    const expression = preserveExact && exact ? value : `try_cast(${value} AS ${cast})`;
    return `${expression} AS c${index}`;
  });
  return `WITH sampled AS MATERIALIZED (
    SELECT ${expressions.join(", ")} FROM parquet_data USING SAMPLE reservoir(${SAMPLE_ROWS} ROWS) REPEATABLE (42)
  )`;
}

function association({ left, right, kind }, a, b) {
  const valid = (column, name) => column.type === "category" || column.exact ? `${name} IS NOT NULL` : `isfinite(${name})`;
  const x = left.exact ? centered(a) : a;
  const y = right.exact ? centered(b) : b;
  const data = `SELECT ${x} AS x, ${y} AS y FROM sampled WHERE ${valid(left, a)} AND ${valid(right, b)}`;
  const single = "NULL AS reverse, NULL AS reason";
  if (kind === "pearson") {
    return `SELECT n AS complete, CASE WHEN isfinite(r) THEN r END AS score, ${single}
      FROM (SELECT count(*) AS n, corr(x, y) AS r FROM (${data}))`;
  }
  if (kind === "time") return `SELECT count(*) AS complete, NULL AS score, ${single} FROM (${data})`;

  const cardinality = `'More than ${MAX_CATEGORIES} categories'`;
  if (kind === "eta") {
    const [category, numeric] = left.type === "category" ? ["x", "y"] : ["y", "x"];
    return `WITH data AS (${data}),
      groups AS (SELECT count(*) AS n, var_pop(${numeric}) AS variance FROM data GROUP BY ${category}),
      whole AS (SELECT count(*) AS n, var_pop(${numeric}) AS variance FROM data),
      within_groups AS (SELECT count(*) AS categories, sum(n * variance) AS ss FROM groups)
      SELECT whole.n AS complete,
             CASE WHEN categories <= ${MAX_CATEGORIES} AND isfinite(whole.variance) AND whole.variance > 0
                  THEN sqrt(greatest(0, least(1, 1 - ss / (whole.n * whole.variance)))) END AS score,
             NULL AS reverse, CASE WHEN categories > ${MAX_CATEGORIES} THEN ${cardinality} END AS reason
      FROM whole CROSS JOIN within_groups`;
  }
  return `WITH joint AS (SELECT x, y, count(*)::DOUBLE AS n FROM (${data}) GROUP BY x, y),
    margins AS (SELECT *, sum(n) OVER () AS total, sum(n) OVER (PARTITION BY x) AS nx, sum(n) OVER (PARTITION BY y) AS ny FROM joint),
    entropy AS (SELECT coalesce(sum(n), 0)::BIGINT AS observations, count(DISTINCT x) AS dx, count(DISTINCT y) AS dy,
      sum(n * ln(n * total / (nx * ny))) AS information, sum(n * ln(total / nx)) AS hx, sum(n * ln(total / ny)) AS hy FROM margins)
    SELECT observations AS complete,
           CASE WHEN dx <= ${MAX_CATEGORIES} AND dy <= ${MAX_CATEGORIES} AND hy > 0 THEN greatest(0, least(1, information / hy)) END AS score,
           CASE WHEN dx <= ${MAX_CATEGORIES} AND dy <= ${MAX_CATEGORIES} AND hx > 0 THEN greatest(0, least(1, information / hx)) END AS reverse,
           CASE WHEN dx > ${MAX_CATEGORIES} OR dy > ${MAX_CATEGORIES} THEN ${cardinality} END AS reason FROM entropy`;
}

function centered(value) {
  const least = `min(${value}) OVER ()`;
  const greatest = `max(${value}) OVER ()`;
  // Subtract a same-sign baseline before rounding so nearby exact values stay distinct
  return `CASE WHEN ${least} > 0 THEN cast(${value} - ${least} AS DOUBLE)
              WHEN ${greatest} < 0 THEN cast(${value} - ${greatest} AS DOUBLE)
              ELSE cast(${value} AS DOUBLE) END`;
}

function numericResult(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rank({ score, reverse }, target) {
  return Math.max(score === null ? -1 : Math.abs(score), target ? -1 : reverse ?? -1);
}

function relationshipTable(rows, target, showDetail) {
  const result = table(["Column", target ? "Target" : "Other column", "Measure", "Score", "Complete pairs", "Recommended plot"], "Relationships");
  const body = result.createTBody();
  for (const pair of rows) {
    const { left, right, kind, count, score, reverse, reason } = pair;
    const measure = {
      pearson: "Pearson’s r",
      theil: target ? "Theil’s U (target given column)" : "Theil’s U",
      eta: "Correlation ratio η",
      time: "—",
    }[kind];
    const plot = { pearson: "Scatter plot", eta: "Group means", theil: "Group counts", time: "Time series" }[kind];
    const scoreText = kind === "theil" && !reason && !target ?
      `${formatScore(score)} (second given first), ${formatScore(reverse)} (first given second)` :
      reason ?? (kind === "time" ? "—" : formatScore(score));
    const row = body.insertRow();
    for (const value of [left.name, right.name, measure, scoreText, count.toLocaleString()]) row.insertCell().textContent = value;
    const button = element("button", plot);
    button.type = "button";
    button.disabled = count === 0;
    button.setAttribute("aria-label", `${plot} for ${left.name} and ${right.name}`);
    button.addEventListener("click", () => void showDetail(pair));
    row.insertCell().append(button);
  }
  return result;
}

function formatScore(value) {
  return value === null ? "Undefined" : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function groupTable(fields, values, shares) {
  const result = table(fields, "Group summary");
  const body = result.createTBody();
  for (const group of values) {
    const row = body.insertRow();
    for (const [index, value] of group.entries()) {
      row.insertCell().textContent = shares && index === 3 ? Number(value).toLocaleString(undefined, {
        style: "percent", maximumFractionDigits: 1,
      }) : value;
    }
  }
  return result;
}

function table(fields, name) {
  const result = element("table");
  result.setAttribute("aria-label", name);
  const header = result.createTHead().insertRow();
  for (const field of fields) {
    const cell = element("th", field);
    cell.scope = "col";
    header.append(cell);
  }
  return result;
}

function field(text, input) {
  const label = element("label", text);
  label.append(input);
  return label;
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function query(sql) {
  return duckdb({ sql });
}
