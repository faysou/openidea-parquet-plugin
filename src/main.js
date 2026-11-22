import { openParquet } from "./reader.js";
import { duckdb } from "./duckdb.js";
import { scalarColumn } from "./chart-query.js";

import { createGridColumns, createColumnChooser, pinGridColumns } from "./grid-columns.js";
import { mountChartPanel } from "./chart-panel.js";
import "./grid-filter.css";
import { createGridFilters } from "./grid-filter.js";
import { mountPageSearch } from "./page-search.js";
import { mountRecipes } from "./query-recipes.js";
import { mountProfile } from "./profile.js";
import { mountExplore } from "./explore.js";
import { mountRelationships } from "./relationships.js";
import { renderComparisonProfile } from "./compare-profile.js";

const analysisViews = new Map([
  ["explore", (panel, source) => mountExplore(panel, source, text => {
    sql.value = text;
    view = "query";
    void show();
    sql.focus();
  })],
  ["profile", mountProfile],
  ["relationships", mountRelationships],
]);
const mounted = new Set();

const byId = id => document.getElementById(id);
const content = byId("content");
const rowsButton = byId("rows");
const schemaButton = byId("schema");
const queryButton = byId("query");
const chartButton = byId("chart");
const compareButton = byId("compare");
const exportButton = byId("export");
const queryForm = byId("query-form");
const sql = byId("sql");
const queryStatus = byId("query-status");
const previous = byId("previous");
const next = byId("next");
const dialog = byId("cell");

let columnLayout;
let unpin;
let file;
let offset = 0;
let view = "rows";
let request = 0;
let queryRunning = false;
let queryResult;
let lastQuery;
let displayed;
let recordIndex = 0;
let compareResult;
let chartSplit = false;
let filters;
let rawPage = [];
let cachedPageOffset;
let headerFocus;
const pageSearch = mountPageSearch(content);
let exportRunning = false;
let comparisonVersion = 0;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function message(text, role) {
  const p = element("p", text);
  p.setAttribute("role", role);
  content.replaceChildren(p);
}

function formatCell(value) {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return Array.from(value.subarray(0, 512), byte => byte.toString(16).padStart(2, "0")).join(" ") +
      (value.length > 512 ? " …" : "");
  }
  if (typeof value === "object") {
    return JSON.stringify(value, (_key, field) => typeof field === "bigint" ? field.toString() : field);
  }
  return String(value);
}

function table(labels, name) {
  const result = element("table");
  result.setAttribute("aria-label", name);
  const head = result.createTHead().insertRow();
  for (const label of labels) {
    const th = element("th", label);
    th.scope = "col";
    head.append(th);
  }
  return result;
}

