import assert from "node:assert/strict";
import { test } from "node:test";
import { createGridColumns, pinGridColumns } from "../src/grid-columns.js";

test("column visibility and order use source indices even for duplicate labels", () => {
  const layout = createGridColumns(["price", "size", "price"]);
  layout.move(2, -1);
  layout.setVisible(0, false);

  assert.deepEqual(layout.columns(), [
    { index: 0, label: "price", shown: false, pinned: false },
    { index: 2, label: "price", shown: true, pinned: false },
    { index: 1, label: "size", shown: true, pinned: false },
  ]);
  assert.deepEqual(layout.visible().map(column => column.index), [2, 1]);
});

test("pinned columns can move ahead of one another and stay pinned when shown again", () => {
  const layout = createGridColumns(["trade", "time", "price", "size"]);
  layout.setPinned(1, true);
  layout.setPinned(3, true);
  layout.move(3, -1);
  layout.move(3, -1);
  layout.setVisible(3, false);

  assert.deepEqual(layout.visible().map(({ index, pinned }) => [index, pinned]), [
    [1, true], [0, false], [2, false],
  ]);

  layout.setAllVisible(false);
  assert.deepEqual(layout.visible(), []);

  layout.setAllVisible(true);
  assert.deepEqual(layout.visible().map(({ index, pinned }) => [index, pinned]), [
    [3, true], [1, true], [0, false], [2, false],
  ]);

  layout.reset();
  assert.deepEqual(layout.columns(), [
    { index: 0, label: "trade", shown: true, pinned: false },
    { index: 1, label: "time", shown: true, pinned: false },
    { index: 2, label: "price", shown: true, pinned: false },
    { index: 3, label: "size", shown: true, pinned: false },
  ]);
});

test("pinned offsets include the row number and update when a preceding column resizes", () => {
  const headers = [30, 80.5, 60, 70].map(width => ({
    width,
    style: {},
    getBoundingClientRect() { return { width: this.width }; },
  }));
  const body = headers.map(() => ({ style: {} }));
  const observed = [];
  let resize;
  let disconnected = false;
  class ResizeObserver {
    constructor(update) { resize = update; }
    observe(header) { observed.push(header); }
    disconnect() { disconnected = true; }
  }
  const layout = createGridColumns(["time", "price", "size"]);
  layout.setPinned(0, true);
  layout.setPinned(2, true);

  const table = {
    ownerDocument: { defaultView: { ResizeObserver } },
    rows: [{ cells: headers }, { cells: body }],
  };
  const cleanup = pinGridColumns(table, layout.visible());
  const offsets = row => row.map(cell => cell.style.insetInlineStart);

  assert.deepEqual(offsets(headers), ["0px", "30px", "110.5px", undefined]);
  assert.deepEqual(offsets(body), offsets(headers));
  assert.deepEqual(observed, headers.slice(0, 2));

  headers[1].width = 120;
  resize();
  assert.deepEqual(offsets(headers), ["0px", "30px", "150px", undefined]);
  assert.deepEqual(offsets(body), offsets(headers));

  cleanup();
  assert.equal(disconnected, true);
});
