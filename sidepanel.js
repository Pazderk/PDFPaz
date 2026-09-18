// Brog's PDF Editor - all processing happens locally via pdf.js (rendering/reading) and
// pdf-lib (writing). No network requests are ever made. The loaded document
// and any applied edits are persisted to IndexedDB so they survive closing
// the side panel (or the whole browser) — only Reset clears them.

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.js');

const els = {
  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('fileInput'),
  mergeRow: document.getElementById('mergeRow'),
  btnMerge: document.getElementById('btnMerge'),
  mergeFileInput: document.getElementById('mergeFileInput'),
  btnEditProfile: document.getElementById('btnEditProfile'),
  profileOverlay: document.getElementById('profileOverlay'),
  profileFormFields: document.getElementById('profileFormFields'),
  profileNotes: document.getElementById('profileNotes'),
  profileSave: document.getElementById('profileSave'),
  profileClear: document.getElementById('profileClear'),
  profileClose: document.getElementById('profileClose'),
  btnAutofillAI: document.getElementById('btnAutofillAI'),
  recentSection: document.getElementById('recentSection'),
  recentList: document.getElementById('recentList'),
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
  designerHint: document.getElementById('designerHint'),
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
  summaryFocus: document.getElementById('summaryFocus'),
  summaryLength: document.getElementById('summaryLength'),
  btnSummarize: document.getElementById('btnSummarize'),
  summarySection: document.getElementById('summarySection'),
  summaryStatus: document.getElementById('summaryStatus'),
  summaryOutput: document.getElementById('summaryOutput'),
  watermarkSection: document.getElementById('watermarkSection'),
  watermarkText: document.getElementById('watermarkText'),
  watermarkSize: document.getElementById('watermarkSize'),
  watermarkRotation: document.getElementById('watermarkRotation'),
  watermarkColor: document.getElementById('watermarkColor'),
  watermarkOpacity: document.getElementById('watermarkOpacity'),
  watermarkOpacityLabel: document.getElementById('watermarkOpacityLabel'),
  watermarkTile: document.getElementById('watermarkTile'),
  watermarkScopeAll: document.getElementById('watermarkScopeAll'),
  watermarkScopeSelected: document.getElementById('watermarkScopeSelected'),
  redactSection: document.getElementById('redactSection'),
  insertPageSection: document.getElementById('insertPageSection'),
  insertTypeBlank: document.getElementById('insertTypeBlank'),
  insertTypeImage: document.getElementById('insertTypeImage'),
  insertImageRow: document.getElementById('insertImageRow'),
  insertImageFile: document.getElementById('insertImageFile'),
  insertPosition: document.getElementById('insertPosition'),
  btnInsertPage: document.getElementById('btnInsertPage'),
  pageNumberSection: document.getElementById('pageNumberSection'),
  pageNumberTemplate: document.getElementById('pageNumberTemplate'),
  pageNumberPosition: document.getElementById('pageNumberPosition'),
  pageNumberSize: document.getElementById('pageNumberSize'),
  pageNumberColor: document.getElementById('pageNumberColor'),
  pageNumberScopeAll: document.getElementById('pageNumberScopeAll'),
  pageNumberScopeSelected: document.getElementById('pageNumberScopeSelected'),
};
const toolButtons = Array.from(document.querySelectorAll('.tool-btn'));

const state = {
  originalBytes: null,   // Uint8Array of the untouched source file
  pdfjsDoc: null,        // pdf.js document proxy, used for rendering
  numPages: 0,
  baseName: 'document',
  deletedPages: new Set(),  // 0-based original indices committed for removal
  stagedDeleted: new Set(), // 0-based original indices currently marked in the UI, not yet applied
  selectedPages: new Set(), // 0-based original indices checked as a rotation/scope target
  rotations: new Map(),     // 0-based original index -> committed additional degrees (0/90/180/270)
  pageOrder: [],             // permutation of original 0-based indices, controls display/export order
  activeTool: null,          // null | 'remove' | 'rotate-selected' | 'rotate-all' | 'fill-form' | 'add-field'
                              // | 'watermark' | 'redact' | 'insert-page' | 'page-numbers' | 'split' | 'export'
  hasAcroForm: false,       // whether the source PDF already has an AcroForm
  formFieldsMeta: [],       // detected existing fields: {name, type, pageIndex, rect, options, currentValue}
  formValues: new Map(),    // field name -> value (string | boolean), covers existing + newly added fields
  newFields: [],            // user-created fields: {id, pageIndex, type, name, rect:{x,y,width,height} in PDF pts, options}
  flattenForm: false,       // whether to flatten the form (bake values, remove interactivity) on export/split
  watermark: null,          // null | {text, fontSize, rotation, color, opacity, tile, pageIndices:[...]}
  redactions: [],           // {id, pageIndex, rect:{x,y,width,height} in PDF pts}
  insertions: [],           // {id, anchor: 'start'|'end'|{after:idx}, type:'blank'|'image', width, height, imageBytes, imageFormat}
  pageNumbering: null,      // null | {template, position, fontSize, color, pageIndices:[...]}
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
// 'session' holds the single currently-open document (out-of-line key 'current').
// 'recent' holds a capped history of documents that were previously open,
// keyed by an in-line generated id, to support reopening them later.
// 'profile' holds a single record (key 'default') with the user's saved
// Autofill Profile — never transmitted anywhere, only read locally to build
// the on-device AI prompt for the Autofill tool.

const MAX_RECENT = 8;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pdfpaz-db', 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('session')) db.createObjectStore('session');
      if (!db.objectStoreNames.contains('recent')) db.createObjectStore('recent', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('profile')) db.createObjectStore('profile');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function profileSet(value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('profile', 'readwrite');
    tx.objectStore('profile').put(value, 'default');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function profileGet() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('profile', 'readonly');
    const req = tx.objectStore('profile').get('default');
    req.onsuccess = () => resolve(req.result || null);
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

async function recentPut(entry) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recent', 'readwrite');
    tx.objectStore('recent').put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function recentGetAll() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recent', 'readonly');
    const req = tx.objectStore('recent').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function recentDelete(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recent', 'readwrite');
    tx.objectStore('recent').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function buildSessionSnapshot() {
  return {
    baseName: state.baseName,
    bytes: state.originalBytes,
    deletedPages: [...state.deletedPages],
    rotations: [...state.rotations.entries()],
    formValues: [...state.formValues.entries()],
    newFields: state.newFields,
    flattenForm: state.flattenForm,
    watermark: state.watermark,
    pageOrder: state.pageOrder,
    insertions: state.insertions,
    redactions: state.redactions,
    pageNumbering: state.pageNumbering,
  };
}

async function persistSession() {
  try {
    await idbSet('current', buildSessionSnapshot());
  } catch (err) {
    console.error('Failed to persist session', err);
  }
}

async function clearSession() {
  try {
    await idbDelete('current');
  } catch (err) {
    console.error('Failed to clear saved session', err);
  }
}

async function saveCurrentToRecentIfAny() {
  if (!state.originalBytes) return;
  try {
    const entry = {
      id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      name: state.baseName,
      savedAt: Date.now(),
      numPages: state.numPages,
      snapshot: buildSessionSnapshot(),
    };
    await recentPut(entry);
    const all = await recentGetAll();
    if (all.length > MAX_RECENT) {
      all.sort((a, b) => a.savedAt - b.savedAt);
      const toRemove = all.slice(0, all.length - MAX_RECENT);
      for (const e of toRemove) await recentDelete(e.id);
    }
  } catch (err) {
    console.error('Failed to save to recent files', err);
  }
}

function formatRelativeTime(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function refreshRecentList() {
  let entries = [];
  try {
    entries = await recentGetAll();
  } catch (err) {
    console.error('Failed to list recent files', err);
  }
  entries.sort((a, b) => b.savedAt - a.savedAt);
  els.recentSection.style.display = entries.length ? 'block' : 'none';
  els.recentList.innerHTML = '';
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'recent-row';

    const info = document.createElement('div');
    info.className = 'recent-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'recent-name';
    nameEl.textContent = `${entry.name}.pdf`;
    const metaEl = document.createElement('div');
    metaEl.className = 'recent-meta';
    metaEl.textContent = `${entry.numPages} page(s) · ${formatRelativeTime(entry.savedAt)}`;
    info.appendChild(nameEl);
    info.appendChild(metaEl);

    const openBtn = document.createElement('button');
    openBtn.className = 'btn';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => openRecentSession(entry.id));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger';
    delBtn.textContent = '×';
    delBtn.title = 'Remove from recent files';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteRecentSession(entry.id);
    });

    row.appendChild(info);
    row.appendChild(openBtn);
    row.appendChild(delBtn);
    els.recentList.appendChild(row);
  });
}

