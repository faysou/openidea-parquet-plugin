import { openParquet } from "./reader.js";

const byId = id => document.getElementById(id);
const content = byId("content");
const rowsButton = byId("rows");
const schemaButton = byId("schema");
const previous = byId("previous");
const next = byId("next");
const dialog = byId("cell");

let file;
let offset = 0;
let schema = false;
let request = 0;

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

function showRows(rows) {
  if (!rows.length) {
    message("No rows", "status");
    return;
  }
  const result = table(["Row", ...file.columns], "Parquet rows");
  const body = result.createTBody();
  for (const [index, values] of rows.entries()) {
    const row = body.insertRow();
    const th = element("th", (offset + index + 1).toLocaleString());
    th.scope = "row";
    row.append(th);
    for (const [column, value] of values.entries()) {
      const td = row.insertCell();
      const label = formatCell(value);
      if (value === null || value === undefined) {
        td.append(element("em", label));
      } else {
        const button = element("button", label.length > 1024 ? label.slice(0, 1024) + "…" : label);
        button.className = "cell";
        button.addEventListener("click", () => {
          byId("column-name").textContent = file.columns[column];
          byId("value").textContent = label.length > 65536 ? label.slice(0, 65536) + "…" : label;
          dialog.showModal();
        });
        td.append(button);
      }
    }
  }
  content.replaceChildren(result);
}

function showSchema() {
  const result = table(["Column", "Type", "Repetition"], "Parquet schema");
  const body = result.createTBody();
  function add(nodes) {
    for (const { element: field, path, children } of nodes) {
      const row = body.insertRow();
      row.insertCell().textContent = path.join(".");
      row.insertCell().textContent = [field.type, field.logical_type?.kind ?? field.converted_type].filter(Boolean).join(" · ") || "Group";
      row.insertCell().textContent = field.repetition_type ?? "";
      add(children);
    }
  }
  add(file.schema);
  content.replaceChildren(result);
}

async function show() {
  if (!file) return;
  const id = ++request;
  rowsButton.setAttribute("aria-pressed", String(!schema));
  schemaButton.setAttribute("aria-pressed", String(schema));
  byId("pager").hidden = schema;
  content.scrollTop = 0;
  if (schema) {
    content.setAttribute("aria-busy", "false");
    showSchema();
    return;
  }

  previous.disabled = true;
  next.disabled = true;
  content.setAttribute("aria-busy", "true");
  message("Reading rows…", "status");
  try {
    const rows = await file.readPage(offset);
    if (id !== request) return;
    showRows(rows);
    byId("position").textContent = rows.length
      ? `${(offset + 1).toLocaleString()}–${(offset + rows.length).toLocaleString()}`
      : "0";
    next.disabled = !rows.length || offset + rows.length >= file.total;
  } catch (error) {
    if (id === request) message(error.message, "alert");
  } finally {
    if (id === request) {
      content.setAttribute("aria-busy", "false");
      previous.disabled = offset === 0;
    }
  }
}

rowsButton.addEventListener("click", () => { schema = false; void show(); });
schemaButton.addEventListener("click", () => { schema = true; void show(); });
previous.addEventListener("click", () => { offset -= file.pageSize; void show(); });
next.addEventListener("click", () => { offset += file.pageSize; void show(); });

openParquet(window.openidea?.document).then(result => {
  file = result;
  const { total, rowGroups, size, codecs } = file;
  byId("metadata").textContent = [
    `${total.toLocaleString()} rows`,
    `${rowGroups.toLocaleString()} row groups`,
    `${size.toLocaleString()} bytes`,
    ...codecs,
  ].join(" · ");
  rowsButton.disabled = false;
  schemaButton.disabled = false;
  return show();
}, error => {
  content.setAttribute("aria-busy", "false");
  message(error.message, "alert");
});
