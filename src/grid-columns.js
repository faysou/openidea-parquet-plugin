export function createGridColumns(labels) {
  const initialColumns = () => labels.map((label, index) => ({ index, label, shown: true, pinned: false }));
  let entries = initialColumns();
  const columns = () => [
    ...entries.filter(column => column.pinned),
    ...entries.filter(column => !column.pinned),
  ].map(column => ({ ...column }));

  return {
    columns,
    visible: () => columns().filter(column => column.shown),
    setVisible(index, shown) {
      entries.find(column => column.index === index).shown = shown;
    },
    setAllVisible(shown) {
      for (const column of entries) column.shown = shown;
    },
    setPinned(index, pinned) {
      entries.find(column => column.index === index).pinned = pinned;
    },
    move(index, direction) {
      const position = entries.findIndex(column => column.index === index);
      const pinned = entries[position].pinned;
      for (let next = position + direction; next >= 0 && next < entries.length; next += direction) {
        if (entries[next].pinned === pinned) {
          [entries[position], entries[next]] = [entries[next], entries[position]];
          return;
        }
      }
    },
    reset() {
      entries = initialColumns();
    },
  };
}

export function createColumnChooser(layout, onChange) {
  const chooser = document.createElement("details");
  chooser.className = "column-chooser";
  const summary = document.createElement("summary");
  const panel = document.createElement("div");
  panel.className = "column-chooser-panel";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search columns";
  search.setAttribute("aria-label", "Search columns");
  const actions = document.createElement("div");
  actions.className = "column-chooser-actions";
  const list = document.createElement("ul");
  list.className = "column-chooser-list";
  const empty = document.createElement("p");
  empty.textContent = "No matching columns";

  const change = (update, index, control) => {
    update();
    render(index, control);
    onChange();
  };

  actions.append(
    columnButton("Show all", () => change(() => layout.setAllVisible(true))),
    columnButton("Hide all", () => change(() => layout.setAllVisible(false))),
    columnButton("Reset", () => change(() => layout.reset())),
  );
  search.addEventListener("input", () => render());
  chooser.addEventListener("keydown", event => {
    if (event.key === "Escape" && chooser.open) {
      event.preventDefault();
      event.stopPropagation();
      chooser.open = false;
      summary.focus();
    }
  });
  panel.append(search, actions, list, empty);
  chooser.append(summary, panel);
  render();
  return chooser;

  function render(focusedIndex, focusedControl) {
    const columns = layout.columns();
    const visibleCount = columns.filter(column => column.shown).length;
    summary.textContent = visibleCount === columns.length ? "Columns" : `Columns (${visibleCount}/${columns.length})`;
    const query = search.value.trim().toLowerCase();
    const pinnedCount = columns.filter(column => column.pinned).length;
    let focus;
    const items = columns.flatMap((column, position) => {
      const { index, label, pinned, shown } = column;
      if (!label.toLowerCase().includes(query)) return [];
      const item = document.createElement("li");
      item.className = "column-chooser-entry";
      const visibility = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = shown;
      checkbox.addEventListener("change", () => change(() => layout.setVisible(index, checkbox.checked), index, "visibility"));
      visibility.append(checkbox, label);
      const pin = columnButton(pinned ? "Unpin" : "Pin", () => change(() => layout.setPinned(index, !pinned), index, "pin"));
      pin.setAttribute("aria-label", `${pinned ? "Unpin" : "Pin"} ${label}`);
      const up = columnButton("Move up", () => change(() => layout.move(index, -1), index, "up"));
      up.setAttribute("aria-label", `Move ${label} up`);
      up.disabled = position === (pinned ? 0 : pinnedCount);
      const down = columnButton("Move down", () => change(() => layout.move(index, 1), index, "down"));
      down.setAttribute("aria-label", `Move ${label} down`);
      down.disabled = position === (pinned ? pinnedCount : columns.length) - 1;
      item.append(visibility, pin, up, down);
      if (index === focusedIndex) {
        const controls = { visibility: checkbox, pin, up, down };
        focus = controls[focusedControl].disabled ? checkbox : controls[focusedControl];
      }
      return [item];
    });
    list.replaceChildren(...items);
    empty.hidden = items.length > 0;
    focus?.focus();
  }
}

export function pinGridColumns(table, visibleColumns) {
  const pinnedCount = visibleColumns.filter(column => column.pinned).length;
  if (!pinnedCount) return () => {};

  const rows = Array.from(table.rows);
  const allHeaders = Array.from(rows[0].cells);
  const headers = allHeaders.slice(0, pinnedCount + 1);
  const cells = headers.map((_, index) => rows.map(row => row.cells[index]));

  for (const header of allHeaders.slice(pinnedCount + 1)) header.style.zIndex = "2";
  for (const [header, ...body] of cells) {
    Object.assign(header.style, { position: "sticky", zIndex: "3" });
    for (const cell of body) {
      Object.assign(cell.style, {
        position: "sticky",
        zIndex: "1",
        background: "var(--openidea-bg-elevated, Canvas)",
      });
    }
  }

  const updateOffsets = () => {
    let offset = 0;
    const widths = headers.map(header => header.getBoundingClientRect().width);
    for (const [index, columnCells] of cells.entries()) {
      for (const cell of columnCells) cell.style.insetInlineStart = `${offset}px`;
      offset += widths[index];
    }
  };

  updateOffsets();
  const observer = new table.ownerDocument.defaultView.ResizeObserver(updateOffsets);
  for (const header of headers.slice(0, -1)) observer.observe(header);
  return () => observer.disconnect();
}

function columnButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}