async function deleteRecentSession(id) {
  try {
    await recentDelete(id);
    await refreshRecentList();
  } catch (err) {
    console.error('Failed to delete recent file', err);
  }
}

async function openRecentSession(id) {
  setBusy(true);
  setStatus('Opening…');
  try {
    const all = await recentGetAll();
    const entry = all.find((e) => e.id === id);
    if (!entry) {
      setStatus('That file is no longer available.', true);
      return;
    }
    await saveCurrentToRecentIfAny();
    await recentDelete(id); // it's becoming the current session now
    await applySnapshotToState(entry.snapshot);
    await renderThumbnails();
    showEditorUI();
    updateKeepInputFromStaged();
    await persistSession();
    setStatus(`Opened "${state.baseName}.pdf" — ${state.numPages} page(s).`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to open: ${err.message}`, true);
  } finally {
    setBusy(false);
    await refreshRecentList();
  }
}

// --- Autofill Profile --------------------------------------------------
// A small, locally-stored profile used only to build the prompt for the
// on-device "Autofill with AI" tool. Never transmitted anywhere.

const PROFILE_FIELDS = [
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'address', label: 'Street Address' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State / Province' },
  { key: 'zip', label: 'ZIP / Postal Code' },
  { key: 'country', label: 'Country' },
  { key: 'dob', label: 'Date of Birth' },
  { key: 'company', label: 'Company / Organization' },
  { key: 'jobTitle', label: 'Job Title' },
];

function renderProfileFormFields(profile) {
  els.profileFormFields.innerHTML = '';
  PROFILE_FIELDS.forEach((f) => {
    const wrap = document.createElement('div');
    wrap.className = 'profile-field';
    const label = document.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `profile_${f.key}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.id = `profile_${f.key}`;
    input.value = (profile && profile[f.key]) || '';
    wrap.appendChild(label);
    wrap.appendChild(input);
    els.profileFormFields.appendChild(wrap);
  });
  els.profileNotes.value = (profile && profile.notes) || '';
}

function readProfileFormFields() {
  const profile = {};
  PROFILE_FIELDS.forEach((f) => {
    const input = document.getElementById(`profile_${f.key}`);
    profile[f.key] = input ? input.value.trim() : '';
  });
  profile.notes = els.profileNotes.value.trim();
  return profile;
}

function hasAnyProfileValue(profile) {
  if (!profile) return false;
  return Object.values(profile).some((v) => v && String(v).trim());
}

async function openProfileOverlay() {
  let profile = null;
  try {
    profile = await profileGet();
  } catch (err) {
    console.error('Failed to load profile', err);
  }
  renderProfileFormFields(profile);
  els.profileOverlay.style.display = 'flex';
}

els.btnEditProfile.addEventListener('click', openProfileOverlay);
els.profileClose.addEventListener('click', () => {
  els.profileOverlay.style.display = 'none';
});
els.profileSave.addEventListener('click', async () => {
  const profile = readProfileFormFields();
  try {
    await profileSet(profile);
    setStatus('Autofill profile saved.');
    els.profileOverlay.style.display = 'none';
  } catch (err) {
    console.error(err);
    setStatus(`Failed to save profile: ${err.message}`, true);
  }
});
els.profileClear.addEventListener('click', async () => {
  try {
    await profileSet({});
    renderProfileFormFields({});
    setStatus('Autofill profile cleared.');
  } catch (err) {
    console.error(err);
    setStatus(`Failed to clear profile: ${err.message}`, true);
  }
});

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

// --- Session loading ---------------------------------------------------

async function applySnapshotToState(record) {
  state.originalBytes = record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes);
  state.baseName = record.baseName || 'document';
  state.deletedPages = new Set(record.deletedPages || []);
  state.rotations = new Map(record.rotations || []);
  state.stagedDeleted = new Set(state.deletedPages);
  state.selectedPages = new Set();
  state.activeTool = null;
  state.newFields = record.newFields || [];
  state.flattenForm = !!record.flattenForm;
  state.watermark = record.watermark || null;
  state.redactions = record.redactions || [];
  state.pageNumbering = record.pageNumbering || null;
  state.insertions = (record.insertions || []).map((ins) => ({
    ...ins,
    imageBytes: ins.imageBytes
      ? (ins.imageBytes instanceof Uint8Array ? ins.imageBytes : new Uint8Array(ins.imageBytes))
      : null,
  }));

  if (state.pdfjsDoc) {
    state.pdfjsDoc.destroy();
    state.pdfjsDoc = null;
  }
  const loadingTask = pdfjsLib.getDocument({ data: state.originalBytes.slice() });
  state.pdfjsDoc = await loadingTask.promise;
  state.numPages = state.pdfjsDoc.numPages;

  state.pageOrder = (record.pageOrder && record.pageOrder.length === state.numPages)
    ? record.pageOrder.slice()
    : Array.from({ length: state.numPages }, (_, i) => i);

  state.formValues = await applyFormDetection();
  (record.formValues || []).forEach(([k, v]) => state.formValues.set(k, v));
}

async function restoreSession() {
  let record;
  try {
    record = await idbGet('current');
  } catch (err) {
    console.error('Failed to read saved session', err);
    await refreshRecentList();
    return false;
  }
  if (!record || !record.bytes) {
    await refreshRecentList();
    return false;
  }

  setStatus('Restoring previous session…');
  try {
    await applySnapshotToState(record);
    await renderThumbnails();
    showEditorUI();
    updateKeepInputFromStaged();
    setStatus(`Restored "${state.baseName}.pdf" — ${state.numPages} page(s).`);
    await refreshRecentList();
    return true;
  } catch (err) {
    console.error('Failed to restore session', err);
    setStatus('Could not restore the previous session.', true);
    await refreshRecentList();
    return false;
  }
}

// --- Download helper -------------------------------------------------------
// Small files go through a data: URL, which has no dependency on this
// document staying alive — safe even if the side panel is closed mid-download.
// Above DATA_URL_SIZE_LIMIT that base64-encoded string gets big enough to risk
// hitting the renderer's own memory/string limits before the download even
// starts, so large files instead use a blob: URL, which stays valid only as
// long as this document is open. That's a real tradeoff (closing the panel
// mid-download can interrupt it), so callers should warn the user to keep the
// panel open until the download begins; see exportEditedPdf/splitDocument.
const DATA_URL_SIZE_LIMIT = 100 * 1024 * 1024; // 100MB

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
  if (bytes.length >= DATA_URL_SIZE_LIMIT) {
    return downloadViaBlobUrl(bytes, filename, mimeType);
  }
  const url = await bytesToDataURL(bytes, mimeType);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(downloadId);
    });
  });
}

