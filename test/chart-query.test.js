import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chartQuery } from "../src/chart-query.js";

const duckdbAvailable = spawnSync("duckdb", ["--version"], { stdio: "ignore" }).status === 0;
const quote = text => `'${text.replaceAll("'", "''")}'`;

test("keeps integer and decimal bin starts exact beyond JavaScript number precision", { skip: !duckdbAvailable }, () => {
  const integer = query(
    "SELECT i AS x FROM range(9007199254740993, 9007199254741000) t(i)",
    "histogram", "x", undefined, 3,
  );
  assert.deepEqual(integer, [
    ["9007199254740993", "2"], ["9007199254740995", "2"], ["9007199254740997", "3"],
  ]);

  const decimal = query(
    `SELECT x FROM (VALUES (99999999999999999999.000000000001), (99999999999999999999.000000000002),
      (99999999999999999999.000000000003), (99999999999999999999.000000000004)) t(x)`,
    "histogram", "x", undefined, 2,
  );
  assert.deepEqual(decimal, [
    ["99999999999999999999.000000000001", "2"], ["99999999999999999999.000000000003", "2"],
  ]);

  const wideDecimal = query(
    `SELECT x FROM (VALUES (-9999999999999999999999999999999999999.9), (-0.1), (0.0),
      (9999999999999999999999999999999999999.9)) t(x)`,
    "histogram", "x", undefined, 2,
  );
  assert.deepEqual(wideDecimal, [
    ["-9999999999999999999999999999999999999.9", "2"], ["0.0", "2"],
  ]);
});

test("bins extreme finite floats and excludes null and non-finite observations", { skip: !duckdbAvailable }, () => {
  const rows = query(
    `SELECT x FROM (VALUES (-1.79e308), (-1e308), (-1.), (0.), (1e308), (1.79e308),
      ('-Infinity'::DOUBLE), ('NaN'::DOUBLE), (NULL)) t(x)`,
    "histogram", "x", undefined, 4,
  );
  assert.deepEqual(rows.map(([start, count]) => [Number(start), Number(count)]), [
    [-1.79e308, 2], [-8.950000000000001e307, 1], [0, 1], [8.950000000000001e307, 2],
  ]);
});

test("handles constant, sparse, and empty histograms", { skip: !duckdbAvailable }, () => {
  assert.deepEqual(query("SELECT 42.17 AS x FROM range(9)", "histogram", "x", undefined, 8), [
    ["42.17", "9"],
  ]);
  assert.deepEqual(query("SELECT i AS x FROM range(2) t(i)", "histogram", "x", undefined, 8), [
    ["0", "1"], ["1", "1"],
  ]);
  assert.deepEqual(query("SELECT NULL::DOUBLE AS x", "histogram", "x", undefined, 8), []);
  assert.throws(() => chartQuery("histogram", "x", undefined, 101), /bin count/);
});

test("samples valid pairs across the Parquet file reproducibly", { skip: !duckdbAvailable }, () => {
  const fixture = fileURLToPath(new URL("./fixtures/synthetic-trades.parquet", import.meta.url));
  const source = `SELECT *, row_number() OVER () AS ordinal, 'label source column' AS label, 'value source column' AS value
    FROM read_parquet(${quote(fixture)})`;
  const rows = query(source, "scatter", "ordinal", "ordinal");
  assert.equal(rows.length, 200);
  assert.deepEqual(rows, query(source, "scatter", "ordinal", "ordinal"));
  assert.ok(rows.some(([ordinal]) => Number(ordinal) > 200));
  assert.ok(rows.every(([x, y]) => x === y && Number.isFinite(Number(x))));

  const alias = query(`SELECT * FROM (VALUES (1.2, 2.1), ('NaN'::DOUBLE, 7.0),
    (1.0, 'Infinity'::DOUBLE), (NULL, 2.0)) t(label, value)`, "scatter", "label", "value");
  assert.deepEqual(alias, [["1.2", "2.1"]]);
});

