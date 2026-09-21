import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Obsidian installs exactly these from a release, by name.
const RELEASE_ASSETS = ['main.js', 'manifest.json', 'styles.css'];

export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function checkVersions(manifest, pkg, lock, versions, tag) {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('Version must be bare semver.');
  if (pkg.version !== manifest.version || lock.version !== manifest.version || lock.packages?.['']?.version !== manifest.version) {
    throw Error('Package, lockfile, and manifest versions disagree.');
  }
  if (versions[manifest.version] !== manifest.minAppVersion) throw Error('versions.json does not match minAppVersion.');
  if (tag && tag !== manifest.version) throw Error('Release tag does not match manifest.version.');
  for (const field of ['id', 'name', 'author', 'minAppVersion']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) throw Error(`Manifest field is required: ${field}`);
  }
}

/** Community directory naming and description rules, checked before submission. */
export function checkListing(manifest) {
  const {id, name, description} = manifest;
  if (!/^[a-z0-9-]+$/.test(id)) throw Error('Plugin id must be lowercase letters, digits, and hyphens.');
  if (id.includes('obsidian')) throw Error('Plugin id must not contain "obsidian".');
  if (/-?plugin$/.test(id)) throw Error('Plugin id must not end with "plugin".');
  if (/obsidian/i.test(name)) throw Error('Plugin name must not contain "Obsidian".');
  if (/\bplugin$/i.test(name)) throw Error('Plugin name must not end with "Plugin".');
  if (typeof description !== 'string' || !description.trim()) throw Error('Manifest field is required: description');
  if (description.length > 250) throw Error('Description must be 250 characters or fewer.');
  if (!description.endsWith('.')) throw Error('Description must end with a period.');
  if (/^(this is a plugin|this plugin|a plugin)/i.test(description)) throw Error('Description must open with an action verb.');
  if (/\p{Extended_Pictographic}/u.test(description)) throw Error('Description must not contain emoji.');
}

export function checkAssetMap(files) {
  for (const name of RELEASE_ASSETS) if (!files.get(name)?.length) throw Error(`Missing release asset: ${name}`);
  for (const name of files.keys()) if (!RELEASE_ASSETS.includes(name)) throw Error(`Unexpected release asset: ${name}`);
}

export async function readTree(directory, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.isSymbolicLink()) throw Error(`Symlink in release: ${prefix}${entry.name}`);
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      for (const [name, data] of await readTree(`${directory}/${entry.name}`, `${relative}/`)) files.set(name, data);
    } else files.set(relative, await readFile(`${directory}/${entry.name}`));
  }
  return files;
}

export async function checkRelease(tag) {
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const manifest = await json('manifest.json');
  checkVersions(manifest, await json('package.json'), await json('package-lock.json'), await json('versions.json'), tag);
  checkListing(manifest);
  const files = await readTree('dist');
  checkAssetMap(files);
  // The build copies these two, so a stale dist is a mismatch rather than a rebuild.
  for (const name of ['manifest.json', 'styles.css']) {
    if (!files.get(name).equals(await readFile(name))) throw Error(`Built ${name} differs from source. Rebuild.`);
  }
  console.log(`Release checked: ${manifest.id} ${manifest.version}, ${files.size} assets.`);
  return {manifest, files};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkRelease(process.argv[2]);
