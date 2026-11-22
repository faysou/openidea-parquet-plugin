import { identifier, numericColumn, scalarColumn, temporalColumn } from "./chart-query.js";

const textColumn = node => scalarColumn(node) &&
  (node.element.logical_type?.type === "STRING" || node.element.converted_type === "UTF8");

export const recipes = [
  {
    label: "Missing-value patterns",
    sql: () => `WITH patterns AS (
  SELECT [name FOR name IN json_keys(to_json(p)) IF json_type(to_json(p), '/' || replace(replace(name, '~', '~0'), '/', '~1')) = 'NULL'] AS missing_columns
  FROM parquet_data AS p
)
SELECT missing_columns, count(*) AS records
FROM patterns GROUP BY missing_columns ORDER BY records DESC, missing_columns`,
  },
  {
    label: "Duplicate records",
    sql: () => `SELECT p AS record, count(*) AS copies FROM parquet_data AS p
GROUP BY p HAVING count(*) > 1 ORDER BY copies DESC`,
  },
  {
    label: "Text lengths", fields: [["Text column", textColumn]],
    sql: ([value]) => `SELECT length(${value}) AS characters, count(*) AS records
FROM parquet_data WHERE ${value} IS NOT NULL GROUP BY characters ORDER BY characters`,
  },
  {
    label: "Time gaps", fields: [["Time column", temporalColumn]],
    sql: ([time]) => `WITH times AS (SELECT DISTINCT ${time} AS t FROM parquet_data WHERE ${time} IS NOT NULL),
gaps AS (SELECT t, lag(t) OVER (ORDER BY t) AS previous_time FROM times)
SELECT previous_time, t, t - previous_time AS gap FROM gaps
WHERE previous_time IS NOT NULL ORDER BY gap DESC, t`,
  },
  {
    label: "Moving average", fields: [["Time column", temporalColumn], ["Value column", numericColumn]],
    sql: ([time, value]) => `WITH observations AS (
  SELECT ${time} AS t, avg(${value}) AS value FROM parquet_data
  WHERE ${time} IS NOT NULL AND isfinite(try_cast(${value} AS DOUBLE)) GROUP BY ${time}
)
SELECT t, value, avg(value) OVER (ORDER BY t ROWS BETWEEN 9 PRECEDING AND CURRENT ROW) AS moving_average_10
FROM observations ORDER BY t`,
  },
  {
    label: "Outlier capping preview", fields: [["Value column", numericColumn]],
    sql: ([value]) => `WITH data AS (SELECT ${value} AS value FROM parquet_data WHERE isfinite(try_cast(${value} AS DOUBLE))),
bounds AS (SELECT quantile_cont(value, 0.25) AS q1, quantile_cont(value, 0.75) AS q3 FROM data),
limits AS (SELECT q1 - 1.5 * (q3-q1) AS lo, q3 + 1.5 * (q3-q1) AS hi FROM bounds)
SELECT value, greatest(lo, least(value, hi)) AS capped_value FROM data CROSS JOIN limits
WHERE value < lo OR value > hi ORDER BY value`,
  },
];

export function mountRecipes(container, schema, editor) {
  const menu = document.createElement("select");
  menu.setAttribute("aria-label", "Analysis query");
  menu.add(new Option("Analysis query…", ""));
  const fields = document.createElement("span");
  fields.className = "query-controls";
  const insert = document.createElement("button");
  insert.type = "button";
  insert.textContent = "Insert SQL";
  insert.hidden = true;
  for (const [index, recipe] of recipes.entries()) {
    const option = new Option(recipe.label, String(index));
    option.disabled = recipe.fields?.some(([, accepts]) => !schema.some(accepts)) ?? false;
    menu.add(option);
  }
  menu.addEventListener("change", () => {
    const recipe = recipes[menu.value];
    fields.replaceChildren();
    for (const [label, accepts] of recipe?.fields ?? []) {
      const field = document.createElement("select");
      field.setAttribute("aria-label", label);
      for (const { element } of schema.filter(accepts)) field.add(new Option(element.name, element.name));
      const caption = document.createElement("label");
      caption.append(label + " ", field);
      fields.append(caption);
    }
    insert.hidden = !recipe;
  });
  insert.addEventListener("click", () => {
    editor.value = recipes[menu.value].sql([...fields.querySelectorAll("select")].map(field => identifier(field.value)));
    editor.focus();
  });
  container.append(menu, fields, insert);
}
