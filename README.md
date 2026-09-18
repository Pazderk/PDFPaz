# PDFPaz

Brog's PDF Editor — a 100% client-side Chrome side-panel extension for editing PDFs. Nothing ever leaves the browser: pdf.js handles rendering/reading and pdf-lib handles writing.

## Features

- Remove / keep pages, rotate (selected or all), split into single-page PDFs, export
- **Merge** — combine one or more additional PDFs with the current document (or start fresh from multiple files)
- **Reorder** — drag thumbnails to reorder pages; takes effect immediately
- **Insert Page** — add a blank page or an image (PNG/JPEG) as a new page, anchored before/after any page
- **Redact** — drag to black out a region; the page is rasterized on export so the underlying content is actually removed, not just covered
- **Annotate** — Highlight (drag a translucent colored box over text) and Note (click to place a small marker with a typed comment). Flattened as drawn graphics on export, like Redact — not interactive PDF annotation objects
- **Fill Form** — detects existing AcroForm fields (text, checkbox, dropdown, radio, option list) and lets you edit their values
- **Autofill with AI** — uses Chrome's on-device Prompt API and a locally-saved Autofill Profile (name, address, email, etc.) to guess field values, using nearby page text to make sense of cryptic field names. Optionally combine with a source document (a Recent File, a Template, or an upload) — its own filled fields and text are pulled into the same prompt, useful for facts specific to one document (a case number, an amount) that the profile alone wouldn't have. If the source document is scanned (no text layer), its first few pages are OCR'd automatically to recover that text. Everything stays editable before you press Apply, and nothing leaves your browser
- **Templates** — save a document (with any default field values already filled in) as a named, reusable template for PDFs you fill out repeatedly. "Use" always loads a fresh working copy; the template itself is untouched until you explicitly "Update" it
- **Add Field** — draw new text, checkbox, or dropdown fields directly on a page, even on a flat (non-fillable) PDF
- **Flatten** — bake filled values into the page content and remove interactivity on export
- **Watermark** — stamp text (e.g. "CONFIDENTIAL", "DRAFT") on all or selected pages, with configurable size, rotation, color, opacity, and optional tiling
- **Page Numbers** — stamp a template like "Page {page} of {pages}" in any corner/center, position-aware across reordering and insertions
- **Summarize with Chrome AI** — uses Chrome's built-in on-device Summarizer API (Chrome 138+) to summarize the extracted text, entirely locally. Optional focus note (e.g. "payment terms and deadlines") and a short/medium/long length control; output streams in progressively instead of appearing all at once
- **OCR for scanned PDFs** — if a document (or a page within it) has no extractable text layer, Summarize offers a "Run OCR" button that recognizes the text on-device using a fully bundled copy of Tesseract.js (English) — no download, nothing leaves the browser. Recognized text is cached in memory per page and reused for the rest of the session
- **Make Searchable** — embeds the OCR'd text as an invisible, selectable/searchable layer over each scanned page on export, so the exported PDF looks identical but its text can be selected, copied, and found with Ctrl+F. Pages that already have real text are left alone, and so is any page with a Redact box on it (never re-embedding content a redaction was meant to remove)
- **Recent Files** — the last 8 documents you had open are saved automatically and can be reopened from the panel
- Session persistence via IndexedDB, so edits survive closing the side panel

## Known limitations

- Reordering, inserting, or splitting a document with an *unflattened* form can break the live form fields in the output (a pdf-lib limitation when rebuilding page order) — flatten first if you need both.
- Redacting a page replaces its entire content with a flattened image, so any form fields or annotations on that page are removed along with it.
- Downloads under 100MB use a `data:` URL, which survives the side panel being closed mid-download. Above that, downloads use a `blob:` URL instead (to avoid the base64 string getting large enough to risk memory/size limits before the download even starts) — keep the panel open until the download starts for those.
- OCR is English-only. For a scanned Autofill source document, only the first 5 pages needing OCR are recognized (a bound on how long Autofill can take), and the resulting text is used for that run only — it isn't cached the way OCR on the working document is.
- Make Searchable's invisible text is positioned per word from OCR's bounding boxes but isn't horizontally scaled to match each word's exact pixel width, so selection highlighting can drift slightly on long words — the recognized text itself, and search/copy results, are unaffected. It also doesn't touch pages that already have a real text layer or pages with a Redact box, and it adds OCR time to export for documents with a lot of scanned pages.

