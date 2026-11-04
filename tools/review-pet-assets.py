"""Inspect downloaded pet assets and create contact sheets; originals stay unchanged."""
import hashlib
import json
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "docs/audit"
ASSETS = AUDIT / "pet-assets-20261104"
manifest = json.loads((AUDIT / "cloud-storage-pets-20261104.json").read_text(encoding="utf-8-sig"))
rows = []
groups = defaultdict(list)
for entry in manifest["data"]:
    relative = Path(entry["key"].removeprefix("pets/"))
    file = ASSETS / relative
    row = {"key": entry["key"], "expected_bytes": int(entry["size"])}
    if not file.is_file():
        row["status"] = "not_downloaded"
    else:
        try:
            raw = file.read_bytes()
            with Image.open(file) as image:
                rgba = image.convert("RGBA")
                digest = hashlib.sha256(rgba.tobytes()).hexdigest()
                row.update(status="decoded", bytes=len(raw), size=list(image.size), mode=image.mode,
                           sha256=hashlib.sha256(raw).hexdigest(), pixel_sha256=digest,
                           alpha_range=list(rgba.getchannel("A").getextrema()),
                           alpha_bbox=rgba.getchannel("A").getbbox(),
                           manifest_size_matches=len(raw) == row["expected_bytes"])
                groups[(image.size, digest)].append(entry["key"])
        except Exception as error:
            row.update(status="decode_failed", error=str(error))
    rows.append(row)

duplicates = [paths for paths in groups.values() if len(paths) > 1]
report = {"scope": "Downloaded original files, no rarity/color filters; no business flow validation",
          "expected": len(rows), "decoded": sum(row["status"] == "decoded" for row in rows),
          "missing": [row["key"] for row in rows if row["status"] == "not_downloaded"],
          "duplicate_pixel_groups": duplicates, "files": rows}
(AUDIT / "pet-asset-review-20261104.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

font_path = Path("C:/Windows/Fonts/arial.ttf")
font = ImageFont.truetype(str(font_path), 16) if font_path.exists() else ImageFont.load_default()
small = ImageFont.truetype(str(font_path), 12) if font_path.exists() else ImageFont.load_default()
species = sorted({Path(row["key"]).parts[1] for row in rows})
lookup = {row["key"]: row for row in rows}
stages = ["baby", "youth", "adult", "perfect"]
duplicate_keys = {key for group in duplicates for key in group}
for page, start in enumerate(range(0, len(species), 5), 1):
    sheet = Image.new("RGB", (800, 1100), "#f5f5f5")
    draw = ImageDraw.Draw(sheet)
    draw.text((12, 10), "Cloud pet originals | no filters | " + str(page), fill="black", font=font)
    for r, name in enumerate(species[start:start + 5]):
        y = 44 + r * 208
        for c, stage in enumerate(stages):
            x = c * 200
            key = f"pets/{name}/{stage}_thumb.png"
            row = lookup[key]
            draw.text((x + 8, y), name + " / " + stage, fill="black", font=small)
            if row["status"] == "decoded":
                with Image.open(ASSETS / name / (stage + "_thumb.png")) as image:
                    tile = image.convert("RGBA")
                    tile.thumbnail((176, 156))
                    sheet.paste(tile, (x + (200 - tile.width) // 2, y + 26 + (156 - tile.height) // 2), tile)
                label = str(row["size"][0]) + "x" + str(row["size"][1])
                if key in duplicate_keys:
                    label += " | DUPLICATE"
                draw.text((x + 8, y + 184), label, fill="#b43224" if key in duplicate_keys else "#555555", font=small)
            else:
                draw.text((x + 8, y + 80), row["status"], fill="#b43224", font=small)
    sheet.save(AUDIT / f"pet-originals-contact-{page}-20261104.png")

print(json.dumps({key: report[key] for key in ["expected", "decoded", "missing", "duplicate_pixel_groups"]}, indent=2))
