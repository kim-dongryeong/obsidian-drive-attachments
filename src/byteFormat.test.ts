import { describe, expect, it } from "vitest";
import { formatBytes } from "./byteFormat";

describe("formatBytes", () => {
  it("formats values below 1 KiB with no decimals", () => {
    expect(formatBytes("0")).toBe("0 B");
    expect(formatBytes("500")).toBe("500 B");
    expect(formatBytes("1023")).toBe("1023 B");
  });

  it("scales to IEC units with one decimal", () => {
    expect(formatBytes("1024")).toBe("1.0 KiB");
    expect(formatBytes("1536")).toBe("1.5 KiB");
    expect(formatBytes("1048576")).toBe("1.0 MiB");
    expect(formatBytes("1073741824")).toBe("1.0 GiB");
    expect(formatBytes("1099511627776")).toBe("1.0 TiB");
  });

  it("caps at the largest unit (TiB)", () => {
    expect(formatBytes(String(1024 ** 5))).toBe("1024.0 TiB");
  });

  it("passes non-numeric or negative input through unchanged", () => {
    expect(formatBytes("abc")).toBe("abc");
    expect(formatBytes("-5")).toBe("-5");
    expect(formatBytes("Size not available")).toBe("Size not available");
  });

  it('treats empty string as 0 (Number("") === 0)', () => {
    expect(formatBytes("")).toBe("0 B");
  });
});
