export function mountPageSearch(content) {
  const bar = document.getElementById("page-search");
  const input = document.getElementById("page-search-text");
  const toggle = document.getElementById("find-page");
  const count = document.getElementById("match-count");
  const previous = document.getElementById("match-prev");
  const next = document.getElementById("match-next");
  let matches = [];
  let active = -1;

  function select(index) {
    matches[active]?.classList.remove("current-match");
    active = matches.length ? (index + matches.length) % matches.length : -1;
    const cell = matches[active];
    if (cell) {
      cell.classList.add("current-match");
      cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    count.textContent = !input.value ? "" : matches.length ? `${active + 1} of ${matches.length}` : "No matches";
    previous.disabled = next.disabled = matches.length === 0;
  }
  function update() {
    for (const cell of matches) cell.classList.remove("search-match", "current-match");
    const query = input.value.toLocaleLowerCase();
    matches = bar.hidden || !query ? [] : [...content.querySelectorAll("tbody td")].filter(cell =>
      cell.textContent.toLocaleLowerCase().includes(query));
    for (const cell of matches) cell.classList.add("search-match");
    active = -1;
    select(0);
  }
  function close() {
    bar.hidden = true;
    toggle.setAttribute("aria-pressed", "false");
    update();
  }
  toggle.addEventListener("click", () => {
    if (!bar.hidden) return close();
    bar.hidden = false;
    toggle.setAttribute("aria-pressed", "true");
    input.focus();
    input.select();
    update();
  });
  input.addEventListener("input", update);
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { close(); toggle.focus(); }
    if (event.key === "Enter") select(active + (event.shiftKey ? -1 : 1));
  });
  previous.addEventListener("click", () => select(active - 1));
  next.addEventListener("click", () => select(active + 1));
  document.getElementById("search-close").addEventListener("click", () => { close(); toggle.focus(); });
  return { update, close };
}
