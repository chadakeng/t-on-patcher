#!/usr/bin/env python3

"""
python tamaed/batch_patch_from_csv.py \
  --firmware dumps/file_name.bin \
  --csv tasks.csv \
  --out patched_fw.bin
  """

import argparse, csv, math
from pathlib import Path
from PIL import Image

HEADER_SIZE = 6

def parse_off(s: str) -> int:
    s = s.strip().lower()
    return int(s, 16) if s.startswith("0x") else int(s)

def read_palette(fw: bytes, offset: int, colors: int):
    p0 = offset + HEADER_SIZE
    p1 = p0 + colors * 2
    pal = fw[p0:p1]
    if len(pal) != colors * 2:
        raise ValueError(f"Palette out of range at 0x{offset:X}")
    out = []
    for i in range(0, len(pal), 2):
        hi, lo = pal[i], pal[i+1]
        v = (hi << 8) | lo  # big-endian BGR565 (BBBBB GGGGGG RRRRR)
        b = (v >> 11) & 0x1F
        g = (v >> 5)  & 0x3F
        r =  v        & 0x1F
        out.append(((r*255)//31, (g*255)//63, (b*255)//31))
    return out

def make_pal_image(palette_rgb):
    pal_img = Image.new("P", (16, 16))
    flat = []
    for r,g,b in palette_rgb: flat += [r,g,b]
    flat += [0,0,0] * (256 - len(palette_rgb))
    pal_img.putpalette(flat, rawmode="RGB")
    return pal_img

def png_to_raw_using_fw_palette(png_path, fw, offset, w, h, colors):
    pal = read_palette(fw, offset, colors)
    pal_img = make_pal_image(pal)
    img = Image.open(png_path)
    if img.size != (w, h):
        raise ValueError(f"{png_path}: size {img.size} != expected {(w,h)}")
    if img.mode != "RGB":
        img = img.convert("RGB")
    q = img.quantize(palette=pal_img, dither=Image.Dither.NONE)
    idx = list(q.getdata())
    if max(idx) >= colors:
        raise ValueError(f"{png_path}: index {max(idx)} >= colors {colors} (used color not in palette)")
    # pack indices
    if colors <= 16:
        out = bytearray()
        it = iter(idx)
        total = w*h
        for i in range(0, total//2):
            a = next(it) & 0x0F  # first pixel -> low nibble
            b = next(it) & 0x0F  # second pixel -> high nibble
            out.append((b<<4) | a)
        if total % 2 == 1:  # odd pixel count (not expected for 128x128)
            a = next(it) & 0x0F
            out.append(a)
        return bytes(out)
    else:
        return bytes(idx)

def patch_one(fw_ba, offset, colors, w, h, raw_bytes):
    pixel_start = offset + HEADER_SIZE + colors*2
    expected = (math.ceil(w*h/2) if colors <= 16 else w*h)
    if len(raw_bytes) != expected:
        raise ValueError(f"RAW length {len(raw_bytes)} != expected {expected}")
    fw_ba[pixel_start : pixel_start + expected] = raw_bytes
    return pixel_start, expected

def main():
    ap = argparse.ArgumentParser(description="Batch patch edited PNGs into Tama firmware from a CSV.")
    ap.add_argument("--firmware", required=True, help="Input firmware .bin")
    ap.add_argument("--csv", required=True, help="CSV file (offset,width,height,colors,png[,name])")
    ap.add_argument("--out", default="patched_fw.bin", help="Output firmware filename")
    args = ap.parse_args()

    fw_path = Path(args.firmware)
    fw = bytearray(fw_path.read_bytes())

    rows = list(csv.DictReader(Path(args.csv).open(newline="")))
    if not rows:
        raise SystemExit("No rows found in CSV.")

    print(f"Patching {len(rows)} item(s) into {args.out} ...")
    patched = 0
    for i, row in enumerate(rows, 1):
        try:
            off   = parse_off(row["offset"])
            w     = int(row["width"])
            h     = int(row["height"])
            colors= int(row["colors"])
            png   = row["png"].strip()
            name  = row.get("name", "").strip() or png

            raw = png_to_raw_using_fw_palette(png, fw, off, w, h, colors)
            start, count = patch_one(fw, off, colors, w, h, raw)
            print(f"  [{i}/{len(rows)}] {name}: wrote {count} bytes at 0x{start:X}")
            patched += 1
        except Exception as e:
            print(f"  [{i}/{len(rows)}] ERROR: {e}")

    Path(args.out).write_bytes(fw)
    print(f"Done. Patched {patched}/{len(rows)} images → {args.out}")

if __name__ == "__main__":
    main()