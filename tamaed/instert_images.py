import json, os, numpy as np
from PIL import Image

BIN_PATH = "fw_tama.bin"
META_PATH = "tama_image_map.json"
IN_DIR = "extracted"
OUT_PATH = "fw_tama_patched.bin"

with open(BIN_PATH, "rb") as f:
    firmware = bytearray(f.read())

with open(META_PATH, "r") as f:
    entities = json.load(f)

for ent in entities:
    offset = int(ent["offset"])
    width, height = ent["width"], ent["height"]
    png_path = f"{IN_DIR}/img_{offset:06X}.png"
    if not os.path.exists(png_path):
        continue

    img = Image.open(png_path).convert("RGB").resize((width, height))
    arr = np.array(img, dtype=np.uint8)
    r = arr[:,:,0].astype(np.uint16)
    g = arr[:,:,1].astype(np.uint16)
    b = arr[:,:,2].astype(np.uint16)
    data = ((r * 31 // 255) << 11) | ((g * 63 // 255) << 5) | (b * 31 // 255)
    raw = data.astype('<u2').tobytes()

    firmware[offset : offset + len(raw)] = raw
    print(f"Replaced {offset:06X} ({width}x{height})")

with open(OUT_PATH, "wb") as f:
    f.write(firmware)
print("All images inserted.")