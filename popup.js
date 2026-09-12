// PDFPaz - all processing happens locally via pdf.js (rendering/reading) and
// pdf-lib (writing). No network requests are ever made.

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.js');

const els = {
  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('fileInput'),
  docInfo: document.getElementById('docInfo'),
  toolbar: document.getElementById('toolbar'),
  status: document.getElementById('status'),
  emptyState: document.getElementById('emptyState'),
  grid: document.getElementById('thumbnailGrid'),
  rotateAngle: document.getElementById('rotateAngle'),
  btnExport: document.getElementById('btnExport'),
  btnSplit: document.getElementById('btnSplit'),
  btnExtractText: document.getElementById('btnExtractText'),
  btnExtractImages: document.getElementById('btnExtractImages'),
  btnRotateSelected: document.getElementById('btnRotateSelected'),
  btnRotateAll: document.getElementById('btnRotateAll'),
  btnClearSelection: document.getElementById('btnClearSelection'),
  btnReset: document.getElementById('btnReset'),
};

const state = {
  originalBytes: null,   // Uint8Array of the untouched source file
  pdfjsDoc: null,        // pdf.js document proxy, used for render/text/image reads
  numPages: 0,
  baseName: 'document',
  deletedPages: new Set(),  // 0-based indices excluded from export
  selectedPages: new Set(), // 0-based indices targeted for the next rotation
  rotations: new Map(),     // 0-based index -> additional degrees (0/90/180/270)
};

function setStatus(message, isError = false) {
  els.status.textContent = message || '';
  els.status.classList.toggle('error', !!isError);
}

function setBusy(busy) {
  document.querySelectorAll('.btn, select').forEach((el) => (el.disabled = busy));
}

function getActivePageNumbers() {
  const active = [];
  for (let i = 0; i < state.numPages; i++) {
    if (!state.deletedPages.has(i)) active.push(i + 1);
  }
  return active;
}

// --- Download helper -------------------------------------------------------
// Data URLs (not blob: URLs) are used because a popup document can be
// destroyed mid-download, which revokes any blob: URL it created.
function bytesToDataURL(bytes, mimeType) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes], { type: mimeType });
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

async function downloadBytes(bytes, filename, mimeType) {
  const url = await bytesToDataURL(bytes, mimeType);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(downloadId);
    });
  });
}

function sanitizeBaseName(name) {
  return name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_') || 'document';
}

// --- Loading & rendering -----------------------------------------------------

