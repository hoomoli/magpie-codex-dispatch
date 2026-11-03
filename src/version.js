import metadata from '../package.json' with { type: 'json' };

// Capture once at module load: reading disk per request could misidentify an old host.
export const pluginName = metadata.name;
export const pluginVersion = metadata.version;
export const loadedAt = new Date().toISOString();
