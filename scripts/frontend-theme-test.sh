#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node - "$ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'tokens.json'), 'utf8'));
const variables = fs.readFileSync(path.join(root, 'variables.css'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'theme.css'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

const requiredTokens = [
  ['color', 'canvas-white'],
  ['color', 'cloud-gray'],
  ['color', 'stone-gray'],
  ['color', 'iron-gray'],
  ['color', 'ash-gray'],
  ['color', 'privacy-violet'],
  ['color', 'action-violet'],
  ['color', 'lavender-glow'],
  ['font', 'protonserif'],
  ['font', 'protonsans'],
  ['spacing', '20'],
  ['radius', '3xl'],
  ['radius', 'full'],
];

for (const [group, name] of requiredTokens) {
  if (!tokens[group]?.[name]?.$value) {
    throw new Error(`missing token ${group}.${name}`);
  }
}

const requiredDefinitions = [
  '--color-canvas-white',
  '--color-cloud-gray',
  '--color-stone-gray',
  '--color-iron-gray',
  '--color-ash-gray',
  '--color-privacy-violet',
  '--color-action-violet',
  '--color-lavender-glow',
  '--font-protonserif',
  '--font-protonsans',
  '--spacing-20',
  '--radius-cards',
  '--radius-buttons',
];

for (const variable of requiredDefinitions) {
  if (!variables.includes(variable)) {
    throw new Error(`variables.css does not define ${variable}`);
  }
}

const requiredStyleUses = [
  '--surface-canvas-white',
  '--surface-cloud-gray',
  '--gradient-cloud-gray',
  '--color-privacy-violet',
  '--color-action-violet',
  '--color-iron-gray',
  '--font-protonserif',
  '--font-protonsans',
  '--spacing-20',
  '--radius-cards',
  '--radius-buttons',
];

for (const variable of requiredStyleUses) {
  if (!styles.includes(`var(${variable}`) && !styles.includes(`var(${variable})`)) {
    throw new Error(`public/styles.css does not consume ${variable}`);
  }
}

for (const artifact of ['/variables.css', '/theme.css', '/tokens.json']) {
  if (!server.includes(artifact)) {
    throw new Error(`server does not expose ${artifact}`);
  }
}

if (!html.includes('href="/variables.css"') || !html.includes('href="/styles.css"')) {
  throw new Error('index.html must load variables.css before styles.css');
}
if (!theme.includes('@theme') || !theme.includes('--color-action-violet')) {
  throw new Error('theme.css no longer exposes the expected theme block');
}
if (!dockerfile.includes('theme.css variables.css tokens.json')) {
  throw new Error('Dockerfile must package design-system artifacts');
}
NODE

echo "frontend theme test passed"