test("keeps time-zone instants and finite means in the line and area charts", { skip: !duckdbAvailable }, () => {
  const source = `SELECT * FROM (VALUES (TIMESTAMPTZ '2026-01-01 02:00:00+02', 1e308),
    (TIMESTAMPTZ '2025-12-31 19:00:00-05', 1e308), ('infinity'::TIMESTAMPTZ, -1e305),
    (TIMESTAMPTZ '2026-01-01 02:00:03+02', 0.0)) t(t, y)`;
  const result = [["1767225600000", "1e+308"], ["1767225602990", "0"]];
  assert.deepEqual(query(source, "line", "t", "y"), result);
  assert.deepEqual(query(source, "area", "t", "y"), result);

  const longSeries = query(`SELECT make_timestamp(i * 1000) AS t, i AS y FROM range(241) t(i)`,
    "line", "t", "y");
  assert.equal(longSeries.length, 81);
  assert.deepEqual(longSeries[0], ["0", "1"]);
  assert.deepEqual(longSeries.at(-1), ["240", "240"]);
});

test("orders category ties and caps count and pie charts", { skip: !duckdbAvailable }, () => {
  const source = "SELECT concat('c', rpad(cast(i AS VARCHAR), 3, 'x')) AS x FROM range(30) t(i)";
  const count = query(source, "bar", "x");
  assert.equal(count.length, 20);
  assert.deepEqual(count, query(source, "pie", "x"));
  assert.deepEqual(count.slice(0, 3), [["c0xx", "1"], ["c10x", "1"], ["c11x", "1"]]);
});

test("averages each measure and group independently on the same time axis", { skip: !duckdbAvailable }, () => {
  const source = `SELECT make_timestamp_ms(ms) AS "when", a AS "bid""price", b, g
    FROM (VALUES (0, 2, 'Infinity'::DOUBLE, 'red'), (0, 4, 30, 'red'), (1, 10, NULL, 'red'),
      (0, 11, NULL, NULL), (1, NULL, 15, '(null)'), (NULL, 100, 100, 'ignored')) t(ms, a, b, g)`;
  assert.deepEqual(chartRows(source, "line", "when", ['bid"price', "b"], undefined, { group: "g" }), [
    { series_number: 0, group_label: "red", group_count: 3, points: [["0", "3.0"], ["1", "10.0"]] },
    { series_number: 0, group_label: null, group_count: 3, points: [["0", "11.0"]] },
    { series_number: 1, group_label: "red", group_count: 3, points: [["0", "30.0"]] },
    { series_number: 1, group_label: "(null)", group_count: 3, points: [["1", "15.0"]] },
  ]);
  assert.deepEqual(chartRows(source, "area", "when", ["b"]), [
    { series_number: 0, group_label: null, group_count: 1, points: [["0", "30.0"], ["1", "15.0"]] },
  ]);
});

test("keeps complete independent samples for the most frequent groups", { skip: !duckdbAvailable }, () => {
  const source = `SELECT i AS x, i * 10 AS a, i * -100 AS b, cast(i % 4 AS VARCHAR) AS g
    FROM range(1200) t(i)`;
  const options = ["scatter", "x", ["a", "b"], undefined, { group: "g" }];
  const rows = chartRows(source, ...options);
  assert.deepEqual(rows, chartRows(source, ...options));
  assert.deepEqual(rows.map(({ series_number, group_label, group_count, points }) =>
    [series_number, group_label, group_count, points.length]), [
    [0, "0", 4, 200], [0, "1", 4, 200], [0, "2", 4, 200],
    [1, "0", 4, 200], [1, "1", 4, 200], [1, "2", 4, 200],
  ]);
  for (const { series_number, group_label, points } of rows) {
    assert.equal(new Set(points.map(([x]) => x)).size, 200);
    for (const [x, value] of points) {
      assert.equal(Number(x) % 4, Number(group_label));
      assert.equal(Number(value), Number(x) * (series_number ? -100 : 10) || 0);
    }
  }
});

function query(source, ...options) {
  return chartRows(source, ...options).map(({ label, value }) => [String(label), String(value)]);
}

function chartRows(source, ...options) {
  const sql = `SET threads=2; SET TimeZone='America/New_York';
    CREATE VIEW parquet_data AS ${source};
    SELECT * FROM query(${quote(chartQuery(...options))}) LIMIT 201;`;
  const { status, stdout, stderr } = spawnSync("duckdb", [
    "-no-init", "-no-stdin", "-batch", "-bail", "-json", "-c", sql,
  ], { encoding: "utf8" });
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout);
}
