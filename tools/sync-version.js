'use strict';

const fs = require('fs');
const path = require('path');
const versionInfo = require('../version');

const ROOT = path.join(__dirname, '..');

function replaceVersionFields(text, count) {
  let seen = 0;
  return text.replace(/("version":\s*")[^"]+(")/g, (match, prefix, suffix) => {
    seen += 1;
    return seen <= count ? `${prefix}${versionInfo.packageVersion}${suffix}` : match;
  });
}

function syncFile(file, versionFieldCount) {
  const fullPath = path.join(ROOT, file);
  const original = fs.readFileSync(fullPath, 'utf8');
  const updated = replaceVersionFields(original, versionFieldCount);
  if (updated !== original) {
    fs.writeFileSync(fullPath, updated);
  }
}

syncFile('package.json', 1);
syncFile('package-lock.json', 2);
console.log(`synced package metadata to ${versionInfo.packageVersion} (${versionInfo.tagName})`);
