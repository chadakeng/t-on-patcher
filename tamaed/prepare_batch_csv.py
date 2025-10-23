#!/usr/bin/env python3
"""
Prepare/augment a CSV for batch patching.

Input CSV requirements:
- Offsets are in the first column (header can be anything, e.g. "offset"),
  values may be hex (e.g. 0x45C040) or decimal.

What this script does:
- Reads firmware at each offset and extracts width, height, colors (expects Tamagotchi image block with 6-byte header: [W,H,colors, 0x00,0x01,0xFF]).
- Computes header_size, data_start, data_len (expected RAW length), block_size.
- Checks for an edited RAW in images/edited/ named either:
    <offset_dec>.raw
    <offset_hex>.raw   (hex lowercase, no 0x)   e.g. 45c040.raw
    img_<offset_hex>.raw (optional convenience) e.g. img_45c040.raw
- Writes an updated CSV with all fields appended.
- Prints and writes a list of offsets that are missing edited RAWs.

Usage:
  python prepare_batch_csv.py \
      --firmware sanrio-test.bin \
      --csv-in offsets.csv \
      --csv-out batch_patch.csv \
      --edited-dir images/edited
"""

import csv, math, sys
from pathlib import Path
import argparse

MAGIC_B5 = 0x00
MAGIC_B6 = 0x01
MAGIC_B7 = 0xFF
HEADER_FIXED = 6  # W,H,colors, magic(3)

def parse_offset(val: str) -> int:
    s = str(val).strip().lower()
    if s.startswith("0x"):
        return int(s, 16)
    return int(s, 10)

def read_image_header(fw: bytes, off: int):
    """
    Returns (width, height, colors, ok_magic) or raises if out of range.
    """
    if off < 0 or off + 6 > len(fw):
        raise ValueError(f"Offset out of range: 0x{off:X}")
    w = fw[off + 0]
    h = fw[off + 1]
    colors = fw[off + 2]
    b5 = fw[off + 3]
    b6 = fw[off + 4]
    b7 = fw[off + 5]
    ok_magic = (b5 == MAGIC_B5 and b6 == MAGIC_B6 and b7 == MAGIC_B7)
    return (w, h, colors, ok_magic)

def calc_sizes(w: int, h: int, colors: int):
    header_size = HEADER_FIXED + colors * 2
    pixels = w * h
    pixels_per_byte = 1 if colors > 16 else 2  # 8bpp vs 4bpp
    data_len = pixels if pixels_per_byte == 1 else math.ceil(pixels / 2)
    block_size = header_size + data_len
    return header_size, data_len, block_size

def possible_raw_names(off_dec: int, off_hex: str):
    # off_hex is lowercase without 0x, e.g. "45c040"
    return [
        f"{off_dec}.raw",
        f"{off_hex}.raw",
        f"img_{off_hex}.raw",  # convenience pattern some folks use
    ]

def find_edited_raw(edited_dir: Path, off: int):
    off_hex = f"{off:X}".lower()
    for name in possible_raw_names(off, off_hex):
        p = edited_dir / name
        if p.exists():
            return True, str(p)
    return False, ""

def main():
    ap = argparse.ArgumentParser(description="Augment offsets CSV with firmware image data and edited RAW presence.")
    ap.add_argument("--firmware", required=True, help="Path to firmware .bin")
    ap.add_argument("--csv-in",   required=True, help="Input CSV file (first column = offset)")
    ap.add_argument("--csv-out",  required=True, help="Output CSV file")
    ap.add_argument("--edited-dir", default="images/edited", help="Directory containing edited RAW files")
    args = ap.parse_args()

    fw = Path(args.firmware).read_bytes()
    edited_dir = Path(args.edited_dir)
    if not edited_dir.exists():
        print(f"⚠️ Edited directory not found: {edited_dir} (will still write CSV, but all will be missing)", file=sys.stderr)

    # Read input CSV (keep all original columns)
    rows_in = []
    with open(args.csv_in, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        rows_in = list(reader)

    if not rows_in:
        sys.exit("Input CSV is empty.")

    # Determine if first row is header (try to parse first cell)
    has_header = False
    try:
        _ = parse_offset(rows_in[0][0])
    except Exception:
        has_header = True

    # Output header
    out_header = []
    if has_header:
        out_header = rows_in[0][:]
        data_rows = rows_in[1:]
    else:
        # fabricate a name for the first column if none given
        out_header = ["offset"] + ([f"col{i}" for i in range(2, len(rows_in[0]) + 1)])
        data_rows = rows_in

    # Append our fields
    extra_cols = [
        "offset_hex",
        "offset_dec",
        "width",
        "height",
        "colors",
        "magic_ok",
        "header_size",
        "data_start_hex",
        "data_len",
        "block_size",
        "edited_raw_exists",
        "edited_raw_path",
    ]
    out_header = out_header + extra_cols

    out_rows = []
    missing = []

    for r in data_rows:
        if not r:
            continue
        try:
            off = parse_offset(r[0])
        except Exception as e:
            # keep row, but mark as invalid
            out_rows.append(r + ["", "", "", "", "", "false", "", "", "", "false", ""])
            continue

        # Read header from firmware
        try:
            w, h, colors, ok_magic = read_image_header(fw, off)
        except Exception as e:
            # out of range; still emit a row with minimal info
            out_rows.append(r + [
                f"0x{off:X}".lower(), off,
                "", "", "", "false",
                "", "", "", "false", ""
            ])
            continue

        header_size, data_len, block_size = calc_sizes(w, h, colors)
        data_start = off + header_size
        exists, path = find_edited_raw(edited_dir, off)

        if not exists:
            missing.append(f"0x{off:X}".lower())

        out_rows.append(r + [
            f"0x{off:X}".lower(),
            str(off),
            str(w),
            str(h),
            str(colors),
            "true" if ok_magic else "false",
            str(header_size),
            f"0x{data_start:X}".lower(),
            str(data_len),
            str(block_size),
            "true" if exists else "false",
            path
        ])

    # Write output CSV
    with open(args.csv_out, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(out_header)
        writer.writerows(out_rows)

    # Report missing edited raws
    if missing:
        miss_file = Path(args.csv_out).with_suffix(".missing.txt")
        miss_file.write_text("\n".join(missing), encoding="utf-8")
        print(f"✅ Wrote {args.csv_out}")
        print(f"⚠️ {len(missing)} edited RAW(s) missing. List saved to {miss_file}")
    else:
        print(f"✅ Wrote {args.csv_out}")
        print("✅ All edited RAWs present.")

if __name__ == "__main__":
    main()