function showRows(rows, columns = file.columns, firstRow = offset + 1, name = "Parquet rows", rowNumbers = Array.from(rows, (_, i) => firstRow + i)) {
  unpin?.();
  unpin = undefined;
  displayed = { rows, columns, firstRow, rowNumbers };
  const visible = view === "rows" ? columnLayout.visible() : columns.map((label, index) => ({ label, index }));
  exportButton.disabled = view === "compare";
  if (!rows.length && !(view === "rows" && byId("row-format").value === "table")) {
    message("No rows", "status");
    return;
  }
  const format = view === "rows" ? byId("row-format").value : "table";
  if (format === "tree") {
    const tree = element("div");
    tree.className = "record-tree";
    for (const [i, values] of rows.entries()) {
      const record = element("details");
      record.append(element("summary", `Record ${rowNumbers[i]}`));
      record.addEventListener("toggle", () => {
        if (!record.open || record.childElementCount > 1) return;
        const fields = element("dl");
        for (const { label, index } of visible) fields.append(element("dt", label), recordValue(values[index]));
        record.append(fields);
      });
      tree.append(record);
    }
    content.replaceChildren(tree);
    return;
  }
  if (format === "text") {
    const text = element("pre");
    text.className = "record-text";
    const escape = value => formatCell(value).replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
    const lines = [visible.map(entry => escape(entry.label)).join("\t")];
    for (const row of rows) lines.push(visible.map(entry => escape(row[entry.index])).join("\t"));
    text.textContent = lines.join("\n");
    content.replaceChildren(text);
    return;
  }
  const transposed = view === "rows" && byId("transpose").getAttribute("aria-pressed") === "true";
  const result = table(transposed ? ["Column", ...rowNumbers] : ["Row", ...visible.map(column => column.label)], name);
  const body = result.createTBody();
  if (transposed) {
    for (const [i, heading] of [...result.tHead.rows[0].cells].slice(1).entries()) {
      heading.replaceChildren(recordButton(i, rowNumbers[i]));
    }
    for (const { index: i, label: column } of visible) {
      const row = body.insertRow();
      const heading = element("th", column);
      heading.scope = "row";
      row.append(heading);
      for (const record of rows) addValue(row, column, record[i]);
    }
  } else {
    for (const [index, values] of rows.entries()) {
      const row = body.insertRow();
      const heading = element("th");
      heading.scope = "row";
      heading.append(recordButton(index, rowNumbers[index]));
      row.append(heading);
      for (const { index: i, label } of visible) addValue(row, label, values[i]);
    }
  }
  if (view === "rows" && !transposed) {
    visible.forEach((column, i) => filters.decorate(result.tHead.rows[0].cells[i + 1], column, rawPage));
  }
  content.replaceChildren(result);
  if (!rows.length) content.append(element("p", "No matching rows"));
  if (view === "rows" && !transposed) {
    unpin = pinGridColumns(result, visible);
    if (headerFocus) filters.restoreFocus(result, headerFocus);
    headerFocus = undefined;
  }
  pageSearch.update();
}

function recordButton(index, number) {
  const button = element("button", number.toLocaleString());
  button.dataset.record = String(number);
  button.className = "cell";
  button.title = "Open record view";
  button.setAttribute("aria-label", `View record ${number}`);
  button.addEventListener("click", () => showRecord(index));
  return button;
}

function addValue(row, column, value) {
  const cell = row.insertCell();
  const label = formatCell(value);
  if (value == null) {
    cell.append(element("em", label));
    return;
  }
  const button = element("button", label.length > 1024 ? label.slice(0, 1024) + "…" : label);
  button.className = "cell";
  button.addEventListener("click", () => {
    byId("column-name").textContent = column;
    byId("value").textContent = label.length > 65536 ? label.slice(0, 65536) + "…" : label;
    dialog.showModal();
  });
  cell.append(button);
}

function showRecord(index) {
  const { rows, columns, firstRow } = displayed;
  recordIndex = index;
  byId("record").hidden = false;
  byId("record-title").textContent = `Record ${displayed.rowNumbers[index].toLocaleString()}`;
  byId("record-previous").disabled = index === 0;
  byId("record-next").disabled = index + 1 === rows.length;
  const fields = rows[index].flatMap((value, column) => {
    const label = element("dt", columns[column]);
    const field = view === "rows" ? file.schema[column]?.element : undefined;
    const type = field?.logical_type?.type ?? field?.converted_type ?? field?.type;
    if (type) {
      const badge = element("span", type);
      badge.className = "record-type";
      label.append(badge);
    }
    return [label, recordValue(value)];
  });
  byId("record-values").replaceChildren(...fields);
}

function recordValue(value) {
  const field = element("dd");
  if (value && typeof value === "object" && !(value instanceof Uint8Array) && !(value instanceof Date)) {
    const tree = element("details");
    const entries = Object.entries(value);
    tree.append(element("summary", Array.isArray(value) ? `Array (${entries.length})` : `Object (${entries.length})`));
    const values = element("dl");
    tree.addEventListener("toggle", () => {
      if (!tree.open || values.childNodes.length) return;
      values.replaceChildren(...entries.map(([name, entry]) => {
        const row = element("div");
        row.append(element("dt", name), recordValue(entry));
        return row;
      }));
    });
    tree.append(values);
    field.append(tree);
  } else {
    field.textContent = formatCell(value);
  }
  return field;
}

