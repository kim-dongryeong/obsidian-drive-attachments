#!/usr/bin/env python3
"""Generate bundled file-type icon themes and a visual catalog.

NOTE: the plugin renders custom icons via an isolated <img> (security), where `currentColor`
resolves to BLACK (it cannot inherit the theme text color). So the LINE set uses an explicit
neutral gray that reads on both light and dark — NOT currentColor."""
import json
import pathlib

OUT = pathlib.Path("/tmp/gdab-iconsets")
ROOT = pathlib.Path(__file__).resolve().parents[1]
TS_OUT = ROOT / "src" / "iconThemes.ts"
VB = '0 0 24 24'
LINE_GRAY = "#7d8694"   # visible on light AND dark (currentColor would render black via <img>)
REFINE_INK = "#94908a"  # warm greige hairline — "진짜 정말 세련된": elegant ink + a single gold accent
REFINE_GOLD = "#b08d57"
# NOIR — the premium/editorial set: a warm-graphite FILLED ink card with a champagne-gold foil
# folded corner + a thin gold frame (so the card silhouette reads on a dark host theme too) and an
# ivory engraved glyph. Solid dark tile (distinct from refined's light hairline); self-contained so
# it is legible on BOTH light and dark — no currentColor.
NOIR_INK = "#262329"    # warm graphite page
NOIR_GOLD = "#c8a96a"   # champagne foil — frame + gilded folded corner + folder lip
NOIR_IVORY = "#efe9dd"  # warm ivory engraving (the type glyph)
TERM_GREEN = "#2ea043"  # phosphor green for the terminal set (single colour, reads on light + dark)


def mix(a, b, t):
    """Blend hex colour a→b by t∈[0,1]. Used to bake pastel tints (no currentColor)."""
    ca = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    cb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(ca, cb))

BODY = "M6.5 2.5 H14 L19.5 8 V19.5 A2 2 0 0 1 17.5 21.5 H6.5 A2 2 0 0 1 4.5 19.5 V4.5 A2 2 0 0 1 6.5 2.5 Z"
FOLD = "M14 2.5 V6 A2 2 0 0 0 16 8 H19.5"
FOLD_FILL = "M14 3 L19 8 H15.6 A1.6 1.6 0 0 1 14 6.4 Z"
FOLDER = "M3.5 6.5 A2 2 0 0 1 5.5 4.5 H9 L11 6.5 H18.5 A2 2 0 0 1 20.5 8.5 V17.5 A2 2 0 0 1 18.5 19.5 H5.5 A2 2 0 0 1 3.5 17.5 Z"

COLOR = {
    "docx":"#2b579a","rtf":"#2b579a","txt":"#5b6470","xlsx":"#1f7a44","spreadsheet":"#1f7a44",
    "csv":"#1f7a44","pptx":"#c43e1c","presentation":"#c43e1c","pdf":"#d93025","photo":"#0e9aa7",
    "video":"#c5221f","audio":"#7c3aed","code":"#3b6ea5","html":"#e0682a","xml":"#3b6ea5",
    "archive":"#d48300","zip":"#d48300","vector":"#8b5cf6","font":"#475569","email":"#2f6fb0",
    "genericfile":"#8a93a0","folder":"#f2b53b",
}
GLYPH = {
    "docx":"lines","rtf":"lines","txt":"lines","pdf":"lines","xlsx":"grid","spreadsheet":"grid",
    "csv":"grid","pptx":"bars","presentation":"bars","photo":"photo","video":"play","audio":"note",
    "code":"code","html":"code","xml":"code","archive":"box","zip":"box","vector":"vector",
    "font":"fontA","email":"mail","genericfile":"plain","folder":None,
}
NAMES = list(GLYPH.keys())

