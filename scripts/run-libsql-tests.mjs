// Run the unit tests that must pass against libsql, the asynchronous,
// batch-only driver that stands in for Cloudflare D1 in CI.
//
//   npm run test:libsql
//
// A test file opts in with a line of its own:
//
//   // @libsql-must-pass
//
// (after a `// @vitest-environment` pragma, if it has one). A file is marked
// once it passes on both drivers: its database access is fully awaited and it
// builds its database with createTestDatabase(). Markers are only added
// (SUP-865 converts directories to awaited access and marks them as it goes);
// a marked file that stops passing is a regression, not a reason to unmark it.
// The marker lives in the file rather than in a shared list so that PRs
// marking different files never conflict, and it moves with a renamed file.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MARKER = '@libsql-must-pass'
const MARKER_LINE = /^\s*\/\/\s*@libsql-must-pass\s*$/m
const TEST_FILE = /\.test\.tsx?$/

// Tracked and untracked (not ignored) files under the directories vitest
// includes, so a new test file is found before it is committed.
const grep = spawnSync('git', ['grep', '-l', '--untracked', '-F', MARKER, '--', 'src', 'scripts'], {
  encoding: 'utf8',
})
// git grep exits 1 when nothing matches.
if (grep.status !== 0 && grep.status !== 1) {
  console.error(grep.stderr || `git grep exited with ${grep.status}`)
  process.exit(1)
}

const candidates = grep.stdout.split('\n').filter((file) => TEST_FILE.test(file))
const files = []
const malformed = []
for (const file of candidates) {
  if (MARKER_LINE.test(readFileSync(file, 'utf8'))) files.push(file)
  else malformed.push(file)
}

if (malformed.length > 0) {
  console.error(
    `These test files mention ${MARKER} but not as a line of its own (\`// ${MARKER}\`):\n` +
      malformed.map((file) => `  ${file}`).join('\n'),
  )
  process.exit(1)
}
if (files.length === 0) {
  console.error(`No test file is marked \`// ${MARKER}\`; markers are only ever added.`)
  process.exit(1)
}

console.log(`Running ${files.length} test files marked // ${MARKER} with DB_DRIVER=libsql`)
const result = spawnSync('npx', ['vitest', 'run', ...files], {
  stdio: 'inherit',
  env: { ...process.env, DB_DRIVER: 'libsql' },
})
process.exit(result.status ?? 1)