function showSchema() {
  const result = table(["Column", "Type", "Repetition"], "Parquet schema");
  const body = result.createTBody();
  function add(nodes) {
    for (const { element: field, path, children } of nodes) {
      const row = body.insertRow();
      row.insertCell().textContent = path.join(".");
      row.insertCell().textContent = [field.type, field.logical_type?.type ?? field.converted_type].filter(Boolean).join(" · ") || "Group";
      row.insertCell().textContent = field.repetition_type ?? "";
      add(children);
    }
  }
  add(file.schema);
  content.replaceChildren(result);
  if (!file.rowGroups) return;
  const controls = element("section");
  controls.className = "storage-details";
  const heading = element("h2", "Row group storage");
  const label = element("label", "Row group ");
  const index = element("input");
  index.type = "number";
  index.min = "1";
  index.max = String(file.rowGroups);
  index.value = "1";
  label.append(index, document.createTextNode(` of ${file.rowGroups.toLocaleString()}`));
  const inspection = element("div");
  function displayGroup() {
    inspection.replaceChildren();
    if (!index.value || !index.validity.valid) return;
    const group = file.rowGroup(index.valueAsNumber - 1);
    const chunks = table(["Column chunk", "Codec", "Compressed bytes", "Uncompressed bytes", "Nulls", "Min bound", "Max bound"], "Row group column chunks");
    const body = chunks.createTBody();
    const metadataValue = value => value == null ? "Unavailable" : formatCell(value);
    for (const chunk of group.columns) {
      const data = chunk.meta_data;
      if (!data) continue;
      const stats = data.statistics;
      const row = body.insertRow();
      const values = [data.path_in_schema.join("."), data.codec, data.total_compressed_size, data.total_uncompressed_size,
        stats?.null_count, stats?.min_value ?? stats?.min, stats?.max_value ?? stats?.max];
      for (const value of values) row.insertCell().textContent = metadataValue(value);
    }
    inspection.append(element("p", `${group.num_rows.toLocaleString()} rows`), chunks);
  }
  index.addEventListener("input", displayGroup);
  controls.append(heading, label, inspection);
  content.append(controls);
  displayGroup();
}

async function show() {
  if (!file) return;
  unpin?.();
  unpin = undefined;
  const id = ++request;
  displayed = undefined;
  byId("record").hidden = true;
  rowsButton.setAttribute("aria-pressed", String(view === "rows"));
  schemaButton.setAttribute("aria-pressed", String(view === "schema"));
  queryButton.setAttribute("aria-pressed", String(view === "query"));
  const split = view === "rows" && chartSplit;
  chartButton.setAttribute("aria-pressed", String(view === "chart" || split));
  byId("workspace").classList.toggle("split-plot", split);
  byId("columns-control").hidden = view !== "rows";
  byId("find-page").disabled = view !== "rows" || byId("row-format").value !== "table";
  if (byId("find-page").disabled) pageSearch.close();
  byId("analysis-name").textContent = analysisViews.has(view) ? byId(view).textContent : "Analyze";
  byId("row-format").disabled = view !== "rows";
  byId("transpose").disabled = view !== "rows" || byId("row-format").value !== "table";
  byId("grid-state").hidden = view !== "rows" || !(filters.active() || filters.scope() === "file");
  byId("position").disabled = false;
  byId("page-total").textContent = filters.scope() === "file" && filters.active() ? "" : `of ${file.total.toLocaleString()}`;
  byId("grid-page").hidden = filters.scope() !== "file";
  byId("grid-clear").disabled = !filters.active();
  byId("grid-scope").textContent = filters.scope() === "file" ? "Whole file" : "Current page";
  compareButton.setAttribute("aria-pressed", String(view === "compare"));
  byId("pager").hidden = view !== "rows";
  queryForm.hidden = view !== "query";
  byId("chart-panel").hidden = view !== "chart" && !split;
  for (const name of analysisViews.keys()) {
    byId(name).setAttribute("aria-pressed", String(view === name));
    byId(name + "-panel").hidden = view !== name;
  }
  content.hidden = view === "chart" || analysisViews.has(view);
  exportButton.disabled = true;
  content.scrollTop = 0;
  content.setAttribute("aria-busy", "false");
  if (analysisViews.has(view)) {
    if (!mounted.has(view)) {
      analysisViews.get(view)(byId(view + "-panel"), file);
      mounted.add(view);
    }
    return;
  }
  if (view === "chart") return;
  if (view === "compare") {
    if (compareResult.profile) {
      content.replaceChildren();
      renderComparisonProfile(content, compareResult.profile);
      return;
    }
    const { rows, columns, truncated, schemaOnly } = compareResult;
    if (!rows.length) {
      message(schemaOnly ? "The schemas match." : "No differences found.", "status");
      return;
    }
    showRows(rows, columns, 1, "Parquet comparison");
    if (!schemaOnly && columns[0] === "Column") {
      content.prepend(element("p", "The schemas differ. Row matching requires the same columns, types, and order."));
    }
    if (truncated) content.prepend(element("p", "Showing the first 200 differences."));
    return;
  }
  if (view === "query") {
    showQueryResult();
    return;
  }
  if (view === "schema") {
    content.setAttribute("aria-busy", "false");
    showSchema();
    return;
  }

  previous.disabled = true;
  next.disabled = true;
  content.setAttribute("aria-busy", "true");
  message("Reading rows…", "status");
  try {
    const wholeFile = filters.scope() === "file";
    const page = !wholeFile && cachedPageOffset === offset
      ? { ...filters.applyPage(rawPage, offset), sourceRows: rawPage, hasNext: offset + rawPage.length < file.total }
      : await filters.readPage(offset);
    if (id !== request) return;
    rawPage = page.sourceRows ?? page.rows;
    cachedPageOffset = page.sourceRows ? offset : undefined;
    showRows(page.rows, file.columns, offset + 1, "Parquet rows", page.rowNumbers);
    const sourceCount = rawPage.length;
    byId("position").textContent = sourceCount
      ? `${(offset + 1).toLocaleString()}–${(offset + sourceCount).toLocaleString()}` : "0";
    if (!wholeFile && page.rows.length !== sourceCount) byId("grid-scope").textContent = `Current page · ${page.rows.length} of ${sourceCount} rows`;
    next.disabled = !page.hasNext;
  } catch (error) {
    if (id === request) {
      message(error.message, "alert");
      pageSearch.update();
    }
  } finally {
    if (id === request) {
      content.setAttribute("aria-busy", "false");
      previous.disabled = offset === 0;
    }
  }
}