def glyph(kind, c):
    sw = 'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"'
    if kind == "lines":
        return (f'<rect x="7.6" y="12.4" width="8.8" height="1.5" rx=".75" fill="{c}"/>'
                f'<rect x="7.6" y="15" width="8.8" height="1.5" rx=".75" fill="{c}"/>'
                f'<rect x="7.6" y="17.6" width="5.6" height="1.5" rx=".75" fill="{c}"/>')
    if kind == "grid":
        return (f'<rect x="7.6" y="12.4" width="8.8" height="7" rx="1" fill="none" stroke="{c}" stroke-width="1.2"/>'
                f'<path d="M7.6 15 H16.4 M7.6 17 H16.4 M10.5 12.4 V19.4 M13.5 12.4 V19.4" stroke="{c}" stroke-width="1"/>')
    if kind == "bars":
        return (f'<rect x="8" y="16" width="2.1" height="3.6" rx=".6" fill="{c}"/>'
                f'<rect x="11" y="13.4" width="2.1" height="6.2" rx=".6" fill="{c}"/>'
                f'<rect x="14" y="15" width="2.1" height="4.6" rx=".6" fill="{c}"/>')
    if kind == "play":
        return f'<path d="M10.3 12.7 L16 15.9 L10.3 19.1 Z" fill="{c}"/>'
    if kind == "note":
        return (f'<path d="M16 11.4 V16.9" stroke="{c}" {sw} fill="none"/>'
                f'<path d="M16 11.4 C 16.1 11.5 17.7 12 17.9 13.4" stroke="{c}" {sw} fill="none"/>'
                f'<circle cx="14.4" cy="17" r="1.7" fill="{c}"/>')
    if kind == "code":
        return f'<path d="M11 12.6 L8.4 15.9 L11 19.2 M15 12.6 L17.6 15.9 L15 19.2" fill="none" stroke="{c}" {sw}/>'
    if kind == "photo":
        return (f'<rect x="7.6" y="12.4" width="8.8" height="7.1" rx="1.3" fill="none" stroke="{c}" stroke-width="1.2"/>'
                f'<circle cx="10" cy="14.8" r="1" fill="{c}"/>'
                f'<path d="M7.9 18.9 L11 15.7 L13 17.7 L15 15.9 L16.2 17.1" fill="none" stroke="{c}" stroke-width="1.2" stroke-linejoin="round"/>')
    if kind == "box":
        return (f'<rect x="7.6" y="12.4" width="8.8" height="7.1" rx="1.3" fill="none" stroke="{c}" stroke-width="1.2"/>'
                f'<path d="M12 12.4 V19.5" stroke="{c}" stroke-width="1.2" stroke-dasharray="1.5 1.3"/>'
                f'<rect x="11" y="14.6" width="2" height="2" rx=".4" fill="{c}"/>')
    if kind == "vector":
        return (f'<circle cx="9" cy="18.3" r="1.3" fill="none" stroke="{c}" stroke-width="1.2"/>'
                f'<circle cx="16" cy="13.3" r="1.3" fill="none" stroke="{c}" stroke-width="1.2"/>'
                f'<path d="M9.9 17.4 C 12.2 15.4 13.8 14.2 15.2 13.6" fill="none" stroke="{c}" stroke-width="1.2"/>')
    if kind == "fontA":
        return f'<path d="M9 19.2 L12 12 L15 19.2 M10.2 16.6 H13.8" fill="none" stroke="{c}" {sw}/>'
    if kind == "mail":
        return (f'<rect x="7.6" y="12.9" width="8.8" height="6.6" rx="1.3" fill="none" stroke="{c}" stroke-width="1.2"/>'
                f'<path d="M7.9 13.6 L12 16.6 L16.1 13.6" fill="none" stroke="{c}" stroke-width="1.2" stroke-linejoin="round"/>')
    if kind == "plain":
        return f'<rect x="8.4" y="17.6" width="5.2" height="1.4" rx=".7" fill="{c}" opacity=".55"/>'
    return ""

