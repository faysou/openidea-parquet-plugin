import { identifier, numericColumn, scalarColumn, temporalColumn } from "./chart-query.js";
import { duckdb } from "./duckdb.js";

const pivotLimit = 20;
const previewCells = 4096;
const comparisons = [
  ["=", "is equal to"], ["<>", "is different from"], ["<", "is less than"],
  ["<=", "is at most"], [">", "is greater than"], [">=", "is at least"],
];
const nullChecks = [["IS NULL", "is missing"], ["IS NOT NULL", "is present"]];
const aggregations = [
  ["count", "Row count"], ["distinct", "Distinct count"], ["sum", "Sum"],
  ["avg", "Mean"], ["min", "Minimum"], ["max", "Maximum"],
];
const transforms = {
  text: [["trim", "Trim whitespace"], ["lower", "Lowercase"], ["upper", "Uppercase"]],
  numeric: [["abs", "Absolute value"], ["round", "Round to two decimals"]],
  date: [["day", "Day"], ["month", "Month"], ["year", "Year"]],
};

export function mountExplore(container, file, onQuery) {
  const types = new Map(file.schema.map(node => [node.element.name, columnType(node)]));
  const columns = file.columns.map(name => [name, name]);
  const scalars = file.schema.filter(scalarColumn).map(({ element }) => [element.name, element.name]);
  const numeric = scalars.filter(([name]) => types.get(name) === "numeric");
  const derivable = scalars.filter(([name]) => Object.hasOwn(transforms, types.get(name)));

  const form = element("form", "analysis-controls");
  const settings = element("fieldset", "explore-settings");
  const fields = element("div", "analysis-fields");
  const mode = select([["rows", "Rows"], ["group", "Group by"], ["pivot", "Pivot"]]);
  const group = select(scalars);
  const category = select(scalars);
  if (scalars.length > 1) category.selectedIndex = 1;
  const aggregate = select(aggregations.filter(([fn]) =>
    fn === "count" || (fn === "distinct" ? scalars.length > 0 : numeric.length > 0)));
  const measure = select([]);
  const groupField = field("Group column", group);
  const categoryField = field("Pivot column", category);
  const aggregateField = field("Calculation", aggregate);
  const measureField = field("Value column", measure);
  fields.append(field("Result", mode), groupField, categoryField, aggregateField, measureField);

  const projection = element("details");
  projection.append(element("summary", "", "Visible columns"));
  const columnChoices = element("div", "analysis-columns");
  const included = columns.map(([name]) => {
    const control = element("input");
    control.type = "checkbox";
    control.checked = true;
    control.value = name;
    const label = element("label");
    label.append(control, document.createTextNode(name));
    columnChoices.append(label);
    return control;
  });
  for (const [label, checked] of [["Select all", true], ["Clear selection", false]]) {
    const button = action(label);
    button.addEventListener("click", () => included.forEach(input => { input.checked = checked; }));
    projection.append(button);
  }
  projection.append(columnChoices);

  const filters = ruleSet("Filters", "Add filter", () => {
    const column = select(columns);
    const operator = select([]);
    const value = element("input");
    value.type = "text";
    const valueField = field("Value", value);
    const refreshValue = () => { valueField.hidden = operator.value.startsWith("IS "); };
    const refreshOperators = () => {
      updateOptions(operator, operators(types.get(column.value)));
      refreshValue();
    };
    column.addEventListener("change", refreshOperators);
    operator.addEventListener("change", refreshValue);
    refreshOperators();
    return {
      controls: [field("Column", column), field("Condition", operator), valueField],
      toSql: () => condition(column.value, types.get(column.value), operator.value, value.value),
    };
  });
  const sorts = ruleSet("Sort order", "Add sort", () => {
    const column = select(scalars);
    const direction = select([["ASC", "Ascending"], ["DESC", "Descending"]]);
    return {
      controls: [field("Column", column), field("Direction", direction)],
      toSql: () => `parquet_data.${identifier(column.value)} ${direction.value} NULLS LAST`,
    };
  });
  const derived = element("div", "analysis-fields");
  const source = select(derivable);
  const transform = select([]);
  const refreshTransforms = () => {
    updateOptions(transform, [["", "None"], ...(transforms[types.get(source.value)] ?? [])]);
  };
  source.addEventListener("change", refreshTransforms);
  refreshTransforms();
  derived.append(field("Derived column source", source), field("Transform", transform));

  const apply = element("button", "", "Apply");
  apply.type = "submit";
  const openQuery = action("Open in Query");
  openQuery.hidden = !onQuery;
  openQuery.disabled = true;
  let appliedSql;
  openQuery.addEventListener("click", () => onQuery(appliedSql));
  const scope = element("p", "", "Filters and calculations use the entire file.");
  const status = element("p");
  status.setAttribute("role", "status");
  const results = element("div", "analysis-results");
  settings.append(fields, filters.layout, sorts.layout, projection, derived, scope, apply, openQuery);
  form.append(settings);
  container.replaceChildren(form, status, results);

  mode.options[1].disabled = !scalars.length;
  mode.options[2].disabled = scalars.length < 2;
  function showMode() {
    const rows = mode.value === "rows";
    groupField.hidden = aggregateField.hidden = rows;
    categoryField.hidden = mode.value !== "pivot";
    sorts.layout.hidden = !rows || !scalars.length;
    projection.hidden = !rows;
    derived.hidden = !rows || !derivable.length;
    measureField.hidden = rows || aggregate.value === "count";
    updateOptions(measure, aggregate.value === "distinct" ? scalars : numeric);
  }
  mode.addEventListener("change", showMode);
  aggregate.addEventListener("change", showMode);
  showMode();

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (settings.disabled) return;
    settings.disabled = true;
    openQuery.disabled = true;
    results.setAttribute("aria-busy", "true");
    results.replaceChildren();
    status.textContent = "Running analysis…";
    try {
      const clauses = filters.clauses();
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const from = ` FROM parquet_data${where}`;
      let sql;
      let width;
      if (mode.value === "rows") {
        const names = included.filter(input => input.checked).map(input => input.value);
        const fields = names.map(identifier);
        if (transform.value) {
          const name = availableName(`${source.value} (${transform.selectedOptions[0].textContent})`, names);
          const expression = transformExpression(transform.value, identifier(source.value));
          fields.push(`${expression} AS ${identifier(name)}`);
        }
        if (!fields.length) throw new Error("Select a visible column or add a derived column.");
        const order = sorts.clauses();
        sql = `SELECT ${fields.join(", ")}${from}${order.length ? ` ORDER BY ${order.join(", ")}` : ""}`;
        width = fields.length;
      } else {
        const key = identifier(group.value);
        const calculation = aggregateExpression(aggregate.value, measure.value);
        const name = availableName(aggregate.selectedOptions[0].textContent, [group.value]);
        let values = [`${calculation} AS ${identifier(name)}`];
        if (mode.value === "pivot") {
          if (group.value === category.value) throw new Error("Choose different group and pivot columns.");
          values = await pivotExpressions(category.value, group.value, calculation, from);
          if (!values.length) {
            status.textContent = "No matching rows.";
            return;
          }
        }
        sql = `SELECT ${key}, ${values.join(", ")}${from} GROUP BY ${key} ORDER BY ${key} NULLS LAST`;
        width = values.length + 1;
      }
      const limit = Math.max(1, Math.floor(previewCells / width));
      const { columns, rows, truncated } = await duckdb({ sql: `${sql} LIMIT ${limit + 1}` });
      const preview = rows.slice(0, limit);
      status.textContent = !preview.length ? "No matching rows." : truncated || rows.length > limit
        ? `Showing the first ${preview.length.toLocaleString()} result rows.`
        : `${preview.length.toLocaleString()} result ${preview.length === 1 ? "row" : "rows"}.`;
      if (preview.length) results.append(resultTable(columns, preview));
      appliedSql = sql;
      openQuery.disabled = false;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      settings.disabled = false;
      results.setAttribute("aria-busy", "false");
    }
  });
}

