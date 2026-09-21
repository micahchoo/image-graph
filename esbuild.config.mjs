import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/main.ts'],bundle:true,external:['obsidian'],format:'cjs',platform:'browser',target:'es2022',outfile:'dist/main.js',sourcemap:false});
await copyFile('manifest.json','dist/manifest.json');
await copyFile('styles.css','dist/styles.css');
