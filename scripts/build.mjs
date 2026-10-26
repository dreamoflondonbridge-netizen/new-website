import { mkdirSync, copyFileSync, cpSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const file of ['index.html', 'app.js', 'static-api.js', 'style.css', 'seed.json']) copyFileSync(file, `dist/${file}`);
cpSync('assets', 'dist/assets', { recursive: true });
