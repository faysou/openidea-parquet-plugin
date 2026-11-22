import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { createGridFilters } from "../src/grid-filter.js";

const duckdbAvailable = spawnSync("duckdb", ["--version"], { stdio: "ignore" }).status === 0;
const fixture = fileURLToPath(new URL("./fixtures/synthetic-trades.parquet", import.meta.url));

test("combines page filters and cycles exact bigint ordering with source row numbers", async () => {
  const rows = [
    [9007199254740995n, "trade", new Date("2026-01-02")],
    [null, "trade", new Date("2026-01-02")],
    [9007199254740994n, "quote", new Date("2026-01-02")],
    [9007199254740993n, "trade", new Date("2026-01-02")],
    [9007199254740993n, "trade", new Date("2026-01-02")],
    [9007199254740992n, "trade", new Date("2026-01-01")],
  ];
  const changes = [];
  const grid = createGridFilters({
    file: { columns: ["sequence", "event", "date"], pageSize: 6 },
    onChange: change => changes.push(change),
  });
  grid.setFilter(1, ["trade"]);
  grid.setFilter(2, [new Date("2026-01-02")]);
  grid.cycleSort(0);
  assert.deepEqual(grid.applyPage(rows, 100), {
    rows: [rows[3], rows[4], rows[0], rows[1]],
    rowNumbers: [104, 105, 101, 102],
  });
  grid.cycleSort(0);
  assert.deepEqual(grid.applyPage(rows, 100).rowNumbers, [101, 104, 105, 102]);
  grid.cycleSort(0);
  assert.deepEqual(grid.applyPage(rows, 100).rowNumbers, [101, 102, 104, 105]);
  assert.deepEqual(await grid.values(0, rows), {
    options: [9007199254740992n, 9007199254740993n, 9007199254740994n, 9007199254740995n, null],
    truncated: false,
  });
  assert.deepEqual(changes[2], { resetOffset: false, focus: { index: 0, control: "sort" } });
});

test("orders native dates and numbers while retaining page navigation when a page has no matches", async () => {
  const rows = [
    [new Date("2026-01-10"), 5],
    [null, NaN],
    [new Date("2026-01-02"), -1],
    [new Date("2026-01-10"), 0],
  ];
  const file = { columns: ["date", "value"], total: 12, pageSize: 4, readPage: async () => rows };
  const grid = createGridFilters({ file, query: () => assert.fail("Unexpected DuckDB request") });
  grid.cycleSort(0);
  assert.deepEqual(grid.applyPage(rows, 0).rowNumbers, [3, 1, 4, 2]);
  grid.cycleSort(1);
  assert.deepEqual(grid.applyPage(rows, 0).rowNumbers, [3, 4, 1, 2]);

  grid.setFilter(0, [new Date("2026-01-01")]);
  assert.deepEqual(await grid.readPage(4), { rows: [], rowNumbers: [], sourceRows: rows, hasNext: true });
  grid.setScope("file");
  assert.equal(grid.active(), false);
  assert.deepEqual(await grid.readPage(4), { rows, rowNumbers: [5, 6, 7, 8], sourceRows: rows, hasNext: true });
  grid.setScope("page");
  assert.equal(grid.active(), true);
  grid.clear();
  assert.deepEqual(grid.applyPage(rows, 4), { rows, rowNumbers: [5, 6, 7, 8] });
});

test("discovers and filters values beyond the native page with exact BIGINT ordering", { skip: !duckdbAvailable }, async () => {
  const file = {
    columns: ["sequence", "timestamp", "event", "price", "tags"],
    pageSize: 2,
    readPage: () => assert.fail("Expected DuckDB paging with active conditions"),
  };
  const grid = createGridFilters({ file, query: request => query(`SELECT * FROM read_parquet(${quote(fixture)})`, request) });
  grid.setScope("file");
  const { options, truncated } = await grid.values(0, [], "900719925474122");
  assert.deepEqual(options, ["9007199254741220", "9007199254741221", "9007199254741222", "9007199254741223", "9007199254741224", "9007199254741225", "9007199254741226", "9007199254741227"]);
  assert.equal(truncated, false);
  const firstValues = await grid.values(0, []);
  assert.equal(firstValues.options.length, 200);
  assert.equal(firstValues.truncated, true);

  grid.setFilter(0, ["9007199254741223", "9007199254741225", "9007199254741227", "9007199254741226"]);
  grid.cycleSort(0);
  grid.cycleSort(0);
  const first = await grid.readPage(0);
  const second = await grid.readPage(2);
  const end = await grid.readPage(4);
  assert.deepEqual(first.rows.map(row => row[0]), ["9007199254741227", "9007199254741226"]);
  assert.deepEqual(first.rowNumbers, [235, 234]);
  assert.equal(first.hasNext, true);
  assert.deepEqual(second.rows.map(row => row[0]), ["9007199254741225", "9007199254741223"]);
  assert.deepEqual(second.rowNumbers, [233, 231]);
  assert.equal(second.hasNext, false);
  assert.deepEqual(end, { rows: [], rowNumbers: [], hasNext: false });
});

