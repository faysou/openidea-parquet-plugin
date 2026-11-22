import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openParquet } from "../src/reader.js";

const fixture = new URL("./fixtures/synthetic-trades.parquet", import.meta.url);
const duckdbAvailable = spawnSync("duckdb", ["--version"], { stdio: "ignore" }).status === 0;
const quote = value => `'${value.replaceAll("'", "''")}'`;
let receive;
let setup;

globalThis.window = {
  openidea: {
    onMessage(callback) {
      receive = callback;
    },
    postMessage(text) {
      const { id, sql } = JSON.parse(text);
      const command = `SET threads=2; ${setup} SELECT * FROM query(${quote(sql)}) LIMIT 201;`;
      const { status, stdout, stderr } = spawnSync("duckdb", ["-batch", "-bail", "-json", "-no-stdin", "-no-init", "-c", command], { encoding: "utf8" });
      if (status !== 0) {
        receive(JSON.stringify({ id, error: stderr }));
        return;
      }
      const records = JSON.parse(stdout);
      const columns = Object.keys(records[0] ?? {});
      const rows = records.slice(0, 200).map(row => columns.map(name => row[name] == null ? null : String(row[name])));
      receive(JSON.stringify({ id, result: { columns, rows, truncated: records.length > 200 } }));
    },
  },
};

const { mountExplore } = await import("../src/explore.js");

test("explores rows beyond the preview with combined filters, ordered sorts, and a derived column", { skip: !duckdbAvailable }, async () => {
  setup = `CREATE VIEW parquet_data AS SELECT * FROM read_parquet(${quote(fileURLToPath(fixture))});`;
  const bytes = await readFile(fixture);
  const file = await openParquet({
    size: async () => bytes.length,
    readRange: async (offset, length) => bytes.subarray(offset, offset + length),
  });
  const panel = mount(file);
  const form = panel.children[0];
  await form.emit("submit");
  assert.equal(panel.children[1].textContent, "Showing the first 200 result rows.");

  await button(panel, "Add filter").emit("click");
  const [firstColumn, firstOperator, firstValue] = rules(panel, "Filters").children[0].children.map(node => node.children[0]);
  firstColumn.value = "sequence";
  await firstColumn.emit("change");
  firstOperator.value = ">";
  firstValue.value = "9007199254741219";

  await button(panel, "Add filter").emit("click");
  const [secondColumn, secondOperator, secondValue] = rules(panel, "Filters").children[1].children.map(node => node.children[0]);
  secondColumn.value = "event";
  await secondColumn.emit("change");
  secondOperator.value = "contains";
  secondValue.value = "o";

  await button(panel, "Add sort").emit("click");
  await button(panel, "Add sort").emit("click");
  const [primary, secondary] = rules(panel, "Sort order").children;
  primary.children[0].children[0].value = "event";
  secondary.children[0].children[0].value = "price";
  secondary.children[1].children[0].value = "DESC";
  for (const input of panel.findAll(node => node.type === "checkbox")) {
    input.checked = ["event", "price"].includes(input.value);
  }
  const source = field(panel, "Derived column source");
  source.value = "event";
  await source.emit("change");
  field(panel, "Transform").value = "upper";
  await form.emit("submit");

  assert.equal(panel.children[1].textContent, "6 result rows.");
  assert.deepEqual(table(panel), [
    ["event", "price", "event (Uppercase)"],
    ["quote", "207.61", "QUOTE"],
    ["quote", "207.52", "QUOTE"],
    ["quote", "207.43", "QUOTE"],
    ["snapshot", "207.58", "SNAPSHOT"],
    ["snapshot", "207.49", "SNAPSHOT"],
    ["snapshot", "207.4", "SNAPSHOT"],
  ]);
});

test("groups filtered rows and pivots quoted and null categories", { skip: !duckdbAvailable }, async () => {
  setup = `CREATE VIEW parquet_data AS SELECT * FROM (VALUES
    ('north', 'can''t', 7), ('north', 'a"b', 4), ('north', NULL, 5),
    ('south', 'can''t', 40), ('east', 'can''t', 1)) t(region, category, amount);`;
  const panel = mount({
    columns: ["region", "category", "amount"],
    schema: [
      { element: { name: "region", converted_type: "UTF8" }, children: [] },
      { element: { name: "category", converted_type: "UTF8" }, children: [] },
      { element: { name: "amount", type: "INT32" }, children: [] },
    ],
  });
  await button(panel, "Add filter").emit("click");
  const [column, operator, value] = rules(panel, "Filters").children[0].children.map(node => node.children[0]);
  column.value = "amount";
  await column.emit("change");
  operator.value = ">";
  value.value = "1";

  const result = field(panel, "Result");
  result.value = "group";
  await result.emit("change");
  const calculation = field(panel, "Calculation");
  calculation.value = "sum";
  await calculation.emit("change");
  await panel.children[0].emit("submit");
  assert.deepEqual(table(panel), [
    ["region", "Sum"], ["north", "16"], ["south", "40"],
  ]);

  result.value = "pivot";
  await result.emit("change");
  await panel.children[0].emit("submit");
  assert.deepEqual(table(panel), [
    ["region", 'category = a"b', "category = can't", "category = NULL"],
    ["north", "4", "7", "5"],
    ["south", "NULL", "40", "NULL"],
  ]);

  setup = `CREATE VIEW parquet_data AS SELECT 'north' AS region, i::VARCHAR AS category,
    5 AS amount FROM range(21) t(i);`;
  await panel.children[0].emit("submit");
  assert.equal(panel.children[1].textContent, "Pivot supports up to 20 categories. Filter the data or choose another column.");
});