function showQueryResult() {
  displayed = undefined;
  byId("record").hidden = true;
  exportButton.disabled = true;
  content.setAttribute("aria-busy", String(queryRunning));
  byId("run").disabled = queryRunning;
  byId("summary").disabled = queryRunning;
  queryStatus.textContent = queryRunning ? "Running query…" : queryResult?.result?.truncated ? "Showing the first 200 rows" : "";
  if (queryRunning) message("Running query…", "status");
  else if (queryResult?.error) message(queryResult.error, "alert");
  else if (queryResult?.result) {
    const { rows, columns } = queryResult.result;
    showRows(rows, columns, 1, "DuckDB query results");
  } else {
    message("Run a SELECT query. If prompted, approve your DuckDB executable in Settings > Plugins > Parquet Viewer.", "status");
  }
}

async function runQuery(text) {
  if (!text.trim() || queryRunning) return;
  queryRunning = true;
  lastQuery = undefined;
  showQueryResult();
  try {
    queryResult = { result: await duckdb({ sql: text }) };
    lastQuery = text;
  } catch (error) {
    queryResult = { error: error.message };
  } finally {
    queryRunning = false;
    if (view === "query") showQueryResult();
  }
}

queryForm.addEventListener("submit", event => {
  event.preventDefault();
  runQuery(sql.value);
});
byId("summary").addEventListener("click", () => {
  runQuery("SELECT * FROM (SUMMARIZE SELECT * FROM parquet_data)");
});
rowsButton.addEventListener("click", () => { view = "rows"; void show(); });
schemaButton.addEventListener("click", () => { view = "schema"; void show(); });
queryButton.addEventListener("click", () => { view = "query"; void show(); });
chartButton.addEventListener("click", () => {
  if (view === "rows") chartSplit = !chartSplit;
  else view = view === "chart" ? "rows" : "chart";
  void show();
});
byId("reload-file").addEventListener("click", () => location.reload());
const rangeButton = byId("position");
const sizeMenu = byId("page-size-menu");
let allRows = false;
let editingSize = false;

