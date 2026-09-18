# PDFPaz

Brog's PDF Editor — a 100% client-side Chrome side-panel extension for editing PDFs. Nothing ever leaves the browser: pdf.js handles rendering/reading and pdf-lib handles writing.

## Features

- Remove / keep pages, rotate (selected or all), split into single-page PDFs, export
- **Merge** — combine one or more additional PDFs with the current document (or start fresh from multiple files)
- **Reorder** — drag thumbnails to reorder pages; takes effect immediately
- **Insert Page** — add a blank page or an image (PNG/JPEG) as a new page, anchored before/after any page
- **Redact** — drag to black out a region; the page is rasterized on export so the underlying content is actually removed, not just covered
- **Fill Form** — detects existing AcroForm fields (text, checkbox, dropdown, radio, option list) and lets you edit their values
- **Autofill with AI** — uses Chrome's on-device Prompt API and a locally-saved Autofill Profile (name, address, email, etc.) to guess field values, using nearby page text to make sense of cryptic field names. Everything stays editable before you press Apply, and the profile never leaves your browser
- **Add Field** — draw new text, checkbox, or dropdown fields directly on a page, even on a flat (non-fillable) PDF
- **Flatten** — bake filled values into the page content and remove interactivity on export
- **Watermark** — stamp text (e.g. "CONFIDENTIAL", "DRAFT") on all or selected pages, with configurable size, rotation, color, opacity, and optional tiling
- **Page Numbers** — stamp a template like "Page {page} of {pages}" in any corner/center, position-aware across reordering and insertions
- **Summarize with Chrome AI** — uses Chrome's built-in on-device Summarizer API (Chrome 138+) to summarize the extracted text, entirely locally. Optional focus note (e.g. "payment terms and deadlines") and a short/medium/long length control; output streams in progressively instead of appearing all at once
- **Recent Files** — the last 8 documents you had open are saved automatically and can be reopened from the panel
- Session persistence via IndexedDB, so edits survive closing the side panel

## Known limitations

- Reordering, inserting, or splitting a document with an *unflattened* form can break the live form fields in the output (a pdf-lib limitation when rebuilding page order) — flatten first if you need both.
- Redacting a page replaces its entire content with a flattened image, so any form fields or annotations on that page are removed along with it.
- Downloads under 100MB use a `data:` URL, which survives the side panel being closed mid-download. Above that, downloads use a `blob:` URL instead (to avoid the base64 string getting large enough to risk memory/size limits before the download even starts) — keep the panel open until the download starts for those.