function columnType(node) {
  const { element } = node;
  const logical = element.logical_type?.type;
  if (!scalarColumn(node)) return "other";
  if (temporalColumn(node)) return "date";
  if (logical === "TIME" || ["TIME_MILLIS", "TIME_MICROS"].includes(element.converted_type)) return "time";
  if (numericColumn(node)) return "numeric";
  if (element.type === "BOOLEAN") return "boolean";
  if (logical === "STRING" || element.converted_type === "UTF8") return "text";
  return "other";
}

function operators(type) {
  const ordered = ["numeric", "date", "time"].includes(type);
  const matching = type === "text" || type === "boolean";
  return [
    ...(ordered ? comparisons : matching ? comparisons.slice(0, 2) : []),
    ...(type === "text" ? [["contains", "contains"]] : []),
    ...nullChecks,
  ];
}

function condition(name, type, operator, input) {
  const column = identifier(name);
  if (operator.startsWith("IS ")) return `${column} ${operator}`;
  if (input.includes("\0")) throw new Error("Filter values cannot contain a null character.");
  const typed = input.trim();
  if (type === "numeric") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(typed)) {
      throw new Error(`Enter a number for ${name}.`);
    }
    return `${column} ${operator} ${typed}`;
  }
  if (type === "boolean") {
    if (!/^(true|false)$/i.test(typed)) throw new Error(`Enter true or false for ${name}.`);
    return `${column} ${operator} ${typed.toUpperCase()}`;
  }
  if (type === "date" || type === "time") return `${column} ${operator} cast_to_type(${literal(typed)}, ${column})`;
  if (operator === "contains") return `contains(${column}, ${literal(input)})`;
  return `${column} ${operator} ${literal(input)}`;
}

