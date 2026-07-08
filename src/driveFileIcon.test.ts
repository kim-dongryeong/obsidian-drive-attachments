import { describe, expect, it } from "vitest";
import { renderFileIcon } from "./driveFileIcon";

class TestStyle {
  private readonly values = new Map<string, string>();

  set color(value: string) {
    this.values.set("color", value);
  }

  get color(): string {
    return this.values.get("color") ?? "";
  }
}

class TestElement {
  innerHTML = "";
  readonly attrs = new Map<string, string>();
  readonly style = new TestStyle();

  empty(): void {
    this.innerHTML = "";
    this.attrs.clear();
    this.style.color = "";
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  createEl(): TestElement {
    return new TestElement();
  }
}

function renderIcon(mimeType: string, name: string, fallback: string, iconTheme = "default"): TestElement {
  const el = new TestElement();
  renderFileIcon(
    el as unknown as HTMLElement,
    mimeType,
    name,
    fallback,
    undefined,
    iconTheme as Parameters<typeof renderFileIcon>[5],
  );
  return el;
}

describe("renderFileIcon", () => {
  it("uses plain Lucide fallbacks for PDF and Office file types in the default theme", () => {
    const pdf = renderIcon("application/pdf", "contract.pdf", "file-type");
    const word = renderIcon(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "draft.docx",
      "file-text",
    );
    const sheet = renderIcon(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "budget.xlsx",
      "table",
    );

    expect(pdf.attrs.get("data-icon")).toBe("file-type");
    expect(word.attrs.get("data-icon")).toBe("file-text");
    expect(sheet.attrs.get("data-icon")).toBe("table");
    expect(pdf.innerHTML).toBe("");
    expect(word.innerHTML).toBe("");
    expect(sheet.innerHTML).toBe("");
    expect(pdf.style.color).toBe("");
    expect(word.style.color).toBe("");
    expect(sheet.style.color).toBe("");
  });

  it("still uses bundled artwork when a non-default icon theme is selected", () => {
    const icon = renderIcon("application/pdf", "contract.pdf", "file-type", "flat");

    expect(icon.innerHTML).toContain("<svg");
    expect(icon.attrs.get("data-icon")).toBeUndefined();
  });
});
