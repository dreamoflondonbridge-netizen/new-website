import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const file of ['index.html', 'app.js', 'style.css']) copyFileSync(file, `dist/${file}`);
