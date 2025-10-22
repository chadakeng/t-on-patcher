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
    static headerSize = 5;

    constructor(offset, bytes) {
      super(offset, bytes, TOImage.typeName);
      // header
      this.byte_5 = bytes[3];
      this.byte_6 = bytes[4];
      this.byte_7 = bytes[5];

      this.width = bytes[0];
      this.height = bytes[1];
      this.colorsCount = bytes[2];

      const paletteSize = this.colorsCount * 2; // 16-bit per entry
      this.paletteData = bytes.subarray(TOImage.headerSize + 1, TOImage.headerSize + paletteSize + 1);
      this.palette = null;

      this.imageData = bytes.subarray(TOImage.headerSize + paletteSize + 1);
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

    // palette entries are 16-bit words (big-endian): 5b blue, 6b green, 5b red
    static decodePalette(bytes) {
      const palette = [];
      for (let i = 0; i < bytes.length; i += 2) {
        const hi = bytes[i];
        const lo = bytes[i + 1];
        const color16 = (hi << 8) | lo;
        const blue = Math.round((((color16 & 0xf800) >> 11) / 31) * 255);
        const green = Math.round((((color16 & 0x07e0) >> 5) / 63) * 255);
        const red = Math.round(((color16 & 0x001f) / 31) * 255);
        palette.push([red, green, blue, 255]);
      }
      return palette;
    }

    static decodeImage(bytes, palette) {
      const halfBytePixel = palette.length <= 16; // 4bpp
      const pixelsCount = halfBytePixel ? bytes.length * 2 : bytes.length; // 2 pixels/byte if 4bpp
      const pixels = new Uint8ClampedArray(pixelsCount * 4);

      if (halfBytePixel) {
        for (let i = 0; i < bytes.length; i++) {
          const byte = bytes[i];
          const idx = i * 2;
          // low nibble first, then high nibble
          pixels.set(palette[byte & 0x0f], idx * 4);
          pixels.set(palette[byte >> 4], idx * 4 + 4);
        }
      } else {
        for (let i = 0; i < bytes.length; i++) {
          pixels.set(palette[bytes[i]], i * 4);
        }
      }
      return pixels;
    }

    static scanForImage(bytes, offset) {
      const width = bytes[offset + 0];
      const height = bytes[offset + 1];
      const paletteSize = bytes[offset + 2];

      if (
        bytes.length - offset > 10 &&
        width > 0 && width <= 128 &&
        height > 0 && height <= 128 &&
        paletteSize > 0 &&
        bytes[offset + 3] === 0 &&
        bytes[offset + 4] === 1 &&
        bytes[offset + 5] === 255
      ) {
        const headerSize = 6 + paletteSize * 2;
        const pixelsPerByte = paletteSize > 16 ? 1 : 2; // 8bpp vs 4bpp
        const size = headerSize + Math.ceil((width * height) / pixelsPerByte);
        try { return new TOImage(offset, bytes.subarray(offset, offset + size)); }
        catch { return null; }
      }
      return null;
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

    // grab DOM
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

    // sanity log
    for (const [name, el] of Object.entries({
      mapCanvas, entitiesList, entityPreviewScaleInput, entityPreviewCanvas,
      hexPageSizeInput, hexOffsetInput, hexPageUpButton, hexRowUpButton,
      hexRowDownButton, hexPageDownButton, exportRawBtn, exportPngBtn,
      exportJsonBtn, exportCsvBtn, offsetsInput, extractListedBtn
    })) {
      if (!el) console.warn("[tamaed] missing DOM element:", name);
    }

    // convenience
    const hexControls = [
      hexPageSizeInput, hexOffsetInput, hexPageUpButton, hexRowUpButton, hexRowDownButton, hexPageDownButton
    ];

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
      const maxOffset = app.firmware.length - pageSize;
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
    hexRowUpButton?.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() - hexViewRowSize));
    hexRowDownButton?.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() + hexViewRowSize));
    hexPageDownButton?.addEventListener("click", () => navigateHexViewTo(getHexViewOffset() + getHexViewPageSize()));
    hexOffsetInput?.addEventListener("change", () => navigateHexViewTo(getHexViewOffset()));
    hexPageSizeInput?.addEventListener("change", () => navigateHexViewTo(getHexViewOffset()));

    // entities list click
    entitiesList?.addEventListener("click", (event) => {
      const idx = nearestDataOffsetAttributeValue(event.target);
      if (!Number.isFinite(idx) || idx < 0 || !app.map) return;
      const dataItem = app.map[idx];
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
      console.log("[tamaed] firmwareReady; building map…");
      entitiesList.textContent = "";
      hexControls.forEach((c) => c?.setAttribute("disabled", "true"));
      app.buildMap();
    });

    app.on(Application.events.mapReady, () => {
      console.log("[tamaed] mapReady; items:", app.map?.length ?? 0);
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
  }

  // robust bootstrap with error surfacing
  window.addEventListener("load", () => {
    try {
      console.log("[tamaed] booting");
      init();
    } catch (e) {
      console.error("[tamaed] init() crashed:", e);
      alert("Init error — open DevTools Console for details.");
    }
  });
})();