def body_of(style, name):
    c = COLOR[name]
    is_folder = name == "folder"
    if style == "flat":
        if is_folder:
            return f'<path d="{FOLDER}" fill="{c}"/><path d="M3.5 9 H20.5" stroke="#fff" stroke-opacity=".35" stroke-width="1"/>'
        return (f'<path d="{BODY}" fill="{c}"/><path d="{FOLD_FILL}" fill="#fff" fill-opacity=".30"/>'
                + glyph(GLYPH[name], "#ffffff"))
    if style == "line":
        if is_folder:
            return f'<path d="{FOLDER}" fill="none" stroke="{LINE_GRAY}" stroke-width="1.5" stroke-linejoin="round"/>'
        return (f'<path d="{BODY}" fill="none" stroke="{LINE_GRAY}" stroke-width="1.5" stroke-linejoin="round"/>'
                f'<path d="{FOLD}" fill="none" stroke="{LINE_GRAY}" stroke-width="1.5" stroke-linejoin="round"/>'
                + glyph(GLYPH[name], LINE_GRAY))
    if style == "refined":
        # hairline warm-greige page + the type glyph in a single restrained gold — quiet luxury
        if is_folder:
            return (f'<path d="{FOLDER}" fill="none" stroke="{REFINE_INK}" stroke-width="1.1" stroke-linejoin="round"/>'
                    f'<path d="M5.5 4.5 H9 L11 6.5" fill="none" stroke="{REFINE_GOLD}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>')
        return (f'<path d="{BODY}" fill="none" stroke="{REFINE_INK}" stroke-width="1.1" stroke-linejoin="round"/>'
                f'<path d="{FOLD}" fill="none" stroke="{REFINE_INK}" stroke-width="1.1" stroke-linejoin="round"/>'
                + glyph(GLYPH[name], REFINE_GOLD))
    if style == "noir":
        # graphite ink card + gold foil corner/frame + ivory glyph — premium/editorial, reads on light AND dark
        if is_folder:
            return (f'<path d="{FOLDER}" fill="{NOIR_INK}"/>'
                    f'<path d="{FOLDER}" fill="none" stroke="{NOIR_GOLD}" stroke-width="1" stroke-linejoin="round"/>'
                    f'<path d="M5.5 4.5 H9 L11 6.5" fill="none" stroke="{NOIR_GOLD}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>')
        return (f'<path d="{BODY}" fill="{NOIR_INK}"/>'
                f'<path d="{FOLD_FILL}" fill="{NOIR_GOLD}"/>'
                f'<path d="{BODY}" fill="none" stroke="{NOIR_GOLD}" stroke-width="1" stroke-linejoin="round"/>'
                + glyph(GLYPH[name], NOIR_IVORY))
    if style == "bold":
        # brutalist: thick saturated type-colour outline + matching glyph — high contrast, chunky
        if is_folder:
            return f'<path d="{FOLDER}" fill="none" stroke="{c}" stroke-width="2.4" stroke-linejoin="round"/>'
        return (f'<path d="{BODY}" fill="none" stroke="{c}" stroke-width="2.4" stroke-linejoin="round"/>'
                f'<path d="{FOLD}" fill="none" stroke="{c}" stroke-width="2.4" stroke-linejoin="round"/>'
                + glyph(GLYPH[name], c))
    if style == "pastel":
        # soft pastel tile (a light tint of the type colour) + a deeper same-hue outline/glyph
        fill, ink = mix(c, "#ffffff", 0.80), mix(c, "#33333a", 0.18)
        if is_folder:
            return (f'<path d="{FOLDER}" fill="{fill}"/>'
                    f'<path d="{FOLDER}" fill="none" stroke="{ink}" stroke-width="1.2" stroke-linejoin="round"/>')
        return (f'<path d="{BODY}" fill="{fill}"/>'
                f'<path d="{BODY}" fill="none" stroke="{ink}" stroke-width="1.2" stroke-linejoin="round"/>'
                f'<path d="{FOLD}" fill="none" stroke="{ink}" stroke-width="1.2" stroke-linejoin="round"/>'
                + glyph(GLYPH[name], ink))
    if style == "terminal":
        # single phosphor-green blocky outline + glyph — CRT/terminal aesthetic (one colour, all types)
        if is_folder:
            return f'<path d="{FOLDER}" fill="none" stroke="{TERM_GREEN}" stroke-width="1.6" stroke-linejoin="miter"/>'
        return (f'<path d="{BODY}" fill="none" stroke="{TERM_GREEN}" stroke-width="1.6" stroke-linejoin="miter"/>'
                f'<path d="{FOLD}" fill="none" stroke="{TERM_GREEN}" stroke-width="1.6" stroke-linejoin="miter"/>'
                + glyph(GLYPH[name], TERM_GREEN))
    # duo
    if is_folder:
        return (f'<path d="{FOLDER}" fill="{c}" fill-opacity=".18"/>'
                f'<path d="{FOLDER}" fill="none" stroke="{c}" stroke-width="1.4" stroke-linejoin="round"/>')
    return (f'<path d="{BODY}" fill="{c}" fill-opacity=".15"/>'
            f'<path d="{BODY}" fill="none" stroke="{c}" stroke-width="1.4" stroke-linejoin="round"/>'
            f'<path d="{FOLD}" fill="none" stroke="{c}" stroke-width="1.4" stroke-linejoin="round"/>'
            + glyph(GLYPH[name], c))

