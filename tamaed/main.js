"use strict";

(function () {
  class EventEmitter {
    constructor() {
      this.events = new Map();
    }
    on(event, listener) {
      const listeners = this.events.get(event) || [];
      this.events.set(event, [listener].concat(listeners));
    }
    emit(event, ...args) {
      const listeners = this.events.get(event) || [];
      for (const listener of listeners) listener(...args);
    }
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

  class Application extends EventEmitter {
    constructor(scan = () => null) {
      super();
      this.firmware = null;
      this.map = null;
      this.scan = scan;
    }
    static events = {
      firmwareReady: "firmwareReady",
      mapReady: "mapReady",
    };
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
          idx += item.size - 1; // skip over the block
        }
      }
      this.map = map;
      this.emit(Application.events.mapReady);
    }
  }

  class TODataItem {
    constructor(offset, bytes, type = "unknown") {
      this.type = type;
      this.offset = offset;
      this.size = bytes.length;
      this.bytes = bytes; // Uint8Array view into firmware buffer slice
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
      this.paletteData = bytes.subarray(
        TOImage.headerSize + 1,
        TOImage.headerSize + paletteSize + 1
      );
      this.palette = null;

      this.imageData = bytes.subarray(TOImage.headerSize + paletteSize + 1);
      this.image = null;
    }

    getPalette() {
      if (this.palette === null) {
        this.palette = TOImage.decodePalette(this.paletteData);
      }
      return this.palette;
    }

    getImage() {
      if (this.image === null) {
        this.image = TOImage.decodeImage(this.imageData, this.getPalette());
      }
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
      const pixelsCount = halfBytePixel ? bytes.length * 2 : bytes.length; // 2 pixels per byte if 4bpp
      const pixels = new Uint8ClampedArray(pixelsCount * 4);

      if (halfBytePixel) {
        for (let i = 0; i < bytes.length; i++) {
          const byte = bytes[i];
          const idx = i * 2;
          // low nibble first, then high nibble (matches existing viewers)
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
        bytes[offset + 3] === 0 &&      // magic?
        bytes[offset + 4] === 1 &&      // magic?
        bytes[offset + 5] === 255       // magic?
      ) {
        const headerSize = 6 + paletteSize * 2;
        const pixelsPerByte = paletteSize > 16 ? 1 : 2; // 8bpp vs 4bpp
        const size = headerSize + Math.ceil((width * height) / pixelsPerByte);
        try {
          return new TOImage(offset, bytes.subarray(offset, offset + size));
        } catch {
          return null;
        }
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

  // DOM helpers
  const $ = (sel) => document.querySelector(sel);

  function passFirstFileTo(fn) {
    return function (event) {
      const files = event.target.files;
      if (files.length > 0) return fn(files[0]);
    };
  }

  // Map colors
  const selectionMapColor = new Uint8ClampedArray([255, 55, 55, 255]);
  const defaultMapColor = new Uint8ClampedArray([100, 100, 100, 255]);
  const dataTypeColors = new Map([
    [TOImage.typeName, new Uint8ClampedArray([255, 255, 0, 255])],
  ]);

  function colorByDataType(type) {
    const typeColor = dataTypeColors.get(type);
    return typeColor !== undefined ? typeColor : defaultMapColor;
  }

  // Map layout
  const chunkSize = 2048;
  const bytesPerPixel = 8;

  function drawMapTo(canvas, map, dataSize, selectionStart, selectionEnd) {
    if (chunkSize % bytesPerPixel !== 0) {
      throw new Error("chunkSize must be a multiple of bytesPerPixel");
    }

    const height = chunkSize / bytesPerPixel;
    const width = Math.ceil(dataSize / chunkSize);
    canvas.height = height;
    canvas.width = width;
    if (canvas.isConnected) fixDPI(canvas);

    const ctx = canvas.getContext("2d");
    if (map === null) return;

    const img = ctx.createImageData(width, height);
    const iter = map[Symbol.iterator]();
    const { done, value } = iter.next();

    const selectionStartYX = Math.floor(selectionStart / bytesPerPixel);
    const selectionEndYX = Math.floor(selectionEnd / bytesPerPixel);

    let colorStartYX = done ? Infinity : Math.floor(value.offset / bytesPerPixel);
    let colorEndYX = done ? Infinity : Math.floor((value.offset + value.size) / bytesPerPixel);
    let color = done ? defaultMapColor : colorByDataType(value.type);

    for (let x = 0; x < width; x++) {
      const yxColumnOffset = x * height;
      for (let y = 0; y < height; y++) {
        const yxIndex = yxColumnOffset + y;
        const pixelOffset = (y * width + x) * 4;

        let drawColor = defaultMapColor;
        if (yxIndex >= colorStartYX) {
          drawColor = color;
          while (yxIndex === colorEndYX) {
            const { done, value } = iter.next();
            colorStartYX = done ? Infinity : Math.floor(value.offset / bytesPerPixel);
            colorEndYX = done ? Infinity : Math.floor((value.offset + value.size) / bytesPerPixel);
            color = done ? defaultMapColor : colorByDataType(value.type);
          }
        }
        if (yxIndex >= selectionStartYX && yxIndex < selectionEndYX) {
          drawColor = selectionMapColor;
        }
        img.data.set(drawColor, pixelOffset);
      }
    }

    ctx.putImageData(img, 0, 0);
  }

  function createElement(tagName, classAttrValue, text = null) {
    const element = document.createElement(tagName);
    element.setAttribute("class", classAttrValue);
    if (text !== null) element.appendChild(document.createTextNode(text));
    return element;
  }

  function nearestDataOffsetAttributeValue(target) {
    while (target && target.getAttribute("data-id") === null && target.tagName !== "UL") {
      target = target.parentElement;
    }
    return parseInt(target.getAttribute("data-id"), 10);
  }

  const hexViewRowSize = 16;

  async function init() {
    const app = new Application(TOImage.scanForImage);
    window.toapp = app;

    let previewItem = null;

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

    const hexControls = [
      hexPageSizeInput,
      hexOffsetInput,
      hexPageUpButton,
      hexRowUpButton,
      hexRowDownButton,
      hexPageDownButton,
    ];

    const hexAreaOffsets = $("#hex-area-offsets");
    const hexAreaHextets = $("#hex-area-hextets");
    const hexAreaChars = $("#hex-area-chars");

    // firmware input
    $("#firmware-file-input").addEventListener(
      "change",
      passFirstFileTo((file) => app.changeFirmware(file))
    );

    function getEntityPreviewScale() {
      return parseInt(entityPreviewScaleInput.value, 10) || 1;
    }

    function setPreview(dataItem) {
      previewItem = dataItem;
      if (dataItem.type === TOImage.typeName) {
        dataItem.drawTo(entityPreviewCanvas, getEntityPreviewScale());
      }
    }

    entityPreviewScaleInput.addEventListener("change", () => {
      if (previewItem !== null) setPreview(previewItem);
    });

    function getHexViewOffset() {
      return hexOffsetInput.valueAsNumber;
    }

    function getHexViewPageSize() {
      const pageSize = hexPageSizeInput.valueAsNumber || 256;
      return Math.ceil(pageSize / hexViewRowSize) * hexViewRowSize;
    }

    function navigateHexViewTo(rawOffset) {
      const pageSize = getHexViewPageSize();
      const maxOffset = app.firmware.length - pageSize;
      const offset = Math.min(maxOffset, Math.max(0, rawOffset));
      const bytes = Array.from(app.firmware.slice(offset, offset + pageSize));

      hexOffsetInput.value = offset;

      hexAreaOffsets.innerText = new Array(pageSize / hexViewRowSize)
        .fill("")
        .map((_, idx) => (offset + hexViewRowSize * idx).toString())
        .join("\n");

      hexAreaHextets.innerText = new Array(pageSize / hexViewRowSize)
        .fill("")
        .map((_, idx) =>
          bytes
            .slice(idx * hexViewRowSize, (idx + 1) * hexViewRowSize)
            .map((byte) => (byte < 16 ? "0" + byte.toString(16) : byte.toString(16)))
            .join(" ")
        )
        .join("\n");

      hexAreaChars.innerText = new Array(pageSize / hexViewRowSize)
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

    hexPageUpButton.addEventListener("click", () =>
      navigateHexViewTo(getHexViewOffset() - getHexViewPageSize())
    );
    hexRowUpButton.addEventListener("click", () =>
      navigateHexViewTo(getHexViewOffset() - hexViewRowSize)
    );
    hexRowDownButton.addEventListener("click", () =>
      navigateHexViewTo(getHexViewOffset() + hexViewRowSize)
    );
    hexPageDownButton.addEventListener("click", () =>
      navigateHexViewTo(getHexViewOffset() + getHexViewPageSize())
    );
    hexOffsetInput.addEventListener("change", () =>
      navigateHexViewTo(getHexViewOffset())
    );
    hexPageSizeInput.addEventListener("change", () =>
      navigateHexViewTo(getHexViewOffset())
    );

    entitiesList.addEventListener("click", (event) => {
      const idx = nearestDataOffsetAttributeValue(event.target);
      const dataItem = app.map[idx];
      navigateHexViewTo(dataItem.offset);
      setPreview(dataItem);
    });

    // === New: Export buttons under preview ===
    const exportRawBtn = document.getElementById("export-raw");
    const exportPngBtn = document.getElementById("export-png");

    function downloadBlob(name, blob) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }

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
    // =========================================

    app.on(Application.events.firmwareReady, () => {
      entitiesList.textContent = "";
      // disable hex controls until map ready
      hexControls.forEach((c) => c.setAttribute("disabled", "true"));
      app.buildMap();
    });

    app.on(Application.events.mapReady, () => {
      // populate list
      const fragment = document.createDocumentFragment();
      for (let idx = 0; idx < app.map.length; idx++) {
        const dataItem = app.map[idx];
        const listItem = createElement("li", "entity");
        listItem.setAttribute("data-id", idx);

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

      // enable hex controls
      hexControls.forEach((c) => c.removeAttribute("disabled"));

      // draw initial hex/map
      navigateHexViewTo(0);

      // === New: auto-export the discovered image map as JSON ===
      try {
        const json = JSON.stringify(app.map, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "tama_image_map.json";
        a.click();
        URL.revokeObjectURL(a.href);
      } catch {}
      // =========================================================
    });
    const offsetsInput = document.getElementById("offsets-input");
    const extractListedBtn = document.getElementById("extract-listed");

    function downloadBlob(name, blob) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    extractListedBtn?.addEventListener("click", async () => {
      const app = window.toapp;
      if (!app || !app.map) return;

      const want = new Set(
        offsetsInput.value
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10))
          .filter(n => Number.isFinite(n))
      );

      const zip = new JSZip();
      const cvs = document.createElement("canvas");
      let matchCount = 0;

      const blobPromises = [];

      for (const ent of app.map) {
        if (ent.type !== "image") continue;
        if (!want.has(ent.offset)) continue;
        matchCount++;

        const promise = new Promise((resolve) => {
          ent.drawTo(cvs, 1);
          cvs.toBlob((blob) => {
            if (blob) {
              const filename = `img_${ent.offset.toString(16)}.png`;
              zip.file(filename, blob);
            }
            resolve();
          }, "image/png");
        });
        blobPromises.push(promise);
      }

      await Promise.all(blobPromises);

      if (matchCount === 0) {
        alert("No matching offsets found.");
        return;
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      downloadBlob("extracted_images.zip", zipBlob);
    });
  }

  window.addEventListener("load", init);
})();
