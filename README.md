# PDFPaz

Brog's PDF Editor — a 100% client-side Chrome side-panel extension for editing PDFs. Nothing ever leaves the browser: pdf.js handles rendering/reading and pdf-lib handles writing.

## Features

- Remove / keep pages, rotate (selected or all), split into single-page PDFs, export
- **Fill Form** — detects existing AcroForm fields (text, checkbox, dropdown, radio, option list) and lets you edit their values
- **Add Field** — draw new text, checkbox, or dropdown fields directly on a page, even on a flat (non-fillable) PDF
- **Flatten** — bake filled values into the page content and remove interactivity on export
- **Summarize with Chrome AI** — uses Chrome's built-in on-device Summarizer API (Chrome 138+) to summarize the extracted text, entirely locally
- Session persistence via IndexedDB, so edits survive closing the side panel

