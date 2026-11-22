import { init, use } from "echarts/core";
import { BarChart, LineChart, ScatterChart, PieChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

use([BarChart, LineChart, ScatterChart, PieChart, DataZoomComponent, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export function renderChart(element, type, rows, { series, stepped = false, showPoints = false } = {}) {
  const chart = init(element);
  const style = getComputedStyle(element);
  const color = style.color;
  const line = type === "line" || type === "area";
  const scatter = type === "scatter";
  const coordinates = line || scatter;
  const datasets = series ?? [{ rows }];
  const allRows = datasets.flatMap(dataset => dataset.rows);
  const xValues = coordinates ? allRows.map(([x]) => Number(x)) : [];
  const time = line && xValues.every(value => Math.abs(value) <= 8.64e15);
  const x = time ? { values: xValues } : chartAxis(xValues);
  const y = chartAxis(allRows.map(([, value]) => Number(value)));
  const scaled = x.name || y.name;
  let offset = 0;
  chart.setOption(type === "pie" ? {
    animation: false, textStyle: { color }, tooltip: { trigger: "item", renderMode: "richText" },
    series: [{ type: "pie", radius: ["25%", "68%"], label: { color }, data: rows.map(([name, value]) => ({ name, value: Number(value) })) }],
  } : {
    animation: false,
    useUTC: true,
    textStyle: { color },
    grid: { left: 65, right: 24, top: series ? 33 : 18, bottom: 64 },
    ...(series && { legend: { type: "scroll", top: 2, textStyle: { color } } }),
    tooltip: {
      trigger: scatter ? "item" : "axis", renderMode: "richText", confine: true,
      ...(coordinates && scaled && { formatter: points => {
        const items = Array.isArray(points) ? points : [points];
        const first = items[0];
        if (!first) return "";
        const label = datasets[first.seriesIndex].rows[first.dataIndex][0];
        return [time ? new Date(Number(label)).toISOString() : label, ...items.map(point => {
          const { name, rows } = datasets[point.seriesIndex];
          const value = rows[point.dataIndex][1];
          return name ? `${name}: ${value}` : value;
        })].join("\n");
      } }),
    },
    xAxis: {
      type: time ? "time" : coordinates ? "value" : "category",
      ...(!coordinates && { data: rows.map(([label]) => label) }),
      name: line && !time ? "Unix time (ms)" : x.name,
      scale: coordinates && !time,
      axisLabel: { color },
    },
    yAxis: { type: "value", name: y.name, scale: coordinates, axisLabel: { color }, splitLine: { lineStyle: { color, opacity: 0.14 } } },
    dataZoom: [{ type: "inside" }, { type: "slider", bottom: 14 }],
    series: datasets.map(({ name, rows }) => ({
      name,
      type: line ? "line" : scatter ? "scatter" : "bar",
      ...(type === "area" && { areaStyle: {} }),
      ...(line && { step: stepped ? "end" : false, showSymbol: showPoints || rows.length === 1 }),
      data: rows.map(() => {
        const index = offset++;
        return coordinates ? [x.values[index], y.values[index]] : y.values[index];
      }),
    })),
  });
  const observer = new ResizeObserver(() => chart.resize());
  observer.observe(element);
  return () => {
    observer.disconnect();
    chart.dispose();
  };
}

function chartAxis(values) {
  const magnitude = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (!magnitude || (magnitude >= 1e-100 && magnitude <= 1e100)) return { values };
  const exponent = Math.max(-300, Math.floor(Math.log10(magnitude)));
  const unit = 10 ** exponent;
  return { values: values.map(value => value / unit), name: `× 10^${exponent}` };
}