function aggregateExpression(fn, column) {
  if (fn === "count") return "count(*)";
  if (fn === "distinct") return `count(DISTINCT ${identifier(column)})`;
  return `${fn}(${identifier(column)})`;
}

function transformExpression(fn, column) {
  if (["day", "month", "year"].includes(fn)) return `date_trunc('${fn}', ${column})`;
  if (fn === "round") return `round(${column}, 2)`;
  return `${fn}(${column})`;
}

async function pivotExpressions(category, group, calculation, from) {
  const value = `cast(${identifier(category)} AS VARCHAR)`;
  const { rows } = await duckdb({
    sql: `SELECT DISTINCT ${value} AS category${from} ORDER BY 1 NULLS LAST LIMIT ${pivotLimit + 1}`,
  });
  if (rows.length > pivotLimit) throw new Error(`Pivot supports up to ${pivotLimit} categories. Filter the data or choose another column.`);
  const names = [group];
  return rows.map(([item]) => {
    const label = item === null ? "NULL" : item.replaceAll("\0", "\\0");
    const name = availableName(`${category} = ${label}`, names);
    names.push(name);
    const match = item === null ? "NULL" : literal(item);
    return `${calculation} FILTER (WHERE ${value} IS NOT DISTINCT FROM ${match}) AS ${identifier(name)}`;
  });
}

function availableName(name, existing) {
  const used = new Set(existing.map(value => value.toLowerCase()));
  let candidate = name;
  for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) candidate = `${name} (${suffix})`;
  return candidate;
}

export function literal(value) {
  return value.split("\0").map(part => `'${part.replaceAll("'", "''")}'`).join(" || chr(0) || ");
}

function ruleSet(title, addLabel, buildRule) {
  const layout = element("fieldset");
  const rules = element("div", "analysis-rules");
  const add = action(addLabel);
  const active = new Map();
  add.addEventListener("click", () => {
    const { controls, toSql } = buildRule();
    const row = element("div", "analysis-fields");
    const remove = action("Remove");
    remove.setAttribute("aria-label", `Remove ${addLabel.slice(4)}`);
    remove.addEventListener("click", () => {
      active.delete(row);
      row.remove();
      add.focus();
    });
    row.append(...controls, remove);
    active.set(row, toSql);
    rules.append(row);
    controls[0].lastElementChild.focus();
  });
  layout.append(element("legend", "", title), rules, add);
  return { layout, clauses: () => [...active.values()].map(toSql => toSql()) };
}

function resultTable(columns, rows) {
  const table = element("table");
  table.setAttribute("aria-label", "Explore results");
  const head = table.createTHead().insertRow();
  for (const name of columns) {
    const cell = element("th", "", name);
    cell.scope = "col";
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) {
      const cell = tr.insertCell();
      if (value === null) cell.append(element("em", "", "NULL"));
      else cell.textContent = value;
    }
  }
  return table;
}

function select(options) {
  const control = element("select");
  updateOptions(control, options);
  return control;
}

function updateOptions(control, options) {
  const previous = control.value;
  control.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  if (options.some(([value]) => value === previous)) control.value = previous;
}

function field(label, control) {
  const node = element("label", "", label);
  node.append(control);
  return node;
}

function action(label) {
  const button = element("button", "", label);
  button.type = "button";
  return button;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