test("bounds wide previews and sends the source-sorted query to the editor", { skip: !duckdbAvailable }, async () => {
  const otherColumns = Array.from({ length: 20 }, (_, index) => `c${index}`);
  const hiddenSort = "x (Absolute value)";
  const columns = ["x", hiddenSort, ...otherColumns];
  setup = `CREATE VIEW parquet_data AS SELECT IF(i = 0, 5, -1) AS x,
    i AS "${hiddenSort}", ${otherColumns.map(name => `i AS ${name}`).join(", ")} FROM range(201) t(i);`;
  let query;
  const panel = mount({
    columns,
    schema: columns.map(name => ({ element: { name, type: "INT32" }, children: [] })),
  }, sql => { query = sql; });
  panel.findAll(node => node.type === "checkbox" && node.value === hiddenSort)[0].checked = false;
  await button(panel, "Add sort").emit("click");
  rules(panel, "Sort order").children[0].children[0].children[0].value = hiddenSort;
  field(panel, "Transform").value = "abs";
  await panel.children[0].emit("submit");
  const [headers, first, second, ...remaining] = table(panel);
  assert.equal(headers.length, 22);
  assert.equal(headers.at(-1), hiddenSort);
  assert.equal(first.at(-1), "5");
  assert.equal(second.at(-1), "1");
  assert.equal(remaining.length, 184);
  assert.equal(panel.children[1].textContent, "Showing the first 186 result rows.");

  await button(panel, "Open in Query").emit("click");
  assert.match(query, /ORDER BY parquet_data\."x \(Absolute value\)" ASC NULLS LAST$/);
});

function mount(file, onQuery) {
  globalThis.document = {
    createElement: tag => new DomNode(tag),
    createTextNode: text => new DomNode("#text", text),
  };
  globalThis.Option = class extends DomNode {
    constructor(label, value) {
      super("option", label);
      this.value = value;
    }
  };
  const panel = new DomNode("section");
  mountExplore(panel, file, onQuery);
  return panel;
}

function button(panel, label) {
  return panel.findAll(node => node.tag === "button" && node.text === label)[0];
}

function field(panel, label) {
  return panel.findAll(node => node.tag === "label" && node.text === label)[0].children[0];
}

function rules(panel, legend) {
  return panel.findAll(node => node.tag === "fieldset" && node.children[0].text === legend)[0].children[1];
}

function table(panel) {
  return panel.findAll(node => node.tag === "tr").map(row => row.children.map(cell => cell.textContent));
}

class DomNode {
  children = [];
  listeners = new Map();
  selectedIndex = 0;

  constructor(tag, text = "") {
    this.tag = tag;
    this.text = text;
  }

  get options() { return this.children; }
  get selectedOptions() { return this.options.slice(this.selectedIndex, this.selectedIndex + 1); }
  get lastElementChild() { return this.children.at(-1); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(text) { this.text = text; }
  get value() { return this.tag === "select" ? this.selectedOptions[0]?.value ?? "" : this.inputValue ?? ""; }
  set value(value) {
    if (this.tag === "select") this.selectedIndex = this.options.findIndex(option => option.value === value);
    else this.inputValue = value;
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) {
    this.children = children;
    this.selectedIndex = 0;
  }
  setAttribute() {}
  focus() {}
  createTHead() { return this.insert("thead"); }
  createTBody() { return this.insert("tbody"); }
  insertRow() { return this.insert("tr"); }
  insertCell() { return this.insert("td"); }
  insert(tag) {
    const node = new DomNode(tag);
    this.append(node);
    return node;
  }
  findAll(matches) {
    return [...(matches(this) ? [this] : []), ...this.children.flatMap(child => child.findAll(matches))];
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  async emit(name) { await this.listeners.get(name)?.({ preventDefault() {} }); }
}
