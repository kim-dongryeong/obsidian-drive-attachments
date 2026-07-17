import { beforeAll, describe, expect, it } from "vitest";
import { renderFileIcon } from "./driveFileIcon";

// setTrustedSvg (used by the bundled-theme path) parses the trusted SVG with DOMParser and appends
// the node — neither exists in the Node test env, so stub the minimum: DOMParser reports a valid
// <svg> root for strings that start with "<svg", and TestElement records appended children.
beforeAll(() => {
  class FakeDoc {
    constructor(private readonly isSvg: boolean) {}
    get documentElement(): { tagName: string } {
      return { tagName: this.isSvg ? "svg" : "html" };
    }
    querySelector(): null {
      return null;
    }
  }
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
    parseFromString(source: string): FakeDoc {
      return new FakeDoc(source.trimStart().startsWith("<svg"));
    }
  };
});

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
  readonly children: Array<{ tagName: string }> = [];
  readonly ownerDocument = { importNode: (node: { tagName: string }) => node };

  empty(): void {
    this.innerHTML = "";
    this.attrs.clear();
    this.style.color = "";
    this.children.length = 0;
  }

  appendChild(node: { tagName: string }): { tagName: string } {
    this.children.push(node);
    return node;
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
    expect(pdf.children).toHaveLength(0);
    expect(word.children).toHaveLength(0);
    expect(sheet.children).toHaveLength(0);
  });

  it("still uses bundled artwork when a non-default icon theme is selected", () => {
    const icon = renderIcon("application/pdf", "contract.pdf", "file-type", "flat");

    expect(icon.children).toHaveLength(1);
    expect(icon.children[0].tagName.toLowerCase()).toBe("svg");
    expect(icon.attrs.get("data-icon")).toBeUndefined();
  });
});
