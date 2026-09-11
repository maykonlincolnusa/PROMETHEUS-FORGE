const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const files = ['server.js', 'database.js', 'playwright.config.js'];
for (const directory of ['public', 'lib', 'scripts', 'tests']) {
  files.push(...fs.readdirSync(directory).filter(file => file.endsWith('.js')).map(file => path.join(directory, file)));
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

const templates = ['foundation', 'runtime'];
for (const name of templates) JSON.parse(fs.readFileSync(path.join('infra', 'aws', `${name}.json`), 'utf8'));
JSON.parse(fs.readFileSync(path.join('data', 'assets.json'), 'utf8'));

console.log(`Syntax verified: ${files.length} JavaScript files, ${templates.length} CloudFormation documents and the asset inventory.`);
