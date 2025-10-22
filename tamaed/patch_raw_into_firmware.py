#!/usr/bin/env python3
"""
python tamaed/patch_raw_into_firmware.py \
  --firmware dumps/fw_name.bin \
  --offset 0x45C040 \
  --width 128 --height 128 --colors 16 \
  --raw images/builds/img_45c040.raw \
  --out patched_fw.bin
"""
import argparse, math
from pathlib import Path

def main():
    p = argparse.ArgumentParser(description="Patch RAW pixel data into Tamagotchi firmware.")
    p.add_argument("--firmware", required=True, help="Original firmware .bin")
    p.add_argument("--offset", required=True, help="Image offset (hex like 0x45C040 or decimal)")
    p.add_argument("--colors", type=int, required=True, help="Palette size (same as before, e.g. 16 or 256)")
    p.add_argument("--width",  type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.add_argument("--raw",    required=True, help="Converted RAW pixel data file")
    p.add_argument("--out",    default="patched.bin", help="Output firmware filename")
    args = p.parse_args()

    # Parse hex or decimal offset
    off = int(args.offset, 16) if args.offset.lower().startswith("0x") else int(args.offset)

    fw = bytearray(Path(args.firmware).read_bytes())
    raw = Path(args.raw).read_bytes()

    # Calculate where pixel data actually begins
    data_start = off + 6 + args.colors * 2
    data_len   = math.ceil(args.width * args.height / 2) if args.colors <= 16 else args.width * args.height

    if len(raw) != data_len:
        print(f"⚠️ RAW length {len(raw)} ≠ expected {data_len}; double-check palette size / dimensions.")
    data_end = data_start + data_len

    fw[data_start:data_end] = raw
    Path(args.out).write_bytes(fw)
    print(f"Patched {len(raw)} bytes at offset 0x{data_start:X} → {args.out}")

if __name__ == "__main__":
    main()