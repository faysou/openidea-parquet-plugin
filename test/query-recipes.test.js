import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chartQuery, identifier } from "../src/chart-query.js";
import { recipes } from "../src/query-recipes.js";

const missingDuckDB = spawnSync("duckdb", ["--version"]).error?.code === "ENOENT";
test("query recipes preserve missingness, duplication, text lengths, time gaps, rolling means and outliers", { skip: missingDuckDB }, () => {
  const source = `CREATE VIEW parquet_data AS SELECT * FROM (VALUES
    ('ab', DATE '2020-01-01', 1), ('ab', DATE '2020-01-01', 1), ('c', DATE '2020-01-03', 1),
    (NULL, DATE '2020-01-03', 1), ('ab', DATE '2020-01-04', 100)) v("label", t, x);`;
  function run(sql) {
    const result = spawnSync("duckdb", ["-no-init", "-batch", "-bail", "-json", "-c", source + sql], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout || "[]");
  }
  const inputs = [[], [], ["label"], ["t"], ["t", "x"], ["x"]];
  const [missing, duplicates, lengths, gaps, averages, outliers] = recipes.map((recipe, i) => run(recipe.sql(inputs[i].map(identifier))));
  assert.deepEqual(missing, [{ missing_columns: [], records: 4 }, { missing_columns: ["label"], records: 1 }]);
  assert.deepEqual(duplicates, [{ record: { label: "ab", t: "2020-01-01", x: 1 }, copies: 2 }]);
  assert.deepEqual(lengths, [{ characters: 1, records: 1 }, { characters: 2, records: 3 }]);
  assert.deepEqual(gaps.map(row => row.gap), [2, 1]);
  assert.deepEqual(averages.map(row => row.moving_average_10), [1, 1, 34]);
  assert.deepEqual(outliers, [{ value: 100, capped_value: 1 }]);
  assert.deepEqual(run(chartQuery("scatter", "x", "x")).map(row => row.value).sort((a,b) => a-b), [1, 1, 1, 1, 100]);
});
