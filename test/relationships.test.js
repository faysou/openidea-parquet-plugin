import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { relationshipColumns, relationshipDetail, relationshipPlan, relationshipRows } from "../src/relationships.js";

const hasDuckdb = spawnSync("duckdb", ["--version"]).status === 0;
const duckdbTest = { skip: hasDuckdb ? false : "DuckDB executable is unavailable" };

const price = { name: 'price"usd', type: "number" };
const size = { name: "size", type: "number" };
const event = { name: "event", type: "category" };
const active = { name: "active", type: "category" };
const timestamp = { name: "timestamp", type: "time" };
const data = `SELECT * FROM (VALUES
  (1.0, 3.0, 'open', true, DATE '2026-11-01'),
  (2.0, 2.0, 'close', true, DATE '2026-11-02'),
  (3.0, 1.0, 'halt', false, DATE '2026-11-03'),
  (NULL, 8.0, 'open', NULL, DATE '2026-11-04'),
  ('NaN'::DOUBLE, -7.0, 'close', NULL, NULL)
) AS values_table("price""usd", size, event, active, timestamp)`;

function run(sql, source = data) {
  const query = sql.replaceAll("'", "''");
  const result = spawnSync("duckdb", ["-no-init", "-batch", "-bail", "-json", "-no-stdin", "-c",
    `SET memory_limit = '256MiB'; SET threads = 2; SET temp_directory = ''; SET lock_configuration = true;
     CREATE VIEW parquet_data AS ${source}; SELECT * FROM query('${query}') LIMIT 201;`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  const columns = Object.keys(records[0] ?? {}).sort();
  const rows = records.map(record => columns.map(column => record[column] === null ? null : String(record[column])));
  return { columns, rows };
}

function runPlan({ pairs, queries }, source, target) {
  return relationshipRows(queries.map(sql => run(sql, source)), pairs, target);
}

test("selects supported top-level columns and orients pairs toward a target", () => {
  const node = (name, type, annotation, children = []) => ({
    element: { name, type, logical_type: annotation ? { type: annotation } : undefined }, children,
  });
  const list = node("list", undefined, "LIST", [node("item", "INT32")]);
  assert.deepEqual(relationshipColumns([
    node('price"usd', "DOUBLE"), node("event", "BYTE_ARRAY", "STRING"), node("active", "BOOLEAN"),
    node("timestamp", "INT64", "TIMESTAMP"), node("blob", "BYTE_ARRAY"), list,
    node("decimal", "FIXED_LEN_BYTE_ARRAY", "DECIMAL"), node("time", "INT64", "TIME"),
  ]), [price, event, active, timestamp, { name: "decimal", type: "number", exact: true }]);
  assert.deepEqual(relationshipPlan([active, size, event, timestamp], event).pairs, [
    { left: active, right: event, kind: "theil" }, { left: size, right: event, kind: "eta" },
  ]);
  assert.deepEqual(relationshipPlan([event, timestamp]), { pairs: [], queries: [] });
  assert.throws(() => relationshipPlan(Array(11).fill(price)), /Choose up to 10 columns/);
});

test("returns signed Pearson scores, both directions of Theil’s U, and mixed correlation ratios", duckdbTest, () => {
  const rows = runPlan(relationshipPlan([price, size, event, active, timestamp]));
  const indices = rows.map(({ left, right }) => `${left.name}/${right.name}`);
  const pair = (a, b) => rows[indices.indexOf(`${a.name}/${b.name}`)];
  assert.deepEqual(pair(price, size), { left: price, right: size, kind: "pearson", count: 3, score: -1, reverse: null, reason: null });
  assert.deepEqual(pair(price, event), { left: price, right: event, kind: "eta", count: 3, score: 1, reverse: null, reason: null });
  assert.equal(pair(price, active).score, Math.sqrt(0.75));
  assert.deepEqual(pair(event, active), { left: event, right: active, kind: "theil", count: 3, score: 1,
    reverse: (2 * Math.log(1.5) + Math.log(3)) / (3 * Math.log(3)), reason: null });
  assert.deepEqual(pair(price, timestamp), { left: price, right: timestamp, kind: "time", count: 3, score: null, reverse: null, reason: null });
  assert.equal(rows[0].kind, "pearson");
});

test("marks a constant numeric pair undefined and suppresses scores for high-cardinality categories", duckdbTest, () => {
  const rows = runPlan(relationshipPlan([price, size, event, active]),
    `SELECT 1 AS "price""usd", i AS size, i::VARCHAR AS event, i % 2 = 0 AS active FROM range(51) AS t(i)`);
  assert.deepEqual(rows.find(row => row.left === price && row.right === size), {
    left: price, right: size, kind: "pearson", count: 51, score: null, reverse: null, reason: null,
  });
  for (const row of rows.filter(row => row.left === event || row.right === event)) {
    assert.equal(row.count, 51);
    assert.equal(row.score, null);
    assert.equal(row.reverse, null);
    assert.equal(row.reason, "More than 50 categories");
  }
});

test("bounds the analysis sample and preserves counts when no complete pairs exist", duckdbTest, () => {
  const rows = runPlan(relationshipPlan([price, size, event]),
    `SELECT i AS "price""usd", -i AS size, NULL::VARCHAR AS event FROM range(12000) AS t(i)`);
  assert.deepEqual(rows.map(row => [row.kind, row.count]), [["pearson", 10000], ["eta", 0], ["eta", 0]]);
  assert.equal(rows[0].score.toFixed(12), "-1.000000000000");
  assert.deepEqual(rows.slice(1).map(row => row.score), [null, null]);
});

test("centers exact integer and decimal values within complete pairs before converting to doubles", duckdbTest, () => {
  const number = name => ({ name, type: "number", exact: true });
  const [big, negative, decimal] = [number("big"), number("negative"), number("decimal")];
  const rows = runPlan(relationshipPlan([big, negative, decimal, size], size), `SELECT * FROM (VALUES
    (9007199254740992::UBIGINT, -9223372036854775807::BIGINT, 12345678901234567890.00000005::DECIMAL(38, 8), 1::DOUBLE),
    (9007199254740993::UBIGINT, '-9223372036854775808'::BIGINT, 12345678901234567890.00000006::DECIMAL(38, 8), 2::DOUBLE),
    (0::UBIGINT, 0::BIGINT, 0::DECIMAL(38, 8), 'NaN'::DOUBLE)
  ) AS t(big, negative, decimal, size)`, size);
  assert.deepEqual(rows.map(({ left, count, score }) => [left.name, count, score]), [
    ["big", 2, 1], ["negative", 2, -1], ["decimal", 2, 1],
  ]);
});

test("processes a ten-column categorical matrix within the DuckDB bridge memory limit", duckdbTest, () => {
  const columns = Array.from({ length: 10 }, (_, index) => ({ name: `field_${index}`, type: "category" }));
  const projection = columns.map(({ name }, index) => `((i + ${index}) % 40)::VARCHAR AS ${name}`);
  const rows = runPlan(relationshipPlan(columns), `SELECT ${projection.join(", ")} FROM range(200) AS t(i)`);
  assert.equal(rows.length, 45);
  assert.equal(new Set(rows.map(({ left, right }) => `${left.name}/${right.name}`)).size, 45);
  for (const row of rows) {
    assert.equal(row.count, 200);
    assert.equal(row.score.toFixed(12), "1.000000000000");
    assert.equal(row.reverse.toFixed(12), "1.000000000000");
    assert.equal(row.reason, null);
  }
});

test("recommends and queries scatter, category means, category counts, and a time series", duckdbTest, () => {
  const { pairs } = relationshipPlan([price, size, event, active, timestamp]);
  const pair = (a, b) => pairs.find(({ left, right }) => left === a && right === b);
  const scatter = relationshipDetail(pair(price, size));
  assert.equal(scatter.type, "scatter");
  assert.deepEqual(run(scatter.sql).rows.sort(), [["1", "3"], ["2", "2"], ["3", "1"]]);
  const means = relationshipDetail(pair(price, active));
  assert.deepEqual(means.fields, ["active", "Rows", "Mean", "Min", "Max"]);
  assert.deepEqual(run(means.sql), {
    columns: ["count", "label", "maximum", "mean", "minimum"],
    rows: [["2", "true", "2", "1.5", "1"], ["1", "false", "3", "3", "3"]],
  });
  const counts = relationshipDetail(pair(event, active));
  assert.deepEqual(counts.fields, ["event", "active", "Rows", "Share of complete pairs"]);
  assert.deepEqual(run(counts.sql), {
    columns: ["count", "first_value", "second_value", "share"],
    rows: [["1", "close", "true", String(1 / 3)], ["1", "halt", "false", String(1 / 3)], ["1", "open", "true", String(1 / 3)]],
  });
  const time = relationshipDetail(pair(price, timestamp));
  assert.equal(time.type, "line");
  assert.equal(time.title, 'Average price"usd by timestamp');
  assert.deepEqual(run(time.sql).rows.map(([, value]) => value), ["1", "2", "3"]);
});
