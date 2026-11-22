import { identifier, scalarColumn } from "./chart-query.js";
import { duckdb } from "./duckdb.js";
import { literal } from "./explore.js";

const queryRowLimit = 200;
const sqlLimit = 64 * 1024;

export function createGridFilters({ file, query = duckdb, formatCell = String, onChange = () => {} }) {
  const states = new Map(["page", "file"].map(scope => [scope, { filters: new Map(), sort: null }]));
  const sourceNames = new Set(file.columns.map(name => name.toLowerCase()));
  const nested = file.schema?.map(node => !scalarColumn(node)) ?? [];
  let rowName = "__parquet_grid_row";
  while (sourceNames.has(rowName)) rowName += "_";
  const rowId = identifier(rowName);
  let scope = "page";
  let openPicker;

  const state = () => states.get(scope);
  const active = () => Boolean(state().sort || state().filters.size);
  const focusAt = (index, control) => ({ index, control });

  return {
    scope: () => scope,
    setScope,
    active,
    clear() {
      state().filters.clear();
      state().sort = null;
      onChange({ resetOffset: scope === "file" });
    },
    setFilter,
    cycleSort,
    applyPage,
    readPage,
    values,
    decorate,
    restoreFocus(table, focus) {
      if (!focus) return;
      const control = table.querySelector(`[data-grid-column="${focus.index}"][data-grid-control="${focus.control}"]`);
      control?.focus();
      if (focus.reopen) control?.click();
    },
  };

  function setScope(nextScope, focus) {
    if (nextScope === scope) return;
    scope = nextScope;
    onChange({ resetOffset: true, focus });
  }

  function setFilter(index, selected) {
    const { filters, sort } = state();
    if (scope === "file" && selected.length) {
      const next = new Map(filters);
      next.set(index, selected);
      validateLength(pageSql(0, queryRowLimit + 1, next, sort));
    }
    if (selected.length) filters.set(index, [...selected]);
    else filters.delete(index);
    onChange({ resetOffset: scope === "file", focus: focusAt(index, "filter") });
  }

  function cycleSort(index) {
    const previous = state().sort;
    state().sort = previous?.index !== index
      ? { index, direction: "ASC" }
      : previous.direction === "ASC" ? { index, direction: "DESC" } : null;
    onChange({ resetOffset: scope === "file", focus: focusAt(index, "sort") });
  }

  function applyPage(rows, offset) {
    const { filters, sort } = states.get("page");
    const columnFilters = [...filters];
    const entries = rows.map((row, index) => ({ row, number: offset + index + 1 })).filter(({ row }) =>
      columnFilters.every(([index, selected]) => selected.some(value => sameValue(row[index], value))));
    if (sort) {
      const sign = sort.direction === "ASC" ? 1 : -1;
      entries.sort(({ row: left }, { row: right }) => compareCells(left[sort.index], right[sort.index], sign));
    }
    return { rows: entries.map(entry => entry.row), rowNumbers: entries.map(entry => entry.number) };
  }

  async function readPage(offset) {
    const { filters, sort } = state();
    const pageScope = scope === "page";
    if (pageScope || !active()) {
      const sourceRows = await file.readPage(offset);
      const result = pageScope ? applyPage(sourceRows, offset) : {
        rows: sourceRows,
        rowNumbers: sourceRows.map((_, index) => offset + index + 1),
      };
      return { ...result, sourceRows, hasNext: offset + sourceRows.length < file.total && sourceRows.length > 0 };
    }

    const pageSize = file.pageSize;
    const page = { rows: [], rowNumbers: [], hasNext: false };
    while (page.rows.length < pageSize) {
      const remaining = pageSize - page.rows.length;
      const limit = remaining > queryRowLimit ? queryRowLimit : remaining + 1;
      const sql = pageSql(offset + page.rows.length, limit, filters, sort);
      validateLength(sql);
      const { columns, rows, truncated } = await query({ sql });
      const rowIndex = columns.indexOf(rowName);
      for (const row of rows.slice(0, remaining)) {
        const values = row.filter((_, index) => index !== rowIndex);
        page.rows.push(values.map((value, index) => nested[index] && value !== null ? nestedValue(value) : value));
        page.rowNumbers.push(Number(row[rowIndex]));
      }
      page.hasNext = truncated || rows.length > remaining;
      if (page.hasNext || rows.length < limit) break;
    }
    return page;
  }

  function pageSql(offset, limit, filters, sort) {
    const conditions = [...filters].map(([index, selected]) => {
      const field = identifier(file.columns[index]);
      const present = selected.filter(value => value !== null);
      const clauses = [];
      if (selected.includes(null)) clauses.push(`${field} IS NULL`);
      if (present.length) {
        const choices = present.map(value => `cast_to_type(${literal(value)}, ${field})`);
        clauses.push(`${field} IN (${choices.join(", ")})`);
      }
      return `(${clauses.join(" OR ")})`;
    });
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const order = sort ? `${identifier(file.columns[sort.index])} ${sort.direction} NULLS LAST, ` : "";
    return `WITH numbered AS (SELECT *, row_number() OVER () AS ${rowId} FROM parquet_data)
      SELECT * FROM numbered${where} ORDER BY ${order}${rowId} LIMIT ${limit} OFFSET ${offset}`;
  }

  async function values(index, rawRows, search = "") {
    if (scope === "page") {
      const options = [];
      for (const row of rawRows ?? []) {
        const value = row[index] ?? null;
        if (supportedValue(value) && !options.some(option => sameValue(option, value))) options.push(value);
      }
      options.sort((left, right) => compareCells(left, right, 1));
      return { options: options.filter(value => valueMatches(value, search)), truncated: false };
    }
    const field = identifier(file.columns[index]);
    const display = `CAST(${field} AS VARCHAR)`;
    const label = `coalesce(CASE ${display} WHEN '' THEN 'Empty string' ELSE ${display} END, 'NULL')`;
    const where = search ? ` WHERE contains(lower(${label}), lower(${literal(search)}))` : "";
    const sql = `SELECT CAST(candidate AS VARCHAR) AS value FROM
      (SELECT DISTINCT ${field} AS candidate FROM parquet_data${where})
      ORDER BY candidate NULLS LAST LIMIT ${queryRowLimit + 1}`;
    const { rows, truncated } = await query({ sql });
    return { options: rows.slice(0, queryRowLimit).map(([value]) => value), truncated: truncated || rows.length > queryRowLimit };
  }

  function valueMatches(value, search) {
    return valueLabel(value).toLowerCase().includes(search.toLowerCase());
  }

  function valueLabel(value) {
    if (value === null) return "NULL";
    if (value === "") return "Empty string";
    return formatCell(value);
  }

  function decorate(header, { index, label }, rawRows) {
    if (!scalarColumn(file.schema[index])) return;
    const doc = header.ownerDocument;
    const wrapper = doc.createElement("div");
    wrapper.className = "grid-heading";
    const direction = state().sort?.index === index ? state().sort.direction : null;
    if (direction) header.setAttribute("aria-sort", direction === "ASC" ? "ascending" : "descending");
    const sort = button(doc, label, () => cycleSort(index));
    sort.className = "grid-sort";
    sort.dataset.gridColumn = index;
    sort.dataset.gridControl = "sort";
    const sortAction = `Sort ${label} ${direction === "ASC" ? "descending" : "ascending"}`;
    sort.title = direction === "DESC" ? `Clear sort on ${label}` : sortAction;
    sort.setAttribute("aria-label", sort.title);
    const ascending = "M4 6l4-4 4 4";
    const descending = "M4 10l4 4 4-4";
    sort.append(headingIcon(doc, direction === "ASC" ? ascending : direction === "DESC" ? descending : `${ascending} ${descending}`));

    const filter = button(doc, "", () => showPicker(filter, index, label, rawRows));
    filter.append(headingIcon(doc, "M2.5 3.5h11l-4 5v4l-3-1.5V8.5z"));
    filter.className = "grid-filter";
    filter.dataset.gridColumn = index;
    filter.dataset.gridControl = "filter";
    const filtered = state().filters.has(index);
    filter.title = filtered ? `Edit filter for ${label}` : `Filter ${label}`;
    filter.setAttribute("aria-label", filter.title);
    filter.setAttribute("aria-haspopup", "dialog");
    filter.classList.toggle("grid-filter-active", filtered);
    wrapper.append(sort, filter);
    header.replaceChildren(wrapper);
  }

  function showPicker(trigger, index, label, rawRows) {
    openPicker?.close();
    const doc = trigger.ownerDocument;
    const dialog = doc.createElement("dialog");
    dialog.className = "grid-filter-dialog";
    dialog.setAttribute("aria-label", `Filter ${label}`);
    const title = doc.createElement("h2");
    title.textContent = `Filter ${label}`;
    const scopeField = doc.createElement("label");
    scopeField.textContent = "Apply sorting and filters to";
    const scopes = doc.createElement("select");
    for (const [value, name] of [["page", "Current page"], ["file", "Whole file"]]) {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = name;
      scopes.append(option);
    }
    scopes.value = scope;
    scopeField.append(scopes);

    const search = doc.createElement("input");
    search.type = "search";
    search.placeholder = "Search values";
    search.setAttribute("aria-label", "Search values");
    search.maxLength = 128;

    const status = doc.createElement("p");
    status.setAttribute("role", "status");
    const list = doc.createElement("div");
    list.className = "grid-filter-values";
    const actions = doc.createElement("div");
    actions.className = "grid-filter-actions";
    let selected = [...(state().filters.get(index) ?? [])];
    let timer;
    let load = 0;
    const apply = button(doc, "Apply", () => commit(selected));
    apply.disabled = !selected.length;
    const clear = button(doc, "Clear filter", () => commit([]));
    clear.disabled = !state().filters.has(index);
    actions.append(clear, button(doc, "Cancel", () => dialog.close()), apply);
    dialog.append(title, scopeField, search, status, list, actions);

    scopes.addEventListener("change", () => {
      dialog.close();
      setScope(scopes.value, { ...focusAt(index, "filter"), reopen: true });
    });
    search.addEventListener("input", () => {
      clearTimeout(timer);
      load++;
      list.replaceChildren();
      if (scope === "file") {
        status.textContent = "Loading values…";
        timer = setTimeout(refresh, 250);
      } else void refresh();
    });
    dialog.addEventListener("close", () => {
      clearTimeout(timer);
      dialog.remove();
      if (openPicker === dialog) {
        openPicker = null;
        if (trigger.isConnected) trigger.focus();
      }
    });
    openPicker = dialog;
    doc.body.append(dialog);
    dialog.showModal();
    search.focus();
    void refresh();

    function commit(items) {
      try {
        setFilter(index, items);
        dialog.close();
      } catch (error) {
        status.textContent = error.message;
      }
    }

    async function refresh() {
      const generation = ++load;
      const find = search.value;
      status.textContent = "Loading values…";
      try {
        const { options, truncated } = await values(index, rawRows, find);
        if (!dialog.open || generation !== load) return;
        const missing = selected.filter(value => valueMatches(value, find) &&
          !options.some(option => sameValue(option, value)));
        const controls = [...options, ...missing].map(value => {
          const choice = doc.createElement("label");
          const checkbox = doc.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = selected.some(item => sameValue(item, value));
          checkbox.addEventListener("change", () => {
            selected = checkbox.checked ? [...selected, value] : selected.filter(item => !sameValue(item, value));
            apply.disabled = !selected.length;
          });
          const text = doc.createElement(value === null || value === "" ? "em" : "span");
          const caption = valueLabel(value);
          text.textContent = caption.length > 1024 ? caption.slice(0, 1024) + "…" : caption;
          choice.append(checkbox, text);
          return choice;
        });
        list.replaceChildren(...controls);
        status.textContent = truncated
          ? `Showing the first ${queryRowLimit} values. Search to find more.`
          : controls.length ? "Select the values to keep." : "No matching values.";
      } catch (error) {
        if (dialog.open && generation === load) status.textContent = error.message;
      }
    }
  }
}

