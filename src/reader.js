import { parquetMetadataAsync, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";

export const RANGE_BYTES = 1024 * 1024;
const MAX_SLICE_BYTES = 32 * RANGE_BYTES;
const MAX_PAGE_BYTES = 96 * RANGE_BYTES;
const MAX_DECODED_PAGE_BYTES = 64 * RANGE_BYTES;
const PAGE_ROWS = 100;
const PAGE_CELLS = 4096;

export async function openParquet(document) {
  if (typeof document?.size !== "function" || typeof document.readRange !== "function") {
    throw new Error("This version of OpenIDEA does not support binary custom editors.");
  }
  const size = await document.size();
  if (!Number.isSafeInteger(size) || size < 12) throw new Error("Invalid Parquet file size.");

  const file = {
    byteLength: size,
    async slice(start, end = size) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) {
        throw new Error("The Parquet file contains an invalid byte range.");
      }
      if (end - start > MAX_SLICE_BYTES) {
        throw new Error("A Parquet section is too large to preview. Try a file with smaller row groups.");
      }
      const output = new Uint8Array(end - start);
      for (let offset = start; offset < end;) {
        const length = Math.min(end - offset, RANGE_BYTES);
        const data = await document.readRange(offset, length);
        if (!(data instanceof Uint8Array) || data.byteLength !== length) {
          throw new Error("The file changed during reading. Reopen it to refresh the preview.");
        }
        output.set(data, offset - start);
        offset += length;
      }
      return output.buffer;
    },
  };

  const metadata = await parquetMetadataAsync(file, { initialFetchSize: 8, geoparquet: false });
  const schema = parquetSchema(metadata);
  const total = Number(metadata.num_rows);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("The Parquet file has an invalid row count.");
  const columns = schema.children.map(({ element }) => element.name);
  const initialPageSize = Math.min(PAGE_ROWS, Math.max(1, Math.floor(PAGE_CELLS / Math.max(columns.length, 1))));
  const codecs = [...new Set(metadata.row_groups.flatMap(group => group.columns.map(column => column.meta_data?.codec).filter(Boolean)))];

  return {
    size, columns, schema: schema.children, total, initialPageSize, pageSize: initialPageSize,
    maxPageSize: Math.min(1000, Math.max(1, Math.floor(20_000 / Math.max(columns.length, 1)))),
    rowGroups: metadata.row_groups.length, codecs,
    rowGroup(index) {
      return metadata.row_groups[index];
    },
    async readPage(start) {
      const end = Math.min(total, start + this.pageSize);
      if (start >= end || !columns.length) return [];
      let bytes = 0;
      let decodedBytes = 0;
      const budgetedCompressors = Object.fromEntries(Object.entries(compressors).map(([codec, decompress]) => [
        codec,
        (input, outputLength) => {
          decodedBytes += outputLength;
          if (!Number.isSafeInteger(outputLength) || outputLength < 0 || decodedBytes > MAX_DECODED_PAGE_BYTES) {
            throw new Error("The compressed Parquet pages are too large to preview.");
          }
          return decompress(input, outputLength);
        },
      ]));
      const pageFile = {
        byteLength: size,
        slice(from, to = size) {
          bytes += to - from;
          if (bytes > MAX_PAGE_BYTES) throw new Error("This row group needs too much data to preview.");
          return file.slice(from, to);
        },
      };
      let rows;
      await parquetRead({
        file: pageFile, metadata, compressors: budgetedCompressors, rowStart: start, rowEnd: end,
        useOffsetIndex: true, onComplete: data => { rows = data; },
      });
      return rows ?? [];
    },
  };
}
