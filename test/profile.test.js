import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { profileData, profileDistribution, profileHtml } from "../src/profile.js";

const duckdbAvailable = spawnSync("duckdb", ["--version"]).status === 0;
const requiresDuckdb = { skip: !duckdbAvailable && "DuckDB CLI is not installed" };
const field = (name, type, logical_type) => ({ element: { name, type, logical_type }, children: [] });

function queryView(select) {
  return async sql => {
    const stdout = execFileSync("duckdb", ["-no-init", "-batch", "-bail", "-json", "-no-stdin", "-c",
      `CREATE VIEW parquet_data AS ${select}; SELECT * FROM query('${sql.replaceAll("'", "''")}') LIMIT 201;`,
    ], { encoding: "utf8" });
    const records = JSON.parse(stdout || "[]");
    const columns = Object.keys(records[0] ?? {}).sort();
    const rows = records.map(row => columns.map(name => {
      const value = row[name];
      return value == null || typeof value === "string" ? value : JSON.stringify(value);
    }));
    return { columns, rows, truncated: rows.length > 200 };
  };
}

test("counts full-row duplicates and profiles typed columns and missing values", requiresDuckdb, async () => {
  const schema = [
    field('large"id', "INT64"), field("price", "DOUBLE"), field("active", "BOOLEAN"),
    field("on_date", "INT32", { type: "DATE" }), field("label", "BYTE_ARRAY"), field("empty", "DOUBLE"),
  ];
  const query = queryView(`SELECT * FROM (VALUES
    (9007199254740993::BIGINT, 0::DOUBLE, true, DATE '2026-01-01', '<script>', NULL::DOUBLE),
    (9007199254740994, 1, false, DATE '2026-01-02', 'a', NULL),
    (9007199254740994, 1, false, DATE '2026-01-02', 'a', NULL),
    (9007199254740995, 2, true, DATE '2026-01-03', '', NULL),
    (9007199254740996, 100, NULL, NULL, 'a', NULL),
    (9007199254740997, 'NaN'::DOUBLE, NULL, DATE '2026-01-03', NULL, NULL),
    (9007199254740998, NULL, NULL, NULL, 'b', NULL)
  ) t("large""id", price, active, on_date, label, empty)`);
  const report = await profileData({ schema, total: 7 }, query);
  const [id, price, active, date, label, empty] = report.columns;
  assert.equal(report.rows, 7);
  assert.equal(report.duplicates, 1);
  assert.equal(report.duplicateError, undefined);
  assert.deepEqual([id.minimum, id.maximum, id.distinct_values, id.quartiles], [
    "9007199254740993", "9007199254740998", 6,
    ["9007199254740994", "9007199254740995", "9007199254740997"],
  ]);
  assert.ok(Math.abs(Number(price.sd) - 44.2797922307682) < 1e-12);
  assert.deepEqual(price, {
    name: "price", type: "DOUBLE", kind: "numeric", integral: false, missing: 1, distinct_values: 5,
    minimum: "0.0", maximum: "100.0", mean: "20.8", sd: price.sd, quartiles: ["1.0", "1.0", "2.0"],
    zeros: 1, non_finite: 1, true_values: null,
  });
  assert.deepEqual([active.missing, active.distinct_values, active.true_values], [3, 2, 2]);
  assert.deepEqual([date.kind, date.minimum, date.maximum, date.missing], ["temporal", "2026-01-01", "2026-01-03", 2]);
  assert.deepEqual([label.missing, label.distinct_values, label.quartiles], [1, 4, null]);
  assert.deepEqual([empty.missing, empty.distinct_values, empty.mean, empty.quartiles], [7, 0, null, null]);

  const [ids, prices, labels, empties] = await Promise.all([
    profileDistribution(id, query), profileDistribution(price, query),
    profileDistribution(label, query), profileDistribution(empty, query),
  ]);
  assert.deepEqual(ids.values, Array.from({ length: 6 }, (_, index) => ({
    label: String(9007199254740993n + BigInt(index)), count: index === 1 ? 2 : 1,
  })));
  assert.deepEqual(prices.values.map(({ count }) => count), [4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(prices.outliers, 1);
  assert.deepEqual(labels.values, [
    { label: "a", count: 3 }, { label: "", count: 1 }, { label: "<script>", count: 1 }, { label: "b", count: 1 },
  ]);
  assert.deepEqual(empties.values, []);
  const html = profileHtml({ ...report, name: "hostile <file>.parquet" }, labels);
  const all = profileHtml(report, [ids, prices, labels, empties]);
  assert.equal((all.match(/<h2>Distribution of /g) ?? []).length, 4);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /large&quot;id/);
  assert.match(html, /All values missing/);
  assert.match(html, /Mean \(approx\.\) unavailable/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /hostile &lt;file&gt;\.parquet/);
  assert.match(html, /\(empty string\)/);
  assert.doesNotMatch(html, /<script|<(?:img|link)[^>]+(?:href|src)=/i);
});

test("preserves decimal bins and reports large finite means", requiresDuckdb, async () => {
  const schema = [field("cost", "INT64", { type: "DECIMAL", precision: 18, scale: 1 }), field("big", "DOUBLE")];
  const query = queryView(`SELECT * FROM (VALUES
    (9007199254740993.1::DECIMAL(18,1), 1.7976931348623157e308::DOUBLE),
    (9007199254740993.2, 1.7976931348623157e308),
    (9007199254740993.3, 1.7976931348623157e308)
  ) t(cost, big)`);
  const { columns: [cost, big] } = await profileData({ schema, total: 3 }, query);
  const distribution = await profileDistribution(cost, query);
  assert.deepEqual([cost.type, cost.integral, cost.minimum, cost.maximum], [
    "DECIMAL", false, "9007199254740993.1", "9007199254740993.3",
  ]);
  assert.equal(Number(big.sd), 0);
  assert.equal(Number(cost.sd), 0.1);
  assert.equal(big.mean, "1.7976931348623157e+308");
  assert.deepEqual(distribution, {
    name: "cost", numeric: true, outliers: 0, values: [
      { label: "9007199254740993.1", count: 1 },
      { label: "9007199254740993.2", count: 1 },
      { label: "9007199254740993.3", count: 1 },
    ],
  });
});

test("profiles an empty typed table and a constant numeric distribution", requiresDuckdb, async () => {
  const schema = [field("x", "DOUBLE")];
  const emptyQuery = queryView("SELECT NULL::DOUBLE AS x WHERE false");
  const constantQuery = queryView("SELECT 0.3::DOUBLE AS x FROM range(3)");
  const report = await profileData({ schema, total: 0 }, emptyQuery);
  const constant = await profileData({ schema, total: 3 }, constantQuery);
  const distribution = await profileDistribution(constant.columns[0], constantQuery);
  assert.equal(report.duplicates, 0);
  assert.equal(report.columns[0].missing, 0);
  assert.equal(report.columns[0].minimum, null);
  assert.equal(constant.duplicates, 2);
  assert.match(profileHtml(constant, distribution), />Constant<\/td>/);
  assert.deepEqual(distribution, {
    name: "x", numeric: true, values: [{ label: "0.3", count: 3 }], outliers: 0,
  });
});

test("uses distinct ordered bins for adjacent and opposing extreme doubles", requiresDuckdb, async () => {
  const column = { name: "x", kind: "numeric", integral: false };
  const adjacent = await profileDistribution(column, queryView(`SELECT * FROM (VALUES
    (1.7976931348623155e308::DOUBLE), (1.7976931348623157e308::DOUBLE)
  ) t(x)`));
  const opposing = await profileDistribution(column, queryView(`SELECT * FROM (VALUES
    (-1.7976931348623157e308::DOUBLE), (0::DOUBLE), (1.7976931348623157e308::DOUBLE)
  ) t(x)`));
  assert.deepEqual(adjacent.values, [
    { label: "1.7976931348623155e+308", count: 1 },
    { label: "(1.7976931348623155e+308, 1.7976931348623157e+308]", count: 1 },
  ]);
  assert.deepEqual(opposing.values.map(({ count }) => count), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
});
