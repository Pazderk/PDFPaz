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
  formFieldsSection: document.getElementById('formFieldsSection'),
  formFieldsList: document.getElementById('formFieldsList'),
  addFieldSection: document.getElementById('addFieldSection'),
  flattenRow: document.getElementById('flattenRow'),
  flattenCheckbox: document.getElementById('flattenCheckbox'),
  fieldDesignerOverlay: document.getElementById('fieldDesignerOverlay'),
  designerPageLabel: document.getElementById('designerPageLabel'),
  designerCanvasWrap: document.getElementById('designerCanvasWrap'),
  designerCanvas: document.getElementById('designerCanvas'),
  designerBoxes: document.getElementById('designerBoxes'),
  designerForm: document.getElementById('designerForm'),
  designerFieldName: document.getElementById('designerFieldName'),
  designerFieldType: document.getElementById('designerFieldType'),
  designerFieldOptions: document.getElementById('designerFieldOptions'),
  designerAdd: document.getElementById('designerAdd'),
  designerCancel: document.getElementById('designerCancel'),
  designerClose: document.getElementById('designerClose'),
  summarizeRow: document.getElementById('summarizeRow'),
  btnSummarize: document.getElementById('btnSummarize'),
  summarySection: document.getElementById('summarySection'),
  summaryStatus: document.getElementById('summaryStatus'),
  summaryOutput: document.getElementById('summaryOutput'),
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
  activeTool: null,         // null | 'remove' | 'rotate-selected' | 'rotate-all' | 'fill-form' | 'add-field' | 'split' | 'export'
  hasAcroForm: false,       // whether the source PDF already has an AcroForm
  formFieldsMeta: [],       // detected existing fields: {name, type, pageIndex, rect, options, currentValue}
  formValues: new Map(),    // field name -> value (string | boolean), covers existing + newly added fields
  newFields: [],            // user-created fields: {id, pageIndex, type, name, rect:{x,y,width,height} in PDF pts, options}
  flattenForm: false,       // whether to flatten the form (bake values, remove interactivity) on export/split
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
      formValues: [...state.formValues.entries()],
      newFields: state.newFields,
      flattenForm: state.flattenForm,
    });
  } catch (err) {
    console.error('Failed to persist session', err);
  }
}

// --- Form field detection (pdf-lib) -----------------------------------

// field.constructor.name is unreliable once pdf-lib is minified (class names
// get mangled independently of the string labels used in its own assertion
// messages), so field types are identified via `instanceof` against the
// actual exported classes instead.
function classifyField(field) {
  if (field instanceof PDFLib.PDFTextField) return 'PDFTextField';
  if (field instanceof PDFLib.PDFCheckBox) return 'PDFCheckBox';
  if (field instanceof PDFLib.PDFRadioGroup) return 'PDFRadioGroup';
  if (field instanceof PDFLib.PDFDropdown) return 'PDFDropdown';
  if (field instanceof PDFLib.PDFOptionList) return 'PDFOptionList';
  if (field instanceof PDFLib.PDFButton) return 'PDFButton';
  if (field instanceof PDFLib.PDFSignature) return 'PDFSignature';
  return 'Unknown';
}

