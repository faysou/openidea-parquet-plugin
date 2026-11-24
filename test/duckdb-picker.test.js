import assert from "node:assert/strict";
import test from "node:test";

test("a slow file choice preserves the request and a cancelled choice resolves it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let receive;
  let request;
  globalThis.window = {
    openidea: {
      onMessage(listener) { receive = listener; },
      postMessage(text) { request = JSON.parse(text); },
    },
  };
  try {
    const { duckdb } = await import("../src/duckdb.js");
    const response = duckdb({ action: "compare", key: "trade_id" });
    assert.equal(request.action, "compare");
    assert.equal(request.key, "trade_id");
    receive(JSON.stringify({ id: request.id, phase: "picking" }));
    t.mock.timers.tick(90_000);
    receive(JSON.stringify({ id: request.id, result: null }));
    assert.equal(await response, null);

    const exported = duckdb({ action: "exportCsv", sql: "SELECT 1" });
    receive(JSON.stringify({ id: request.id, phase: "picking" }));
    t.mock.timers.tick(90_000);
    receive(JSON.stringify({ id: request.id, phase: "running" }));
    t.mock.timers.tick(65_000);
    await assert.rejects(exported, /DuckDB did not return a result/);
  } finally {
    delete globalThis.window;
  }
});
