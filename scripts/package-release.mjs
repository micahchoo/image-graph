import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {checkRelease, sha256} from './check-release.mjs';

// Stage exactly the three installable files. The workflow uploads them by name,
// so nothing else in this folder can reach the public release.
const {manifest, files} = await checkRelease(process.env.RELEASE_TAG);
await rm('release', {recursive: true, force: true});
await mkdir('release');

const assets = ['main.js', 'manifest.json', 'styles.css'];
for (const name of assets) await writeFile(`release/${name}`, files.get(name));

const checksums = await Promise.all(assets.map(async name => `${sha256(await readFile(`release/${name}`))}  ${name}`));
await writeFile('release/SHA256SUMS', `${checksums.join('\n')}\n`);

console.log(`Staged ${manifest.id} ${manifest.version}: ${assets.join(', ')}`);
