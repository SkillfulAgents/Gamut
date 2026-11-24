/**
 * For checking a running app by hand (the Electron dev build on a moved port):
 * connects to `<origin>/mcp` with the token, reads a binary drive file, and
 * fetches its download URL.
 *
 *   npx tsx e2e/mcp/harness/check-download-url.ts http://127.0.0.1:47892 <token> <drive path>
 *
 * Prints the URL's origin, its HTTP status and whether the bytes match the
 * file on disk when a local path is given as the fourth argument.
 */
import * as fs from 'node:fs'
import { connectV2, resultJson } from './clients'

async function main() {
  const [origin, token, drivePath, localFile] = process.argv.slice(2)
  if (!origin || !token || !drivePath) throw new Error('usage: check-download-url.ts <origin> <token> <drive path> [local file]')
  const client = await connectV2(`${origin}/mcp`, token, 'modern')
  const drives = resultJson(await client.callTool('list_drives'))
  const brain = drives.drives.find((drive: { team_brain: boolean }) => drive.team_brain) ?? drives.drives[0]
  const file = resultJson(await client.callTool('read_drive_file', { drive: brain.id, path: drivePath }))
  await client.close()
  const download = await fetch(file.download_url)
  const body = Buffer.from(await download.arrayBuffer())
  console.log(JSON.stringify({
    reached: `${origin}/mcp`,
    kind: file.kind,
    download_origin: new URL(file.download_url).origin,
    status: download.status,
    bytes: body.length,
    matches_disk: localFile ? body.equals(fs.readFileSync(localFile)) : null,
  }))
}

void main()
