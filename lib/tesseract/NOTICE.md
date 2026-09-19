# Third-party notice: Tesseract.js (OCR)

This directory vendors a minimal, offline build of Tesseract.js so OCR works
with zero network requests, matching the rest of this extension.

- `tesseract.min.js`, `worker.min.js` — [tesseract.js](https://github.com/naptha/tesseract.js) v7.0.0, Apache License 2.0
- `tesseract-core-simd-lstm.js`, `tesseract-core-simd-lstm.wasm` — [tesseract.js-core](https://github.com/naptha/tesseract.js-core) v6.1.2, Apache License 2.0 (SIMD+LSTM-only build; smallest core variant that still supports the recognition mode this extension uses)
- `lang/eng.traineddata.gz` — [@tesseract.js-data/eng](https://github.com/naptha/tessdata) v1.0.0, MIT License (`4.0.0_best_int` quantized English trained data)

Full license text: https://www.apache.org/licenses/LICENSE-2.0

No files here were modified from their published npm package contents beyond
being copied out of the package directory structure.
