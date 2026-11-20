// The desktop's app list, generated from catalog.yaml by `npm run catalog` (enabled apps only,
// in catalog order). Edit catalog.yaml, not the generated JSON. External tools announce their
// new-tab behavior in their title and description.
import entries from './registry.generated.json' with { type: 'json' };
// The kind: panel entry (Buddy) opens from the taskbar into the side panel; it is not a desktop app.
export const apps = entries.filter(app => app.kind !== 'panel');
export const buddy = entries.find(app => app.kind === 'panel') ?? null;
export const categories = [...new Set(apps.map(app => app.category))];