test("retains typed timestamp precision, quoted strings, nulls, and tied source order in file scope", { skip: !duckdbAvailable }, async () => {
  const source = `SELECT * FROM (VALUES
    (TIMESTAMP_NS '2026-01-02 12:00:00.000000002', 'Alice''s' || chr(0) || ' trade', 42),
    (TIMESTAMP_NS '2026-01-02 12:00:00.000000001', NULL, 43),
    (TIMESTAMP_NS '2026-01-02 12:00:00.000000001', 'Alice''s' || chr(0) || ' trade', 44),
    (TIMESTAMP_NS '2026-01-02 12:00:00.000000003', 'excluded', 45),
    (NULL, NULL, 46)) t("time""stamp", "event", "__PARQUET_GRID_ROW")`;
  const grid = createGridFilters({
    file: { columns: ['time"stamp', "event", "__PARQUET_GRID_ROW"], pageSize: 2 },
    query: request => query(source, request),
  });
  grid.setScope("file");
  const values = await grid.values(0, []);
  assert.deepEqual(values, { options: [
    "2026-01-02 12:00:00.000000001",
    "2026-01-02 12:00:00.000000002",
    "2026-01-02 12:00:00.000000003",
    null,
  ], truncated: false });
  grid.setFilter(0, [values.options[0], values.options[1], null]);
  grid.setFilter(1, ["Alice's\0 trade", null]);
  grid.cycleSort(0);
  assert.deepEqual(await grid.readPage(0), {
    rows: [
      ["2026-01-02 12:00:00.000000001", null, "43"],
      ["2026-01-02 12:00:00.000000001", "Alice's\0 trade", "44"],
    ],
    rowNumbers: [2, 3],
    hasNext: true,
  });
  assert.deepEqual(await grid.readPage(2), {
    rows: [
      ["2026-01-02 12:00:00.000000002", "Alice's\0 trade", "42"],
      [null, null, "46"],
    ],
    rowNumbers: [1, 5],
    hasNext: false,
  });
});

test("preserves nested record shape and exact wide integer leaves from the bridge", async () => {
  const file = {
    columns: ["id", "attributes", "notes", "payload"],
    schema: [
      { element: { name: "id" }, children: [] },
      { element: { name: "attributes" }, children: [{ element: { name: "field" } }] },
      { element: { name: "notes" }, children: [] },
      { element: { name: "payload", repetition_type: "REPEATED" }, children: [] },
    ],
    pageSize: 2,
  };
  const quoted = 'literal "9007199254740993"';
  const attributes = `{"name":${JSON.stringify(quoted)},"values":[-9223372036854775808,{"wide":18446744073709551615,"small":7,"ratio":1e2}],"present":true}`;
  const grid = createGridFilters({
    file,
    query: async () => ({
      columns: [...file.columns, "__parquet_grid_row"],
      rows: [
        ["500", attributes, "[9007199254740993]", null, "18"],
        ["501", null, "text", "[9007199254740991,9007199254740992]", "21"],
      ],
      truncated: false,
    }),
  });
  grid.setScope("file");
  grid.cycleSort(0);
  assert.deepEqual(await grid.readPage(0), {
    rows: [
      ["500", {
        name: quoted,
        values: ["-9223372036854775808", { wide: "18446744073709551615", small: 7, ratio: 100 }],
        present: true,
      }, "[9007199254740993]", null],
      ["501", null, "text", [9007199254740991, "9007199254740992"]],
    ],
    rowNumbers: [18, 21],
    hasNext: false,
  });
});

test("fetches a 250-row file page in bounded batches with stable ordering and lookahead", { skip: !duckdbAvailable }, async () => {
  const source = "SELECT i AS id, i // 5 AS bucket FROM range(502) t(i)";
  const file = { columns: ["id", "bucket"], pageSize: 250 };
  const requests = [];
  const grid = createGridFilters({
    file,
    query: request => {
      requests.push(request.sql.match(/LIMIT (\d+) OFFSET (\d+)$/).slice(1).map(Number));
      return query(source, request);
    },
  });
  grid.setScope("file");
  grid.cycleSort(1);
  grid.cycleSort(1);
  const first = await grid.readPage(0);
  const second = await grid.readPage(250);
  const last = await grid.readPage(500);
  assert.deepEqual(requests, [[200, 0], [51, 200], [200, 250], [51, 450], [200, 500]]);
  const numbers = [501, 502, ...Array.from({ length: 100 }, (_, group) =>
    Array.from({ length: 5 }, (_, n) => (99 - group) * 5 + n + 1)).flat()];
  assert.deepEqual(first, expected(0, 250, true));
  assert.deepEqual(second, expected(250, 500, true));
  assert.deepEqual(last, expected(500, 502, false));

  file.pageSize = 200;
  requests.length = 0;
  assert.deepEqual(await grid.readPage(0), expected(0, 200, true));
  assert.deepEqual(await grid.readPage(302), expected(302, 502, false));
  assert.deepEqual(requests, [[201, 0], [201, 302]]);

  function expected(start, end, hasNext) {
    const rowNumbers = numbers.slice(start, end);
    const rows = rowNumbers.map(number => [String(number - 1), String(Math.floor((number - 1) / 5))]);
    return { rows, rowNumbers, hasNext };
  }
});

function quote(text) {
  return `'${text.replaceAll("'", "''")}'`;
}

function query(source, { sql }) {
  const command = `SET threads = 2; CREATE VIEW parquet_data AS ${source}; SELECT * FROM query(${quote(sql)}) LIMIT 201;`;
  const marker = "__PARQUET_TEST_NULL__";
  const { status, stdout, stderr } = spawnSync(
    "duckdb", ["-batch", "-bail", "-csv", "-nullvalue", marker, "-no-stdin", "-no-init", "-c", command],
    { encoding: "utf8" },
  );
  assert.equal(status, 0, stderr);
  const { data, errors } = Papa.parse(stdout, { delimiter: ",", skipEmptyLines: true });
  assert.deepEqual(errors, []);
  const [columns = [], ...records] = data;
  const rows = records.slice(0, 200).map(row => row.map(value => value === marker ? null : value));
  return { columns, rows, truncated: records.length > 200 };
}