async function detectFormFields(bytes) {
  let pdfDoc;
  try {
    pdfDoc = await PDFLib.PDFDocument.load(bytes.slice(), { ignoreEncryption: true });
  } catch (err) {
    return { hasAcroForm: false, fields: [] };
  }
  let form;
  try {
    form = pdfDoc.getForm();
  } catch (err) {
    return { hasAcroForm: false, fields: [] };
  }
  const rawFields = form.getFields();
  if (!rawFields.length) return { hasAcroForm: false, fields: [] };

  const pages = pdfDoc.getPages();
  const fields = rawFields.map((field) => {
    const type = classifyField(field);
    let pageIndex = 0;
    let rect = null;
    try {
      const widget = field.acroField.getWidgets()[0];
      if (widget) {
        const pRef = widget.P();
        const idx = pRef ? pages.findIndex((p) => p.ref.tag === pRef.tag) : -1;
        if (idx >= 0) pageIndex = idx;
        const r = widget.getRectangle();
        rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    } catch (err) {
      // leave defaults; field will still be listed, just without a page overlay
    }

    let options = null;
    if (type === 'PDFRadioGroup' || type === 'PDFDropdown' || type === 'PDFOptionList') {
      try {
        options = field.getOptions();
      } catch (err) {
        options = [];
      }
    }

    let currentValue;
    try {
      if (type === 'PDFTextField') currentValue = field.getText() || '';
      else if (type === 'PDFCheckBox') currentValue = field.isChecked();
      else if (type === 'PDFDropdown' || type === 'PDFOptionList') {
        const sel = field.getSelected();
        currentValue = sel && sel.length ? sel[0] : '';
      } else if (type === 'PDFRadioGroup') {
        currentValue = field.getSelected() || '';
      }
    } catch (err) {
      // leave undefined
    }

    return { name: field.getName(), type, pageIndex, rect, options, currentValue };
  });

  return { hasAcroForm: true, fields };
}

async function applyFormDetection() {
  const detection = await detectFormFields(state.originalBytes);
  state.hasAcroForm = detection.hasAcroForm;
  state.formFieldsMeta = detection.fields;
  const values = new Map(detection.fields.map((f) => [f.name, f.currentValue]));
  return values;
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
    state.newFields = record.newFields || [];
    state.flattenForm = !!record.flattenForm;

    const loadingTask = pdfjsLib.getDocument({ data: state.originalBytes.slice() });
    state.pdfjsDoc = await loadingTask.promise;
    state.numPages = state.pdfjsDoc.numPages;

    state.formValues = await applyFormDetection();
    (record.formValues || []).forEach(([k, v]) => state.formValues.set(k, v));

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
    state.hasAcroForm = false;
    state.formFieldsMeta = [];
    state.formValues = new Map();
    state.newFields = [];
    state.flattenForm = false;

    if (state.pdfjsDoc) {
      state.pdfjsDoc.destroy();
      state.pdfjsDoc = null;
    }

    const loadingTask = pdfjsLib.getDocument({ data: state.originalBytes.slice() });
    state.pdfjsDoc = await loadingTask.promise;
    state.numPages = state.pdfjsDoc.numPages;

    state.formValues = await applyFormDetection();

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
  els.summarizeRow.style.display = 'block';
  els.flattenCheckbox.checked = state.flattenForm;
  updateDocInfo();
  updateFlattenRowVisibility();
}

function updateDocInfo() {
  const activeCount = state.numPages - state.deletedPages.size;
  let text =
    `${state.baseName}.pdf — ${state.numPages} page${state.numPages === 1 ? '' : 's'} total, ` +
    `${activeCount} currently active.`;
  const fillableCount = state.formFieldsMeta.filter(
    (f) => f.type !== 'PDFButton' && f.type !== 'PDFSignature'
  ).length;
  if (fillableCount) text += ` ${fillableCount} form field(s) detected.`;
  els.docInfo.textContent = text;
}

function updateFlattenRowVisibility() {
  els.flattenRow.style.display = state.hasAcroForm || state.newFields.length > 0 ? 'flex' : 'none';
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

    const fieldBadge = document.createElement('div');
    fieldBadge.className = 'field-badge';

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `Page ${pageNum}`;

    card.appendChild(checkLabel);
    card.appendChild(tag);
    card.appendChild(badge);
    card.appendChild(fieldBadge);
    card.appendChild(canvas);
    card.appendChild(label);

    card.addEventListener('click', () => {
      if (state.activeTool === 'add-field') {
        openFieldDesigner(pageIndex);
        return;
      }
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

    const fieldBadge = card.querySelector('.field-badge');
    const newFieldCount = state.newFields.filter((f) => f.pageIndex === idx).length;
    if (newFieldCount) {
      fieldBadge.textContent = `+${newFieldCount} field${newFieldCount === 1 ? '' : 's'}`;
      fieldBadge.style.display = 'block';
    } else {
      fieldBadge.style.display = 'none';
    }
  });
}

// --- Tool selection & Apply ----------------------------------------------

function setActiveTool(tool) {
  state.activeTool = state.activeTool === tool ? null : tool;
  toolButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === state.activeTool));
  els.formFieldsSection.style.display = state.activeTool === 'fill-form' ? 'block' : 'none';
  els.addFieldSection.style.display = state.activeTool === 'add-field' ? 'block' : 'none';
  if (state.activeTool === 'fill-form') renderFormFieldsPanel();
  refreshAllCardVisuals();
  updateApplyHint();
}

