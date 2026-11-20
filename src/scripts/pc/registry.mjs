// The desktop's app list, generated from catalog.yaml by `npm run catalog` (enabled apps only,
// in catalog order). Edit catalog.yaml, not the generated JSON. External tools announce their
// new-tab behavior in their title and description.
import apps from './registry.generated.json' with { type: 'json' };
export { apps };
export const categories = [...new Set(apps.map(app => app.category))];
