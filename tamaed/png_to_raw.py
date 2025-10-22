#!/usr/bin/env python3
"""
python png_to_tama_raw.py \
  --firmware fw_name.bin \
  --offset 0x45C040 \
  --width 128 --height 128 --colors 16 \
  --png edited/img_45c040.png \
  --out builds/img_45c040.raw
"""

import argparse, sys, struct, math
from pathlib import Path
from PIL import Image

def read_palette_from_firmware(fw_bytes: bytes, offset: int, colors_count: int):
    """
    Palette bytes are stored right after a 6-byte header.
    Each entry is a 16-bit big-endian word with bit layout: 5 Blue, 6 Green, 5 Red (BGR565).
    """
    header_size = 6
    pal_off = offset + header_size
    pal_len = colors_count * 2
    pal_bytes = fw_bytes[pal_off : pal_off + pal_len]
    if len(pal_bytes) != pal_len:
        raise ValueError("Firmware too short to contain the palette at given offset/size.")

    palette_rgb = []
    for i in range(0, len(pal_bytes), 2):
        hi = pal_bytes[i]
        lo = pal_bytes[i + 1]
        color16 = (hi << 8) | lo  # big-endian

        # Decode BGR565 (MSB..LSB: BBBBB GGGGGG RRRRR)
        blue  = (color16 >> 11) & 0x1F
        green = (color16 >> 5)  & 0x3F
        red   =  color16        & 0x1F

        # Scale to 0..255
        r8 = (red   * 255) // 31
        g8 = (green * 255) // 63
        b8 = (blue  * 255) // 31
        palette_rgb.append((r8, g8, b8))

    return palette_rgb  # list of (R,G,B), length = colors_count

def make_palette_image(palette_rgb):
    """Build a tiny P-mode image with the exact palette for use in PIL.quantize()."""
    pal_img = Image.new("P", (16, 16))
    # PIL wants a palette list of length 768 (256*3). Pad with zeros beyond our palette.
    flat = []
    for (r, g, b) in palette_rgb:
        flat.extend([r, g, b])
    # pad to 256*3
    flat.extend([0, 0, 0] * (256 - len(palette_rgb)))
    pal_img.putpalette(flat, rawmode="RGB")
    return pal_img

def quantize_to_palette(img: Image.Image, pal_img: Image.Image):
    """
    Quantize the edited image to the exact firmware palette.
    Dither off to keep indexes stable.
    """
    # Ensure no alpha during quantization
    if img.mode in ("RGBA", "LA"):
        img = img.convert("RGB")
    elif img.mode != "RGB":
        img = img.convert("RGB")

    # Use the fixed palette
    quant = img.quantize(palette=pal_img, dither=Image.Dither.NONE)
    return quant  # mode "P", palette equals pal_img

def pack_indices_to_raw(indices, width, height, colors_count):
    """
    Firmware pixel data is indices into the palette.
    - If colors_count <= 16: 4bpp, pack two pixels per byte.
      IMPORTANT: low nibble = first pixel, high nibble = second pixel
      (matches the viewer's decode: low nibble first)
    - Else: 8bpp, one pixel per byte.
    """
    if colors_count <= 16:
        # 4bpp
        out = bytearray()
        # Walk in raster order; pack two at a time
        it = iter(indices)
        try:
            while True:
                a = next(it)
                b = next(it)
                byte = (b << 4) | (a & 0x0F)  # low nibble first: a in low, b in high
                out.append(byte)
        except StopIteration:
            # If odd number of pixels, pad the last high nibble with 0
            total = width * height
            if total % 2 == 1:
                # last 'a' has been processed but no 'b'
                # reconstruct last 'a':
                last_a = indices[-1] & 0x0F
                out.append(last_a)  # high nibble zeroed automatically
        return bytes(out)
    else:
        # 8bpp
        return bytes(indices)

def main():
    p = argparse.ArgumentParser(description="Convert edited PNG to Tama RAW pixel data using firmware palette.")
    p.add_argument("--firmware", required=True, help="Path to firmware .bin")
    p.add_argument("--offset", required=True, help="Image block offset (hex like 0x45C040 or decimal)")
    p.add_argument("--width", type=int, required=True, help="Image width (must match firmware)")
    p.add_argument("--height", type=int, required=True, help="Image height (must match firmware)")
    p.add_argument("--colors", type=int, required=True, help="Palette size from firmware (e.g., 16 or 256)")
    p.add_argument("--png", required=True, help="Edited PNG to convert")
    p.add_argument("--out", required=True, help="Output RAW filename (pixel data only)")
    args = p.parse_args()

    # Parse offset
    off_str = args.offset.lower().strip()
    if off_str.startswith("0x"):
        offset = int(off_str, 16)
    else:
        offset = int(off_str, 10)

    fw = Path(args.firmware).read_bytes()

    # 1) Read original palette from firmware at offset
    palette_rgb = read_palette_from_firmware(fw, offset, args.colors)

    # 2) Load edited PNG and sanity-check size
    img = Image.open(args.png)
    if img.width != args.width or img.height != args.height:
        sys.exit(f"ERROR: PNG size {img.width}x{img.height} does not match expected {args.width}x{args.height}")

    # 3) Quantize edited PNG to the exact firmware palette
    pal_img = make_palette_image(palette_rgb)
    pal_quant = quantize_to_palette(img, pal_img)

    # 4) Extract indices (row-major)
    idx = list(pal_quant.getdata())
    # Sanity-check indices are within palette range
    max_idx = max(idx) if idx else 0
    if max_idx >= args.colors:
        sys.exit(f"ERROR: Quantized image used index {max_idx}, but palette has only {args.colors} colors. "
                 "Check that you stayed within color limits.")

    # 5) Pack to RAW bytes
    raw = pack_indices_to_raw(idx, args.width, args.height, args.colors)

    # 6) Write RAW
    Path(args.out).write_bytes(raw)
    print(f"Wrote RAW pixel data to {args.out}")
    if args.colors <= 16:
        exp = math.ceil((args.width * args.height) / 2)
    else:
        exp = args.width * args.height
    print(f"   bytes: {len(raw)} (expected {exp})")
    if len(raw) != exp:
        print("⚠️ WARNING: output length does not match expected pixel byte count.")

if __name__ == "__main__":
    main()