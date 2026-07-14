import { describe, expect, it } from "vitest";
import { computeMd5Hex, computeMd5HexFromSource } from "./driveDedupService";
import { BufferUploadSource, type UploadSource } from "./driveUploadService";

function bytes(length: number, seed = 7): ArrayBuffer {
  const view = new Uint8Array(length);
  let value = seed;
  for (let index = 0; index < length; index += 1) {
    value = (value * 31 + 17) % 251;
    view[index] = value;
  }
  return view.buffer;
}

describe("BufferUploadSource", () => {
  it("reports size and serves exact chunk windows", async () => {
    const data = bytes(100);
    const source = new BufferUploadSource(data);
    expect(source.size).toBe(100);

    const chunk = new Uint8Array(await source.readChunk(10, 20));
    expect(chunk).toEqual(new Uint8Array(data).slice(10, 20));
  });

  it("re-reads the same range identically (root-fallback / 308 rewind)", async () => {
    const source = new BufferUploadSource(bytes(64));
    const first = new Uint8Array(await source.readChunk(0, 32));
    const second = new Uint8Array(await source.readChunk(0, 32));
    expect(second).toEqual(first);
  });
});

describe("computeMd5HexFromSource", () => {
  it("matches the whole-buffer hash for small input", async () => {
    const data = bytes(1024);
    expect(await computeMd5HexFromSource(new BufferUploadSource(data))).toBe(computeMd5Hex(data));
  });

  it("matches the whole-buffer hash across the 8 MiB chunk boundary", async () => {
    // 9 MiB forces at least two readChunk windows, proving the incremental digest is
    // chunking-independent (Drive's md5Checksum hashes whole content, however it was read).
    const data = bytes(9 * 1024 * 1024);
    let reads = 0;
    const counting: UploadSource = {
      size: data.byteLength,
      readChunk: (start, end) => {
        reads += 1;
        return Promise.resolve(data.slice(start, end));
      },
    };
    expect(await computeMd5HexFromSource(counting)).toBe(computeMd5Hex(data));
    expect(reads).toBeGreaterThan(1);
  });

  it("hashes the empty source to the md5 of empty input", async () => {
    expect(await computeMd5HexFromSource(new BufferUploadSource(new ArrayBuffer(0))))
      .toBe(computeMd5Hex(new ArrayBuffer(0)));
  });
});
