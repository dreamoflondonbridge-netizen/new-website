import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const file of ['index.html', 'app.js', 'static-api.js', 'style.css', 'seed.json']) copyFileSync(file, `dist/${file}`);