// --- Fill Form panel -------------------------------------------------------

const NEW_FIELD_TYPE_MAP = { text: 'PDFTextField', checkbox: 'PDFCheckBox', dropdown: 'PDFDropdown' };

function renderFormFieldsPanel() {
  const container = els.formFieldsList;
  container.innerHTML = '';
  const existing = state.formFieldsMeta.filter((f) => f.type !== 'PDFButton' && f.type !== 'PDFSignature');
  const created = state.newFields.map((f) => ({
    name: f.name,
    type: NEW_FIELD_TYPE_MAP[f.type] || 'PDFTextField',
    pageIndex: f.pageIndex,
    options: f.options,
  }));
  const fillable = [...existing, ...created];
  if (!fillable.length) {
    container.innerHTML = '<div class="hint-text">No fillable fields detected in this PDF. Use "Add Field" to create some.</div>';
    return;
  }
  const byPage = new Map();
  fillable.forEach((f) => {
    if (!byPage.has(f.pageIndex)) byPage.set(f.pageIndex, []);
    byPage.get(f.pageIndex).push(f);
  });
  [...byPage.keys()].sort((a, b) => a - b).forEach((pageIdx) => {
    const header = document.createElement('div');
    header.className = 'field-page-header';
    header.textContent = `Page ${pageIdx + 1}`;
    container.appendChild(header);
    byPage.get(pageIdx).forEach((f) => container.appendChild(buildFieldRow(f)));
  });
}

