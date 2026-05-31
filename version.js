'use strict';

const name = 'Sonobook Player';
const version = '0.2';

function toPackageVersion(value) {
  const parts = String(value).split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

module.exports = {
  name,
  version,
  packageVersion: toPackageVersion(version),
  tagName: `v${version}`,
  title: `${name} v${version}`
};
