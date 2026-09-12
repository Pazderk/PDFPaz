// Brog's PDF Editor - all processing happens locally via pdf.js (rendering/reading) and
// pdf-lib (writing). No network requests are ever made. The loaded document
// and any applied edits are persisted to IndexedDB so they survive closing
// the side panel (or the whole browser) — only Reset clears them.

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.js');

const els = {
  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('fileInput'),
  docInfo: document.getElementById('docInfo'),
  toolSection: document.getElementById('toolSection'),
  keepSection: document.getElementById('keepSection'),
  keepInput: document.getElementById('keepInput'),
  applyHint: document.getElementById('applyHint'),
  actionRow: document.getElementById('actionRow'),
  status: document.getElementById('status'),
  emptyState: document.getElementById('emptyState'),
  grid: document.getElementById('thumbnailGrid'),
  rotateAngle: document.getElementById('rotateAngle'),
  btnClearSelection: document.getElementById('btnClearSelection'),
  btnReset: document.getElementById('btnReset'),
  btnApply: document.getElementById('btnApply'),
};
const toolButtons = Array.from(document.querySelectorAll('.tool-btn'));

const state = {
  originalBytes: null,   // Uint8Array of the untouched source file
  pdfjsDoc: null,        // pdf.js document proxy, used for rendering
  numPages: 0,
  baseName: 'document',
  deletedPages: new Set(),  // 0-based indices committed for removal (used by Export/Split)
  stagedDeleted: new Set(), // 0-based indices currently marked in the UI, not yet applied
  selectedPages: new Set(), // 0-based indices checked as a rotation target
  rotations: new Map(),     // 0-based index -> committed additional degrees (0/90/180/270)
  activeTool: null,         // null | 'remove' | 'rotate-selected' | 'rotate-all' | 'split' | 'export'
};

function setStatus(message, isError = false) {
  els.status.textContent = message || '';
  els.status.classList.toggle('error', !!isError);
}

function setBusy(busy) {
  document.querySelectorAll('.btn, select, input').forEach((el) => (el.disabled = busy));
  if (!busy) updateApplyHint();
}

// --- IndexedDB persistence --------------------------------------------------

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pdfpaz-db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('session');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('session', 'readwrite');
    tx.objectStore('session').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('session', 'readonly');
    const req = tx.objectStore('session').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('session', 'readwrite');
    tx.objectStore('session').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function persistSession() {
  try {
    await idbSet('current', {
      baseName: state.baseName,
      bytes: state.originalBytes,
      deletedPages: [...state.deletedPages],
      rotations: [...state.rotations.entries()],
    });
  } catch (err) {
    console.error('Failed to persist session', err);
  }
}

async function restoreSession() {
  let record;
  try {
    record = await idbGet('current');
  } catch (err) {
    console.error('Failed to read saved session', err);
    return false;
  }
  if (!record || !record.bytes) return false;

  setStatus('Restoring previous session…');
  try {
    state.originalBytes = record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes);
    state.baseName = record.baseName || 'document';
    state.deletedPages = new Set(record.deletedPages || []);
    state.rotations = new Map(record.rotations || []);
    state.stagedDeleted = new Set(state.deletedPages);

    const loadingTask = pdfjsLib.getDocument({ data: state.originalBytes.slice() });
    state.pdfjsDoc = await loadingTask.promise;
    state.numPages = state.pdfjsDoc.numPages;

    await renderThumbnails();
    showEditorUI();
    updateKeepInputFromStaged();
    setStatus(`Restored "${state.baseName}.pdf" — ${state.numPages} page(s).`);
    return true;
  } catch (err) {
    console.error('Failed to restore session', err);
    setStatus('Could not restore the previous session.', true);
    return false;
  }
}

async function clearSession() {
  try {
    await idbDelete('current');
  } catch (err) {
    console.error('Failed to clear saved session', err);
  }
}

// --- Download helper -------------------------------------------------------
// Data URLs (not blob: URLs) are used because the side panel document can be
// closed mid-download, which would revoke any blob: URL it created.
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

// --- Page-range parsing (the "pages to keep" text field) -------------------