function downloadViaBlobUrl(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        URL.revokeObjectURL(url);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      // Revoke once the download reaches a terminal state rather than
      // immediately — Chrome needs the blob: URL to stay valid while it
      // reads the file off it, which for a large file isn't instantaneous.
      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
          chrome.downloads.onChanged.removeListener(listener);
          URL.revokeObjectURL(url);
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      // Safety net in case onChanged never reports a terminal state.
      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        URL.revokeObjectURL(url);
      }, 5 * 60 * 1000);
      resolve(downloadId);
    });
  });
}

function sanitizeBaseName(name) {
  return name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_') || 'document';
}

// --- Page-range parsing (the "pages to keep" text field) -------------------
// Ranges always refer to ORIGINAL page numbers, independent of any reordering.

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
    await saveCurrentToRecentIfAny();
    await loadBytes(new Uint8Array(buffer), sanitizeBaseName(file.name));
    setStatus(`Loaded "${file.name}" — ${state.numPages} page${state.numPages === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load PDF: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function loadBytes(bytes, baseName) {
  state.originalBytes = bytes;
  state.baseName = baseName;
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
  state.watermark = null;
  state.redactions = [];
  state.insertions = [];
  state.pageNumbering = null;

  if (state.pdfjsDoc) {
    state.pdfjsDoc.destroy();
    state.pdfjsDoc = null;
  }

  const loadingTask = pdfjsLib.getDocument({ data: state.originalBytes.slice() });
  state.pdfjsDoc = await loadingTask.promise;
  state.numPages = state.pdfjsDoc.numPages;
  state.pageOrder = Array.from({ length: state.numPages }, (_, i) => i);

  state.formValues = await applyFormDetection();

  await renderThumbnails();
  showEditorUI();
  updateKeepInputFromStaged();
  await persistSession();
  await refreshRecentList();
}

function showEditorUI() {
  els.docInfo.style.display = 'block';
  els.toolSection.style.display = 'block';
  els.keepSection.style.display = 'block';
  els.actionRow.style.display = 'flex';
  els.summarizeRow.style.display = 'block';
  els.flattenCheckbox.checked = state.flattenForm;
  applyWatermarkStateToControls();
  applyPageNumberStateToControls();
  updateDocInfo();
  updateFlattenRowVisibility();
}

function applyWatermarkStateToControls() {
  const wm = state.watermark;
  els.watermarkText.value = wm ? wm.text : '';
  els.watermarkSize.value = wm ? wm.fontSize : 40;
  els.watermarkRotation.value = wm ? wm.rotation : -45;
  els.watermarkColor.value = wm ? wm.color : '#808080';
  const opacityPct = wm ? Math.round(wm.opacity * 100) : 30;
  els.watermarkOpacity.value = opacityPct;
  els.watermarkOpacityLabel.textContent = `${opacityPct}%`;
  els.watermarkTile.checked = wm ? !!wm.tile : false;
  els.watermarkScopeAll.checked = true;
  els.watermarkScopeSelected.checked = false;
}

function applyPageNumberStateToControls() {
  const pn = state.pageNumbering;
  els.pageNumberTemplate.value = pn ? pn.template : 'Page {page} of {pages}';
  els.pageNumberPosition.value = pn ? pn.position : 'bottom-center';
  els.pageNumberSize.value = pn ? pn.fontSize : 11;
  els.pageNumberColor.value = pn ? pn.color : '#000000';
  els.pageNumberScopeAll.checked = true;
  els.pageNumberScopeSelected.checked = false;
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
  if (state.insertions.length) text += ` +${state.insertions.length} inserted page(s).`;
  els.docInfo.textContent = text;
}

function updateFlattenRowVisibility() {
  els.flattenRow.style.display = state.hasAcroForm || state.newFields.length > 0 ? 'flex' : 'none';
}

// --- Thumbnail rendering -----------------------------------------------

let dragSourceIndex = null; // original page index currently being drag-reordered

async function renderThumbnails() {
  els.grid.innerHTML = '';
  els.emptyState.style.display = 'none';

  for (const ins of state.insertions.filter((i) => i.anchor === 'start')) {
    els.grid.appendChild(await buildInsertionCard(ins));
  }

  for (const pageIndex of state.pageOrder) {
    els.grid.appendChild(await buildPageCard(pageIndex));
    for (const ins of state.insertions.filter((i) => i.anchor && i.anchor.after === pageIndex)) {
      els.grid.appendChild(await buildInsertionCard(ins));
    }
  }

  for (const ins of state.insertions.filter((i) => i.anchor === 'end')) {
    els.grid.appendChild(await buildInsertionCard(ins));
  }

  refreshAllCardVisuals();
}

async function buildPageCard(pageIndex) {
  const pageNum = pageIndex + 1;
  const page = await state.pdfjsDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const thumbScale = 0.28;
  const viewport = page.getViewport({ scale: thumbScale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Bake staged redaction boxes directly into the thumbnail as visual feedback.
  const boxesForPage = state.redactions.filter((r) => r.pageIndex === pageIndex);
  if (boxesForPage.length) {
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    boxesForPage.forEach((r) => {
      const x = r.rect.x * thumbScale;
      const y = (baseViewport.height - r.rect.y - r.rect.height) * thumbScale;
      ctx.fillRect(x, y, r.rect.width * thumbScale, r.rect.height * thumbScale);
    });
  }

  const card = document.createElement('div');
  card.className = 'thumb-card';
  card.dataset.pageIndex = String(pageIndex);
  card.draggable = true;

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

  const wmBadge = document.createElement('div');
  wmBadge.className = 'wm-badge';
  wmBadge.textContent = 'WM';

  const label = document.createElement('div');
  label.className = 'page-label';
  label.textContent = `Page ${pageNum}`;

  card.appendChild(checkLabel);
  card.appendChild(tag);
  card.appendChild(badge);
  card.appendChild(fieldBadge);
  card.appendChild(wmBadge);
  card.appendChild(canvas);
  card.appendChild(label);

  card.addEventListener('click', () => {
    if (state.activeTool === 'add-field') {
      openPageDesigner(pageIndex, 'field');
      return;
    }
    if (state.activeTool === 'redact') {
      openPageDesigner(pageIndex, 'redact');
      return;
    }
    if (state.stagedDeleted.has(pageIndex)) state.stagedDeleted.delete(pageIndex);
    else state.stagedDeleted.add(pageIndex);
    refreshAllCardVisuals();
    updateKeepInputFromStaged();
    updateApplyHint();
  });

  wireDragEvents(card, pageIndex);

  return card;
}

async function buildInsertionCard(ins) {
  const card = document.createElement('div');
  card.className = 'thumb-card insertion';
  card.dataset.insertionId = ins.id;

  const scale = 0.28;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(ins.width * scale));
  canvas.height = Math.max(1, Math.round(ins.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (ins.type === 'image' && ins.imageBytes) {
    try {
      const bitmap = await createImageBitmap(new Blob([ins.imageBytes]));
      const s = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
      const w = bitmap.width * s;
      const h = bitmap.height * s;
      ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    } catch (err) {
      console.error('Failed to preview inserted image', err);
    }
  } else {
    ctx.strokeStyle = '#c9ccd1';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  }

  const rm = document.createElement('button');
  rm.className = 'designer-box-remove';
  rm.textContent = '×';
  rm.title = 'Remove this inserted page';
  rm.addEventListener('click', (e) => {
    e.stopPropagation();
    state.insertions = state.insertions.filter((i) => i.id !== ins.id);
    renderThumbnails();
    persistSession();
    setStatus('Inserted page removed.');
  });

  const label = document.createElement('div');
  label.className = 'page-label';
  label.textContent = ins.type === 'image' ? 'Image page' : 'Blank page';

  card.appendChild(rm);
  card.appendChild(canvas);
  card.appendChild(label);
  return card;
}

function wireDragEvents(card, pageIndex) {
  card.addEventListener('dragstart', (e) => {
    if (state.activeTool === 'add-field' || state.activeTool === 'redact' || e.target.closest('.select-check')) {
      e.preventDefault();
      return;
    }
    dragSourceIndex = pageIndex;
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    dragSourceIndex = null;
    els.grid.querySelectorAll('.drag-over').forEach((c) => c.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', (e) => {
    if (dragSourceIndex === null || dragSourceIndex === pageIndex) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (dragSourceIndex === null || dragSourceIndex === pageIndex) return;
    reorderPages(dragSourceIndex, pageIndex);
  });
}

function reorderPages(fromIdx, toIdx) {
  const order = state.pageOrder;
  const fromPos = order.indexOf(fromIdx);
  const toPos = order.indexOf(toIdx);
  if (fromPos === -1 || toPos === -1 || fromPos === toPos) return;
  order.splice(fromPos, 1);
  order.splice(toPos, 0, fromIdx);
  renderThumbnails();
  persistSession();
  setStatus('Pages reordered.');
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
  els.grid.querySelectorAll('.thumb-card[data-page-index]').forEach((card) => {
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

    const wmBadge = card.querySelector('.wm-badge');
    const watermarked = state.watermark && state.watermark.pageIndices.includes(idx);
    wmBadge.style.display = watermarked ? 'block' : 'none';
  });
}

// --- Tool selection & Apply ----------------------------------------------

function setActiveTool(tool) {
  state.activeTool = state.activeTool === tool ? null : tool;
  toolButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tool === state.activeTool));
  els.formFieldsSection.style.display = state.activeTool === 'fill-form' ? 'block' : 'none';
  els.addFieldSection.style.display = state.activeTool === 'add-field' ? 'block' : 'none';
  els.watermarkSection.style.display = state.activeTool === 'watermark' ? 'block' : 'none';
  els.redactSection.style.display = state.activeTool === 'redact' ? 'block' : 'none';
  els.insertPageSection.style.display = state.activeTool === 'insert-page' ? 'block' : 'none';
  els.pageNumberSection.style.display = state.activeTool === 'page-numbers' ? 'block' : 'none';
  if (state.activeTool === 'fill-form') renderFormFieldsPanel();
  if (state.activeTool === 'insert-page') populateInsertPositionOptions();
  refreshAllCardVisuals();
  updateApplyHint();
}

// --- Fill Form panel -------------------------------------------------------

const NEW_FIELD_TYPE_MAP = { text: 'PDFTextField', checkbox: 'PDFCheckBox', dropdown: 'PDFDropdown' };

// Field names most recently set by Autofill, purely so their rows get a
// visual "please review me" highlight until the user touches them.
let lastAutofilledNames = new Set();

// Merges detected AcroForm fields and user-created fields into one normalized
// shape ({name, type, pageIndex, rect, options}) used by the Fill Form panel
// and by Autofill's field-label matching.
function getAllFillableFieldDescriptors() {
  const existing = state.formFieldsMeta
    .filter((f) => f.type !== 'PDFButton' && f.type !== 'PDFSignature')
    .map((f) => ({ name: f.name, type: f.type, pageIndex: f.pageIndex, rect: f.rect, options: f.options }));
  const created = state.newFields.map((f) => ({
    name: f.name,
    type: NEW_FIELD_TYPE_MAP[f.type] || 'PDFTextField',
    pageIndex: f.pageIndex,
    rect: f.rect,
    options: f.options,
  }));
  return [...existing, ...created];
}

function renderFormFieldsPanel() {
  const container = els.formFieldsList;
  container.innerHTML = '';
  const fillable = getAllFillableFieldDescriptors();
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
  if (lastAutofilledNames.has(f.name)) row.classList.add('autofilled');
  const unmark = () => {
    lastAutofilledNames.delete(f.name);
    row.classList.remove('autofilled');
  };

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
      unmark();
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
      unmark();
    });
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = currentVal || '';
    input.addEventListener('input', () => {
      state.formValues.set(f.name, input.value);
      unmark();
    });
  }
  row.appendChild(input);
  return row;
}

// --- Autofill with AI --------------------------------------------------
// Uses Chrome's on-device Prompt API (LanguageModel) to map the saved
// Autofill Profile onto this document's fillable fields. Everything stays
// local — the model runs on-device and nothing is transmitted anywhere.

// Finds, for each field's rect, the nearest text on the same page that reads
// like a label — immediately to its left (e.g. "Name: ____"), or just above
// it (e.g. "Name" over a box) — to help the model make sense of cryptic
// internal field names like "Text1_2".
async function extractFieldLabelHints(fields) {
  const byPage = new Map();
  fields.forEach((f) => {
    if (!f.rect) return;
    if (!byPage.has(f.pageIndex)) byPage.set(f.pageIndex, []);
    byPage.get(f.pageIndex).push(f);
  });

  const hints = new Map();
  for (const [pageIndex, pageFields] of byPage) {
    let items = [];
    try {
      const page = await state.pdfjsDoc.getPage(pageIndex + 1);
      const content = await page.getTextContent();
      items = content.items
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({
          str: it.str.trim(),
          x: it.transform[4],
          y: it.transform[5],
          width: it.width,
          height: it.height || Math.abs(it.transform[3]) || 10,
        }));
    } catch (err) {
      items = [];
    }

    for (const f of pageFields) {
      const rect = f.rect;
      const fieldMidY = rect.y + rect.height / 2;
      let bestLeft = null;
      let bestLeftDist = Infinity;
      let bestAbove = null;
      let bestAboveDist = Infinity;
      for (const it of items) {
        const itemMidY = it.y + it.height / 2;
        const verticalOverlap = Math.abs(itemMidY - fieldMidY) < Math.max(rect.height, it.height) * 0.75 + 4;
        if (verticalOverlap) {
          const dist = rect.x - (it.x + it.width);
          if (dist > -4 && dist < 160 && dist < bestLeftDist) {
            bestLeft = it.str;
            bestLeftDist = dist;
          }
        }
        const isAboveRow = it.y >= rect.y + rect.height - 2 && Math.abs(it.x - rect.x) < 220;
        if (isAboveRow) {
          const dist = it.y - (rect.y + rect.height);
          if (dist >= -2 && dist < 40 && dist < bestAboveDist) {
            bestAbove = it.str;
            bestAboveDist = dist;
          }
        }
      }
      hints.set(f, bestLeft || bestAbove || null);
    }
  }
  return hints;
}

function buildAutofillPrompt(profile, fieldDescriptors) {
  const profileLines = PROFILE_FIELDS
    .map((f) => [f.label, profile[f.key]])
    .concat([['Notes', profile.notes]])
    .filter(([, v]) => v)
    .map(([label, v]) => `${label}: ${v}`)
    .join('\n');

  const fieldsJson = JSON.stringify(
    fieldDescriptors.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options })),
    null,
    2
  );

  return [
    "You are filling out a PDF form using the person's saved profile information below.",
    '',
    'PROFILE:',
    profileLines || '(no profile information provided)',
    '',
    'FORM FIELDS (JSON array; each has an id, a best-guess label taken from text near the field, a type, and options if it is a choice field):',
    fieldsJson,
    '',
    'For each field id, decide the best value from the profile. Rules:',
    '- If type is "checkbox", answer "true" or "false".',
    '- If type is "choice", answer with EXACTLY one of the listed options, verbatim, or "" if none fit.',
    '- If type is "text" and no profile value clearly matches, answer "" — never invent a value.',
    '- Combine first/last name if a field asks for a full name.',
    '',
    'Respond with a single JSON object mapping each field id to its string value, e.g. {"f0":"Jane","f1":""}.',
  ].join('\n');
}

function buildAutofillSchema(fieldDescriptors) {
  const properties = {};
  fieldDescriptors.forEach((f) => {
    properties[f.id] = { type: 'string' };
  });
  return {
    type: 'object',
    properties,
    required: fieldDescriptors.map((f) => f.id),
    additionalProperties: false,
  };
}

function parseAutofillResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err2) {
        // fall through to the throw below
      }
    }
    throw new Error('Could not parse the AI response as JSON.');
  }
}

async function autofillWithAI() {
  if (typeof LanguageModel === 'undefined') {
    setStatus(
      "Chrome's built-in AI isn't available in this browser. It requires a recent Chrome (138+) with on-device AI.",
      true
    );
    return;
  }

  const fields = getAllFillableFieldDescriptors();
  if (!fields.length) {
    setStatus('No fillable fields to autofill.', true);
    return;
  }

  let profile = null;
  try {
    profile = await profileGet();
  } catch (err) {
    console.error('Failed to load profile', err);
  }
  if (!hasAnyProfileValue(profile)) {
    setStatus('Set up your Autofill Profile first.', true);
    openProfileOverlay();
    return;
  }

  els.btnAutofillAI.disabled = true;
  setStatus('Checking availability…');
  let session;
  try {
    const availability = await LanguageModel.availability();
    if (availability === 'unavailable') {
      setStatus('The on-device AI model is unavailable on this device.', true);
      return;
    }

    setStatus('Reading field labels…');
    const hints = await extractFieldLabelHints(fields);
    const descriptors = fields.map((f, i) => ({
      id: `f${i}`,
      label: hints.get(f) || f.name,
      type: f.type === 'PDFCheckBox' ? 'checkbox' : f.options && f.options.length ? 'choice' : 'text',
      options: f.options && f.options.length ? f.options : undefined,
    }));

    setStatus('Preparing on-device model…');
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 60000);
    try {
      session = await LanguageModel.create({
        signal: abortController.signal,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            setStatus(`Downloading on-device model… ${Math.round(e.loaded * 100)}%`);
          });
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    setStatus('Matching fields to your profile…');
    const promptText = buildAutofillPrompt(profile, descriptors);
    const schema = buildAutofillSchema(descriptors);
    let raw;
    try {
      raw = await session.prompt(promptText, { responseConstraint: schema, signal: abortController.signal });
    } catch (err) {
      // responseConstraint may not be supported everywhere — retry plainly.
      raw = await session.prompt(`${promptText}\n\nRespond with ONLY the JSON object and no other text.`, {
        signal: abortController.signal,
      });
    }

    const mapping = parseAutofillResponse(raw);
    const filledNames = new Set();
    fields.forEach((f, i) => {
      const val = mapping[`f${i}`];
      if (val === undefined || val === null) return;
      const trimmed = String(val).trim();
      if (!trimmed) return;
      if (f.type === 'PDFCheckBox') {
        state.formValues.set(f.name, /^(true|yes|checked|1)$/i.test(trimmed));
        filledNames.add(f.name);
      } else if (f.options && f.options.length) {
        const match = f.options.find((o) => o.toLowerCase() === trimmed.toLowerCase());
        if (match) {
          state.formValues.set(f.name, match);
          filledNames.add(f.name);
        }
      } else {
        state.formValues.set(f.name, trimmed);
        filledNames.add(f.name);
      }
    });

    lastAutofilledNames = filledNames;
    if (state.activeTool === 'fill-form') renderFormFieldsPanel();
    setStatus(`AI filled ${filledNames.size} of ${fields.length} field(s) — review the values below, then press Apply.`);
  } catch (err) {
    console.error(err);
    if (err.name === 'AbortError') {
      setStatus(
        "Timed out waiting for Chrome's on-device model to become ready. It may still be downloading in the background — try again shortly.",
        true
      );
    } else {
      setStatus(`Autofill failed: ${err.message}`, true);
    }
  } finally {
    if (session) {
      try {
        session.destroy();
      } catch (err) {
        // ignore
      }
    }
    els.btnAutofillAI.disabled = false;
  }
}

els.btnAutofillAI.addEventListener('click', autofillWithAI);

// --- Insert Page panel -------------------------------------------------

function populateInsertPositionOptions() {
  const sel = els.insertPosition;
  const previous = sel.value;
  sel.innerHTML = '';
  const optStart = document.createElement('option');
  optStart.value = 'start';
  optStart.textContent = 'At the start';
  sel.appendChild(optStart);
  for (const idx of state.pageOrder) {
    const opt = document.createElement('option');
    opt.value = `after:${idx}`;
    opt.textContent = `After page ${idx + 1}`;
    sel.appendChild(opt);
  }
  const optEnd = document.createElement('option');
  optEnd.value = 'end';
  optEnd.textContent = 'At the end';
  sel.appendChild(optEnd);
  sel.value = [...sel.options].some((o) => o.value === previous) ? previous : 'end';
}

function parseInsertPosition(value) {
  if (value === 'start' || value === 'end') return value;
  const [, idxStr] = value.split(':');
  return { after: Number(idxStr) };
}

async function insertPage() {
  const type = els.insertTypeImage.checked ? 'image' : 'blank';
  const anchor = parseInsertPosition(els.insertPosition.value);

  let width = 612;
  let height = 792; // US Letter fallback
  const refIdx = anchor === 'start' ? state.pageOrder[0]
    : anchor === 'end' ? state.pageOrder[state.pageOrder.length - 1]
    : anchor.after;
  if (refIdx !== undefined && state.pdfjsDoc) {
    try {
      const p = await state.pdfjsDoc.getPage(refIdx + 1);
      const vp = p.getViewport({ scale: 1 });
      width = vp.width;
      height = vp.height;
    } catch (err) {
      // keep Letter fallback
    }
  }

  let imageBytes = null;
  let imageFormat = null;
  if (type === 'image') {
    const file = els.insertImageFile.files[0];
    if (!file) {
      setStatus('Choose an image file first.', true);
      return;
    }
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setStatus('Only PNG and JPEG images are supported.', true);
      return;
    }
    imageFormat = file.type === 'image/png' ? 'png' : 'jpg';
    imageBytes = new Uint8Array(await file.arrayBuffer());
  }

  state.insertions.push({
    id: `ins${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    anchor,
    type,
    width,
    height,
    imageBytes,
    imageFormat,
  });

  els.insertImageFile.value = '';
  await renderThumbnails();
  populateInsertPositionOptions();
  await persistSession();
  updateDocInfo();
  updateApplyHint();
  setStatus(type === 'blank' ? 'Blank page inserted.' : 'Image page inserted.');
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
  } else if (tool === 'watermark') {
    const text = els.watermarkText.value.trim();
    if (!text) {
      hint = state.watermark
        ? 'Text is empty — press Apply to remove the current watermark.'
        : 'Enter watermark text above, then press Apply.';
      canApply = !!state.watermark;
    } else {
      const scope = els.watermarkScopeSelected.checked ? `${state.selectedPages.size} selected page(s)` : 'all pages';
      hint = `Ready to stamp "${text}" on ${scope}.`;
      canApply = !els.watermarkScopeSelected.checked || state.selectedPages.size > 0;
    }
  } else if (tool === 'redact') {
    hint = state.redactions.length
      ? `${state.redactions.length} redaction box(es) staged. Click a page to add more, then press Apply.`
      : 'Click a page thumbnail below to open the redaction designer.';
    canApply = true;
  } else if (tool === 'insert-page') {
    hint = `${state.insertions.length} inserted page(s) so far. Configure above and press Insert to add one.`;
    canApply = true;
  } else if (tool === 'page-numbers') {
    const template = els.pageNumberTemplate.value.trim();
    if (!template) {
      hint = state.pageNumbering
        ? 'Template is empty — press Apply to remove page numbers.'
        : 'Enter a template above, then press Apply.';
      canApply = !!state.pageNumbering;
    } else {
      const scope = els.pageNumberScopeSelected.checked ? `${state.selectedPages.size} selected page(s)` : 'all pages';
      hint = `Ready to number ${scope} using "${template}".`;
      canApply = !els.pageNumberScopeSelected.checked || state.selectedPages.size > 0;
    }
  } else if (tool === 'split') {
    const active = activePageCount();
    hint = `Ready to split ${active} active page(s) into separate PDFs.`;
    canApply = active > 0;
  } else if (tool === 'export') {
    const active = activePageCount();
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
    } else if (tool === 'watermark') {
      const text = els.watermarkText.value.trim();
      if (!text) {
        state.watermark = null;
        await persistSession();
        setStatus('Watermark removed.');
      } else {
        const pageIndices = els.watermarkScopeSelected.checked
          ? [...state.selectedPages]
          : Array.from({ length: state.numPages }, (_, i) => i);
        state.watermark = {
          text,
          fontSize: Math.max(8, Math.min(120, Number(els.watermarkSize.value) || 40)),
          rotation: Math.max(-90, Math.min(90, Number(els.watermarkRotation.value) || 0)),
          color: els.watermarkColor.value,
          opacity: Math.max(0.05, Math.min(1, Number(els.watermarkOpacity.value) / 100)),
          tile: els.watermarkTile.checked,
          pageIndices,
        };
        await persistSession();
        setStatus(`Watermark "${text}" staged on ${pageIndices.length} page(s).`);
      }
      refreshAllCardVisuals();
    } else if (tool === 'redact') {
      await persistSession();
      setStatus(`Saved ${state.redactions.length} redaction box(es).`);
    } else if (tool === 'insert-page') {
      await persistSession();
      setStatus(`${state.insertions.length} inserted page(s) confirmed.`);
    } else if (tool === 'page-numbers') {
      const template = els.pageNumberTemplate.value.trim();
      if (!template) {
        state.pageNumbering = null;
        await persistSession();
        setStatus('Page numbers removed.');
      } else {
        const pageIndices = els.pageNumberScopeSelected.checked
          ? [...state.selectedPages]
          : Array.from({ length: state.numPages }, (_, i) => i);
        state.pageNumbering = {
          template,
          position: els.pageNumberPosition.value,
          fontSize: Math.max(6, Math.min(36, Number(els.pageNumberSize.value) || 11)),
          color: els.pageNumberColor.value,
          pageIndices,
        };
        await persistSession();
        setStatus(`Page numbers staged on ${pageIndices.length} page(s).`);
      }
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

// --- Page count / ordering helpers --------------------------------------

function activePageCount() {
  const activeOriginal = state.pageOrder.filter((idx) => !state.deletedPages.has(idx)).length;
  return activeOriginal + state.insertions.length;
}

// Maps each active original page index to its 1-based position in the final
// exported document, accounting for deletions and interleaved insertions.
function computeFinalPositionMap() {
  const map = new Map();
  let counter = state.insertions.filter((i) => i.anchor === 'start').length;
  for (const idx of state.pageOrder) {
    if (state.deletedPages.has(idx)) continue;
    counter += 1;
    map.set(idx, counter);
    counter += state.insertions.filter((i) => i.anchor && i.anchor.after === idx).length;
  }
  return map;
}

// --- pdf-lib helpers -----------------------------------------------------

function hexToRgb01(hex) {
  const clean = (hex || '#808080').replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return PDFLib.rgb(r || 0, g || 0, b || 0);
}

function drawWatermarkOnPage(page, font, wm, color) {
  const { width, height } = page.getSize();
  const drawOpts = {
    font,
    size: wm.fontSize,
    color,
    opacity: wm.opacity,
    rotate: PDFLib.degrees(wm.rotation),
  };
  const textWidth = font.widthOfTextAtSize(wm.text, wm.fontSize);
  if (!wm.tile) {
    page.drawText(wm.text, { ...drawOpts, x: (width - textWidth) / 2, y: height / 2 });
    return;
  }
  const stepX = textWidth + 80;
  const stepY = wm.fontSize + 80;
  // Overshoot the page bounds on every side since rotating each stamp expands
  // its effective footprint beyond the unrotated text box.
  for (let y = -height; y < height * 2; y += stepY) {
    for (let x = -width; x < width * 2; x += stepX) {
      page.drawText(wm.text, { ...drawOpts, x, y });
    }
  }
}

function drawPageNumberOnPage(page, font, pn, color, pageNum, totalPages) {
  const text = pn.template.replace(/\{page\}/g, String(pageNum)).replace(/\{pages\}/g, String(totalPages));
  if (!text) return;
  const { width, height } = page.getSize();
  const size = pn.fontSize;
  const textWidth = font.widthOfTextAtSize(text, size);
  const margin = 24;
  let x;
  if (pn.position.endsWith('left')) x = margin;
  else if (pn.position.endsWith('right')) x = width - textWidth - margin;
  else x = (width - textWidth) / 2;
  const y = pn.position.startsWith('top') ? height - margin : margin;
  page.drawText(text, { x, y, size, font, color });
}

async function rasterizePageWithRedactions(pageIndex, pdfHeight, rects) {
  const page = await state.pdfjsDoc.getPage(pageIndex + 1);
  const scale = 2; // decent resolution for the flattened raster replacing this page
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  ctx.fillStyle = '#000000';
  rects.forEach((r) => {
    const x = r.x * scale;
    const y = (pdfHeight - r.y - r.height) * scale;
    ctx.fillRect(x, y, r.width * scale, r.height * scale);
  });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

// Replaces each redacted page with a flattened raster image (boxes baked in),
// so the underlying text/vector content is actually gone, not just covered —
// any form fields or annotations on that page are removed along with it.
async function applyRedactionsToDoc(pdfDoc, pages) {
  const byPage = new Map();
  state.redactions.forEach((r) => {
    if (!byPage.has(r.pageIndex)) byPage.set(r.pageIndex, []);
    byPage.get(r.pageIndex).push(r.rect);
  });
  for (const [idx, rects] of byPage) {
    const oldPage = pages[idx];
    if (!oldPage) continue;
    const { width, height } = oldPage.getSize();
    const rotationAngle = oldPage.getRotation().angle;
    const pngBytes = await rasterizePageWithRedactions(idx, height, rects);
    const img = await pdfDoc.embedPng(pngBytes);
    pdfDoc.removePage(idx);
    const newPage = pdfDoc.insertPage(idx, [width, height]);
    newPage.setRotation(PDFLib.degrees(rotationAngle));
    newPage.drawImage(img, { x: 0, y: 0, width, height });
  }
}

async function buildEditedDocument() {
  const pdfDoc = await PDFLib.PDFDocument.load(state.originalBytes.slice());
  let pages = pdfDoc.getPages();
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

  if (state.redactions.length) {
    await applyRedactionsToDoc(pdfDoc, pages);
    pages = pdfDoc.getPages(); // redacted pages were replaced; refresh references
  }

  if (state.watermark && state.watermark.text && state.watermark.pageIndices.length) {
    try {
      const font = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);
      const color = hexToRgb01(state.watermark.color);
      for (const idx of state.watermark.pageIndices) {
        const page = pages[idx];
        if (page) drawWatermarkOnPage(page, font, state.watermark, color);
      }
    } catch (err) {
      console.error('Failed to draw watermark', err);
    }
  }

  if (state.pageNumbering && state.pageNumbering.template.trim() && state.pageNumbering.pageIndices.length) {
    try {
      const font = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
      const color = hexToRgb01(state.pageNumbering.color);
      const totalPages = activePageCount();
      const posMap = computeFinalPositionMap();
      for (const idx of state.pageNumbering.pageIndices) {
        if (state.deletedPages.has(idx)) continue;
        const page = pages[idx];
        const pageNum = posMap.get(idx);
        if (page && pageNum) drawPageNumberOnPage(page, font, state.pageNumbering, color, pageNum, totalPages);
      }
    } catch (err) {
      console.error('Failed to draw page numbers', err);
    }
  }

  return pdfDoc;
}

async function appendInsertionPage(doc, ins) {
  const page = doc.addPage([ins.width, ins.height]);
  if (ins.type === 'image' && ins.imageBytes) {
    const img = ins.imageFormat === 'jpg' ? await doc.embedJpg(ins.imageBytes) : await doc.embedPng(ins.imageBytes);
    const scale = Math.min(ins.width / img.width, ins.height / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x: (ins.width - w) / 2, y: (ins.height - h) / 2, width: w, height: h });
  }
}

