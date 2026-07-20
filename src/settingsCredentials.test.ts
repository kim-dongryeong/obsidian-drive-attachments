import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, deriveAppIdFromClientId, getEffectivePickerAppId, parseOAuthClientJson } from "./settings";

describe("deriveAppIdFromClientId", () => {
  it("extracts the leading project number from a canonical client ID", () => {
    expect(deriveAppIdFromClientId("123456789012-abc123def.apps.googleusercontent.com")).toBe("123456789012");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(deriveAppIdFromClientId("  987654321-xyz.apps.googleusercontent.com  ")).toBe("987654321");
  });

  it("returns empty string when the client ID has no numeric prefix", () => {
    expect(deriveAppIdFromClientId("not-a-real-client-id")).toBe("");
    expect(deriveAppIdFromClientId("")).toBe("");
    expect(deriveAppIdFromClientId("abc-123.apps.googleusercontent.com")).toBe("");
  });
});

describe("getEffectivePickerAppId", () => {
  it("prefers an explicit App ID override", () => {
    const settings = { ...DEFAULT_SETTINGS, clientId: "111-a.apps.googleusercontent.com", pickerAppId: "222" };
    expect(getEffectivePickerAppId(settings)).toBe("222");
  });

  it("falls back to the App ID derived from the client ID", () => {
    const settings = { ...DEFAULT_SETTINGS, clientId: "111222333-a.apps.googleusercontent.com", pickerAppId: "" };
    expect(getEffectivePickerAppId(settings)).toBe("111222333");
  });

  it("ignores a whitespace-only override", () => {
    const settings = { ...DEFAULT_SETTINGS, clientId: "444555-a.apps.googleusercontent.com", pickerAppId: "   " };
    expect(getEffectivePickerAppId(settings)).toBe("444555");
  });

  it("returns empty when neither an override nor a derivable client ID is present", () => {
    const settings = { ...DEFAULT_SETTINGS, clientId: "malformed", pickerAppId: "" };
    expect(getEffectivePickerAppId(settings)).toBe("");
  });
});

describe("parseOAuthClientJson", () => {
  it("parses a desktop (installed) client JSON", () => {
    const raw = JSON.stringify({
      installed: {
        client_id: "123-abc.apps.googleusercontent.com",
        project_id: "my-project-123",
        client_secret: "SECRET_VALUE",
        redirect_uris: ["http://localhost"],
      },
    });
    expect(parseOAuthClientJson(raw)).toEqual({
      clientId: "123-abc.apps.googleusercontent.com",
      clientSecret: "SECRET_VALUE",
    });
  });

  it("parses a web client JSON", () => {
    const raw = JSON.stringify({ web: { client_id: "9-w.apps.googleusercontent.com", client_secret: "WS" } });
    expect(parseOAuthClientJson(raw)).toEqual({ clientId: "9-w.apps.googleusercontent.com", clientSecret: "WS" });
  });

  it("accepts a flat JSON without the installed/web wrapper", () => {
    const raw = JSON.stringify({ client_id: "5-f.apps.googleusercontent.com", client_secret: "FS" });
    expect(parseOAuthClientJson(raw)).toEqual({ clientId: "5-f.apps.googleusercontent.com", clientSecret: "FS" });
  });

  it("trims whitespace inside the fields", () => {
    const raw = JSON.stringify({ installed: { client_id: "  1-a.apps.googleusercontent.com ", client_secret: " S " } });
    expect(parseOAuthClientJson(raw)).toEqual({ clientId: "1-a.apps.googleusercontent.com", clientSecret: "S" });
  });

  it("returns null when required fields are missing", () => {
    expect(parseOAuthClientJson(JSON.stringify({ installed: { client_id: "1-a" } }))).toBeNull();
    expect(parseOAuthClientJson(JSON.stringify({ installed: { client_secret: "S" } }))).toBeNull();
    expect(parseOAuthClientJson(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("returns null for non-JSON or non-object input", () => {
    expect(parseOAuthClientJson("not json{")).toBeNull();
    expect(parseOAuthClientJson("null")).toBeNull();
    expect(parseOAuthClientJson("[1,2,3]")).toBeNull();
    expect(parseOAuthClientJson('"a string"')).toBeNull();
  });
});