function parseKeepRanges(text, maxPage) {
  const keep = new Set();
  const invalid = [];
  const tokens = text.split(',').map((t) => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    const singleMatch = token.match(/^(\d+)$/);
    if (rangeMatch) {
      let a = Number(rangeMatch[1]);
      let b = Number(rangeMatch[2]);
      if (a > b) [a, b] = [b, a];
      a = Math.max(1, a);
      b = Math.min(maxPage, b);
      for (let p = a; p <= b; p++) keep.add(p);
    } else if (singleMatch) {
      const p = Number(singleMatch[1]);
      if (p >= 1 && p <= maxPage) keep.add(p);
      else invalid.push(token);
    } else {
      invalid.push(token);
    }
  }
  return { keep, invalid };
}

function formatKeepRanges(keptPagesAscending) {
  if (keptPagesAscending.length === 0) return '';
  const parts = [];
  let start = keptPagesAscending[0];
  let prev = start;
  for (let i = 1; i <= keptPagesAscending.length; i++) {
    const current = keptPagesAscending[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = current;
    prev = current;
  }
  return parts.join(',');
}

function updateKeepInputFromStaged() {
  if (document.activeElement === els.keepInput) return; // don't clobber while typing
  const kept = [];
  for (let i = 0; i < state.numPages; i++) {
    if (!state.stagedDeleted.has(i)) kept.push(i + 1);
  }
  els.keepInput.value = formatKeepRanges(kept);
}

function applyKeepInputToStaged() {
  const { keep, invalid } = parseKeepRanges(els.keepInput.value, state.numPages);
  state.stagedDeleted = new Set();
  for (let i = 0; i < state.numPages; i++) {
    if (!keep.has(i + 1)) state.stagedDeleted.add(i);
  }
  refreshAllCardVisuals();
  updateApplyHint();
  if (invalid.length) setStatus(`Ignored invalid page reference(s): ${invalid.join(', ')}`, true);
  else setStatus('');
}

// --- Loading -----------------------------------------------------------

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
    state.stagedDeleted = new Set();
    state.selectedPages = new Set();
    state.rotations = new Map();
    state.activeTool = null;

    if (state.pdfjsDoc) {
      state.pdfjsDoc.destroy();
      state.pdfjsDoc = null;
    }

    const loadingTask = pdfjsLib.getDocument({ data: state.originalBytes.slice() });
    state.pdfjsDoc = await loadingTask.promise;
    state.numPages = state.pdfjsDoc.numPages;

    await renderThumbnails();
    showEditorUI();
    updateKeepInputFromStaged();
    setStatus(`Loaded "${file.name}" — ${state.numPages} page${state.numPages === 1 ? '' : 's'}.`);
    await persistSession();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load PDF: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

function showEditorUI() {
  els.docInfo.style.display = 'block';
  els.toolSection.style.display = 'block';
  els.keepSection.style.display = 'block';
  els.actionRow.style.display = 'flex';
  updateDocInfo();
}

function updateDocInfo() {
  const activeCount = state.numPages - state.deletedPages.size;
  els.docInfo.textContent =
    `${state.baseName}.pdf — ${state.numPages} page${state.numPages === 1 ? '' : 's'} total, ` +
    `${activeCount} currently active.`;
}

// --- Thumbnail rendering -----------------------------------------------

async function renderThumbnails() {
  els.grid.innerHTML = '';
  els.emptyState.style.display = 'none';

  for (let pageNum = 1; pageNum <= state.numPages; pageNum++) {
    const pageIndex = pageNum - 1;
    const page = await state.pdfjsDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 0.28 });

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
    checkbox.title = 'Target this page for the Rotate Selected action';
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      if (checkbox.checked) state.selectedPages.add(pageIndex);
      else state.selectedPages.delete(pageIndex);
      card.classList.toggle('selected', checkbox.checked);
      refreshAllCardVisuals();
      updateApplyHint();
    });
    checkLabel.addEventListener('click', (e) => e.stopPropagation());
    checkLabel.appendChild(checkbox);

    const tag = document.createElement('div');
    tag.className = 'status-tag';
    tag.hidden = true;

    const badge = document.createElement('div');
    badge.className = 'rot-badge';

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `Page ${pageNum}`;

    card.appendChild(checkLabel);
    card.appendChild(tag);
    card.appendChild(badge);
    card.appendChild(canvas);
    card.appendChild(label);

    card.addEventListener('click', () => {
      if (state.stagedDeleted.has(pageIndex)) state.stagedDeleted.delete(pageIndex);
      else state.stagedDeleted.add(pageIndex);
      refreshAllCardVisuals();
      updateKeepInputFromStaged();
      updateApplyHint();
    });

    els.grid.appendChild(card);
  }

  refreshAllCardVisuals();
}

