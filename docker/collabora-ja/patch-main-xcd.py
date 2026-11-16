#!/usr/bin/env python3
"""Prepend Hina Mincho to LibreOffice's localized default text font lists.

The base Collabora image ships main.xcd with VCL/DefaultFonts. We patch the
English and Japanese text/serif lists so new documents and unresolved text
fallbacks prefer Hina Mincho while keeping the existing fallback chains.
"""
from __future__ import annotations

import re
import sys

TARGET_PROPS = {"LATIN_TEXT", "CJK_TEXT", "SERIF"}



def patch_default_fonts(xml: str) -> tuple[str, list[str]]:
    changed: list[str] = []
    # Locate the VCL component data that holds the actual values (not the schema).
    for component in re.finditer(
        r'<oor:component-data\b[^>]*oor:name="VCL"[^>]*>',
        xml,
    ):
        start = component.start()
        end = xml.find("</oor:component-data>", start)
        if end < 0:
            continue
        segment = xml[start:end]
        defaults_start = segment.find('<node oor:name="DefaultFonts">')
        if defaults_start < 0:
            continue

        updated_segment = segment
        # DefaultFonts children are flat language nodes (en, ja, zh-CN, ...).
        lang_pattern = re.compile(
            r'(<node oor:name="([^"]+)" oor:op="replace">)(.*?)(</node>)',
            re.S,
        )
        pieces: list[str] = []
        cursor = 0
        for lang_match in lang_pattern.finditer(segment[defaults_start:]):
            lang = lang_match.group(2)
            offset = defaults_start + lang_match.start()
            pieces.append(segment[cursor:offset])
            body = lang_match.group(3)
            new_body = body
            for prop in TARGET_PROPS:
                prop_re = re.compile(
                    rf'(<prop oor:name="{prop}"[^>]*><value>)([^<]*)(</value>)'
                )
                match = prop_re.search(new_body)
                if not match:
                    continue
                current = match.group(2).strip()
                if current.split(";")[0].strip() == "Hina Mincho":
                    continue
                replacement = "Hina Mincho" + (f";{current}" if current else "")
                new_body = (
                    new_body[: match.start(2)]
                    + replacement
                    + new_body[match.end(2) :]
                )
                changed.append(f"{lang}:{prop}")
            pieces.append(lang_match.group(1) + new_body + lang_match.group(4))
            cursor = offset + len(lang_match.group(0))
        pieces.append(segment[cursor:])
        updated_segment = "".join(pieces)
        if updated_segment != segment:
            xml = xml[:start] + updated_segment + xml[end:]
            break
    return xml, changed


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-main-xcd.py /path/to/main.xcd")
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as handle:
        original = handle.read()
    patched, changed = patch_default_fonts(original)
    if not changed:
        raise SystemExit("no VCL default font entries were patched")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(patched)
    print("patched:", ", ".join(changed))


if __name__ == "__main__":
    main()
