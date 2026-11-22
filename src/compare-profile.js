const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumSignificantDigits: 4 });

export function renderComparisonProfile(container, { profileColumn, kind, exactInteger, types, files, distribution }) {
  const profile = document.createElement("section");
  profile.className = "comparison-profile";
  profile.append(textElement("h2", profileColumn));

  const summary = profileTable("Column profile", "Statistic");
  const summaryBody = summary.createTBody();
  profileRow(summaryBody, "Type", types.map(type => type ?? "Column missing"));
  profileRow(summaryBody, "Rows", files.map(file => countLabel(file.rows)));
  profileRow(summaryBody, "Nulls", files.map(file => countLabel(file.nulls, file.rows)));
  if (kind === "numeric") {
    profileRow(summaryBody, "Non-finite values", files.map(file => countLabel(file.nonfinite, file.rows)));
    for (const [label, key] of [["Minimum", "minimum"], ["Mean", "mean"], ["Maximum", "maximum"]]) {
      profileRow(summaryBody, label, files.map(file => file[key] ?? "N/A"));
    }
  }
  profile.append(summary);

  if (kind === "numeric") {
    profile.append(textElement("p", exactInteger
      ? "The mean uses double precision. Bin boundaries use exact integers."
      : "The mean and shared bins use double precision. Fine differences may share a bin."));
  }

  const messages = {
    missing: "The selected file does not contain this column.",
    incompatible: "The column types differ and cannot share a distribution.",
    unsupported: "Distribution comparison is unavailable for this column type.",
  };
  if (messages[kind]) {
    profile.append(textElement("p", messages[kind]));
  } else if (!distribution.length) {
    profile.append(textElement("p", kind === "numeric" ? "Neither file contains finite values." : "Neither file contains non-null values."));
  } else {
    const numeric = kind === "numeric";
    const totals = files.map(file => BigInt(file.rows) - BigInt(file.nulls) - BigInt(file.nonfinite ?? 0));
    const table = profileTable(
      numeric ? "Shared bins · share of finite values" : "Categories · share of non-null values",
      numeric ? "Range" : "Category",
    );
    const body = table.createTBody();
    for (const [index, bucket] of distribution.entries()) {
      const label = numeric ? binLabel(bucket, index === distribution.length - 1) : (bucket.label ?? "Other categories");
      const row = profileRow(body, label === "" ? '""' : label, [
        countLabel(bucket.opened, totals[0]),
        countLabel(bucket.selected, totals[1]),
      ]);
      for (const [side, count] of [bucket.opened, bucket.selected].entries()) {
        if (totals[side] === 0n) continue;
        const meter = document.createElement("meter");
        meter.max = 1;
        meter.value = share(count, totals[side]);
        meter.setAttribute("aria-hidden", "true");
        row.cells[side + 1].prepend(meter);
      }
    }
    profile.append(table);
  }
  container.replaceChildren(profile);
}

function textElement(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function profileTable(title, firstColumn) {
  const table = document.createElement("table");
  table.createCaption().textContent = title;
  const head = table.createTHead().insertRow();
  for (const label of [firstColumn, "Open file", "Selected file"]) {
    const cell = textElement("th", label);
    cell.scope = "col";
    head.append(cell);
  }
  return table;
}

function profileRow(body, label, values) {
  const row = body.insertRow();
  const heading = textElement("th", label);
  heading.scope = "row";
  row.append(heading);
  for (const value of values) row.insertCell().textContent = value;
  return row;
}

function countLabel(count, total) {
  if (count == null) return "N/A";
  const label = BigInt(count).toLocaleString();
  return total && BigInt(total) > 0n ? `${label} (${percent.format(share(count, total))})` : label;
}

function share(count, total) {
  return Number(count) / Number(total);
}

function binLabel({ lower, upper }, last) {
  return lower === upper ? lower : `[${lower}, ${upper}${last ? "]" : ")"}`;
}
