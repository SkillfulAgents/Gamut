import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileExclusive } from './key-material'

describe('writeFileExclusive', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-material-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates the file, and leaves one that exists alone', async () => {
    const file = path.join(dir, '.vault-key')
    expect(await writeFileExclusive(file, 'first')).toBe('created')
    expect(await writeFileExclusive(file, 'second')).toBe('exists')
    expect(fs.readFileSync(file, 'utf-8')).toBe('first')
    expect(fs.readdirSync(dir)).toEqual(['.vault-key'])
  })

  it.each(['EMLINK', 'EPERM', 'ENOTSUP', 'EXDEV'])('falls back to an exclusive create when link() fails with %s', async (code) => {
    vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error(code), { code }))
    const file = path.join(dir, '.vault-key')
    expect(await writeFileExclusive(file, 'first')).toBe('created')
    expect(await writeFileExclusive(file, 'second')).toBe('exists')
    expect(fs.readFileSync(file, 'utf-8')).toBe('first')
    expect(fs.readdirSync(dir)).toEqual(['.vault-key'])
  })

  it('throws other link() errors', async () => {
    vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }))
    await expect(writeFileExclusive(path.join(dir, '.vault-key'), 'x')).rejects.toMatchObject({ code: 'EIO' })
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
