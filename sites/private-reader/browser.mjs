import {
  createReaderController,
  createReaderRequest,
} from './reader-model.mjs';
import { mountReader } from './view.mjs';

let view;
const controller = createReaderController({
  request: createReaderRequest(),
  onState: (state) => view?.render(state),
});
view = mountReader({
  document,
  root: document.getElementById('reader-root'),
  controller,
  saveDownload({ blob, filename }) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
});
controller.loadAuthors();
window.addEventListener('pagehide', () => controller.dispose(), { once: true });