function closeSizeMenu(focus = false) {
  sizeMenu.hidden = true;
  rangeButton.setAttribute("aria-expanded", "false");
  if (focus) rangeButton.focus();
}

function inputPageNumber(custom) {
  closeSizeMenu(true);
  editingSize = custom;
  byId("go-title").textContent = custom ? "Custom page size" : "Go to row";
  byId("page-input-label").textContent = custom ? "Rows per page" : "Row number";
  const input = byId("page-input");
  input.max = String(custom ? file.maxPageSize : file.total);
  input.value = String(custom ? file.pageSize : offset + 1);
  byId("go-dialog").showModal();
  input.select();
}

async function changePage(size, number, jump) {
  cachedPageOffset = undefined;
  file.pageSize = size;
  offset = Math.floor((number - 1) / size) * size;
  await show();
  if (!jump || view !== "rows") return;
  const index = displayed?.rowNumbers.indexOf(number);
  if (index >= 0) {
    content.querySelector(`[data-record="${number}"]`)?.focus();
    showRecord(index);
  } else if (displayed) {
    byId("grid-scope").textContent = `Row ${number} is hidden by the current page filters`;
  }
}

function selectPageSize(size, all = false) {
  const selected = displayed && !byId("record").hidden;
  const whole = filters.scope() === "file" && filters.active();
  const number = selected && !whole ? displayed.rowNumbers[recordIndex] : offset + (selected ? recordIndex : 0) + 1;
  allRows = all;
  closeSizeMenu(true);
  void changePage(size, number, selected && !whole);
}