function buildFieldRow(f) {
  const row = document.createElement('div');
  row.className = 'field-row';
  const label = document.createElement('label');
  label.textContent = f.name;
  label.title = f.name;
  row.appendChild(label);

  const currentVal = state.formValues.get(f.name);
  let input;
  if (f.type === 'PDFCheckBox') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!currentVal;
    input.addEventListener('change', () => {
      state.formValues.set(f.name, input.checked);
    });
  } else if (f.type === 'PDFDropdown' || f.type === 'PDFRadioGroup' || f.type === 'PDFOptionList') {
    input = document.createElement('select');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '(none)';
    input.appendChild(blank);
    (f.options || []).forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (opt === currentVal) o.selected = true;
      input.appendChild(o);
    });
    input.addEventListener('change', () => {
      state.formValues.set(f.name, input.value);
    });
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = currentVal || '';
    input.addEventListener('input', () => {
      state.formValues.set(f.name, input.value);
    });
  }
  row.appendChild(input);
  return row;
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
  } else if (tool === 'fill-form') {
    hint = 'Edit values above, then press Apply to save them to this session.';
    canApply = true;
  } else if (tool === 'add-field') {
    hint = state.newFields.length
      ? `${state.newFields.length} new field(s) staged. Click a page to add more, then press Apply.`
      : 'Click a page thumbnail below to open the field designer.';
    canApply = true;
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
  updateFlattenRowVisibility();
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
    } else if (tool === 'fill-form') {
      await persistSession();
      setStatus('Form values saved.');
    } else if (tool === 'add-field') {
      await persistSession();
      setStatus(`Saved ${state.newFields.length} field definition(s).`);
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

  if (state.hasAcroForm || state.newFields.length) {
    const form = pdfDoc.getForm();

    for (const nf of state.newFields) {
      const page = pages[nf.pageIndex];
      if (!page) continue;
      const { x, y, width, height } = nf.rect;
      const val = state.formValues.get(nf.name);
      try {
        if (nf.type === 'checkbox') {
          const field = form.createCheckBox(nf.name);
          field.addToPage(page, { x, y, width, height, borderWidth: 1 });
          if (val) field.check();
        } else if (nf.type === 'dropdown') {
          const field = form.createDropdown(nf.name);
          field.addToPage(page, { x, y, width, height, borderWidth: 1 });
          field.setOptions(nf.options || []);
          if (val) field.select(val);
        } else {
          const field = form.createTextField(nf.name);
          field.addToPage(page, { x, y, width, height, borderWidth: 1 });
          if (val) field.setText(String(val));
        }
      } catch (err) {
        console.error(`Failed to create field "${nf.name}"`, err);
      }
    }

    for (const meta of state.formFieldsMeta) {
      if (meta.type === 'PDFButton' || meta.type === 'PDFSignature') continue;
      if (!state.formValues.has(meta.name)) continue;
      const val = state.formValues.get(meta.name);
      try {
        const field = form.getField(meta.name);
        if (meta.type === 'PDFTextField') field.setText(val ? String(val) : '');
        else if (meta.type === 'PDFCheckBox') { if (val) field.check(); else field.uncheck(); }
        else if (val) field.select(val);
      } catch (err) {
        console.error(`Failed to set field "${meta.name}"`, err);
      }
    }

    if (state.flattenForm) {
      try {
        form.flatten();
      } catch (err) {
        console.error('Failed to flatten form', err);
      }
    }
  }

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
  state.hasAcroForm = false;
  state.formFieldsMeta = [];
  state.formValues = new Map();
  state.newFields = [];
  state.flattenForm = false;

  await clearSession();

  els.grid.innerHTML = '';
  els.emptyState.style.display = 'block';
  els.docInfo.style.display = 'none';
  els.toolSection.style.display = 'none';
  els.keepSection.style.display = 'none';
  els.actionRow.style.display = 'none';
  els.formFieldsSection.style.display = 'none';
  els.addFieldSection.style.display = 'none';
  els.flattenRow.style.display = 'none';
  els.fieldDesignerOverlay.style.display = 'none';
  els.summarizeRow.style.display = 'none';
  els.summarySection.style.display = 'none';
  els.summaryOutput.textContent = '';
  els.summaryStatus.textContent = '';
  els.keepInput.value = '';
  els.fileInput.value = '';
  toolButtons.forEach((btn) => btn.classList.remove('active'));
  updateApplyHint();
  setStatus('Reset. Load a PDF to start again.');
}

// --- Field designer (Add Field tool) ---------------------------------------

let designerState = null; // { pageIndex, scale, pdfWidth, pdfHeight }
let dragRect = null;      // { x1, y1, x2, y2 } in canvas CSS pixels, while dragging
let pendingScreenRect = null;

async function openFieldDesigner(pageIndex) {
  designerState = null;
  els.designerPageLabel.textContent = `Page ${pageIndex + 1}`;
  els.designerForm.style.display = 'none';
  els.designerBoxes.innerHTML = '';
  els.fieldDesignerOverlay.style.display = 'flex';

  const page = await state.pdfjsDoc.getPage(pageIndex + 1);
  const baseViewport = page.getViewport({ scale: 1 });
  const wrapWidth = els.designerCanvasWrap.clientWidth || 260;
  const scale = Math.max(0.5, Math.min(3, (wrapWidth - 2) / baseViewport.width));
  const viewport = page.getViewport({ scale });

  const canvas = els.designerCanvas;
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  designerState = { pageIndex, scale, pdfWidth: baseViewport.width, pdfHeight: baseViewport.height };
  renderDesignerBoxes();
}