function computePendingAngle(idx) {
  const committed = state.rotations.get(idx) || 0;
  const chosen = Number(els.rotateAngle.value);
  if (state.activeTool === 'rotate-all') return (committed + chosen) % 360;
  if (state.activeTool === 'rotate-selected' && state.selectedPages.has(idx)) {
    return (committed + chosen) % 360;
  }
  return committed;
}

function refreshAllCardVisuals() {
  els.grid.querySelectorAll('.thumb-card').forEach((card) => {
    const idx = Number(card.dataset.pageIndex);
    const tag = card.querySelector('.status-tag');
    const badge = card.querySelector('.rot-badge');
    const committedDeleted = state.deletedPages.has(idx);
    const stagedDel = state.stagedDeleted.has(idx);

    card.classList.remove('committed-deleted', 'pending-remove', 'pending-keep');
    if (committedDeleted && stagedDel) {
      card.classList.add('committed-deleted');
      tag.textContent = 'REMOVED';
      tag.hidden = false;
    } else if (!committedDeleted && stagedDel) {
      card.classList.add('pending-remove');
      tag.textContent = 'PENDING REMOVE';
      tag.hidden = false;
    } else if (committedDeleted && !stagedDel) {
      card.classList.add('pending-keep');
      tag.textContent = 'PENDING KEEP';
      tag.hidden = false;
    } else {
      tag.hidden = true;
    }

    const committedAngle = state.rotations.get(idx) || 0;
    const pendingAngle = computePendingAngle(idx);
    if (pendingAngle !== committedAngle) {
      badge.textContent = `${pendingAngle}°`;
      badge.classList.add('pending');
      badge.style.display = 'block';
    } else if (committedAngle) {
      badge.textContent = `${committedAngle}°`;
      badge.classList.remove('pending');
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  });
}

// --- Tool selection & Apply ----------------------------------------------

function setActiveTool(tool) {
  state.activeTool = state.activeTool === tool ? null : tool;
  toolButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === state.activeTool));
  refreshAllCardVisuals();
  updateApplyHint();
}

function updateApplyHint() {
  const tool = state.activeTool;
  let hint = 'Select an action above, then press Apply.';
  let canApply = false;

  if (tool === 'remove') {
    const removing = state.stagedDeleted.size;
    hint = `Ready to remove ${removing} page(s) and keep ${state.numPages - removing}.`;
    canApply = true;
  } else if (tool === 'rotate-selected') {
    const count = state.selectedPages.size;
    hint = count
      ? `Ready to rotate ${count} selected page(s) by ${els.rotateAngle.value}°.`
      : 'Check at least one page to rotate, then press Apply.';
    canApply = count > 0;
  } else if (tool === 'rotate-all') {
    hint = `Ready to rotate all ${state.numPages} page(s) by ${els.rotateAngle.value}°.`;
    canApply = state.numPages > 0;
  } else if (tool === 'split') {
    const active = state.numPages - state.deletedPages.size;
    hint = `Ready to split ${active} active page(s) into separate PDFs.`;
    canApply = active > 0;
  } else if (tool === 'export') {
    const active = state.numPages - state.deletedPages.size;
    hint = `Ready to export a PDF with ${active} active page(s).`;
    canApply = active > 0;
  }

  els.applyHint.textContent = hint;
  els.btnApply.disabled = !canApply;
}