function openSizeMenu() {
  sizeMenu.replaceChildren();
  function item(label, action, checked, disabled = false) {
    const button = element("button", label);
    button.type = "button";
    button.setAttribute("role", checked === undefined ? "menuitem" : "menuitemradio");
    if (checked !== undefined) button.setAttribute("aria-checked", String(checked));
    button.disabled = disabled;
    button.addEventListener("click", action);
    sizeMenu.append(button);
    return button;
  }
  const sizes = new Set([10, 100, 250, 500, 1000, file.initialPageSize]);
  if (!allRows) sizes.add(file.pageSize);
  for (const size of [...sizes].sort((a, b) => a - b)) {
    const button = item(size.toLocaleString(), () => selectPageSize(size), !allRows && size === file.pageSize, size > file.maxPageSize);
    if (size === file.initialPageSize) button.append(element("small", "Default"));
  }
  item("All", () => selectPageSize(file.total, true), allRows, !file.total || file.total > file.maxPageSize);
  item("Custom…", () => inputPageNumber(true));
  sizeMenu.append(element("hr"));
  item("Go to row…", () => inputPageNumber(false), undefined, !file.total || (filters.scope() === "file" && filters.active()));
  sizeMenu.hidden = false;
  rangeButton.setAttribute("aria-expanded", "true");
  const rect = rangeButton.getBoundingClientRect();
  sizeMenu.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - sizeMenu.offsetWidth - 4)) + "px";
  sizeMenu.style.top = rect.bottom + 2 + "px";
  (sizeMenu.querySelector('[aria-checked="true"]') ?? sizeMenu.querySelector("button:enabled")).focus();
}
rangeButton.addEventListener("click", () => sizeMenu.hidden ? openSizeMenu() : closeSizeMenu(true));
rangeButton.addEventListener("keydown", event => {
  if (event.key === "ArrowDown") { event.preventDefault(); openSizeMenu(); }
});
sizeMenu.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); closeSizeMenu(true); return; }
  const items = [...sizeMenu.querySelectorAll("button:enabled")];
  const index = items.indexOf(document.activeElement);
  const target = { ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length,
    Home: 0, End: items.length - 1 }[event.key];
  if (target !== undefined) { event.preventDefault(); items[target].focus(); }
});
document.addEventListener("pointerdown", event => {
  if (!sizeMenu.hidden && !sizeMenu.contains(event.target) && !rangeButton.contains(event.target)) closeSizeMenu();
});
sizeMenu.addEventListener("focusout", event => {
  if (!sizeMenu.hidden && event.relatedTarget && event.relatedTarget !== rangeButton && !sizeMenu.contains(event.relatedTarget)) closeSizeMenu();
});
window.addEventListener("resize", () => closeSizeMenu());
byId("go-cancel").addEventListener("click", () => byId("go-dialog").close());
byId("go-form").addEventListener("submit", event => {
  event.preventDefault();
  const input = byId("page-input");
  if (!input.reportValidity()) return;
  byId("go-dialog").close();
  if (editingSize) selectPageSize(input.valueAsNumber);
  else void changePage(file.pageSize, input.valueAsNumber, true);
});
byId("full-chart").addEventListener("click", () => { view = "chart"; void show(); });
byId("grid-page").addEventListener("click", () => filters.setScope("page"));
byId("grid-clear").addEventListener("click", () => filters.clear());
for (const menu of document.querySelectorAll("#grid-toolbar .tool-menu")) {
  menu.addEventListener("click", event => {
    if (event.target.closest("button")) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  });
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); }
  });
}
document.addEventListener("pointerdown", event => {
  for (const menu of document.querySelectorAll("#grid-toolbar details[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
for (const name of analysisViews.keys()) {
  byId(name).addEventListener("click", () => { view = name; void show(); });
}
byId("row-format").addEventListener("change", () => {
  byId("find-page").disabled = byId("transpose").disabled = byId("row-format").value !== "table";
  if (byId("find-page").disabled) pageSearch.close();
  if (displayed) showRows(displayed.rows, displayed.columns, displayed.firstRow, "Parquet rows", displayed.rowNumbers);
});
byId("transpose").addEventListener("click", () => {
  const control = byId("transpose");
  control.setAttribute("aria-pressed", String(control.getAttribute("aria-pressed") !== "true"));
  if (displayed) showRows(displayed.rows, displayed.columns, displayed.firstRow, "Parquet rows", displayed.rowNumbers);
});
previous.addEventListener("click", () => { offset -= file.pageSize; void show(); });
next.addEventListener("click", () => { offset += file.pageSize; void show(); });
byId("record-close").addEventListener("click", () => { byId("record").hidden = true; });
byId("record-previous").addEventListener("click", () => showRecord(recordIndex - 1));
byId("record-next").addEventListener("click", () => showRecord(recordIndex + 1));

function setColumns(select, columns, initial = []) {
  const previous = select.value;
  select.replaceChildren(...initial, ...columns.map(column => new Option(column, column)));
  if (columns.includes(previous)) select.value = previous;
}

for (const name of ["export", "compare"]) {
  byId(`${name}-cancel`).addEventListener("click", () => byId(`${name}-dialog`).close());
}

exportButton.addEventListener("click", () => {
  const scope = byId("export-scope");
  scope.value = "visible";
  scope.querySelector('[value="query"]').disabled = view !== "query" || !lastQuery;
  showExportScope();
  byId("export-dialog").showModal();
});
function showExportScope() {
  const scope = byId("export-scope").value;
  const format = byId("export-format");
  format.disabled = scope === "visible";
  if (format.disabled) format.value = "csv";
  byId("export-status").textContent = scope === "visible"
    ? `${displayed?.rows.length ?? 0} displayed rows. CSV includes column headers.`
    : format.value === "parquet"
      ? "Choose a new Parquet file as the destination."
      : "Writes CSV with column headers directly to disk.";
  byId("export-run").disabled = exportRunning || (scope === "visible" && !displayed?.rows.length);
}
byId("export-scope").addEventListener("change", showExportScope);
byId("export-format").addEventListener("change", showExportScope);
byId("export-form").addEventListener("submit", async event => {
  event.preventDefault();
  const status = byId("export-status");
  if (byId("export-run").disabled) return;
  exportRunning = true;
  byId("export-run").disabled = true;
  const scope = byId("export-scope").value;
  const extension = byId("export-format").value;
  const format = extension === "parquet" ? "Parquet" : "CSV";
  const name = `parquet-export.${extension}`;
  const filters = [{ name: format, extensions: [extension] }];
  try {
    if (scope === "visible") {
      if (!displayed?.rows.length) throw new Error("There are no displayed rows.");
      const { default: Papa } = await import("papaparse");
      const projection = view === "rows" ? columnLayout.visible() : displayed.columns.map((label, index) => ({ label, index }));
      if (!projection.length) throw new Error("Show at least one column to export.");
      const data = Papa.unparse({
        fields: projection.map(column => column.label),
        data: displayed.rows.map(row => projection.map(({ index }) => row[index] == null ? "" : formatCell(row[index]))),
      }, { escapeFormulae: true });
      if (!await window.openidea.saveFile({ name, filters, data })) return;
    } else {
      const sql = scope === "query" ? lastQuery : "SELECT * FROM parquet_data";
      if (!await duckdb({ sql }, { mode: "save", name, filters })) return;
    }
    byId("export-dialog").close();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    exportRunning = false;
    byId("export-run").disabled = byId("export-scope").value === "visible" && !displayed?.rows.length;
  }
});

byId("compare-mode").addEventListener("change", () => {
  const profile = byId("compare-mode").value === "profile";
  byId("compare-key-field").hidden = profile;
  byId("key-hint").hidden = profile;
  byId("distribution-field").hidden = !profile;
});
compareButton.addEventListener("click", () => {
  comparisonVersion++;
  byId("compare-run").disabled = false;
  byId("compare-status").textContent = "";
  byId("compare-dialog").showModal();
});
byId("compare-form").addEventListener("submit", async event => {
  event.preventDefault();
  const status = byId("compare-status");
  const button = byId("compare-run");
  if (button.disabled) return;
  const version = comparisonVersion;
  button.disabled = true;
  const key = byId("compare-key").value;
  status.textContent = "Waiting for comparison…";
  try {
    const profile = byId("compare-mode").value === "profile";
    const input = profile ? { profileColumn: byId("distribution-column").value } : { key };
    const result = await duckdb(input, { mode: "open", filters: [{ name: "Parquet", extensions: ["parquet"] }] });
    if (version !== comparisonVersion || !byId("compare-dialog").open) return;
    if (!result) {
      status.textContent = "";
      return;
    }
    compareResult = profile ? { profile: result } : { ...result, schemaOnly: !key };
    byId("compare-dialog").close();
    view = "compare";
    void show();
  } catch (error) {
    if (version === comparisonVersion && byId("compare-dialog").open) status.textContent = error.message;
  } finally {
    if (version === comparisonVersion) button.disabled = false;
  }
});

openParquet(window.openidea?.document).then(result => {
  file = result;
  columnLayout = createGridColumns(file.columns);
  filters = createGridFilters({ file, formatCell, onChange: ({ resetOffset, focus }) => {
    if (resetOffset) offset = 0;
    headerFocus = focus;
    void show();
  } });
  const chooser = createColumnChooser(columnLayout, () => {
    if (view === "rows" && displayed) showRows(displayed.rows, displayed.columns, displayed.firstRow, "Parquet rows", displayed.rowNumbers);
  });
  chooser.querySelector("summary").title = "Manage columns";
  chooser.querySelector("summary").setAttribute("aria-label", "Manage columns");
  byId("columns-control").append(chooser);
  const { total, rowGroups, size, codecs } = file;
  byId("metadata").textContent = [
    `${total.toLocaleString()} rows`,
    `${rowGroups.toLocaleString()} row groups`,
    `${size.toLocaleString()} bytes`,
    ...codecs,
  ].join(" · ");
  rowsButton.disabled = false;
  schemaButton.disabled = false;
  queryButton.disabled = false;
  for (const name of analysisViews.keys()) byId(name).disabled = false;
  setColumns(byId("distribution-column"), file.schema.filter(scalarColumn).map(node => node.element.name));
  byId("compare-mode").options[1].disabled = !byId("distribution-column").options.length;
  chartButton.disabled = false;
  compareButton.disabled = false;
  mountRecipes(byId("recipes"), file.schema, sql);
  mountChartPanel(file);
  setColumns(byId("compare-key"), file.schema.filter(scalarColumn).map(node => node.element.name),
    [new Option("Compare schemas only", "")]);
  return show();
}, error => {
  content.setAttribute("aria-busy", "false");
  message(error.message, "alert");
});
