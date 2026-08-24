from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "assets" / "game" / "nft-directional-v2"
LEGACY_ROOT = ROOT / "assets" / "game" / "nft-evolution"
ATLAS_ROOT = SOURCE_ROOT / "atlases"
FRAME_ROOT = SOURCE_ROOT / "frames"
MANIFEST_PATH = SOURCE_ROOT / "sprite-library.json"

ATLAS_COLUMNS = 6
ATLAS_ROWS = 4
EXPECTED_SIZE = (1536, 1024)

TIERS = {
    "rookie": "rookie-atlas-v1.png",
    "apprentice": "apprentice-atlas-v1.png",
    "crystal-hunter": "crystal-hunter-atlas-v1.png",
    "veteran": "veteran-atlas-v1.png",
    "vault-raider": "vault-raider-atlas-v1.png",
    "elite": "elite-atlas-v1.png",
    "mine-legend": "mine-legend-atlas-v1.png",
}

DIRECTIONS = ("east", "north", "south")
FRAME_NAMES = (
    ("idle", "idle-0"),
    ("walk", "walk-1"),
    ("walk", "walk-2"),
    ("walk", "walk-3"),
    ("walk", "walk-4"),
    ("knockout", "knockout-0"),
    *(("pickaxe", f"pickaxe-{index}") for index in range(6)),
    *(("blaster", f"blaster-{index}") for index in range(6)),
    *(("dynamite", f"dynamite-{index}") for index in range(6)),
)


def source_for(tier: str, direction: str) -> Path:
    if direction == "east":
        return LEGACY_ROOT / TIERS[tier]
    return SOURCE_ROOT / tier / f"{direction}.png"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def alpha_coverage(image: Image.Image) -> float:
    alpha = image.getchannel("A")
    histogram = alpha.histogram()
    visible = sum(histogram[1:])
    return visible / (image.width * image.height)


def build() -> dict:
    if len(FRAME_NAMES) != ATLAS_COLUMNS * ATLAS_ROWS:
        raise RuntimeError("Frame naming table must describe all 24 atlas cells.")

    manifest = {
        "version": 2,
        "atlas": {"columns": ATLAS_COLUMNS, "rows": ATLAS_ROWS, "width": 1536, "height": 1024},
        "runtimeDirections": ["east", "west", "north", "south"],
        "storedDirections": list(DIRECTIONS),
        "westMirrors": "east",
        "tierCount": len(TIERS),
        "framesPerStoredDirection": len(FRAME_NAMES),
        "frameCount": len(TIERS) * len(DIRECTIONS) * len(FRAME_NAMES),
        "tiers": {},
    }

    frame_width = EXPECTED_SIZE[0] // ATLAS_COLUMNS
    frame_height = EXPECTED_SIZE[1] // ATLAS_ROWS

    for tier in TIERS:
        tier_manifest = {"directions": {}}
        for direction in DIRECTIONS:
            source = source_for(tier, direction)
            if not source.is_file():
                raise FileNotFoundError(source)

            with Image.open(source) as opened:
                atlas = opened.convert("RGBA")
            if atlas.size != EXPECTED_SIZE:
                raise RuntimeError(f"{source} has {atlas.size}, expected {EXPECTED_SIZE}")

            atlas_output = ATLAS_ROOT / tier / f"{direction}.webp"
            atlas_output.parent.mkdir(parents=True, exist_ok=True)
            source_changed = (
                not atlas_output.exists()
                or source.stat().st_mtime_ns > atlas_output.stat().st_mtime_ns
            )
            if source_changed:
                atlas.save(atlas_output, "WEBP", lossless=True, method=6, exact=True)

            frames = []
            for index, (action, name) in enumerate(FRAME_NAMES):
                row, column = divmod(index, ATLAS_COLUMNS)
                frame = atlas.crop((
                    column * frame_width,
                    row * frame_height,
                    (column + 1) * frame_width,
                    (row + 1) * frame_height,
                ))
                coverage = alpha_coverage(frame)
                if coverage < 0.01:
                    raise RuntimeError(f"{source} cell {row},{column} is effectively empty")

                frame_output = FRAME_ROOT / tier / direction / action / f"{name}.webp"
                frame_output.parent.mkdir(parents=True, exist_ok=True)
                if source_changed or not frame_output.exists():
                    frame.save(frame_output, "WEBP", lossless=True, method=6, exact=True)
                relative = frame_output.relative_to(ROOT).as_posix()
                frames.append({
                    "index": index,
                    "row": row,
                    "column": column,
                    "action": action,
                    "name": name,
                    "path": f"/{relative}",
                    "alphaCoverage": round(coverage, 6),
                })

            atlas_relative = atlas_output.relative_to(ROOT).as_posix()
            tier_manifest["directions"][direction] = {
                "atlas": f"/{atlas_relative}",
                "atlasSha256": sha256(atlas_output),
                "frames": frames,
            }
        manifest["tiers"][tier] = tier_manifest

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    result = build()
    print(f"Built {result['frameCount']} directional Miner frame files.")
    print(f"Built {len(TIERS) * len(DIRECTIONS)} optimized runtime atlases.")
    print(f"Manifest: {MANIFEST_PATH}")
