#!/usr/bin/env python3
import json, csv
from pathlib import Path

def json_to_csv(json_path, csv_path):
    data = json.loads(Path(json_path).read_text())
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["offset", "width", "height", "colors", "png", "name"])
        for item in data:
            if item["type"] != "image":
                continue
            writer.writerow([
                hex(item["offset"]),
                item["width"],
                item["height"],
                item["colorsCount"],
                f"imgs/{hex(item['offset'])[2:]}.png",
                ""
            ])
    print(f"Wrote {csv_path}")

if __name__ == "__main__":
    json_to_csv("tama_image_map.json", "tasks.csv")