// Builds the final page sequence: order + insertions + deletions, from a
// source document that already has rotations/forms/redactions/watermark/
// page-numbers baked in.
async function assembleFinalDocument(sourceDoc) {
  const finalDoc = await PDFLib.PDFDocument.create();

  for (const ins of state.insertions.filter((i) => i.anchor === 'start')) {
    await appendInsertionPage(finalDoc, ins);
  }

  for (const idx of state.pageOrder) {
    if (state.deletedPages.has(idx)) continue;
    const [copied] = await finalDoc.copyPages(sourceDoc, [idx]);
    finalDoc.addPage(copied);
    for (const ins of state.insertions.filter((i) => i.anchor && i.anchor.after === idx)) {
      await appendInsertionPage(finalDoc, ins);
    }
  }

  for (const ins of state.insertions.filter((i) => i.anchor === 'end')) {
    await appendInsertionPage(finalDoc, ins);
  }

  return finalDoc;
}

// Reordering/inserting pages requires rebuilding the document via copyPages
// into a fresh PDFDocument, which drops the root-level AcroForm structure for
// any unflattened form fields (copyPages only carries the page's own widget
// annotations, not the field dictionary linking them together) — a known
// pdf-lib limitation, not something we can avoid once a full reassembly is
// needed. When the page order is untouched and nothing was inserted, plain
// in-place page removal on the same document avoids that entirely, so forms
// export correctly for the common case.
function needsReassembly() {
  const isIdentityOrder = state.pageOrder.every((idx, i) => idx === i);
  return !isIdentityOrder || state.insertions.length > 0;
}