function renderDesignerBoxes() {
  els.designerBoxes.innerHTML = '';
  if (!designerState) return;
  const { pageIndex, scale, pdfHeight } = designerState;
  els.designerBoxes.style.width = `${els.designerCanvas.width}px`;
  els.designerBoxes.style.height = `${els.designerCanvas.height}px`;

  state.formFieldsMeta
    .filter((f) => f.pageIndex === pageIndex && f.rect)
    .forEach((f) => els.designerBoxes.appendChild(makeDesignerBox(f.rect, scale, pdfHeight, f.name, false)));

  state.newFields
    .filter((f) => f.pageIndex === pageIndex)
    .forEach((f) => els.designerBoxes.appendChild(makeDesignerBox(f.rect, scale, pdfHeight, f.name, true, f.id)));
}

function makeDesignerBox(rect, scale, pdfHeight, name, removable, id) {
  const box = document.createElement('div');
  box.className = 'designer-box' + (removable ? ' new' : ' existing');
  box.style.left = `${rect.x * scale}px`;
  box.style.top = `${(pdfHeight - rect.y - rect.height) * scale}px`;
  box.style.width = `${rect.width * scale}px`;
  box.style.height = `${rect.height * scale}px`;

  const tag = document.createElement('span');
  tag.className = 'designer-box-label';
  tag.textContent = name;
  box.appendChild(tag);

  if (removable) {
    const rm = document.createElement('button');
    rm.className = 'designer-box-remove';
    rm.textContent = '×';
    rm.title = 'Remove this field';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      state.newFields = state.newFields.filter((f) => f.id !== id);
      state.formValues.delete(name);
      renderDesignerBoxes();
      refreshAllCardVisuals();
      updateApplyHint();
    });
    box.appendChild(rm);
  }
  return box;
}

function updateDragPreview() {
  let el = document.getElementById('designerDragPreview');
  if (!el) {
    el = document.createElement('div');
    el.id = 'designerDragPreview';
    el.className = 'designer-drag-preview';
    els.designerBoxes.appendChild(el);
  }
  const left = Math.min(dragRect.x1, dragRect.x2);
  const top = Math.min(dragRect.y1, dragRect.y2);
  const width = Math.abs(dragRect.x2 - dragRect.x1);
  const height = Math.abs(dragRect.y2 - dragRect.y1);
  Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
}

function removeDragPreview() {
  const el = document.getElementById('designerDragPreview');
  if (el) el.remove();
}

els.designerCanvasWrap.addEventListener('pointerdown', (e) => {
  if (!designerState || e.target.closest('.designer-box')) return;
  const bounds = els.designerCanvas.getBoundingClientRect();
  const x = e.clientX - bounds.left;
  const y = e.clientY - bounds.top;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return;
  dragRect = { x1: x, y1: y, x2: x, y2: y };
  els.designerCanvasWrap.setPointerCapture(e.pointerId);
  updateDragPreview();
});
els.designerCanvasWrap.addEventListener('pointermove', (e) => {
  if (!dragRect) return;
  const bounds = els.designerCanvas.getBoundingClientRect();
  dragRect.x2 = Math.max(0, Math.min(bounds.width, e.clientX - bounds.left));
  dragRect.y2 = Math.max(0, Math.min(bounds.height, e.clientY - bounds.top));
  updateDragPreview();
});
els.designerCanvasWrap.addEventListener('pointerup', () => {
  if (!dragRect) return;
  const { x1, y1, x2, y2 } = dragRect;
  dragRect = null;
  removeDragPreview();
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (width < 6 || height < 6) return; // ignore accidental clicks/taps
  pendingScreenRect = { left, top, width, height };
  els.designerFieldName.value = '';
  els.designerFieldType.value = 'text';
  els.designerFieldOptions.style.display = 'none';
  els.designerFieldOptions.value = '';
  els.designerForm.style.display = 'flex';
  els.designerFieldName.focus();
});

els.designerFieldType.addEventListener('change', () => {
  els.designerFieldOptions.style.display = els.designerFieldType.value === 'dropdown' ? 'block' : 'none';
});

