import json, os, numpy as np
from PIL import Image

BIN_PATH = "fw_tama.bin"
META_PATH = "tama_image_map.json"
OUT_DIR = "extracted"

os.makedirs(OUT_DIR, exist_ok=True)

with open(BIN_PATH, "rb") as f:
    firmware = f.read()

with open(META_PATH, "r") as f:
    entities = json.load(f)

for ent in entities:
    offset = int(ent["offset"])
    size = int(ent["size"])
    width, height = ent["width"], ent["height"]
    raw = firmware[offset : offset + size]

    # Skip tiny blocks that aren't images
    if width * height < 64:
        continue

    data = np.frombuffer(raw, dtype=np.uint16)
    if data.size != width * height:
        continue
    r = ((data >> 11) & 0x1F) * 255 // 31
    g = ((data >> 5) & 0x3F) * 255 // 63
    b = (data & 0x1F) * 255 // 31
    img = np.dstack((r, g, b)).astype(np.uint8)

    Image.fromarray(img, "RGB").save(f"{OUT_DIR}/img_{offset:06X}.png")
    print(f"Exported {offset:06X} ({width}x{height})")