def svg(b):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VB}">{b}</svg>'

STYLES = ["flat", "line", "duo", "refined", "noir", "bold", "pastel", "terminal"]
themes = {s: {n: svg(body_of(s, n)) for n in NAMES} for s in STYLES}
for s in STYLES:
    d = OUT / s
    d.mkdir(parents=True, exist_ok=True)
    for n in NAMES:
        (d / f"{n}.svg").write_text(themes[s][n])
print("wrote", len(STYLES) * len(NAMES), "svgs")

# ---- trusted inline constants used by the plugin bundle ----
ts = [
    "// Generated by scripts/gen-icon-themes.py. Do not edit by hand.",
    'import type { IconTheme } from "./settings";',
    'import { fileIconName } from "./fileIconName";',
    "",
    'type BundledIconTheme = Exclude<IconTheme, "default">;',
    "",
    "export const BUNDLED_ICON_THEMES: Readonly<Record<BundledIconTheme, Readonly<Record<string, string>>>> =",
    json.dumps(themes, indent=2, separators=(",", ": ")) + ";",
    "",
    "export function bundledIconForFile(theme: IconTheme, mimeType: string, name: string): string | null {",
    '  if (theme === "default") {',
    "    return null;",
    "  }",
    "  const icons = BUNDLED_ICON_THEMES[theme];",
    "  const iconName = fileIconName(mimeType, name);",
    "  return (iconName ? icons[iconName] : null) ?? icons.genericfile ?? null;",
    "}",
    "",
]
TS_OUT.write_text("\n".join(ts))
print("wrote", TS_OUT.relative_to(ROOT))

# ---- combined catalog.svg (one file, light panel bg so it reads in dark theme too) ----
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
col_w = 168
colx = {s: 18 + i * col_w for i, s in enumerate(STYLES)}
HEADW = {"flat": "Flat (color)", "line": "Line (gray)", "duo": "Duotone",
         "refined": "Refined (ink+gold)", "noir": "Noir (ink+gold)",
         "bold": "Bold", "pastel": "Pastel", "terminal": "Terminal"}
row_h, top = 26, 70
W, H = 18 + col_w * len(STYLES) + 2, top + row_h * len(NAMES) + 16
parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" font-family="{FONT}">']
parts.append(f'<rect x="1" y="1" width="{W-2}" height="{H-2}" rx="16" fill="#f7f8fa" stroke="#e3e5e8"/>')
parts.append(f'<text x="18" y="34" font-size="15" font-weight="700" fill="#23262b">Drive Attachments — 커스텀 아이콘 세트</text>')
for s in STYLES:
    parts.append(f'<text x="{colx[s]+30}" y="56" font-size="11" font-weight="700" letter-spacing=".5" fill="#5b6470">{HEADW[s].upper()}</text>')
for i, n in enumerate(NAMES):
    y = top + i * row_h
    for s in STYLES:
        x = colx[s]
        parts.append(f'<g transform="translate({x},{y}) scale(0.92)">{body_of(s, n)}</g>')
        parts.append(f'<text x="{x+30}" y="{y+15}" font-size="10.5" fill="#3a3f47">{n}</text>')
parts.append("</svg>")
(OUT / "catalog.svg").write_text("".join(parts))
print("wrote catalog.svg", W, "x", H)
