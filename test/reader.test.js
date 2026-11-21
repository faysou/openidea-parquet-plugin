import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { openParquet, RANGE_BYTES } from "../src/reader.js";

const fixture = await readFile(new URL("./fixtures/synthetic-trades.parquet", import.meta.url));

test("reads selected rows through bounded ranges of a 600 MiB file", async () => {
  const size = 600 * RANGE_BYTES;
  const footer = fixture.subarray(-(fixture.readUInt32LE(fixture.length - 8) + 8));
  const reads = [];
  const document = {
    size: async () => size,
    async readRange(offset, length) {
      reads.push([offset, length]);
      assert.ok(length <= RANGE_BYTES);
      if (offset < fixture.length && offset + length <= fixture.length) {
        return new Uint8Array(fixture.subarray(offset, offset + length));
      }
      const start = offset - (size - footer.length);
      assert.ok(start >= 0 && start + length <= footer.length);
      return new Uint8Array(footer.subarray(start, start + length));
    },
  };

  const reader = await openParquet(document);
  assert.deepEqual(reads, [[size - 8, 8], [size - footer.length, footer.length - 8]]);
  assert.equal(reader.total, 235);
  assert.equal(reader.rowGroups, 4);
  assert.deepEqual(reader.columns, ["sequence", "timestamp", "event", "price", "tags"]);
  assert.deepEqual(reader.codecs, ["ZSTD"]);
  const page = await reader.readPage(100);
  assert.equal(page.length, 100);
  assert.deepEqual(page[0], [9007199254741093n, new Date("2026-11-20T12:01:40.000Z"), "trade", 207.31, ["live", "primary"]]);
  assert.equal((await reader.readPage(200)).length, 35);
  assert.equal((await reader.readPage(235)).length, 0);
  assert.ok(reads.reduce((sum, [, length]) => sum + length, 0) < 64 * 1024);
});

test("reports a file that ends before a requested range", async () => {
  await assert.rejects(
    openParquet({ size: async () => 128, readRange: async () => new Uint8Array(0) }),
    /file changed during reading/,
  );
});
