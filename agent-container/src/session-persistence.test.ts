import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('SessionPersistence', () => {
  let testDirectory: string;
  let sessionsFile: string;

  beforeEach(() => {
    testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-persistence-'));
    sessionsFile = path.join(testDirectory, 'sessions.json');
    vi.resetModules();
    vi.stubEnv('SUPERAGENT_SESSIONS_FILE', sessionsFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  });

  async function loadPersistence() {
    const { SessionPersistence } = await import('./session-persistence');
    return new SessionPersistence();
  }

  function legacySession(sessionId: string) {
    return {
      sessionId,
      claudeSessionId: `claude-${sessionId}`,
      workingDirectory: '/workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:01.000Z',
      model: 'claude-sonnet-5',
    };
  }

  it('keeps connection references but removes provider secrets before persisting a session', async () => {
    const persistence = await loadPersistence();
    persistence.saveSession({ ...legacySession('bound'), llmProviderId: 'personal-account', customEnvVars: {
      ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_AUTH_TOKEN: 'access-token', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token', AWS_SECRET_ACCESS_KEY: 'aws-secret', MY_TOOL_SETTING: 'retained',
    } });
    const file = fs.readFileSync(sessionsFile, 'utf8');
    expect(file).toContain('personal-account');
    expect(file).toContain('MY_TOOL_SETTING');
    expect(persistence.getSession('bound')?.customEnvVars?.AWS_SECRET_ACCESS_KEY).toBe('aws-secret');
    for (const secret of ['old-key', 'access-token', 'oauth-token']) expect(file).not.toContain(secret);
  });

  const modelData = () => ({
    subagentModels: [{ id: 'claude-haiku-5', label: 'Claude Haiku 5', blurb: 'Fast model for small tasks' }],
    modelContextWindows: { 'claude-haiku-5': 200000 },
    modelPromptHints: ['Call one tool at a time and wait for its result.'],
  });

  it('drops the model data an older build stored in each record and rewrites the file at load', async () => {
    fs.writeFileSync(
      sessionsFile,
      JSON.stringify({
        first: { ...legacySession('first'), ...modelData(), effort: 'high' },
        second: { ...legacySession('second'), ...modelData() },
      }),
    );

    const persistence = await loadPersistence();

    expect(persistence.getSession('first')).toMatchObject({ ...legacySession('first'), effort: 'high' });
    const file = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    expect(Object.keys(file)).toEqual(['first', 'second']);
    expect(file.first).toMatchObject({ ...legacySession('first'), effort: 'high' });
    for (const field of Object.keys(modelData())) {
      expect(persistence.getSession('first')).not.toHaveProperty(field);
      expect(file.first).not.toHaveProperty(field);
      expect(file.second).not.toHaveProperty(field);
    }
  });

  it('does not rewrite a file that holds no model data at load', async () => {
    const written = JSON.stringify({ legacy: legacySession('legacy') });
    fs.writeFileSync(sessionsFile, written);

    const persistence = await loadPersistence();

    expect(persistence.getSession('legacy')).toMatchObject(legacySession('legacy'));
    expect(fs.readFileSync(sessionsFile, 'utf8')).toBe(written);
  });

  it('drops only an invalid record while preserving other resume metadata', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fs.writeFileSync(
      sessionsFile,
      JSON.stringify({
        valid: legacySession('valid'),
        invalid: { ...legacySession('invalid'), speed: 'impossibly-fast' },
      }),
    );

    const persistence = await loadPersistence();

    expect(persistence.getSession('valid')?.claudeSessionId).toBe('claude-valid');
    expect(persistence.getSession('invalid')).toBeNull();
    expect(error).toHaveBeenCalledWith(
      'Dropping invalid persisted session "invalid":',
      expect.any(String),
    );
    expect(fs.existsSync(sessionsFile)).toBe(true);
    expect(fs.readdirSync(testDirectory).some((name) => name.includes('.corrupt-'))).toBe(false);
  });

  it('preserves malformed JSON aside because no records can be recovered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fs.writeFileSync(sessionsFile, '{not-json');

    const persistence = await loadPersistence();

    expect(persistence.getSession('anything')).toBeNull();
    expect(fs.existsSync(sessionsFile)).toBe(false);
    expect(fs.readdirSync(testDirectory).some((name) => name.startsWith('sessions.json.corrupt-'))).toBe(true);
  });

  it('applies a combined per-message update with one file write', async () => {
    const atomicFile = await vi.importActual<typeof import('./atomic-file')>('./atomic-file');
    const writes = vi.fn(atomicFile.writeFileAtomicSync);
    vi.doMock('./atomic-file', () => ({ ...atomicFile, writeFileAtomicSync: writes }));
    try {
      const persistence = await loadPersistence();
      persistence.saveSession(legacySession('turn'));
      writes.mockClear();

      persistence.updateSession('turn', {
        lastActivity: '2026-01-02T00:00:00.000Z',
        llmProviderId: 'personal-account',
        effort: 'high',
        model: 'claude-opus-5',
        metadata: { isAutomated: false },
        globalInstructions: 'Reply in plain English.',
      });

      expect(writes).toHaveBeenCalledTimes(1);
      vi.resetModules();
      expect((await loadPersistence()).getSession('turn')).toMatchObject({
        lastActivity: '2026-01-02T00:00:00.000Z',
        llmProviderId: 'personal-account',
        effort: 'high',
        model: 'claude-opus-5',
        metadata: { isAutomated: false },
        globalInstructions: 'Reply in plain English.',
      });
    } finally {
      vi.doUnmock('./atomic-file');
    }
  });

  describe('saveSessionChecked', () => {
    const record = (sessionId: string, extra: Record<string, unknown> = {}) => ({
      sessionId,
      claudeSessionId: sessionId,
      workingDirectory: '/workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:00.000Z',
      ...extra,
    })

    it('throws when the parent directory is missing and records nothing', async () => {
      vi.resetModules()
      vi.stubEnv('SUPERAGENT_SESSIONS_FILE', path.join(testDirectory, 'missing', 'sessions.json'))
      const { SessionPersistence } = await import('./session-persistence')
      const persistence = new SessionPersistence()

      expect(() => persistence.saveSessionChecked(record('fork-1'))).toThrow()
      expect(persistence.getSession('fork-1')).toBeNull()
      expect(() => persistence.saveSession(record('fork-1'))).not.toThrow() // the swallowing path is unchanged
    })

    it('restores the previous entry when overwriting fails', async () => {
      const dir = path.join(testDirectory, 'locked')
      fs.mkdirSync(dir)
      const file = path.join(dir, 'sessions.json')
      fs.writeFileSync(file, JSON.stringify({ 'src-1': record('src-1', { model: 'old' }) }))
      vi.resetModules()
      vi.stubEnv('SUPERAGENT_SESSIONS_FILE', file)
      const { SessionPersistence } = await import('./session-persistence')
      const persistence = new SessionPersistence()
      expect(persistence.getSession('src-1')?.model).toBe('old')

      fs.chmodSync(dir, 0o500) // atomic write needs to create a temp file here
      try {
        expect(() => persistence.saveSessionChecked(record('src-1', { model: 'new' }))).toThrow()
        expect(persistence.getSession('src-1')?.model).toBe('old')
      } finally {
        fs.chmodSync(dir, 0o700)
      }
    })
  })
});
