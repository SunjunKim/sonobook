'use strict';

const { spawnSync } = require('child_process');
const versionInfo = require('../version');

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit'
  });
  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status || 1);
  }
  return result;
}

const tagName = versionInfo.tagName;
const push = process.argv.includes('--push');
const dryRun = process.argv.includes('--dry-run');
const existing = git(['rev-parse', '-q', '--verify', `refs/tags/${tagName}`], {
  quiet: true,
  allowFailure: true
});

if (existing.status === 0) {
  console.log(`tag ${tagName} already exists locally`);
} else if (dryRun) {
  console.log(`would create local tag ${tagName}`);
} else {
  git(['tag', '-a', tagName, '-m', `${versionInfo.name} ${tagName}`]);
  console.log(`created local tag ${tagName}`);
}

if (push && dryRun) {
  console.log(`would push ${tagName} to origin`);
} else if (push) {
  git(['push', 'origin', tagName]);
}