async function finalizeDocument(sourceDoc) {
  if (!needsReassembly()) {
    const indicesToRemove = [...state.deletedPages].sort((a, b) => b - a);
    for (const idx of indicesToRemove) sourceDoc.removePage(idx);
    return sourceDoc;
  }
  return assembleFinalDocument(sourceDoc);
}

async function exportEditedPdf() {
  if (activePageCount() === 0) {
    throw new Error('Cannot export: no active pages.');
  }
  setStatus('Building edited PDF…');
  const sourceDoc = await buildEditedDocument();
  const finalDoc = await finalizeDocument(sourceDoc);
  const bytes = await finalDoc.save();
  if (bytes.length >= DATA_URL_SIZE_LIMIT) {
    setStatus('Large file — keep this panel open until the download starts…');
  }
  await downloadBytes(bytes, `${state.baseName}-edited.pdf`, 'application/pdf');
  setStatus(`Exported ${finalDoc.getPageCount()} page(s) to ${state.baseName}-edited.pdf`);
}

async function splitDocument() {
  if (activePageCount() === 0) {
    throw new Error('Cannot split: no active pages.');
  }
  const sourceDoc = await buildEditedDocument();
  const finalDoc = await assembleFinalDocument(sourceDoc);
  const count = finalDoc.getPageCount();
  let done = 0;
  for (let i = 0; i < count; i++) {
    setStatus(`Splitting… (${done + 1}/${count})`);
    const newDoc = await PDFLib.PDFDocument.create();
    const [copied] = await newDoc.copyPages(finalDoc, [i]);
    newDoc.addPage(copied);
    const bytes = await newDoc.save();
    if (bytes.length >= DATA_URL_SIZE_LIMIT) {
      setStatus(`Splitting… (${done + 1}/${count}) — large page, keep this panel open until the download starts…`);
    }
    await downloadBytes(bytes, `${state.baseName}-page-${i + 1}.pdf`, 'application/pdf');
    done++;
  }
  setStatus(`Split complete: ${done} file(s) downloaded.`);
}