async function loadFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    setStatus('Please choose a .pdf file.', true);
    return;
  }
  setBusy(true);
  setStatus('Loading PDF…');
  try {
    const buffer = await file.arrayBuffer();
    state.originalBytes = new Uint8Array(buffer);
    state.baseName = sanitizeBaseName(file.name);
    state.deletedPages = new Set();
    state.selectedPages = new Set();
    state.rotations = new Map();

    if (state.pdfjsDoc) {
      state.pdfjsDoc.destroy();
      state.pdfjsDoc = null;
    }

    const loadingTask = pdfjsLib.getDocument({ data: state.originalBytes.slice() });
    state.pdfjsDoc = await loadingTask.promise;
    state.numPages = state.pdfjsDoc.numPages;

    await renderThumbnails();

    els.docInfo.style.display = 'block';
    els.toolbar.style.display = 'flex';
    updateDocInfo();
    setStatus(`Loaded "${file.name}" — ${state.numPages} page${state.numPages === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load PDF: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

function updateDocInfo() {
  const activeCount = getActivePageNumbers().length;
  els.docInfo.textContent =
    `${state.baseName}.pdf — ${state.numPages} page${state.numPages === 1 ? '' : 's'} total, ` +
    `${activeCount} active for export.`;
}

async function renderThumbnails() {
  els.grid.innerHTML = '';
  els.emptyState.style.display = 'none';

  for (let pageNum = 1; pageNum <= state.numPages; pageNum++) {
    const pageIndex = pageNum - 1;
    const page = await state.pdfjsDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 0.2 });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const card = document.createElement('div');
    card.className = 'thumb-card';
    card.dataset.pageIndex = String(pageIndex);

    const checkLabel = document.createElement('label');
    checkLabel.className = 'select-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (checkbox.checked) state.selectedPages.add(pageIndex);
      else state.selectedPages.delete(pageIndex);
      card.classList.toggle('selected', checkbox.checked);
    });
    checkLabel.addEventListener('click', (e) => e.stopPropagation());
    checkLabel.appendChild(checkbox);

    const badge = document.createElement('div');
    badge.className = 'rot-badge';

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `Page ${pageNum}`;

    card.appendChild(checkLabel);
    card.appendChild(badge);
    card.appendChild(canvas);
    card.appendChild(label);

    card.addEventListener('click', () => {
      if (state.deletedPages.has(pageIndex)) state.deletedPages.delete(pageIndex);
      else state.deletedPages.add(pageIndex);
      card.classList.toggle('deleted', state.deletedPages.has(pageIndex));
      updateDocInfo();
    });

    els.grid.appendChild(card);
  }

  refreshRotationBadges();
}

function refreshRotationBadges() {
  els.grid.querySelectorAll('.thumb-card').forEach((card) => {
    const idx = Number(card.dataset.pageIndex);
    const angle = state.rotations.get(idx) || 0;
    const badge = card.querySelector('.rot-badge');
    if (angle) {
      badge.textContent = `${angle}°`;
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  });
}

// --- Rotation ----------------------------------------------------------

function applyRotation(indices, angle) {
  for (const idx of indices) {
    const current = state.rotations.get(idx) || 0;
    state.rotations.set(idx, (current + angle) % 360);
  }
  refreshRotationBadges();
}

// --- pdf-lib helpers -----------------------------------------------------

async function buildEditedDocument() {
  const pdfDoc = await PDFLib.PDFDocument.load(state.originalBytes.slice());
  const pages = pdfDoc.getPages();
  pages.forEach((page, idx) => {
    const addedAngle = state.rotations.get(idx) || 0;
    if (addedAngle) {
      const current = page.getRotation().angle;
      page.setRotation(PDFLib.degrees((current + addedAngle) % 360));
    }
  });
  return pdfDoc;
}

async function exportEditedPdf() {
  setBusy(true);
  setStatus('Building edited PDF…');
  try {
    const pdfDoc = await buildEditedDocument();
    const indicesToRemove = [...state.deletedPages].sort((a, b) => b - a);
    if (indicesToRemove.length === pdfDoc.getPageCount()) {
      throw new Error('Cannot export: every page is marked for removal.');
    }
    for (const idx of indicesToRemove) pdfDoc.removePage(idx);
    const bytes = await pdfDoc.save();
    await downloadBytes(bytes, `${state.baseName}-edited.pdf`, 'application/pdf');
    setStatus(`Exported ${pdfDoc.getPageCount()} page(s) to ${state.baseName}-edited.pdf`);
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function splitDocument() {
  setBusy(true);
  try {
    const sourceDoc = await buildEditedDocument();
    const activeIndices = [];
    for (let i = 0; i < state.numPages; i++) {
      if (!state.deletedPages.has(i)) activeIndices.push(i);
    }
    let done = 0;
    for (const idx of activeIndices) {
      setStatus(`Splitting… (${done + 1}/${activeIndices.length})`);
      const newDoc = await PDFLib.PDFDocument.create();
      const [copied] = await newDoc.copyPages(sourceDoc, [idx]);
      newDoc.addPage(copied);
      const bytes = await newDoc.save();
      await downloadBytes(bytes, `${state.baseName}-page-${idx + 1}.pdf`, 'application/pdf');
      done++;
    }
    setStatus(`Split complete: ${done} file(s) downloaded.`);
  } catch (err) {
    console.error(err);
    setStatus(`Split failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

// --- Text extraction -----------------------------------------------------

async function extractAllText() {
  setBusy(true);
  setStatus('Extracting text…');
  try {
    const parts = [];
    for (const pageNum of getActivePageNumbers()) {
      const page = await state.pdfjsDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item) => item.str || '').join(' ');
      parts.push(`--- Page ${pageNum} ---\n${pageText.trim()}`);
    }
    const bytes = new TextEncoder().encode(parts.join('\n\n'));
    await downloadBytes(bytes, `${state.baseName}-text.txt`, 'text/plain');
    setStatus('Text extracted.');
  } catch (err) {
    console.error(err);
    setStatus(`Text extraction failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

// --- Image extraction ------------------------------------------------------
// pdf.js's page.objs/getOperatorList API is internal and not officially
// stable across versions, so the pixel-format handling here is best-effort.

function getPageObject(page, objId) {
  return new Promise((resolve) => {
    page.objs.get(objId, (obj) => resolve(obj));
  });
}

function imageToCanvas(imgData) {
  if (typeof ImageBitmap !== 'undefined' && imgData instanceof ImageBitmap) {
    const canvas = document.createElement('canvas');
    canvas.width = imgData.width;
    canvas.height = imgData.height;
    canvas.getContext('2d').drawImage(imgData, 0, 0);
    return canvas;
  }
  if (imgData && imgData.bitmap) {
    const canvas = document.createElement('canvas');
    canvas.width = imgData.width;
    canvas.height = imgData.height;
    canvas.getContext('2d').drawImage(imgData.bitmap, 0, 0);
    return canvas;
  }
  if (!imgData || !imgData.width || !imgData.height || !imgData.data) return null;

  const { width, height, data } = imgData;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  const out = imageData.data;
  const KIND = pdfjsLib.ImageKind || { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 };

  if (imgData.kind === KIND.RGBA_32BPP || data.length === width * height * 4) {
    out.set(data);
  } else if (imgData.kind === KIND.RGB_24BPP || data.length === width * height * 3) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      out[j] = data[i];
      out[j + 1] = data[i + 1];
      out[j + 2] = data[i + 2];
      out[j + 3] = 255;
    }
  } else if (imgData.kind === KIND.GRAYSCALE_1BPP) {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = data[y * rowBytes + (x >> 3)];
        const v = (byte >> (7 - (x & 7))) & 1 ? 255 : 0;
        const j = (y * width + x) * 4;
        out[j] = v;
        out[j + 1] = v;
        out[j + 2] = v;
        out[j + 3] = 255;
      }
    }
  } else {
    // Fallback: assume one grayscale byte per pixel.
    for (let i = 0, j = 0; i < data.length && j < out.length; i++, j += 4) {
      const v = data[i];
      out[j] = v;
      out[j + 1] = v;
      out[j + 2] = v;
      out[j + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function extractAllImages() {
  setBusy(true);
  setStatus('Scanning for images…');
  try {
    const ops = pdfjsLib.OPS;
    let totalCount = 0;
    for (const pageNum of getActivePageNumbers()) {
      const page = await state.pdfjsDoc.getPage(pageNum);
      const opList = await page.getOperatorList();
      let imgIndexOnPage = 0;

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        if (fn !== ops.paintImageXObject) continue;
        const objId = opList.argsArray[i][0];

        let imgData;
        try {
          imgData = await getPageObject(page, objId);
        } catch (e) {
          continue;
        }
        const canvas = imageToCanvas(imgData);
        if (!canvas) continue;

        imgIndexOnPage++;
        totalCount++;
        setStatus(`Extracting images… (found ${totalCount})`);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await downloadBytes(
          bytes,
          `${state.baseName}-page${pageNum}-image${imgIndexOnPage}.png`,
          'image/png'
        );
      }
    }
    setStatus(
      totalCount > 0
        ? `Extracted ${totalCount} image(s).`
        : 'No embedded raster images were found.'
    );
  } catch (err) {
    console.error(err);
    setStatus(`Image extraction failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

// --- Reset -----------------------------------------------------------------

function resetEdits() {
  state.deletedPages.clear();
  state.selectedPages.clear();
  state.rotations.clear();
  els.grid.querySelectorAll('.thumb-card').forEach((card) => {
    card.classList.remove('deleted', 'selected');
    const checkbox = card.querySelector('input[type=checkbox]');
    if (checkbox) checkbox.checked = false;
  });
  refreshRotationBadges();
  updateDocInfo();
  setStatus('All edits reset.');
}

// --- Wiring ------------------------------------------------------------

els.dropZone.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => loadFile(els.fileInput.files[0]));

['dragenter', 'dragover'].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.remove('dragover');
  })
);
els.dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  loadFile(file);
});

els.btnExport.addEventListener('click', exportEditedPdf);
els.btnSplit.addEventListener('click', splitDocument);
els.btnExtractText.addEventListener('click', extractAllText);
els.btnExtractImages.addEventListener('click', extractAllImages);

els.btnRotateSelected.addEventListener('click', () => {
  if (state.selectedPages.size === 0) {
    setStatus('Check at least one page to rotate first.', true);
    return;
  }
  applyRotation(state.selectedPages, Number(els.rotateAngle.value));
  setStatus(`Rotated ${state.selectedPages.size} selected page(s).`);
});

els.btnRotateAll.addEventListener('click', () => {
  const all = [];
  for (let i = 0; i < state.numPages; i++) all.push(i);
  applyRotation(all, Number(els.rotateAngle.value));
  setStatus('Rotated all pages.');
});

els.btnClearSelection.addEventListener('click', () => {
  state.selectedPages.clear();
  els.grid.querySelectorAll('.thumb-card.selected').forEach((card) => {
    card.classList.remove('selected');
    const checkbox = card.querySelector('input[type=checkbox]');
    if (checkbox) checkbox.checked = false;
  });
  setStatus('Selection cleared.');
});

els.btnReset.addEventListener('click', resetEdits);
