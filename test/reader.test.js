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
  const group = reader.rowGroup(0);
  const column = group.columns[0].meta_data;
  assert.equal(group.num_rows, 65n);
  assert.deepEqual([column.path_in_schema, column.codec, column.total_compressed_size,
    column.total_uncompressed_size, column.statistics.null_count, column.statistics.min_value, column.statistics.max_value],
    [["sequence"], "ZSTD", 271n, 655n, 0n, 9007199254740993n, 9007199254741057n]);
  assert.equal(reads.length, 2);
  const page = await reader.readPage(100);
  assert.equal(page.length, 100);
  assert.deepEqual(page[0], [9007199254741093n, new Date("2026-11-20T12:01:40.000Z"), "trade", 207.31, ["live", "primary"]]);
  assert.equal((await reader.readPage(200)).length, 35);
  assert.equal((await reader.readPage(235)).length, 0);
  assert.ok(reads.reduce((sum, [, length]) => sum + length, 0) < 64 * 1024);
});

test("honors a custom preview size and stops at the last record", async () => {
  const file = await openParquet({
    size: async () => fixture.length,
    readRange: async (offset, length) => new Uint8Array(fixture.subarray(offset, offset + length)),
  });
  assert.equal(file.pageSize, 100);
  assert.equal(file.maxPageSize, 1000);
  file.pageSize = 7;
  const small = await file.readPage(7);
  assert.deepEqual([small.length, small[0][0], small.at(-1)[0]], [7, 9007199254741000n, 9007199254741006n]);
  file.pageSize = 250;
  const all = await file.readPage(0);
  assert.deepEqual([all.length, all.at(-1)[0]], [235, 9007199254741227n]);
});

test("reports a file that ends before a requested range", async () => {
  await assert.rejects(
    openParquet({ size: async () => 128, readRange: async () => new Uint8Array(0) }),
    /file changed during reading/,
  );
});