function nestedValue(value) {
  const maxInteger = String(Number.MAX_SAFE_INTEGER);
  const json = value.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token.startsWith('"') || /[.eE]/.test(token)) return token;
    const digits = token.startsWith("-") ? token.slice(1) : token;
    const outsideRange = digits.length > maxInteger.length ||
      (digits.length === maxInteger.length && digits > maxInteger);
    return outsideRange ? `"${token}"` : token;
  });
  return JSON.parse(json);
}

function validateLength(sql) {
  if (new TextEncoder().encode(sql).length > sqlLimit) {
    throw new Error("The selected values exceed DuckDB’s query limit. Select fewer or shorter values.");
  }
}

function button(doc, text, action) {
  const node = doc.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.addEventListener("click", action);
  return node;
}

function headingIcon(doc, pathData) {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = doc.createElementNS(namespace, "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS(namespace, "path");
  path.setAttribute("d", pathData);
  icon.append(path);
  return icon;
}

function supportedValue(value) {
  return value === null || ["string", "number", "bigint", "boolean"].includes(typeof value) ||
    value instanceof Date || value instanceof Uint8Array;
}

function sameValue(left, right) {
  return left === right || Object.is(left, right) || (left == null && right == null) ||
    (left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime())) ||
    (left instanceof Uint8Array && right instanceof Uint8Array && compareBytes(left, right) === 0);
}

function compareCells(left, right, sign) {
  if (sameValue(left, right)) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (left instanceof Uint8Array && right instanceof Uint8Array) return sign * compareBytes(left, right);
  if (left instanceof Date) left = left.getTime();
  if (right instanceof Date) right = right.getTime();
  if (Number.isNaN(left)) return sign;
  if (Number.isNaN(right)) return -sign;
  return sign * (left < right ? -1 : left > right ? 1 : 0);
}

function compareBytes(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
