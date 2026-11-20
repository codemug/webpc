// Shared Playwright helper: catalog-aware skips for app-specific browser tests. With an app
// set to enabled: false in catalog.yaml, its tests skip (not fail) on a production build.
import { loadCatalog, isEnabled } from '../../scripts/catalog/catalog.mjs';
const catalog = loadCatalog();
export const enabledApp = id => isEnabled(catalog, id);
export const skipUnlessEnabled = (test, id) => test.skip(!enabledApp(id), `${id} is disabled in catalog.yaml`);