// --- Merge ---------------------------------------------------------------

async function mergeFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  setBusy(true);
  setStatus('Merging PDFs…');
  try {
    await saveCurrentToRecentIfAny();
    const mergedDoc = await PDFLib.PDFDocument.create();

    if (state.originalBytes) {
      const sourceDoc = await buildEditedDocument();
      const finalDoc = await assembleFinalDocument(sourceDoc);
      const indices = finalDoc.getPages().map((_, i) => i);
      if (indices.length) {
        const copied = await mergedDoc.copyPages(finalDoc, indices);
        copied.forEach((p) => mergedDoc.addPage(p));
      }
    }

    let skipped = 0;
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        skipped++;
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const indices = doc.getPages().map((_, i) => i);
      const copied = await mergedDoc.copyPages(doc, indices);
      copied.forEach((p) => mergedDoc.addPage(p));
    }

    if (mergedDoc.getPageCount() === 0) {
      setStatus('Nothing to merge — no valid PDF pages found.', true);
      return;
    }

    const mergedBytes = await mergedDoc.save();
    const mergedName = state.originalBytes
      ? `${state.baseName}-merged`
      : `${sanitizeBaseName(files[0].name)}${files.length > 1 ? '-merged' : ''}`;
    await loadBytes(mergedBytes, mergedName);
    setStatus(
      `Merged into a ${mergedDoc.getPageCount()}-page document.` +
        (skipped ? ` Skipped ${skipped} non-PDF file(s).` : '')
    );
  } catch (err) {
    console.error(err);
    setStatus(`Merge failed: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
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
  state.pageOrder = [];
  state.activeTool = null;
  state.hasAcroForm = false;
  state.formFieldsMeta = [];
  state.formValues = new Map();
  state.newFields = [];
  state.flattenForm = false;
  state.watermark = null;
  state.redactions = [];
  state.insertions = [];
  state.pageNumbering = null;

  await clearSession();

  els.grid.innerHTML = '';
  els.emptyState.style.display = 'block';
  els.docInfo.style.display = 'none';
  els.toolSection.style.display = 'none';
  els.keepSection.style.display = 'none';
  els.actionRow.style.display = 'none';
  els.formFieldsSection.style.display = 'none';
  els.addFieldSection.style.display = 'none';
  els.watermarkSection.style.display = 'none';
  els.redactSection.style.display = 'none';
  els.insertPageSection.style.display = 'none';
  els.pageNumberSection.style.display = 'none';
  els.flattenRow.style.display = 'none';
  els.fieldDesignerOverlay.style.display = 'none';
  els.summarizeRow.style.display = 'none';
  els.summarySection.style.display = 'none';
  els.summaryOutput.textContent = '';
  els.summaryStatus.textContent = '';
  els.keepInput.value = '';
  els.fileInput.value = '';
  els.mergeFileInput.value = '';
  toolButtons.forEach((btn) => btn.classList.remove('active'));
  updateApplyHint();
  setStatus('Reset. Load a PDF to start again.');
}

// --- Page designer (Add Field / Redact tools share this overlay) -----------

let designerMode = 'field'; // 'field' | 'redact'
let designerState = null;   // { pageIndex, scale, pdfWidth, pdfHeight }
let dragRect = null;        // { x1, y1, x2, y2 } in canvas CSS pixels, while dragging
let pendingScreenRect = null;

async function openPageDesigner(pageIndex, mode) {
  designerMode = mode;
  designerState = null;
  els.designerPageLabel.textContent = `Page ${pageIndex + 1}`;
  els.designerForm.style.display = 'none';
  els.designerBoxes.innerHTML = '';
  els.designerHint.textContent = mode === 'redact'
    ? "Drag on the page to black out a region. Click a box's × to remove it."
    : "Drag on the page to draw a new field. Amber boxes are existing fields; blue boxes are new ones you've staged.";
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

  if (designerMode === 'field') {
    state.formFieldsMeta
      .filter((f) => f.pageIndex === pageIndex && f.rect)
      .forEach((f) => els.designerBoxes.appendChild(makeDesignerBox(f.rect, scale, pdfHeight, f.name, false)));
    state.newFields
      .filter((f) => f.pageIndex === pageIndex)
      .forEach((f) => els.designerBoxes.appendChild(makeDesignerBox(f.rect, scale, pdfHeight, f.name, true, f.id)));
  } else if (designerMode === 'redact') {
    state.redactions
      .filter((r) => r.pageIndex === pageIndex)
      .forEach((r) => els.designerBoxes.appendChild(makeRedactBox(r.rect, scale, pdfHeight, r.id)));
  }
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

function makeRedactBox(rect, scale, pdfHeight, id) {
  const box = document.createElement('div');
  box.className = 'designer-box redact';
  box.style.left = `${rect.x * scale}px`;
  box.style.top = `${(pdfHeight - rect.y - rect.height) * scale}px`;
  box.style.width = `${rect.width * scale}px`;
  box.style.height = `${rect.height * scale}px`;

  const rm = document.createElement('button');
  rm.className = 'designer-box-remove';
  rm.textContent = '×';
  rm.title = 'Remove this redaction';
  rm.addEventListener('click', (e) => {
    e.stopPropagation();
    state.redactions = state.redactions.filter((r) => r.id !== id);
    renderDesignerBoxes();
    persistSession();
  });
  box.appendChild(rm);
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

  if (designerMode === 'redact') {
    const { scale, pdfHeight } = designerState;
    const rect = {
      x: left / scale,
      y: pdfHeight - (top + height) / scale,
      width: width / scale,
      height: height / scale,
    };
    state.redactions.push({
      id: `rx${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      pageIndex: designerState.pageIndex,
      rect,
    });
    renderDesignerBoxes();
    persistSession();
    setStatus('Redaction box added.');
    return;
  }

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
  const wasRedact = designerMode === 'redact';
  designerState = null;
  if (wasRedact) renderThumbnails();
});