async function applyCurrentTool() {
  const tool = state.activeTool;
  if (!tool) {
    setStatus('Select an action first.', true);
    return;
  }
  setBusy(true);
  try {
    if (tool === 'remove') {
      state.deletedPages = new Set(state.stagedDeleted);
      updateDocInfo();
      refreshAllCardVisuals();
      await persistSession();
      setStatus(`Removed ${state.deletedPages.size} page(s).`);
    } else if (tool === 'rotate-selected') {
      commitRotation([...state.selectedPages], Number(els.rotateAngle.value));
      await persistSession();
      setStatus(`Rotated ${state.selectedPages.size} selected page(s).`);
    } else if (tool === 'rotate-all') {
      const all = Array.from({ length: state.numPages }, (_, i) => i);
      commitRotation(all, Number(els.rotateAngle.value));
      await persistSession();
      setStatus('Rotated all pages.');
    } else if (tool === 'split') {
      await splitDocument();
    } else if (tool === 'export') {
      await exportEditedPdf();
    }
  } catch (err) {
    console.error(err);
    setStatus(`Action failed: ${err.message}`, true);
  } finally {
    state.activeTool = null;
    toolButtons.forEach((btn) => btn.classList.remove('active'));
    refreshAllCardVisuals();
    updateApplyHint();
    setBusy(false);
  }
}

function commitRotation(indices, angle) {
  for (const idx of indices) {
    const current = state.rotations.get(idx) || 0;
    state.rotations.set(idx, (current + angle) % 360);
  }
  refreshAllCardVisuals();
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
  setStatus('Building edited PDF…');
  const pdfDoc = await buildEditedDocument();
  const indicesToRemove = [...state.deletedPages].sort((a, b) => b - a);
  if (indicesToRemove.length === pdfDoc.getPageCount()) {
    throw new Error('Cannot export: every page is marked for removal.');
  }
  for (const idx of indicesToRemove) pdfDoc.removePage(idx);
  const bytes = await pdfDoc.save();
  await downloadBytes(bytes, `${state.baseName}-edited.pdf`, 'application/pdf');
  setStatus(`Exported ${pdfDoc.getPageCount()} page(s) to ${state.baseName}-edited.pdf`);
}

async function splitDocument() {
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
}

// --- Reset -----------------------------------------------------------------

async function resetEverything() {
  if (state.pdfjsDoc) {
    state.pdfjsDoc.destroy();
    state.pdfjsDoc = null;
  }
  state.originalBytes = null;
  state.numPages = 0;
  state.baseName = 'document';
  state.deletedPages = new Set();
  state.stagedDeleted = new Set();
  state.selectedPages = new Set();
  state.rotations = new Map();
  state.activeTool = null;

  await clearSession();

  els.grid.innerHTML = '';
  els.emptyState.style.display = 'block';
  els.docInfo.style.display = 'none';
  els.toolSection.style.display = 'none';
  els.keepSection.style.display = 'none';
  els.actionRow.style.display = 'none';
  els.keepInput.value = '';
  els.fileInput.value = '';
  toolButtons.forEach((btn) => btn.classList.remove('active'));
  updateApplyHint();
  setStatus('Reset. Load a PDF to start again.');
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

toolButtons.forEach((btn) => btn.addEventListener('click', () => setActiveTool(btn.dataset.tool)));
els.rotateAngle.addEventListener('change', () => {
  refreshAllCardVisuals();
  updateApplyHint();
});
els.keepInput.addEventListener('input', applyKeepInputToStaged);

els.btnClearSelection.addEventListener('click', () => {
  state.selectedPages.clear();
  els.grid.querySelectorAll('.thumb-card.selected').forEach((card) => {
    card.classList.remove('selected');
    const checkbox = card.querySelector('input[type=checkbox]');
    if (checkbox) checkbox.checked = false;
  });
  refreshAllCardVisuals();
  updateApplyHint();
  setStatus('Selection cleared.');
});

els.btnApply.addEventListener('click', applyCurrentTool);
els.btnReset.addEventListener('click', resetEverything);

// --- Startup -----------------------------------------------------------

restoreSession();