els.designerAdd.addEventListener('click', () => {
  const name = els.designerFieldName.value.trim();
  if (!name) {
    setStatus('Field name is required.', true);
    return;
  }
  const used = new Set([
    ...state.formFieldsMeta.map((f) => f.name),
    ...state.newFields.map((f) => f.name),
  ]);
  if (used.has(name)) {
    setStatus(`Field name "${name}" is already used.`, true);
    return;
  }
  const type = els.designerFieldType.value;
  let options = null;
  if (type === 'dropdown') {
    options = els.designerFieldOptions.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!options.length) {
      setStatus('Add at least one option for a dropdown field.', true);
      return;
    }
  }

  const { scale, pdfHeight } = designerState;
  const { left, top, width, height } = pendingScreenRect;
  const rect = {
    x: left / scale,
    y: pdfHeight - (top + height) / scale,
    width: width / scale,
    height: height / scale,
  };

  state.newFields.push({
    id: `f${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    pageIndex: designerState.pageIndex,
    type,
    name,
    rect,
    options,
  });
  state.formValues.set(name, type === 'checkbox' ? false : '');

  els.designerForm.style.display = 'none';
  renderDesignerBoxes();
  refreshAllCardVisuals();
  updateApplyHint();
  setStatus(`Added field "${name}".`);
});

els.designerCancel.addEventListener('click', () => {
  els.designerForm.style.display = 'none';
});
els.designerClose.addEventListener('click', () => {
  els.fieldDesignerOverlay.style.display = 'none';
  designerState = null;
});

els.flattenCheckbox.addEventListener('change', () => {
  state.flattenForm = els.flattenCheckbox.checked;
  persistSession();
});

// --- Chrome on-device AI summarize -----------------------------------------

async function extractActiveText() {
  let combined = '';
  for (let i = 0; i < state.numPages; i++) {
    if (state.deletedPages.has(i)) continue;
    const page = await state.pdfjsDoc.getPage(i + 1);
    const content = await page.getTextContent();
    combined += content.items.map((it) => it.str).join(' ') + '\n\n';
  }
  return combined;
}

async function summarizeDocument() {
  if (!state.pdfjsDoc) return;
  els.btnSummarize.disabled = true;
  els.summarySection.style.display = 'block';
  els.summaryOutput.textContent = '';
  els.summaryStatus.textContent = 'Checking availability…';
  try {
    if (typeof Summarizer === 'undefined') {
      els.summaryStatus.textContent =
        "Chrome's built-in Summarizer AI isn't available in this browser. It requires a recent Chrome (138+) with on-device AI.";
      return;
    }
    const availability = await Summarizer.availability();
    if (availability === 'unavailable') {
      els.summaryStatus.textContent = 'The on-device summarization model is unavailable on this device.';
      return;
    }

    els.summaryStatus.textContent = 'Extracting text…';
    const text = await extractActiveText();
    if (!text.trim()) {
      els.summaryStatus.textContent = 'No extractable text found (this may be a scanned/image PDF).';
      return;
    }

    els.summaryStatus.textContent = 'Preparing on-device model…';
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 60000);
    let summarizer;
    try {
      summarizer = await Summarizer.create({
        type: 'key-points',
        format: 'plain-text',
        length: 'medium',
        signal: abortController.signal,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            els.summaryStatus.textContent = `Downloading on-device model… ${Math.round(e.loaded * 100)}%`;
          });
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    els.summaryStatus.textContent = 'Summarizing…';
    const truncated = text.length > 20000 ? text.slice(0, 20000) : text;
    const summary = await summarizer.summarize(truncated, {
      context: `Text extracted from a PDF named ${state.baseName}.pdf.`,
      signal: abortController.signal,
    });
    summarizer.destroy();

    els.summaryOutput.textContent = summary;
    els.summaryStatus.textContent =
      truncated.length < text.length ? 'Summary (document truncated for length):' : 'Summary:';
  } catch (err) {
    console.error(err);
    if (err.name === 'AbortError') {
      els.summaryStatus.textContent =
        "Timed out waiting for Chrome's on-device model to become ready. It may still be downloading in the background — try again shortly.";
    } else {
      els.summaryStatus.textContent = `Summarization failed: ${err.message}`;
    }
  } finally {
    els.btnSummarize.disabled = false;
  }
}

els.btnSummarize.addEventListener('click', summarizeDocument);

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
