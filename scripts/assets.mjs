import { mkdir, cp } from 'node:fs/promises';
await mkdir('dist/presentation', {recursive:true});
await cp('src/presentation/index.html', 'dist/presentation/index.html');
await cp('src/presentation/style.css', 'dist/presentation/style.css');
await cp('src/integrations/remote_scan.py', 'dist/integrations/remote_scan.py');
await mkdir('extension/out', {recursive:true});
await cp('dist/extension/extension.js', 'extension/out/extension.js');
await mkdir('release', {recursive:true});
