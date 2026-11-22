import { chartQuery, chartSeriesLimit, numericColumn, scalarColumn, temporalColumn } from "./chart-query.js";
import { duckdb } from "./duckdb.js";
import "./chart-panel.css";

export function mountChartPanel(file) {
  const byId = id => document.getElementById(id);
  const form = byId("chart-form");
  const types = [...byId("chart-type").querySelectorAll("button")];
  const settings = byId("chart-settings");
  const x = byId("chart-x");
  const group = byId("chart-group");
  const ySeries = byId("chart-y-series");
  const add = byId("chart-add-series");
  const bins = byId("chart-bins");
  const run = byId("chart-run");
  const png = byId("chart-png");
  const status = byId("chart-status");
  const plot = byId("plot");
  const scalar = file.schema.filter(scalarColumn);
  const columns = scalar.map(node => node.element.name);
  const numeric = scalar.filter(numericColumn).map(node => node.element.name);
  const time = scalar.filter(temporalColumn).map(node => node.element.name);
  const axisColumns = { bar: columns, line: time, area: time, scatter: numeric, histogram: numeric, pie: columns };
  let type = "bar";
  let running = false;
  let disposeChart;

  const line = () => type === "line" || type === "area";
  const coordinates = () => line() || type === "scatter";
  const ySelectors = () => [...ySeries.querySelectorAll("select")];

  function updateSeries() {
    const selects = ySelectors();
    const values = selects.map(select => select.value);
    for (const [index, select] of selects.entries()) {
      select.disabled = !coordinates();
      select.setAttribute("aria-label", index ? `Y axis ${index + 1}` : "Y axis");
      for (const option of select.options) {
        option.disabled = option.value !== select.value && values.includes(option.value);
      }
      const remove = select.nextElementSibling;
      remove.hidden = selects.length === 1;
      remove.setAttribute("aria-label", `Remove Y axis ${index + 1}`);
    }
    add.disabled = selects.length >= Math.min(numeric.length, chartSeriesLimit);
  }

  function addSeries() {
    const selected = ySelectors().map(select => select.value);
    const row = document.createElement("div");
    const select = document.createElement("select");
    select.required = true;
    select.replaceChildren(...numeric.map(name => new Option(name, name)));
    select.value = numeric.find(name => name !== x.value && !selected.includes(name)) ??
      numeric.find(name => !selected.includes(name)) ?? "";
    select.addEventListener("change", updateSeries);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      row.remove();
      updateSeries();
      ySelectors().at(-1).focus();
    });
    row.append(select, remove);
    ySeries.append(row);
    updateSeries();
    return select;
  }

  function chartFields() {
    const available = axisColumns[type];
    const previous = x.value;
    x.replaceChildren(...available.map(name => new Option(name, name)));
    if (available.includes(previous)) x.value = previous;
    byId("chart-x-label").textContent = line() ? "X axis (time)" : "X axis";
    byId("chart-y-field").hidden = !coordinates();
    byId("chart-group-field").hidden = !coordinates();
    group.disabled = !coordinates();
    byId("chart-bins-field").hidden = type !== "histogram";
    bins.disabled = type !== "histogram";
    byId("chart-line-style").hidden = !line();
    for (const button of types) {
      const needsY = ["line", "area", "scatter"].includes(button.value);
      button.setAttribute("aria-pressed", String(button.value === type));
      button.disabled = running || !axisColumns[button.value].length || (needsY && !numeric.length);
    }
    run.disabled = running || !available.length || (coordinates() && !numeric.length);
    settings.disabled = running;
    updateSeries();
  }

  group.replaceChildren(new Option("None", ""), ...columns.map(name => new Option(name, name)));
  for (const button of types) {
    button.addEventListener("click", () => {
      if (type === button.value) return;
      type = button.value;
      chartFields();
      if (coordinates() && !ySelectors().length) addSeries();
    });
  }
  add.addEventListener("click", () => addSeries().focus());
  chartFields();
  if (!columns.length) status.textContent = "No plottable columns.";

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (run.disabled) return;
    const column = x.value;
    const measures = ySelectors().map(select => select.value);
    const grouping = group.disabled ? undefined : group.value || undefined;
    const options = {
      stepped: byId("chart-stepped").checked,
      showPoints: byId("chart-points").checked,
    };
    running = true;
    chartFields();
    plot.setAttribute("aria-busy", "true");
    status.textContent = "Building chart…";
    png.disabled = true;
    disposeChart?.();
    disposeChart = undefined;
    try {
      const sql = chartQuery(type, column, measures, bins.valueAsNumber, { group: grouping });
      const { rows, columns } = await duckdb({ sql });
      if (!rows.length) {
        status.textContent = "No values to plot.";
        return;
      }
      let description;
      if (coordinates()) {
        const measureIndex = columns.indexOf("series_number");
        const groupIndex = columns.indexOf("group_label");
        const groupsIndex = columns.indexOf("group_count");
        const pointsIndex = columns.indexOf("points");
        options.series = rows.map(row => {
          const measure = measures[Number(row[measureIndex])];
          const label = row[groupIndex] === null ? "NULL" : JSON.stringify(row[groupIndex]);
          return { name: grouping ? `${measure} · ${label}` : measure, rows: JSON.parse(row[pointsIndex]) };
        });
        const shown = new Set(rows.map(row => row[groupIndex])).size;
        const groups = Number(rows[0][groupsIndex]);
        const scope = shown < groups ? ` · ${shown} of ${groups} groups` : "";
        const count = options.series.reduce((total, series) => total + series.rows.length, 0);
        description = (line() ? `Averages by time bucket (${column})` : `${count.toLocaleString()} sampled points by ${column}`) + scope;
      } else {
        description = {
          bar: `Top ${rows.length} categories by count`,
          pie: `Share among the top ${rows.length} categories`,
          histogram: `Distribution of ${column} by bin start`,
        }[type];
      }
      const { renderChart } = await import("./charts.js");
      disposeChart = renderChart(plot, type, rows, options);
      png.disabled = false;
      status.textContent = description;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      plot.setAttribute("aria-busy", "false");
      running = false;
      chartFields();
    }
  });

  png.addEventListener("click", async () => {
    png.disabled = true;
    try {
      const { getInstanceByDom } = await import("echarts/core");
      const chart = getInstanceByDom(plot);
      if (!chart) return;
      const backgroundColor = getComputedStyle(document.documentElement).backgroundColor;
      const uri = chart.getDataURL({ type: "png", pixelRatio: 2, backgroundColor });
      const data = Uint8Array.from(atob(uri.slice(uri.indexOf(",") + 1)), char => char.charCodeAt(0));
      await window.openidea.saveFile({ name: "parquet-chart.png", filters: [{ name: "PNG image", extensions: ["png"] }], data });
    } catch (error) {
      status.textContent = error.message;
    } finally {
      png.disabled = !disposeChart;
    }
  });
}