els.watermarkOpacity.addEventListener('input', () => {
  els.watermarkOpacityLabel.textContent = `${els.watermarkOpacity.value}%`;
});
[els.watermarkText, els.watermarkScopeAll, els.watermarkScopeSelected].forEach((el) => {
  el.addEventListener('input', updateApplyHint);
  el.addEventListener('change', updateApplyHint);
});
[els.pageNumberTemplate, els.pageNumberScopeAll, els.pageNumberScopeSelected].forEach((el) => {
  el.addEventListener('input', updateApplyHint);
  el.addEventListener('change', updateApplyHint);
});

[els.insertTypeBlank, els.insertTypeImage].forEach((el) => {
  el.addEventListener('change', () => {
    els.insertImageRow.style.display = els.insertTypeImage.checked ? 'flex' : 'none';
  });
});
els.btnInsertPage.addEventListener('click', insertPage);

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

    const focus = els.summaryFocus.value.trim();
    let sharedContext = `Text extracted from a PDF named ${state.baseName}.pdf.`;
    if (focus) sharedContext += ` Focus the summary on: ${focus}.`;

    els.summaryStatus.textContent = 'Preparing on-device model…';
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 60000);
    let summarizer;
    try {
      summarizer = await Summarizer.create({
        type: 'key-points',
        format: 'plain-text',
        length: els.summaryLength.value,
        sharedContext,
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

    // Prefer the model's own token-based input quota over a blind character
    // cap, so long documents only get truncated as much as actually needed.
    let inputText = text;
    let wasTruncated = false;
    try {
      if (typeof summarizer.measureInputUsage === 'function' && typeof summarizer.inputQuota === 'number') {
        const usage = await summarizer.measureInputUsage(inputText);
        if (usage > summarizer.inputQuota) {
          const ratio = (summarizer.inputQuota / usage) * 0.9; // safety margin
          inputText = inputText.slice(0, Math.max(500, Math.floor(inputText.length * ratio)));
          wasTruncated = true;
        }
      } else if (inputText.length > 20000) {
        inputText = inputText.slice(0, 20000);
        wasTruncated = true;
      }
    } catch (err) {
      if (text.length > 20000) {
        inputText = text.slice(0, 20000);
        wasTruncated = true;
      }
    }

    els.summaryStatus.textContent = 'Summarizing…';
    let summary;
    if (typeof summarizer.summarizeStreaming === 'function') {
      // Streamed so the panel fills in progressively instead of sitting on
      // "Summarizing…" for the whole generation — chunks are incremental
      // pieces of text to append, not cumulative snapshots.
      const stream = summarizer.summarizeStreaming(inputText, { signal: abortController.signal });
      let acc = '';
      for await (const chunk of stream) {
        acc += chunk;
        els.summaryOutput.textContent = acc;
      }
      summary = acc;
    } else {
      summary = await summarizer.summarize(inputText, { signal: abortController.signal });
    }
    summarizer.destroy();

    els.summaryOutput.textContent = summary;
    els.summaryStatus.textContent = wasTruncated ? 'Summary (document truncated for length):' : 'Summary:';
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

els.btnMerge.addEventListener('click', () => els.mergeFileInput.click());
els.mergeFileInput.addEventListener('change', () => {
  mergeFiles(els.mergeFileInput.files);
  els.mergeFileInput.value = '';
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
