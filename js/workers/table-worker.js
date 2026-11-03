// Background worker: rebuilds the tables of ONE page per message,
// so the page stays responsive and memory use stays small.
import { processPage } from '../modules/doc-processor.js';

self.onmessage = (e) => {
  const { id, page, opts, running } = e.data;
  try {
    self.postMessage({ id, ok: true, result: processPage(page, opts, running) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
