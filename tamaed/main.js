"use strict";

(function () {
  // ============ tiny event emitter ============
  class EventEmitter {
    constructor() { this.events = new Map(); }
    on(event, listener) {
      const listeners = this.events.get(event) || [];
      this.events.set(event, [listener].concat(listeners));
    }
    emit(event, ...args) { (this.events.get(event) || []).forEach(fn => fn(...args)); }
  }

  // ============ helpers ============
  function fixDPI(canvas) {
    const dpi = window.devicePixelRatio || 1;
    const cs = getComputedStyle(canvas);
    const width = parseFloat(cs.getPropertyValue("width"));
    const height = parseFloat(cs.getPropertyValue("height"));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    canvas.setAttribute("width", Math.max(1, Math.round(width * dpi)));
    canvas.setAttribute("height", Math.max(1, Math.round(height * dpi)));
  }
  const $ = (sel) => document.querySelector(sel);

  function passFirstFileTo(fn) {
    return function (event) {
      const files = event.target.files;
      if (files && files.length > 0) return fn(files[0]);
    };
  }

  // ============ data types ============
  class TODataItem {
    constructor(offset, bytes, type = "unknown") {
      this.type = type;
      this.offset = offset;
      this.size = bytes.length;
      this.bytes = bytes;
    }
  }

  class TOImage extends TODataItem {
    static typeName = "image";
    static headerSize = 6; // [w,h,colors,0,1,255]

    constructor(offset, bytes) {
      super(offset, bytes, TOImage.typeName);
      this.width = bytes[0];
      this.height = bytes[1];
      this.colorsCount = bytes[2];
      this.byte_5 = bytes[3];
      this.byte_6 = bytes[4];
      this.byte_7 = bytes[5];

      const paletteSize = this.colorsCount * 2;
      this.paletteData = bytes.subarray(TOImage.headerSize, TOImage.headerSize + paletteSize);
      this.palette = null;

      this.imageData = bytes.subarray(TOImage.headerSize + paletteSize);
      this.image = null;
    }

    getPalette() {
      if (this.palette === null) this.palette = TOImage.decodePalette(this.paletteData);
      return this.palette;
    }

    getImage() {
      if (this.image === null) this.image = TOImage.decodeImage(this.imageData, this.getPalette());
      return this.image;
    }

    // palette words (big-endian): 5b blue, 6b green, 5b red
    static decodePalette(bytes) {
      const palette = [];
      for (let i = 0; i < bytes.length; i += 2) {
        const hi = bytes[i];
        const lo = bytes[i + 1];
        const color16 = (hi << 8) | lo;
        const blue  = Math.round((((color16 & 0xf800) >> 11) / 31) * 255);
        const green = Math.round((((color16 & 0x07e0) >> 5) / 63) * 255);
        const red   = Math.round(((color16 & 0x001f) / 31) * 255);
        palette.push([red, green, blue, 255]);
      }
      return palette;
    }

    static decodeImage(bytes, palette) {
      const halfBytePixel = palette.length <= 16; // 4bpp
      const pixelsCount = halfBytePixel ? bytes.length * 2 : bytes.length;
      const pixels = new Uint8ClampedArray(pixelsCount * 4);

      if (halfBytePixel) {
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];
          const idx = i * 2;
          pixels.set(palette[b & 0x0f], idx * 4);      // low nibble
          pixels.set(palette[b >> 4],    idx * 4 + 4); // high nibble
        }
      } else {
        for (let i = 0; i < bytes.length; i++) {
          pixels.set(palette[bytes[i]], i * 4);
        }
      }
      return pixels;
    }

static scanForImage(bytes, offset) {
  const width  = bytes[offset + 0];
  const height = bytes[offset + 1];
  const colors = bytes[offset + 2]; // palette entries (1..255)

  // header magic: [0,1,255]
  const okHeader =
    bytes.length - offset > 10 &&
    width  > 0 && width  <= 255 &&
    height > 0 && height <= 255 &&
    colors > 0 &&
    bytes[offset + 3] === 0 &&
    bytes[offset + 4] === 1 &&
    bytes[offset + 5] === 255;

  if (!okHeader) return null;

  // bytes after header: colors*2 palette words + pixel data
  const headerSize = 6 + colors * 2;
  const pixels = width * height;
  const pixelsPerByte = colors > 16 ? 1 : 2; // 8bpp vs 4bpp
  const imageBytes = Math.ceil(pixels / pixelsPerByte);
  const totalSize = headerSize + imageBytes;

  // make sure the slice fits
  if (offset + totalSize > bytes.length) return null;

  try { return new TOImage(offset, bytes.subarray(offset, offset + totalSize)); }
  catch { return null; }
}

    drawTo(canvas, scale = 1) {
      const width = this.width * scale;
      const height = this.height * scale;

      canvas.width = width;
      canvas.height = height;
      if (canvas.isConnected) fixDPI(canvas);
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(width, height);
      const src = this.getImage();

      const widthPixelBytes = width * 4;
      const rowOffsetBytes = scale * widthPixelBytes;
      const xOffsetPixelBytes = scale * 4;

      for (let y = 0; y < this.height; y++) {
        const srcRowOffset = y * this.width * 4;
        const rowOffset = y * rowOffsetBytes;

        for (let x = 0; x < this.width; x++) {
          const srcPixelOffset = srcRowOffset + x * 4;
          const pixelOffset = rowOffset + x * xOffsetPixelBytes;

          for (let xs = 0; xs < scale; xs++) {
            img.data.set(src.slice(srcPixelOffset, srcPixelOffset + 4), pixelOffset + xs * 4);
          }
        }

        // vertical scale copy
        const row = img.data.slice(rowOffset, rowOffset + widthPixelBytes);
        for (let ys = 1; ys < scale; ys++) {
          img.data.set(row, rowOffset + ys * widthPixelBytes);
        }
      }
      ctx.putImageData(img, 0, 0);
    }
  }

  // ============ app ============
  class Application extends EventEmitter {
    constructor(scan = () => null) {
      super();
      this.firmware = null;
      this.map = null;
      this.scan = scan;
    }
    static events = { firmwareReady: "firmwareReady", mapReady: "mapReady" };
    async changeFirmware(file) {
      this.firmware = new Uint8Array(await file.arrayBuffer());
      this.map = null;
      this.emit(Application.events.firmwareReady);
    }
    async buildMap() {
      if (this.firmware === null) return;
      const map = [];
      const bytes = this.firmware;
      const scan = this.scan;
      for (let idx = 0; idx < bytes.length; idx++) {
        const item = scan(bytes, idx);
        if (item !== null) {
          map.push(item);
          idx += item.size - 1;
        }
      }
      this.map = map;
      this.emit(Application.events.mapReady);
    }
  }

  // ============ map drawing ============
  const selectionMapColor = new Uint8ClampedArray([255, 55, 55, 255]);
  const defaultMapColor = new Uint8ClampedArray([100, 100, 100, 255]);
  const dataTypeColors = new Map([[TOImage.typeName, new Uint8ClampedArray([255, 255, 0, 255])]]);
  function colorByDataType(type) { return dataTypeColors.get(type) || defaultMapColor; }

  const chunkSize = 2048;
  const bytesPerPixel = 8;

  function drawMapTo(canvas, map, dataSize, selectionStart, selectionEnd) {
    if (chunkSize % bytesPerPixel !== 0) throw new Error("chunkSize must be a multiple of bytesPerPixel");

    const height = chunkSize / bytesPerPixel;
    const width = Math.ceil(dataSize / chunkSize);
    canvas.height = height;
    canvas.width = width;
    if (canvas.isConnected) fixDPI(canvas);

    const ctx = canvas.getContext("2d");
    if (map === null) return;

    const img = ctx.createImageData(width, height);
    const iter = map[Symbol.iterator]();
    const first = iter.next();
    let colorStartYX = first.done ? Infinity : Math.floor(first.value.offset / bytesPerPixel);
    let colorEndYX = first.done ? Infinity : Math.floor((first.value.offset + first.value.size) / bytesPerPixel);
    let color = first.done ? defaultMapColor : colorByDataType(first.value.type);

    const selectionStartYX = Math.floor(selectionStart / bytesPerPixel);
    const selectionEndYX = Math.floor(selectionEnd / bytesPerPixel);

    let current = first;
    for (let x = 0; x < width; x++) {
      const yxColumnOffset = x * height;
      for (let y = 0; y < height; y++) {
        const yxIndex = yxColumnOffset + y;
        const pixelOffset = (y * width + x) * 4;

        let drawColor = defaultMapColor;
        if (yxIndex >= colorStartYX) {
          drawColor = color;
          while (yxIndex === colorEndYX) {
            current = iter.next();
            colorStartYX = current.done ? Infinity : Math.floor(current.value.offset / bytesPerPixel);
            colorEndYX = current.done ? Infinity : Math.floor((current.value.offset + current.value.size) / bytesPerPixel);
            color = current.done ? defaultMapColor : colorByDataType(current.value.type);
          }
        }
        if (yxIndex >= selectionStartYX && yxIndex < selectionEndYX) drawColor = selectionMapColor;
        img.data.set(drawColor, pixelOffset);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ============ UI ============
  const hexViewRowSize = 16;

  function nearestDataOffsetAttributeValue(target) {
    while (target && target.getAttribute("data-id") === null && target.tagName !== "UL") {
      target = target.parentElement;
    }
    return parseInt(target?.getAttribute("data-id") || "-1", 10);
  }

  function init() {
    console.log("[tamaed] init()");
    const app = new Application(TOImage.scanForImage);
    window.toapp = app;

    // DOM
    const mapCanvas = $("#map-canvas");
    const entitiesList = $("#entities-list");
    const entityPreviewScaleInput = $("#entity-preview-scale-input");
    const entityPreviewCanvas = $("#entity-preview-canvas");

    const hexPageSizeInput = $("#hex-page-size-input");
    const hexOffsetInput = $("#hex-offset-input");
    const hexPageUpButton = $("#hex-page-up-button");
    const hexRowUpButton = $("#hex-row-up-button");
    const hexRowDownButton = $("#hex-row-down-button");
    const hexPageDownButton = $("#hex-page-down-button");

    const exportRawBtn = $("#export-raw");
    const exportPngBtn = $("#export-png");
    const exportJsonBtn = $("#export-map-json");
    const exportCsvBtn = $("#export-map-csv");

    const offsetsInput = $("#offsets-input");
    const extractListedBtn = $("#extract-listed");

    const hexControls = [
      hexPageSizeInput, hexOffsetInput, hexPageUpButton, hexRowUpButton,
      hexRowDownButton, hexPageDownButton
    ];

    function markSelected(li) {
      if (!li) return;
      document.querySelectorAll("#entities-list .entity.selected")
        .forEach(el => el.classList.remove("selected"));
      li.classList.add("selected");
    }

    function downloadBlob(name, blob) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function getEntityPreviewScale() {
      return parseInt(entityPreviewScaleInput?.value || "1", 10) || 1;
    }

    // state
    let previewItem = null;

    function setPreview(dataItem) {
      previewItem = dataItem;
      if (!dataItem) return;
      if (dataItem.type === TOImage.typeName) {
        dataItem.drawTo(entityPreviewCanvas, getEntityPreviewScale());
        exportRawBtn?.removeAttribute("disabled");
        exportPngBtn?.removeAttribute("disabled");
      }
    }

    entityPreviewScaleInput?.addEventListener("change", () => {
      if (previewItem !== null) setPreview(previewItem);
    });

    function getHexViewOffset() { return hexOffsetInput.valueAsNumber; }

    function getHexViewPageSize() {
      const pageSize = hexPageSizeInput.valueAsNumber || 256;
      return Math.ceil(pageSize / hexViewRowSize) * hexViewRowSize;
    }

    function navigateHexViewTo(rawOffset) {
      if (!app.firmware) return;
      const pageSize = getHexViewPageSize();
      const maxOffset = Math.max(0, app.firmware.length - pageSize);
      const offset = Math.min(maxOffset, Math.max(0, rawOffset));
      const bytes = Array.from(app.firmware.slice(offset, offset + pageSize));

      hexOffsetInput.value = offset;

      $("#hex-area-offsets").innerText = new Array(pageSize / hexViewRowSize)
        .fill("")
        .map((_, idx) => (offset + hexViewRowSize * idx).toString())
        .join("\n");

      $("#hex-area-hextets").innerText = new Array(pageSize / hexViewRowSize)
        .fill("")
        .map((_, idx) =>
          bytes
            .slice(idx * hexViewRowSize, (idx + 1) * hexViewRowSize)
            .map((byte) => (byte < 16 ? "0" + byte.toString(16) : byte.toString(16)))
            .join(" ")
        )
        .join("\n");

      $("#hex-area-chars").innerText = new Array(pageSize / hexViewRowSize)
        .fill("")
        .map((_, idx) =>
          bytes
            .slice(idx * hexViewRowSize, (idx + 1) * hexViewRowSize)
            .map((byte) => (byte > 31 && byte < 127 ? String.fromCharCode(byte) : "."))
            .join("")
        )
        .join("\n");

      drawMapTo(mapCanvas, app.map, app.firmware.byteLength, offset, offset + pageSize);

      // keep map visible for very large firmwares
      const mapCanvasEl = document.getElementById("map-canvas");
      if (mapCanvasEl && app.map) {
        const scale = Math.max(1, app.firmware.byteLength / (1024 * 512));
        mapCanvasEl.style.width = `${Math.min(scale * 100, 10000)}px`;
      }
    }

    // firmware input
    $("#firmware-file-input")?.addEventListener(
      "change",
      passFirstFileTo((file) => {
        console.log("[tamaed] firmware selected:", file?.name, file?.size, "bytes");
        app.changeFirmware(file);
      })
    );

    // hex nav
    hexPageUpButton?.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() - getHexViewPageSize()));
    hexRowUpButton?.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() - 16));
    hexRowDownButton?.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() + 16));
    hexPageDownButton?.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() + getHexViewPageSize()));
    hexOffsetInput?.addEventListener("change", () => navigateHexViewTo(getHexViewOffset()));
    hexPageSizeInput?.addEventListener("change", () => navigateHexViewTo(getHexViewOffset()));

    // entities list click
    entitiesList?.addEventListener("click", (event) => {
      const idx = nearestDataOffsetAttributeValue(event.target);
      if (!Number.isFinite(idx) || idx < 0 || !app.map) return;
      const dataItem = app.map[idx];

      // find the li we clicked (walk up to .entity)
      let li = event.target;
      while (li && !li.classList?.contains("entity")) li = li.parentElement;
      markSelected(li);

      navigateHexViewTo(dataItem.offset);
      setPreview(dataItem);
    });

    // export selected RAW/PNG
    exportRawBtn?.addEventListener("click", () => {
      if (!previewItem) return;
      downloadBlob(
        `image_${previewItem.offset.toString(16)}_${previewItem.size}.raw`,
        new Blob([previewItem.bytes], { type: "application/octet-stream" })
      );
    });

    exportPngBtn?.addEventListener("click", () => {
      if (!previewItem) return;
      entityPreviewCanvas.toBlob((blob) => {
        if (blob) downloadBlob(`image_${previewItem.offset.toString(16)}.png`, blob);
      }, "image/png");
    });

    // app events
    app.on(Application.events.firmwareReady, () => {
      entitiesList.textContent = "";
      hexControls.forEach((c) => c?.setAttribute("disabled", "true"));
      app.buildMap();
    });

    app.on(Application.events.mapReady, () => {
      const fragment = document.createDocumentFragment();
      for (let idx = 0; idx < app.map.length; idx++) {
        const dataItem = app.map[idx];
        const listItem = createElement("li", "entity");
        listItem.setAttribute("data-id", String(idx));

        listItem.appendChild(createElement("span", "entity-type", dataItem.type));
        listItem.appendChild(createElement("span", "entity-offset", dataItem.offset.toString()));
        listItem.appendChild(createElement("span", "entity-size", dataItem.size.toString()));

        if (dataItem.type === TOImage.typeName) {
          const dims = createElement("span", "entity-dimensions");
          dims.appendChild(createElement("span", "entity-dimensions-width", dataItem.width.toString()));
          dims.appendChild(createElement("span", "entity-dimensions-height", dataItem.height.toString()));
          listItem.appendChild(dims);
          listItem.appendChild(createElement("span", "entity-colors", dataItem.colorsCount.toString()));
        }
        fragment.appendChild(listItem);
      }
      entitiesList.appendChild(fragment);

      // enable everything that depends on the map
      hexControls.forEach((c) => c?.removeAttribute("disabled"));
      exportJsonBtn?.removeAttribute("disabled");
      exportCsvBtn?.removeAttribute("disabled");

      // show initial hex/map
      if (app.firmware) navigateHexViewTo(0);
    });

    // ---- map export helpers (metadata only) ----
    function createElement(tagName, classAttrValue, text = null) {
      const element = document.createElement(tagName);
      element.setAttribute("class", classAttrValue);
      if (text !== null) element.appendChild(document.createTextNode(text));
      return element;
    }

    function serializeMapImagesOnly(map) {
      const out = [];
      for (const it of map || []) {
        if (it.type !== "image") continue;
        out.push({
          type: it.type,
          offset: it.offset,
          size: it.size,
          width: it.width,
          height: it.height,
          colorsCount: it.colorsCount
        });
      }
      return out;
    }

    function buildCsvFromMap(map) {
      const rows = serializeMapImagesOnly(map).map(it => ([
        "0x" + it.offset.toString(16),
        it.offset,
        it.type,
        it.width,
        it.height,
        it.colorsCount,
        it.size
      ]));
      const header = ["offset_hex", "offset_dec", "type", "width", "height", "colors", "block_size"];
      return [header, ...rows].map(r => r.join(",")).join("\n");
    }

    exportJsonBtn?.addEventListener("click", () => {
      if (!app || !app.map) return;
      const data = serializeMapImagesOnly(app.map);
      downloadBlob("tama_image_map.json", new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    });

    exportCsvBtn?.addEventListener("click", () => {
      if (!app || !app.map) return;
      const csv = buildCsvFromMap(app.map);
      downloadBlob("tama_image_map.csv", new Blob([csv], { type: "text/csv;charset=utf-8" }));
    });

    // === ZIP selected offsets ===
    extractListedBtn?.addEventListener("click", async () => {
      if (!app || !app.map) return;

      const want = new Set(
        (offsetsInput?.value || "")
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10))
          .filter(Number.isFinite)
      );

      const zip = new JSZip();
      const cvs = document.createElement("canvas");
      let matched = 0;

      const tasks = [];
      for (const ent of app.map) {
        if (ent.type !== "image" || !want.has(ent.offset)) continue;
        matched++;
        tasks.push(new Promise((resolve) => {
          ent.drawTo(cvs, 1);
          cvs.toBlob((blob) => {
            if (blob) zip.file(`img_${ent.offset.toString(16)}.png`, blob);
            resolve();
          }, "image/png");
        }));
      }

      await Promise.all(tasks);
      if (matched === 0) {
        alert("No matching offsets found.");
        return;
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      downloadBlob("extracted_images.zip", zipBlob);
    });

    // ====== Common helpers ======
    function hex(n) { return "0x" + n.toString(16).toLowerCase(); }
    function parseOff(s) {
      const t = s.trim().toLowerCase();
      if (!t) return NaN;
      return t.startsWith("0x") ? parseInt(t, 16) : parseInt(t, 10);
    }
    function firmwarePaletteAt(bytes, offset, colors) {
      const start = offset + 6;
      const out = [];
      for (let i = 0; i < colors; i++) {
        const hi = bytes[start + i * 2];
        const lo = bytes[start + i * 2 + 1];
        const c16 = (hi << 8) | lo; // BGR565
        const b = (c16 >> 11) & 0x1f, g = (c16 >> 5) & 0x3f, r = c16 & 0x1f;
        out.push([
          Math.round(r * 255 / 31),
          Math.round(g * 255 / 63),
          Math.round(b * 255 / 31),
          255
        ]);
      }
      return out;
    }
    function headerInfo(bytes, off) {
      const w = bytes[off + 0], h = bytes[off + 1], colors = bytes[off + 2];
      const ok = (bytes[off + 3] === 0 && bytes[off + 4] === 1 && bytes[off + 5] === 255);
      const headerSize = 6 + colors * 2;
      const dataStart = off + headerSize;
      const pixels = w * h;
      const dataLen = colors <= 16 ? Math.ceil(pixels / 2) : pixels;
      return { w, h, colors, ok, headerSize, dataStart, dataLen };
    }
    function packRaw4bpp(indexes) {
      const out = new Uint8Array(Math.ceil(indexes.length / 2));
      let j = 0;
      for (let i = 0; i < indexes.length; i += 2) {
        const a = indexes[i] & 0x0f;
        const b = (i + 1 < indexes.length) ? (indexes[i + 1] & 0x0f) : 0;
        out[j++] = (b << 4) | a;
      }
      return out;
    }
    function nearestIndex(rgb, palette) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const p = palette[i], dr = rgb[0] - p[0], dg = rgb[1] - p[1], db = rgb[2] - p[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = i; if (d === 0) break; }
      }
      return bi;
    }
    function pngToRawUsingPalette(pngBlob, w, h, colors, palette) {
      return new Promise(async (resolve, reject) => {
        try {
          const img = new Image();
          img.onload = () => {
            if (img.naturalWidth !== w || img.naturalHeight !== h) {
              reject(new Error(`PNG is ${img.naturalWidth}x${img.naturalHeight}, expected ${w}x${h}`));
              return;
            }
            const cvs = document.createElement("canvas");
            cvs.width = w; cvs.height = h;
            const ctx = cvs.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const { data } = ctx.getImageData(0, 0, w, h);
            const idx = new Uint8Array(w * h);
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) {
                const o = (y * w + x) * 4;
                idx[y * w + x] = nearestIndex([data[o], data[o + 1], data[o + 2], 255], palette);
              }
            }
            resolve(colors <= 16 ? packRaw4bpp(idx) : idx);
          };
          img.onerror = () => reject(new Error("Failed to load PNG"));
          img.src = URL.createObjectURL(pngBlob);
        } catch (e) { reject(e); }
      });
    }
    function patchRawIntoFirmware(fwBytes, off, rawBytes, info) {
      const { dataStart, dataLen } = info;
      if (rawBytes.length !== dataLen) {
        throw new Error(`RAW is ${rawBytes.length} bytes, expected ${dataLen}`);
      }
      fwBytes.set(rawBytes, dataStart);
    }
    function blobFromBytes(bytes) { return new Blob([bytes], { type: "application/octet-stream" }); }
    function downloadPatchedFirmware(baseName, fwBytes) {
      const out = new Uint8Array(fwBytes);
      const blob = blobFromBytes(out);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `patched_${baseName}`;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // ====== Wire up new controls ======
    const singleFileInput = document.getElementById("single-edit-file");
    const btnPatchSelected = document.getElementById("btn-patch-selected");
    const csvInput = document.getElementById("batch-csv-input");
    const btnBatchExport = document.getElementById("btn-batch-export");
    const folderInput = document.getElementById("batch-folder-input");
    const btnBatchPatch = document.getElementById("btn-batch-patch");

    btnPatchSelected.setAttribute("disabled", "true");
    btnBatchExport.setAttribute("disabled", "true");
    btnBatchPatch.setAttribute("disabled", "true");

    app.on(Application.events.mapReady, () => {
      btnBatchExport.removeAttribute("disabled");
    });

    entitiesList.addEventListener("click", (ev) => {
      const idx = nearestDataOffsetAttributeValue(ev.target);
      const ent = app.map[idx];
      if (ent && ent.type === "image") {
        btnPatchSelected.removeAttribute("disabled");
      }
    });

    btnPatchSelected.addEventListener("click", async () => {
      const li = document.querySelector("#entities-list .entity.selected") || null;
      const idx = (li ? parseInt(li.getAttribute("data-id"), 10) : null);
      const ent = (idx !== null ? app.map[idx] : null) || (window.toapp && window.toapp.map && previewItem) || null;
      const selected = ent || previewItem;
      if (!selected || selected.type !== "image") { alert("Pick an image from the list first."); return; }
      if (!singleFileInput.files || singleFileInput.files.length === 0) { alert("Pick a PNG/RAW to patch."); return; }

      const f = singleFileInput.files[0];
      const info = headerInfo(app.firmware, selected.offset);
      if (!info.ok) { alert("Header magic check failed at this offset."); return; }

      const fwBytes = new Uint8Array(app.firmware);
      const baseName = "firmware.bin";

      try {
        let raw;
        if (f.name.toLowerCase().endsWith(".raw")) {
          raw = new Uint8Array(await f.arrayBuffer());
        } else {
          const pal = firmwarePaletteAt(app.firmware, selected.offset, info.colors);
          raw = await pngToRawUsingPalette(f, info.w, info.h, info.colors, pal);
        }
        patchRawIntoFirmware(fwBytes, selected.offset, raw, info);
        downloadPatchedFirmware(baseName, fwBytes);
      } catch (e) {
        console.error(e);
        alert("Patch failed: " + e.message);
      }
    });

    btnBatchExport.addEventListener("click", async () => {
      if (!csvInput.files || csvInput.files.length === 0) { alert("Choose a CSV first."); return; }
      const file = csvInput.files[0];
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(s => s.trim().length > 0);
      const startIdx = isNaN(parseOff(lines[0].split(",")[0] || "")) ? 1 : 0;

      const offsets = [];
      for (let i = startIdx; i < lines.length; i++) {
        const cell = (lines[i].split(",")[0] || "").trim();
        const off = parseOff(cell);
        if (Number.isFinite(off)) offsets.push(off);
      }
      if (!offsets.length) { alert("No offsets found in first column."); return; }

      const zip = new JSZip();
      const csvRows = [["offset_hex","offset_dec","width","height","colors","magic_ok","header_size","data_start_hex","data_len","block_size"]];
      const cvs = document.createElement("canvas");

      for (const off of offsets) {
        const info = headerInfo(app.firmware, off);
        csvRows.push([hex(off), String(off), info.w, info.h, info.colors, info.ok ? "true":"false", info.headerSize, hex(info.dataStart), info.dataLen, info.headerSize + info.dataLen]);

        const ent = app.map.find(e => e.type === "image" && e.offset === off);
        if (ent) {
          ent.drawTo(cvs, 1);
          const blob = await new Promise(res => cvs.toBlob(res, "image/png"));
          if (blob) zip.file(`${hex(off)}.png`, blob);
        }
      }

      zip.file("batch.csv", new Blob([csvRows.map(r => r.join(",")).join("\n")], { type: "text/csv;charset=utf-8" }));
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(zipBlob);
      a.download = "images_and_batch_csv.zip";
      a.click();
      URL.revokeObjectURL(a.href);

      btnBatchPatch.removeAttribute("disabled");
    });

    btnBatchPatch.addEventListener("click", async () => {
      if (!folderInput.files || folderInput.files.length === 0) { alert("Pick the edited folder."); return; }
      const fwBytes = new Uint8Array(app.firmware);
      const byName = new Map();
      for (const f of folderInput.files) {
        const name = f.name.toLowerCase();
        if (!name.endsWith(".png") && !name.endsWith(".raw")) continue;
        const base = name.replace(/^img_/, "").replace(/\.png$|\.raw$/, "");
        byName.set(base, f);
      }

      let patchedCount = 0, missing = [];
      for (const ent of app.map) {
        if (ent.type !== "image") continue;
        const offHex = ent.offset.toString(16).toLowerCase();
        const candidates = [`0x${offHex}`, `${offHex}`, `${ent.offset}`];
        let f = null;
        for (const k of candidates) { if (byName.has(k)) { f = byName.get(k); break; } }
        if (!f) continue;

        const info = headerInfo(app.firmware, ent.offset);
        try {
          let raw;
          if (f.name.endsWith(".raw")) {
            raw = new Uint8Array(await f.arrayBuffer());
          } else {
            const pal = firmwarePaletteAt(app.firmware, ent.offset, info.colors);
            raw = await pngToRawUsingPalette(f, info.w, info.h, info.colors, pal);
          }
          patchRawIntoFirmware(fwBytes, ent.offset, raw, info);
          patchedCount++;
        } catch (e) {
          console.warn("Failed patch at", hex(ent.offset), e);
          missing.push(hex(ent.offset) + " (" + e.message + ")");
        }
      }

      if (patchedCount === 0) {
        alert("No matching edited files found for any image offsets.");
        return;
      }
      if (missing.length) {
        console.warn("Some patches failed:\n" + missing.join("\n"));
      }
      downloadPatchedFirmware("firmware.bin", fwBytes);
    });
  }

  window.addEventListener("load", () => {
    try { init(); }
    catch (e) {
      console.error("[tamaed] init() crashed:", e);
      alert("Init error — open DevTools Console for details.");
    }
  });
})();
