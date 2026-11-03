// Background worker: rebuilds tables so the page stays responsive.
import { processDocument } from '../modules/doc-processor.js';

self.onmessage = (e) => {
  const { id, pages, opts } = e.data;
  try {
    const result = processDocument(pages, opts);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
