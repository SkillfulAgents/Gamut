import { connectionRuntimeSchema } from './connection-runtime';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
// Captures SUPERAGENT_HOST_TOKEN and strips it from process.env — import early
// so no later module can snapshot an environment that still contains it.
import { HOST_TOKEN_HEADER, hostAuthEnabled, isValidHostToken } from './host-auth';
import { SessionManager, isSdkSessionNotFound, type UndeliveredTurnReport } from './session-manager';
import { notifyUndeliveredTurn } from './host-events';
import { sessionCreationFailure } from './session-creation-error';
import { CreateSessionRequest, SendMessageRequest } from './types';
import { agentCapabilityPoliciesSchema, speedLevelSchema } from './capability-policies';
import { globalInstructionsSchema } from './global-instructions';
import type { UUID } from 'crypto';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';

import { inputManager, UNANSWERED_REASONS } from './input-manager';
import { resolveCdpIp } from './cdp-host';
import { startScreenshotJanitor } from './screenshot-janitor';
import { dashboardManager, getDashboardBasePath } from './dashboard-manager';
import { widgetManager } from './widget-manager';
import { registerRenderRoute } from './render-route';
import {
  dashboardHttpForwardHeaders,
  dashboardHttpUpstreamPath,
  dashboardWebSocketForwardHeaders,
  dashboardWebSocketUpstreamPath,
  parseDashboardProxyRoute,
  requestedWebSocketProtocols,
} from './dashboard-proxy';
import { tabManager, type NewTabResult } from './tab-manager';
import { closesTabs, labelTabList, ownTabCount, popupsOf, tabAfterClose, tabCloses, type TabsAsSeen } from './session-tabs';
import { startTabPolling, stopTabPolling } from './tab-poll';
import { runBrowserUpload } from './browser-upload';
import { runBrowserDownload } from './browser-download';
import { updateEnvFileEntry, healEnvFilePermissions } from './env-file-store';
import { isAgentIdentityEnvKey } from './attribution-headers';
import {
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
  WorkspaceEntryOperationError,
  type DeleteWorkspaceEntryRequest,
  type RenameWorkspaceEntryRequest,
} from './workspace-entry-operations';
import { registerLegacyFileRoutes } from './legacy-file-routes';

import { getEditingCommands } from './cdp-editing-commands';
import { createBrowserNavigation, type BrowserNavigation } from './browser-navigation';
import type { BrowserTabInfo, BrowserTabListMessage } from './browser-stream-protocol';
import { clampViewerWidth, screencastSize } from './screencast-size';
import { CREDENTIAL_AUTOFILL_FUNCTION } from './credential-autofill-script';
import { CdpConnection } from './login-cdp';
import type { LoginFillDeps, PageActivity } from './login-fill';
import type { FieldBox } from './login-form-script';
import { closePreparedLogins } from './login-requests';
import type { LoginFillReport } from './login-schema';
import { clickSubmit, registerLoginRoutes, type SubmitOutcome, type SubmitPlan } from './login-routes';
import { registerSessionRoutes } from './session-routes';
import { registerPasskeyRoutes } from './passkey-routes';
import { PasskeyKeeper } from './passkey-keeper';
import { isSessionStubTarget } from './browser-session';
import { browserCommand } from './browser-gate';
import { forgetInjectedSecrets, redactInjectedSecrets, redactInjectedSecretsDeep, rememberInjectedSecret } from './injected-secrets';
import { selectActivePageTarget } from './active-page-target';
import { decodeChromeTargetTitle } from './chrome-target-title';
import { drainVolumeUploads, finishVolumeStop, mountVolumes, mountedVolumeIds, parseVolumes, unmountVolumes } from './volume-mounts';
import { installVolumeStop } from './volume-stop';

// Global error handlers to prevent crashes from AbortError during interrupts
// The SDK throws AbortError when queries are aborted, which can propagate uncaught
process.on('uncaughtException', (error: Error) => {
  // AbortError is expected during interrupt operations - don't crash
  if (error.name === 'AbortError' || error.message?.includes('aborted')) {
    console.log('[Server] Caught AbortError (expected during interrupt):', error.message);
    return;
  }
  console.error('[Server] Uncaught exception:', error);
  // For other errors, log but don't exit - let the container stay alive
});

process.on('unhandledRejection', (reason: unknown) => {
  // AbortError is expected during interrupt operations - don't crash
  if (reason instanceof Error) {
    if (reason.name === 'AbortError' || reason.message?.includes('aborted')) {
      console.log('[Server] Caught unhandled AbortError (expected during interrupt):', reason.message);
      return;
    }
  }
  console.error('[Server] Unhandled rejection:', reason);
  // Don't exit - let the container stay alive
});

const app = new Hono();
const sessionManager = new SessionManager();

sessionManager.on('undelivered-turn', (report: UndeliveredTurnReport) => {
  console.error(
    `[Session ${report.sessionId}] Turn ended (${report.resultSubtype ?? 'unknown'}) with no stream subscriber; ` +
    `the last one closed at ${report.closedAt}, ${report.msSinceClose}ms earlier (code=${report.closeCode}, ` +
    `reason=${report.closeReason || 'none'}, age=${report.socketAgeMs}ms, idle=${report.idleMsBeforeClose}ms, ` +
    `error=${report.socketError ?? 'none'})`,
  );
  void notifyUndeliveredTurn(report).catch((error) => {
    console.warn(`[Session ${report.sessionId}] Failed to report undelivered turn:`, error);
  });
});

const WORKSPACE_DOWNLOADS_DIR = '/workspace/downloads';

// The agent's own Bash can reach this API (shared network namespace), so every
// endpoint that could loosen policy or self-approve an input must prove the
// caller is the host. /health stays open for the Docker HEALTHCHECK.
app.use('*', async (c, next) => {
  if (!hostAuthEnabled() || c.req.path === '/health') return next();
  if (!isValidHostToken(c.req.header(HOST_TOKEN_HEADER))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

// Volumes mount at boot. Until they settle, /health holds the host's start check.
let volumesSettled = false;
const volumesMounted = mountVolumes(parseVolumes(process.env.SUPERAGENT_VOLUMES)).then(() => {
  volumesSettled = true;
});

// Health check endpoint
app.get('/health', (c) => {
  if (!volumesSettled) return c.json({ status: 'starting' }, 503);
  return c.json({ status: 'ok', timestamp: new Date().toISOString(), volumes: mountedVolumeIds() });
});

// Session endpoints
installVolumeStop(app, {
  hasVolumes: () => mountedVolumeIds().length > 0,
  stopWriters: async () => { await Promise.all([dashboardManager.stopAll(), sessionManager.stopAll()]); },
  drain: drainVolumeUploads,
  finish: finishVolumeStop,
});

app.post('/sessions', async (c) => {
  try {
    const body = await c.req.json<CreateSessionRequest>();

    if (!body.initialMessage) {
      return c.json({ error: 'initialMessage is required', inputAccepted: false }, 400);
    }

    if (body.maxBrowserTabs) {
      tabManager.setMaxTabs(body.maxBrowserTabs);
    }
    const session = await sessionManager.createSession(body);
    return c.json(session, 201);
  } catch (error: any) {
    console.error('Error creating session:', error);
    // The Agent SDK attaches the spawn errno (`code`) and a failure class
    // (`errorClass`, e.g. 'executable_launch_failed') to CLI launch errors.
    // Forward both: the message alone hides the errno behind the SDK's canned
    // libc-mismatch guess, and the host keys auto-recovery off errorClass.
    return c.json(sessionCreationFailure(error), 500);
  }
});

app.get('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({
    ...session,
    isRunning: sessionManager.isSessionRunning(sessionId),
  });
});

// Persisted "Allow for this session" review grants. The host consults this when
// its in-memory grant mirror is cold (fresh host process against a live
// container) before broadcasting a review card the container isn't waiting on.
app.get('/sessions/:id/capability-grants', (c) => {
  const grants = sessionManager.getSessionCapabilityGrants(c.req.param('id'));
  if (grants === null) {
    return c.json({ error: 'Session not found' }, 404);
  }
  return c.json({ grants });
});

app.get('/sessions', (c) => {
  const sessions = sessionManager.getAllSessions();
  return c.json(sessions);
});

app.post('/sessions/:id/release', async (c) => {
  const sessionId = c.req.param('id');
  await sessionManager.releaseSession(sessionId);
  inputManager.rejectForSession(sessionId);
  // Also acknowledges an unknown session: it has no process to release.
  return c.json({ success: true });
});

app.delete('/sessions/:id', async (c) => {
  const sessionId = c.req.param('id');
  const deleted = await sessionManager.deleteSession(sessionId);

  // The host never answers a deleted session's input requests — reject them
  // so awaiting tool handlers unblock and the entries don't live forever.
  // Unconditional: a not-found session may still own entries from a racing
  // or repeated delete.
  inputManager.rejectForSession(sessionId);

  if (!deleted) {
    return c.json({ error: 'Session not found' }, 404);
  }

  return c.json({ success: true });
});

// scope 'turn' (default) ends the foreground turn and keeps the CLI process,
// so background tasks live on; 'all' replaces the process and kills them.
// `processKept` tells the host which of the two actually happened — a soft
// interrupt falls back to the restart when the CLI cannot be trusted with it.
const interruptBodySchema = z.object({
  scope: z.enum(['turn', 'all']).default('turn'),
});

app.post('/sessions/:id/interrupt', async (c) => {
  const sessionId = c.req.param('id');

  try {
    const rawBody = await c.req.text();
    let parsedBody: unknown = {};
    if (rawBody.trim()) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
    }
    const body = interruptBodySchema.safeParse(parsedBody);
    if (!body.success) {
      return c.json({ error: 'Invalid interrupt scope' }, 400);
    }
    const { found, discardedUuids, processKept } = await sessionManager.interruptSession(sessionId, body.data.scope);

    if (!found) {
      return c.json({ error: 'Session not found' }, 404);
    }

    // The same uuids also flow to the host as synthetic command_lifecycle
    // 'discarded' stream frames; this response is for the API caller.
    return c.json({ success: true, discardedUuids, processKept });
  } catch (error: any) {
    console.error('Error interrupting session:', error);
    return c.json({ error: error.message || 'Failed to interrupt session' }, 500);
  }
});

app.post('/sessions/:id/fork', async (c) => {
  const sessionId = c.req.param('id');

  try {
    const id = await sessionManager.forkSession(sessionId);
    if (!id) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json({ id }, 201);
  } catch (error: any) {
    if (isSdkSessionNotFound(error)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    console.error('Error forking session:', error);
    return c.json({ error: error.message || 'Failed to fork session' }, 500);
  }
});

// Pre-resume a session's CLI before its next message (the host asks when a
// person starts typing into the session), so the send skips the CLI spawn and
// `--resume`. Answers at once — the resume runs in the background, and a send
// that arrives first waits for it instead of racing a second restart. A JSON
// 404 is an unknown session; the host reads a plain 404 as an older image.
app.post('/sessions/:id/warm', (c) => {
  const sessionId = c.req.param('id');
  if (!sessionManager.hasSession(sessionId)) {
    return c.json({ error: 'Session not found' }, 404);
  }
  void sessionManager.warmSession(sessionId).then(
    (outcome) => {
      if (outcome === 'resumed') console.log(`[Session ${sessionId}] Pre-resumed ahead of the next message`);
    },
    (error) => console.error(`[Session ${sessionId}] Pre-resume failed (the next send restarts it):`, error),
  );
  return c.json({ accepted: true }, 202);
});

// Message endpoints
app.post('/sessions/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const session = await sessionManager.getSession(sessionId);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  try {
    const body = await c.req.json<SendMessageRequest>();
    const content = typeof body.content === 'string' ? body.content : JSON.stringify(body.content);

    await sessionManager.sendMessage(sessionId, content, body.uuid, {
      effort: body.effort,
      speed: speedLevelSchema.parse(body.speed),
      model: body.model,
      llmRuntime: body.llmRuntime ? connectionRuntimeSchema.parse(body.llmRuntime) : undefined,
      shouldQuery: body.shouldQuery,
      isAutomated: body.isAutomated,
      capabilityPolicies: agentCapabilityPoliciesSchema.parse(body.capabilityPolicies),
      globalInstructions: globalInstructionsSchema.parse(body.globalInstructions),
    });

    return c.json({ success: true }, 201);
  } catch (error: any) {
    console.error('Error sending message:', error);
    return c.json({ error: error.message || 'Failed to send message' }, 500);
  }
});

// The session's full context breakdown (the drawer's Context tab). A session
// that is not resident has none to give; one with no live query answers null.
app.get('/sessions/:id/context', async (c) => {
  const sessionId = c.req.param('id');
  try {
    return c.json(await sessionManager.contextBreakdown(sessionId));
  } catch (error: any) {
    console.error('Error reading context breakdown:', error);
    return c.json({ error: error.message || 'Failed to read context' }, 500);
  }
});

// Stop one background task (backgrounded Bash, background subagent, workflow)
// by the SDK task id. The CLI answers on the stream with a task_notification
// of status 'stopped', which is what retires the task in the host UI.
app.post('/sessions/:id/tasks/:taskId/stop', async (c) => {
  const sessionId = c.req.param('id');
  const taskId = c.req.param('taskId');

  try {
    const { found, stopped } = await sessionManager.stopTask(sessionId, taskId);
    if (!found) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (!stopped) {
      return c.json({ error: 'Session has no running query' }, 409);
    }
    return c.json({ success: true });
  } catch (error: any) {
    console.error(`Error stopping task :`, error);
    return c.json({ error: error.message || 'Failed to stop task' }, 500);
  }
});

// Cancel a queued (not yet picked up) message by the uuid it was sent with.
// `cancelled: false` means it was already dequeued for execution (or the
// session isn't live) — never an error; the caller treats it as "too late".
app.delete('/sessions/:id/queued-messages/:uuid', async (c) => {
  const sessionId = c.req.param('id');
  const uuid = c.req.param('uuid');

  try {
    const cancelled = await sessionManager.cancelQueuedMessage(sessionId, uuid as UUID);
    return c.json({ cancelled });
  } catch (error: any) {
    console.error('Error cancelling queued message:', error);
    return c.json({ error: error.message || 'Failed to cancel queued message' }, 500);
  }
});

// File system endpoints
// These host-authenticated mutations deliberately execute inside the container
// namespace. The workspace is bind-mounted, so changes persist, while a racing
// symlink can never redirect a destructive operation into the host filesystem.
app.patch('/workspace/entries', async (c) => {
  try {
    const result = await renameWorkspaceEntry(await c.req.json<RenameWorkspaceEntryRequest>());
    return c.json(result);
  } catch (error) {
    if (error instanceof WorkspaceEntryOperationError) {
      return c.json({ error: error.message }, error.status);
    }
    console.error('Error renaming workspace entry:', error);
    return c.json({ error: error instanceof Error ? error.message : 'Failed to rename workspace entry' }, 500);
  }
});

app.delete('/workspace/entries', async (c) => {
  try {
    await deleteWorkspaceEntry(await c.req.json<DeleteWorkspaceEntryRequest>());
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof WorkspaceEntryOperationError) {
      return c.json({ error: error.message }, error.status);
    }
    console.error('Error deleting workspace entry:', error);
    return c.json({ error: error instanceof Error ? error.message : 'Failed to delete workspace entry' }, 500);
  }
});

registerLegacyFileRoutes(app);

app.delete('/files/*', async (c) => {
  const filePath = c.req.param('*') || '';
  const fullPath = path.join('/workspace', filePath);

  try {
    const stats = await fs.promises.stat(fullPath);
    if (stats.isDirectory()) {
      await fs.promises.rm(fullPath, { recursive: true });
    } else {
      await fs.promises.unlink(fullPath);
    }
    return c.json({ success: true });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return c.json({ error: 'File or directory not found' }, 404);
    }
    console.error('Error deleting file:', error);
    return c.json({ error: error.message || 'Failed to delete file' }, 500);
  }
});

app.get('/files/tree', async (c) => {
  const depth = parseInt(c.req.query('depth') || '3');
  const startPath = c.req.query('path') || '';
  const fullPath = path.join('/workspace', startPath);

  try {
    const tree = await buildFileTree(fullPath, depth, 0);
    return c.json(tree);
  } catch (error: any) {
    console.error('Error building file tree:', error);
    return c.json({ error: error.message || 'Failed to build file tree' }, 500);
  }
});

// Input resolution endpoints - used by the server to resolve pending user input requests
// Requests are keyed by toolUseId (captured via PreToolUse hook)

// POST /inputs/:toolUseId/resolve - Resolve a pending input request with a value
app.post('/inputs/:toolUseId/resolve', async (c) => {
  const toolUseId = c.req.param('toolUseId');

  try {
    const body = await c.req.json<{ value: string | string[] | Record<string, string> }>();

    if (body.value === undefined || body.value === null) {
      return c.json({ error: 'value is required' }, 400);
    }

    inputManager.resolve(toolUseId, body.value);
    return c.json({ success: true });
  } catch (error: any) {
    console.error('Error resolving input:', error);
    return c.json({ error: error.message || 'Failed to resolve input' }, 500);
  }
});

// `unanswered`: the person chose not to answer (the card's Decline); a
// question then ends as an annotated answer rather than a failed tool call.
const rejectInputBodySchema = z.object({
  reason: z.string().optional(),
  unanswered: z.enum(UNANSWERED_REASONS).optional(),
});

// POST /inputs/:toolUseId/reject - Reject a pending input request
app.post('/inputs/:toolUseId/reject', async (c) => {
  const toolUseId = c.req.param('toolUseId');

  try {
    const parsed = rejectInputBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const reason = parsed.data.reason || 'User declined';

    if (inputManager.reject(toolUseId, reason, parsed.data.unanswered)) {
      return c.json({ success: true });
    }

    return c.json({ error: 'No pending request found for this toolUseId' }, 404);
  } catch (error: any) {
    console.error('Error rejecting input:', error);
    return c.json({ error: error.message || 'Failed to reject input' }, 500);
  }
});

// GET /inputs/pending - List all pending input requests (useful for debugging)
app.get('/inputs/pending', (c) => {
  return c.json(inputManager.getAllPending());
});

// Helper to update the .env file with a key-value pair
async function updateEnvFile(key: string, value: string): Promise<void> {
  const envFilePath = '/workspace/.env';

  try {
    // The host app also writes this file (user secrets). updateEnvFileEntry
    // serializes via the shared on-disk lock, reads fail-closed (an unreadable
    // file THROWS instead of being treated as empty — merging into "empty" and
    // writing back once wiped every secret), merges line-preservingly (the
    // host's header and display-name comments survive), and writes atomically.
    await updateEnvFileEntry(envFilePath, key, value);
    console.log(`[ENV] Updated .env file with ${key}`);
  } catch (error) {
    console.error(`[ENV] Failed to update .env file:`, error);
    throw error;
  }
}

// POST /env - Set an environment variable at runtime
app.post('/env', async (c) => {
  try {
    const body = await c.req.json<{ key: string; value: string }>();

    if (!body.key || body.value === undefined) {
      console.error('[ENV] Missing key or value in request');
      return c.json({ error: 'key and value are required' }, 400);
    }

    // Validate the key is a valid environment variable name
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(body.key)) {
      console.error(`[ENV] Invalid env var name: ${body.key}`);
      return c.json({ error: 'Invalid environment variable name' }, 400);
    }

    // Identity and Platform service credentials belong to the host runtime.
    if (isAgentIdentityEnvKey(body.key) || body.key === 'PLATFORM_BASE_URL' || body.key === 'PLATFORM_AUTH_TOKEN') {
      console.error(`[ENV] Rejected write to reserved runtime env var: ${body.key}`);
      return c.json({ error: `${body.key} is reserved and cannot be modified` }, 403);
    }

    // Set the environment variable in process.env (for Node.js code)
    process.env[body.key] = body.value;
    console.log(`[ENV] Set environment variable: ${body.key} (${body.value.length} chars)`);

    // A pre-warmed subprocess captured the old env when it spawned (REMOTE_MCPS
    // in particular is read while building its query options), so it would run
    // the next session against a stale view. Invalidated here — immediately
    // after the env changes and BEFORE the awaited file write below — so a
    // session arriving in that window cannot claim the stale process. The
    // generation bump inside is synchronous and also rejects a warm-up that is
    // still spawning; the next createSession re-warms from the current env.
    const discarded = sessionManager.discardPrewarmed(`env var ${body.key} changed`);

    // Also write to .env file (for uv/python scripts)
    await updateEnvFile(body.key, body.value);
    await discarded;

    // Verify it was set in process.env
    if (process.env[body.key] !== body.value) {
      console.error(`[ENV] Failed to verify env var was set: ${body.key}`);
      return c.json({ error: 'Failed to verify environment variable was set' }, 500);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error('[ENV] Error setting env var:', error);
    return c.json({ error: error.message || 'Failed to set environment variable' }, 500);
  }
});

// ============================================================
// Dashboard / Artifacts endpoints
// ============================================================

// GET /artifacts - List all dashboards
app.get('/artifacts', (c) => {
  const dashboards = dashboardManager.listDashboards();
  return c.json(dashboards);
});

// POST /artifacts/:slug/create - Scaffold a new dashboard
app.post('/artifacts/:slug/create', async (c) => {
  try {
    const slug = c.req.param('slug');
    const body = await c.req.json<{
      name: string;
      description?: string;
      framework?: 'plain' | 'react';
    }>();

    if (!body.name) {
      return c.json({ error: 'name is required' }, 400);
    }

    await dashboardManager.createDashboard(
      slug,
      body.name,
      body.description || '',
      body.framework || 'plain'
    );

    return c.json({ success: true, slug, path: `/workspace/artifacts/${slug}` });
  } catch (error: any) {
    console.error('[Artifacts] Error creating dashboard:', error);
    return c.json({ error: error.message || 'Failed to create dashboard' }, 500);
  }
});

// POST /artifacts/:slug/start - Start or restart a dashboard
app.post('/artifacts/:slug/start', async (c) => {
  try {
    const slug = c.req.param('slug');
    const info = await dashboardManager.startDashboard(slug);
    return c.json({
      success: true,
      slug: info.slug,
      name: info.name,
      status: info.status,
      port: info.port,
    });
  } catch (error: any) {
    console.error('[Artifacts] Error starting dashboard:', error);
    return c.json({ error: error.message || 'Failed to start dashboard' }, 500);
  }
});

// DELETE /artifacts/:slug - Stop dashboard process and clean up
app.delete('/artifacts/:slug', async (c) => {
  try {
    const slug = c.req.param('slug');
    await dashboardManager.stopDashboard(slug);
    return c.json({ success: true });
  } catch (error: any) {
    console.error('[Artifacts] Error deleting dashboard:', error);
    return c.json({ error: error.message || 'Failed to delete dashboard' }, 500);
  }
});

// GET /artifacts/:slug/logs - Get dashboard logs
app.get('/artifacts/:slug/logs', async (c) => {
  try {
    const slug = c.req.param('slug');
    const clear = c.req.query('clear') === 'true';
    const logs = await dashboardManager.getDashboardLogs(slug, clear);
    return c.text(logs);
  } catch (error: any) {
    console.error('[Artifacts] Error getting logs:', error);
    return c.json({ error: error.message || 'Failed to get logs' }, 500);
  }
});

// ============================================================
// Widgets — an artifact's static snapshot, refreshed by a script, no server.
// Registered before the dashboard proxy so /artifacts/:slug/widget/* never
// reaches a dashboard process.
// ============================================================

// GET /widgets - Artifacts that expose a widget, with snapshot metadata
app.get('/widgets', (c) => {
  return c.json(widgetManager.listWidgets());
});

// POST /artifacts/:slug/widget/refresh - Run the widget script, rasterize,
// rewrite snapshot.json. Long-running (script timeout + rasterization); the
// host calls it with a matching fetch timeout. Serialized in the manager.
app.post('/artifacts/:slug/widget/refresh', async (c) => {
  try {
    const slug = c.req.param('slug');
    const snapshot = await widgetManager.refreshWidget(slug);
    return c.json(snapshot);
  } catch (error: any) {
    console.error('[Widgets] Error refreshing widget:', error);
    return c.json({ error: error.message || 'Failed to refresh widget' }, 500);
  }
});

// GET /artifacts/:slug/widget/logs - Refresh script stdout/stderr
app.get('/artifacts/:slug/widget/logs', async (c) => {
  try {
    const slug = c.req.param('slug');
    const clear = c.req.query('clear') === 'true';
    return c.text(await widgetManager.getWidgetLogs(slug, clear));
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to get widget logs' }, 500);
  }
});

registerRenderRoute(app);

// Shared handler for proxying requests to a dashboard server
async function proxyToDashboard(c: any) {
  const slug = c.req.param('slug');
  let port = dashboardManager.getDashboardPort(slug);

  // A request during startup is held until the dashboard reaches an outcome
  // rather than bounced with a 503 — the renderer mounts its iframe while the
  // dashboard is still 'starting', so the first paint happens the moment the
  // server binds. Stopped/crashed/unknown dashboards still fail fast.
  if (!port && dashboardManager.getDashboardStatus(slug) === 'starting') {
    await dashboardManager.waitForStartupOutcome(slug, 20_000);
    port = dashboardManager.getDashboardPort(slug);
  }

  if (!port) {
    return c.json({ error: `Dashboard ${slug} is not running` }, 503);
  }

  const url = new URL(c.req.url);
  const prefixPattern = `/artifacts/${slug}`;
  const subPath = url.pathname.slice(url.pathname.indexOf(prefixPattern) + prefixPattern.length) || '/';
  const upstreamPathMode = dashboardManager.getDashboardUpstreamPathMode(slug);
  const targetPath = dashboardHttpUpstreamPath(
    subPath,
    getDashboardBasePath(slug),
    upstreamPathMode,
  );
  const targetUrl = `http://localhost:${port}${targetPath}${url.search}`;

  const headers = dashboardHttpForwardHeaders(c.req.header(), upstreamPathMode);

  const response = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    redirect: 'manual',
    body: c.req.method !== 'GET' && c.req.method !== 'HEAD'
      ? await c.req.arrayBuffer()
      : undefined,
  });

  return new Response(response.body, {
    status: response.status,
    headers: new Headers(response.headers),
  });
}

// ALL /artifacts/:slug/* - Proxy to dashboard server
app.all('/artifacts/:slug/*', async (c) => {
  try {
    return await proxyToDashboard(c);
  } catch (error: any) {
    console.error('[Artifacts] Proxy error:', error);
    return c.json({ error: error.message || 'Failed to proxy request' }, 502);
  }
});

// Also handle /artifacts/:slug (no trailing slash)
app.all('/artifacts/:slug', async (c) => {
  try {
    return await proxyToDashboard(c);
  } catch (error: any) {
    console.error('[Artifacts] Proxy error:', error);
    return c.json({ error: error.message || 'Failed to proxy request' }, 502);
  }
});


// ============================================================
// Browser automation endpoints (agent-browser tool proxy)
// ============================================================

import {
  type BrowserState,
  type BrowserSession,
  getBrowserState as _getBrowserState,
  setBrowserState as _setBrowserState,
  attachBrowserSession,
  browserSessionOf,
  browserSessions,
  detachBrowserSession,
  onBrowserSessionReleased,
  releaseBrowserSession,
} from './browser-state';
import {
  BROWSER_OPEN_LOCATIONS,
  type BrowserOpenLocation,
  type BrowserRuntimeLocation,
  requiresBrowserLocationSwitch,
  resolveBrowserRuntimeLocation,
  shouldRefuseImplicitHostLoopback,
} from './browser-location';
import { confirmNoPagesLeft, listPageTargetsExcept, readTabSources, recheckPageTarget } from './browser-liveness';

// Bumped each time /browser/open succeeds. External-close detection spans real
// time (two target lookups 750ms apart, then a confirmation request); a browser
// opened during that span must not be torn down by a verdict formed against the
// one before it. Detection snapshots this before looking and re-compares last.
let browserOpenGeneration = 0;

// Proxy object so existing code can read `browserState.active` etc. without changes.
// Writes must go through _setBrowserState() to keep the canonical module state in sync.
const browserState: BrowserState = new Proxy({} as BrowserState, {
  get(_target, prop) {
    return (_getBrowserState() as any)[prop];
  },
});

/**
 * For the route modules' session check: null when the session may use the
 * browser, as when it has opened it, or there is no browser yet. Another
 * session's use of the browser never makes this one wait.
 */
function browserSessionRefusal(sessionId: string): string | null {
  return browserSessionOf(sessionId) || !browserState.active ? null : 'This session has no browser open';
}

/** A browser tool's answer when the session has no page to act on: no browser at all, or none of this session's in the agent's. */
function noBrowserOpen(): string {
  return browserState.active
    ? 'This session has no browser open. Other sessions of this agent are using the browser; browser_open opens a tab of this session\'s in it.'
    : 'Browser is not active';
}


const execFileAsync = promisify(execFile);

import { resolveRunCommandArgs, runCommandRefusal, runCommands } from './browser-command-args';
import { validatePressKey } from './press-key';
import { prepareEvalScript, finalizeEvalOutput, evalErrorHint } from './eval-script';
import { judgeSelectCommit, parseSelectOptions, targetOptionMatches, selectRefusalText, SELECT_COMMIT_SETTLE_MS } from './select-verify';
import { classifyWaitTarget, WAIT_PAGE_PROBE_SCRIPT, parseWaitPageProbe } from './wait-target';

/** Budget for the page probe around a wait — independent of the exec ceiling. */
const WAIT_PAGE_PROBE_TIMEOUT_MS = 3000;
import { resolveCommittedValue } from './field-value-readback';
import { topFrameScript, ranInFrame, stepOutOfFrame, atTopFrame, frameSelectionOf } from './top-frame-probe';
import { frameInventory, formatFrameInventory, formatFrameLine, frameUrlShown, parseFrameInfo, FRAME_INFO_SCRIPT, type SelectedFrame } from './frame-inventory';
import { capBrowserOutput, redactCdpUrls, describeExecFailure, commandWarnings, cliJsonError, extractScreenshotPath, navigationNetError, BROWSER_EXEC_TIMEOUT_MS, MAX_BROWSER_OUTPUT_CHARS, MAX_SNAPSHOT_RAW_CHARS, MAX_BROWSER_ERROR_CHARS } from './browser-output';
import { capSnapshot, capReadText, compactWithText, countRefs, formatIframePlaceholders, formatTextFooter, THIN_TREE_REFS } from './snapshot-format';
import { observerScript, parseObservation, EMPTY_OBSERVATION, PREVIEW_CHARS, THIN_TREE_PREVIEW_CHARS, type PageObservation } from './page-observer';
import { formatStatusLine, waitForLoaded } from './page-status';
import { activeTabAddress, resolveErrorPageUrl } from './error-page-url';
import { observeAction, pressPolicy, effectWantsTree, sameDocument, newDocument, ACTION_POLICIES, type ActionEffect, type ActionPolicy, type EffectTreeDiff } from './action-settle';
import { diffTrees, formatUnknownRef, goneRefOf, lineWithoutRef, parseTreeRefs } from './tree-diff';
import { readerScript, parseReadResult, outlineOf, sectionOf, tidyRead, formatUnreadFrames } from './page-reader';
import { browserScale, pinBrowserScaleArgs } from './browser-scale';
import { parseIfChangedOutput, screenshotKey, rememberScreenshot, recallScreenshot, forgetScreenshots } from './screenshot-memory';
import { noteChallenge, resetChallengedSites, useHumanInput } from './challenge-input';
import { parseNetworkActivity, type NetworkActivity } from './network-activity';
import { harSchema, redactHar, summarizeEndpoints, formatCaptureSummary, captureFileName, bodyFileName, requestFileName, readableBody } from './traffic-capture';
import { type UrlDigest, type ScrollInfo, parseScrollInfo } from './browser-digest';

// Ensure Chrome download preferences are set in the browser profile directory.
// Merges with existing preferences to avoid overwriting other settings.
async function ensureBrowserDownloadPreferences(profileDir: string, downloadDir: string): Promise<void> {
  const prefsDir = path.join(profileDir, 'Default');
  const prefsPath = path.join(prefsDir, 'Preferences');

  await fs.promises.mkdir(prefsDir, { recursive: true });
  await fs.promises.mkdir(downloadDir, { recursive: true });

  let prefs: Record<string, any> = {};
  try {
    const existing = await fs.promises.readFile(prefsPath, 'utf-8');
    prefs = JSON.parse(existing);
  } catch {
    // No existing preferences file
  }

  prefs.download = {
    ...prefs.download,
    default_directory: downloadDir,
    prompt_for_download: false,
  };

  await fs.promises.writeFile(prefsPath, JSON.stringify(prefs, null, 2));
}

import { readChromeDebugPort } from './chrome-debug-port';

/**
 * The agent-browser instance that launches the container's Chrome. No session
 * drives it: each session attaches an instance of its own to that Chrome. It
 * is the one an agent's own `agent-browser` command in Bash reaches, so that
 * command uses the same Chrome rather than starting a second one on the profile.
 */
const OWNER_SESSION = process.env.AGENT_BROWSER_SESSION || 'default';

// Clean up every agent-browser instance (the owner's and the sessions'), the
// container's Chrome and the owner's socket file. Prevents "Daemon failed to
// start" errors when a previous daemon is left running (e.g. browser closed
// externally, conversation ended without closing, or previous execBrowser
// timed out). Only while no session uses the browser.
function cleanupAgentBrowserDaemon(): void {
  try { fs.unlinkSync(tabManager.socketPath(OWNER_SESSION)); } catch { /* ignore missing */ }
  try { execSync('pkill -f "agent-browser" 2>/dev/null || true', { timeout: 3000 }); } catch { /* ignore */ }
  // Also kill Chrome processes spawned by the daemon — otherwise they survive
  // and hold the profile SingletonLock, causing "File exists" on retry.
  try { execSync('pkill -f "chrome.*--headless" 2>/dev/null || true', { timeout: 3000 }); } catch { /* ignore */ }
  // Remove stale SingletonLock from the profile directory
  const profile = process.env.AGENT_BROWSER_PROFILE || '/workspace/.browser-profile';
  try { fs.unlinkSync(path.join(profile, 'SingletonLock')); } catch { /* ignore */ }
}

type BrowserExecOptions = {
  timeoutMs?: number;
  outputCap?: number;
  /** A command of the step out of the agent's frame itself, which every other command of the session waits for (stepOutOfFrame). */
  withinFrameStep?: boolean;
};

// Execute an agent-browser CLI command in a session's own instance: attached
// to the agent's Chrome and pinned to the session's tab. Never while a
// saved-session operation of that session runs (browser-gate.ts), nor while
// the harness has stepped out of the agent's frame to read the top page.
async function execBrowser(args: string[], s: BrowserSession, opts: BrowserExecOptions = {}): ReturnType<typeof runBrowserCommand> {
  if (!opts.withinFrameStep) while (s.frameStep) await s.frameStep;
  const instance = ['--session', s.key, '--cdp', browserState.cdpUrl ?? '', '--pin-tab'];
  return browserCommand(s.sessionId, () => runBrowserCommand(instance, args, opts));
}

/**
 * Run a harness probe script on the session's top frame, whatever frame the
 * agent selected (top-frame-probe.ts): one `eval` when the instance is on the
 * top frame, as it is unless the agent ran `frame <target>`.
 */
async function probeTopFrame(s: BrowserSession, script: string, opts: BrowserExecOptions = {}): Promise<{ stdout: string; exitCode: number }> {
  const r = await execBrowser(['eval', topFrameScript(script)], s, opts);
  if (r.exitCode !== 0) return r;
  if (!ranInFrame(r.stdout)) {
    // On the top frame: any frame the agent selected has been left (a
    // navigation, a tab change or a removed frame resets it in the CLI).
    s.frame = null;
    return r;
  }
  return stepOutOfFrame(s, script, (args) => execBrowser(args, s, { ...opts, withinFrameStep: true }));
}

/** A command for the instance that launches (and closes) the container's Chrome: no session's tab. */
function execOwner(args: string[], opts: BrowserExecOptions = {}): ReturnType<typeof runBrowserCommand> {
  return runBrowserCommand(['--session', OWNER_SESSION], args, opts);
}

// Uses execFile (no shell) to prevent command injection.
async function runBrowserCommand(
  instance: string[],
  args: string[],
  opts: BrowserExecOptions = {},
): Promise<{ stdout: string; exitCode: number; warnings?: string[] }> {
  const started = Date.now();
  const outputCap = opts.outputCap ?? MAX_BROWSER_OUTPUT_CHARS;
  const fullArgs = [...instance, ...args];
  try {
    const { stdout, stderr } = await execFileAsync('agent-browser', fullArgs, {
      timeout: opts.timeoutMs ?? BROWSER_EXEC_TIMEOUT_MS,
      // Large-but-legitimate outputs must not THROW (the throw path used to
      // stuff up to 1 MiB of partial output into an error string);
      // capBrowserOutput below bounds what the model actually sees.
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        AGENT_BROWSER_STREAM_PORT: process.env.AGENT_BROWSER_STREAM_PORT || '9223',
        AGENT_BROWSER_ARGS: process.env.AGENT_BROWSER_ARGS || '--no-sandbox,--disable-blink-features=AutomationControlled',
      },
    });
    // Raw on purpose: the server parses this output itself. Text bound for the
    // agent is redacted where it leaves (the browser tools' results). The
    // CLI's warnings about the page (a value it truncated, a range it
    // snapped to its step) come on stderr: the action routes pass them on.
    const warnings = commandWarnings(String(stderr ?? ''));
    return { stdout: capBrowserOutput(stdout.trim(), outputCap), exitCode: 0, ...(warnings.length > 0 && { warnings: warnings.map(w => capBrowserOutput(w, MAX_BROWSER_ERROR_CHARS)) }) };
  } catch (error: any) {
    // Full, unsanitized detail (incl. the command line with the CDP URL) goes
    // to container logs for connectivity debugging — never to the model.
    // Container logs reach error reports: no injected value goes along.
    console.error('[Browser] agent-browser failed:', redactInjectedSecrets(String(error.message)));
    if (error.stderr) {
      console.error('[Browser] agent-browser stderr:', redactInjectedSecrets(String(error.stderr)));
    }
    // error.message carries the full argv (the agent's own script or text)
    // and stands in for a cause it does not name — describeExecFailure
    // reports the verb and the failure class the exec layer can vouch for.
    const rawDetail = describeExecFailure(error, args[0] || 'command', Date.now() - started);
    return {
      stdout: redactCdpUrls(capBrowserOutput(rawDetail, MAX_BROWSER_ERROR_CHARS)),
      exitCode: typeof error.code === 'number' ? error.code : 1,
    };
  }
}

/**
 * The URL the agent is shown: the page's own, except on Chrome's error page,
 * where it is the address that failed to load (error-page-url.ts).
 */
function addressBarUrl(s: BrowserSession, url: string): Promise<string> {
  return resolveErrorPageUrl(url, async () => activeTabAddress(
    await tabManager.queryTabs(s.key),
    getAllPageTargets,
    (left, right) => tabManager.urlsMatch(left, right),
  ));
}

/** An observation whose URL is the address bar's (see addressBarUrl). */
async function withAddressBarUrl(s: BrowserSession, obs: PageObservation): Promise<PageObservation> {
  const url = await addressBarUrl(s, obs.url);
  return url === obs.url ? obs : { ...obs, url };
}

/** Read the current URL after an action and build the navigation digest. */
async function observeUrlDigest(s: BrowserSession): Promise<UrlDigest | null> {
  const r = await execBrowser(['get', 'url'], s);
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;
  return s.urls.observe(await addressBarUrl(s, r.stdout.trim()));
}

/**
 * The frame the agent selected, read inside it: its address and title. Null
 * when none is selected; a remembered selection the CLI has since dropped (a
 * navigation, a tab change, the frame removed) is forgotten here.
 */
async function selectedFrame(s: BrowserSession): Promise<SelectedFrame | null> {
  if (!s.frame) return null;
  const r = await execBrowser(['eval', FRAME_INFO_SCRIPT], s);
  if (r.exitCode !== 0) return null;
  const frame = parseFrameInfo(r.stdout, s.frame);
  if (!frame && r.stdout.trim() === 'null') s.frame = null;
  return frame;
}

/** Run a page-observer script in the session's page (its top frame); null when the page cannot be read. */
async function observePage(s: BrowserSession, script: string): Promise<string | null> {
  const r = await probeTopFrame(s, script);
  return r.exitCode === 0 ? r.stdout : null;
}

/**
 * With 2x rendering on, what scales a capture to the page's CSS size, for the image the agent
 * gets. Its image's pixels are then the coordinates `mouse` takes, and it costs what it does at
 * 1x. The saved file stays as captured, because `diff screenshot` compares it with a new capture.
 */
async function screenshotCssScale(s: BrowserSession): Promise<number | undefined> {
  const scale = browserScale();
  if (!scale) return undefined;
  const ratio = await observePage(s, 'window.devicePixelRatio');
  // A page emulating another ratio (`set viewport`, `set device`) keeps what it asked for.
  return ratio !== null && Number(ratio) === scale ? 1 / scale : undefined;
}

/** One observation of the session's current page. */
async function observeNow(s: BrowserSession, opts: { previewChars?: number } = {}): Promise<PageObservation> {
  const out = await observePage(s, observerScript(opts));
  const obs = out === null ? null : parseObservation(out);
  return obs ? withAddressBarUrl(s, obs) : EMPTY_OBSERVATION;
}

/**
 * The requests an action issued (network-activity.ts), for how long its
 * settle waits. The log is cleared as each action starts, so an agent's own
 * `network requests` lists what was issued since its last action.
 */
const actionNetwork = (s: BrowserSession) => ({
  start: async (): Promise<boolean> => (await execBrowser(['network', 'requests', '--clear'], s)).exitCode === 0,
  since: async (): Promise<NetworkActivity | null> => {
    const r = await execBrowser(['network', 'requests', '--json', '--type', 'xhr,fetch'], s, { outputCap: MAX_SNAPSHOT_RAW_CHARS });
    return r.exitCode === 0 ? parseNetworkActivity(r.stdout) : null;
  },
});

/** Budget for the tree read after an action — a heavy page's tree takes ~1 s. */
const TREE_READ_TIMEOUT_MS = 10_000;

/**
 * Since 0.44 a snapshot whose page loaded a new document while it was being
 * captured fails ("The document changed while the snapshot was being
 * captured … Take the snapshot again", upstream #2685) instead of mixing two
 * documents' nodes. The new document is there to read: take it once more.
 */
const SNAPSHOT_DOCUMENT_CHANGED = /The document changed while the snapshot was being captured/;

/** A snapshot of the session's page, taken again once when the document changed under it. */
async function readSnapshot(s: BrowserSession, args: string[], opts: BrowserExecOptions = {}): ReturnType<typeof runBrowserCommand> {
  const first = await execBrowser(args, s, opts);
  if (first.exitCode === 0 || !SNAPSHOT_DOCUMENT_CHANGED.test(first.stdout)) return first;
  return execBrowser(args, s, opts);
}

/**
 * Read the interactive tree after an action and diff it, by ref, against the
 * last tree the agent was shown on this page (tree-diff.ts). The read becomes
 * the new baseline either way. Null when it could not run or there was no
 * baseline for this page to compare with.
 */
async function readTreeDiff(s: BrowserSession, url: string, exclude: { refs?: string[]; subtrees?: string[]; overlayOpened?: boolean }, docStart = 0): Promise<EffectTreeDiff | null> {
  const prior = s.trees.get(url, docStart);
  const r = await readSnapshot(s, ['snapshot', '-i', '-c'], { timeoutMs: TREE_READ_TIMEOUT_MS, outputCap: MAX_SNAPSHOT_RAW_CHARS });
  if (r.exitCode !== 0) return null;
  const now = Date.now();
  // Diff before the read becomes the baseline: the baseline's `seen` lines
  // carry over to the next one and would already include this read.
  const result = prior
    ? {
      diff: diffTrees(prior.refs, parseTreeRefs(r.stdout), { excludeRefs: exclude.refs, excludeSubtrees: exclude.subtrees, seen: prior.seen, acknowledged: prior.acknowledged, overlayOpened: exclude.overlayOpened }),
      baselineAgeMs: now - prior.takenAt,
      baselineSource: prior.source,
    }
    : null;
  s.trees.set(url, r.stdout, 'action', now, docStart);
  return result;
}

/**
 * Run a mutating action through the settle primitive (action-settle.ts) so
 * the result can say what the action did rather than only whether the URL
 * moved. The "after" observation also supplies the URL, so this replaces the
 * post-action `get url` at no extra round trip; a failed read falls back to
 * it. No effect is reported across a navigation. When the effect is
 * structural, the changed elements come back as a tree diff with their refs.
 */
async function runWithEffect(
  s: BrowserSession,
  action: (before: PageObservation | null) => Promise<{ exitCode: number; stdout: string }>,
  policy: ActionPolicy,
  opts: { excludeRefs?: string[]; excludeSubtrees?: string[] } = {},
): Promise<{ result: { exitCode: number; stdout: string }; digest: UrlDigest | null; effect: ActionEffect | null; settleMs: number; treeDiff: EffectTreeDiff | null; docStart: number }> {
  const settled = await observeAction({
    exec: action,
    isFailure: r => r.exitCode !== 0,
    evalScript: (script) => observePage(s, script),
    policy,
    network: actionNetwork(s),
  });
  noteChallenge(settled.before);
  noteChallenge(settled.after);
  if (settled.result.exitCode !== 0) return { result: settled.result, digest: null, effect: null, settleMs: 0, treeDiff: null, docStart: 0 };
  const lastReported = s.urls.last();
  const recorded = settled.after?.url ? s.urls.observe(await addressBarUrl(s, settled.after.url)) : await observeUrlDigest(s);
  // With both reads in hand, the action navigated when the URL differs
  // between them — not when it differs from the last URL some earlier call
  // recorded (a page that moved on its own before this action did not
  // "navigate" on it).
  const reloaded = settled.before?.url === settled.after?.url && newDocument(settled.before, settled.after);
  const movedBefore = lastReported !== null && settled.before?.url && settled.before.url !== lastReported && (await addressBarUrl(s, settled.before.url)) !== lastReported;
  const observed = recorded && settled.before?.url && settled.after?.url
    ? { ...recorded, navigated: settled.before.url !== settled.after.url || reloaded, ...(reloaded ? { reloaded: true } : {}), ...(movedBefore ? { changedBefore: lastReported } : {}) }
    : recorded;
  // A URL change inside one document (an SPA route, a hash) is not a page
  // load: the effect and the refs carry over, and the result says so.
  const sameDoc = Boolean(observed?.navigated) && sameDocument(settled.before, settled.after);
  const digest = observed && sameDoc ? { ...observed, sameDocument: true } : observed;
  const effect = digest?.navigated && !sameDoc ? null : settled.effect;
  const docStart = settled.after?.docStart ?? 0;
  const treeDiff = effect && digest && effectWantsTree(effect, policy.verb)
    ? await readTreeDiff(s, digest.url, { refs: opts.excludeRefs, subtrees: opts.excludeSubtrees, overlayOpened: effect.opened.length > 0 }, docStart)
    : null;
  return { result: settled.result, digest, effect, settleMs: settled.waitedMs, treeDiff, docStart };
}

/**
 * The CLI's answer that a ref's element is gone (`✗ Unknown ref: eN`, or a
 * role+name fallback that found none or several — tree-diff.ts goneRefOf),
 * plus what eN was when the agent last saw it and which current refs carry
 * exactly that line (formatUnknownRef). Refs persist since 0.38, so this
 * means the element left the tree — most often a site re-rendering it under
 * a new ref. Costs one tree read, only on this error; the read becomes the
 * baseline.
 */
async function explainUnknownRef(s: BrowserSession, stdout: string, actionRef?: string): Promise<string> {
  const ref = goneRefOf(stdout, actionRef);
  if (!ref) return stdout;
  // By document, not URL: after an in-page URL change (a back within the
  // page, a hash) the baseline is still this document's.
  const page = await observeNow(s);
  if (!page.url) return stdout;
  const was = s.trees.get(page.url, page.docStart)?.seen.get(ref);
  if (!was) {
    // A ref from before the page loaded a new document (the observer's load
    // start moved on): every ref of that document is gone.
    const old = s.trees.fromPreviousDocument(ref, page.url, page.docStart);
    return old
      ? `${stdout}\n${ref} was ${lineWithoutRef(old.text).slice(0, 160)} on the previous page load (${old.url}); the page has loaded a new document since, and refs from before the load do not carry over.`
      : stdout;
  }
  const fresh = await readSnapshot(s, ['snapshot', '-i', '-c'], { timeoutMs: TREE_READ_TIMEOUT_MS, outputCap: MAX_SNAPSHOT_RAW_CHARS });
  if (fresh.exitCode !== 0) return stdout;
  s.trees.set(page.url, fresh.stdout, 'action', Date.now(), page.docStart);
  return stdout + formatUnknownRef(ref, was, parseTreeRefs(fresh.stdout));
}

/**
 * Run a ref action; when the CLI answers `Unknown ref` for it, read the tree
 * once and, if the ref is in it, run the action again. The CLI drops its whole
 * ref table when a tab command runs (new, switch, close, a click that opens a
 * tab, a new window), and a read brings every ref back unchanged — so the
 * agent's ref was right all along. A ref of a document the page has since
 * replaced is refused as such (0.44+) and is not retried: it is not coming back.
 * When the ref is not back, the first answer stands (explainUnknownRef).
 */
async function withRefRestore(s: BrowserSession, ref: string | undefined, run: () => Promise<{ exitCode: number; stdout: string }>): Promise<{ exitCode: number; stdout: string }> {
  const r = await run();
  const id = r.exitCode !== 0 && ref ? /Unknown ref: @?(e\d+)/.exec(r.stdout)?.[1] : undefined;
  if (!id || id !== ref?.replace(/^@/, '')) return r;
  const fresh = await readSnapshot(s, ['snapshot', '-i', '-c'], { timeoutMs: TREE_READ_TIMEOUT_MS, outputCap: MAX_SNAPSHOT_RAW_CHARS });
  if (fresh.exitCode !== 0 || !parseTreeRefs(fresh.stdout).lines.has(id)) return r;
  console.log(`[Browser] ${id} was unknown to the CLI but is in a fresh read — running the action again`);
  return run();
}

/** The session's tab, as a key for per-tab state: its CDP target id when the daemon reports one. */
async function activeTabKey(s: BrowserSession): Promise<string> {
  try {
    const active = (await tabManager.queryTabs(s.key)).find(t => t.active);
    return active?.targetId || active?.tabId || 'active';
  } catch {
    return 'active';
  }
}

/**
 * Forget everything kept about the browser that just went away: the
 * screenshots an "unchanged" answer would name and the sites that served a
 * challenge to it. What each session kept (the tree the next action would be
 * diffed against, a traffic capture) went with its BrowserSession.
 */
function resetPerBrowserState(): void {
  forgetScreenshots();
  resetChallengedSites();
  closePreparedLogins();
  forgetInjectedSecrets();
  void passkeyKeeper.disarm();
}

/**
 * Requests only answerable while the browser exists: a hand-off. They may
 * belong to a session other than the one that closed it (a background
 * subagent parked on a hand-off); with `sessionId`, only that session's (it
 * stopped using the browser, which others still use). A sign-in is not one of
 * them: the user may answer it long after its browser closed, and what they
 * save then signs the agent in once it opens the page again.
 */
function rejectBrowserBoundInputs(reason: string, sessionId?: string): void {
  inputManager.rejectByType('browser_input', reason, sessionId);
}

/**
 * Read back the committed value of a field after fill/type.
 *
 * `get value` reads `.value`, which contenteditable widgets (LinkedIn's message
 * box, rich-text editors) do not expose — it returns "" for them even when text
 * is present. The false-empty read-back made agents believe their keystrokes
 * had not landed and re-type, duplicating text. When `get value` is empty we
 * fall back to `get text`, which IS populated for contenteditables.
 */
async function readCommittedFieldValue(s: BrowserSession, ref: string): Promise<string | null> {
  const value = await execBrowser(['get', 'value', ref], s);
  const valueRead = { ok: value.exitCode === 0, text: value.stdout.trim() };
  if (valueRead.ok && valueRead.text !== '') return valueRead.text;

  // Empty/unreadable `.value`: read text content to catch contenteditables.
  const text = await execBrowser(['get', 'text', ref], s);
  const textRead = { ok: text.exitCode === 0, text: text.stdout.trim() };
  return resolveCommittedValue(valueRead, textRead);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface HostBrowserInfo {
  cdpUrl: string;
  /** Host-filesystem path where Chrome should save downloads */
  hostDownloadDir: string;
}

// Relay a container-side browser-launch failure to the host for Sentry.
// Only called for failures after the launch request itself succeeded — the
// host is known reachable at that point, but has no other way to learn this
// half of the launch broke (the error otherwise surfaces only in the agent's
// tool result). Fire-and-forget: reporting must never mask the real error.
function reportHostBrowserLaunchError(
  hostAppUrl: string,
  headers: Record<string, string>,
  stage: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  void fetch(`${hostAppUrl}/api/browser/report-launch-error`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agentId: process.env.AGENT_ID || 'default', stage, message }),
  }).catch(() => {});
}

// Launch the host browser via CDP when this open request resolved to the host.
// Returns the CDP WebSocket URL and host download dir, or undefined if not using host browser.
// Throws if the request resolves to the host but that browser fails to launch.
async function launchHostBrowserIfNeeded(location: BrowserRuntimeLocation): Promise<HostBrowserInfo | undefined> {
  if (location !== 'host') {
    return undefined;
  }

  const hostAppUrl = process.env.HOST_APP_URL;
  if (!hostAppUrl) {
    throw new Error('Host browser mode is enabled but HOST_APP_URL is not configured');
  }

  const agentId = process.env.AGENT_ID;

  const proxyToken = process.env.PROXY_TOKEN;
  const browserAuthHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (proxyToken) browserAuthHeaders['Authorization'] = `Bearer ${proxyToken}`;

  // A network-level failure here means the launch request never reached the
  // host app at all — the host never launches Chrome and never reports to
  // Sentry, so this bare 'fetch failed' used to be the only trace. On Windows
  // it is almost always Windows Firewall blocking the app's API port for
  // container (WSL2) traffic, e.g. after the first-run firewall prompt was
  // dismissed. Surface that diagnosis instead.
  let response: Response;
  try {
    response = await fetch(`${hostAppUrl}/api/browser/launch-host-browser`, {
      method: 'POST',
      headers: browserAuthHeaders,
      body: JSON.stringify({ agentId: agentId || 'default' }),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach the host app at ${hostAppUrl} to launch the browser (${cause}). ` +
      `Connections from the agent container to the host machine appear to be blocked — on Windows this is usually ` +
      `Windows Defender Firewall blocking the app (open "Allow an app through Windows Firewall" and enable it for both Private and Public networks), ` +
      `or third-party antivirus. Ask the user to allow the app through their firewall, then try again.`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to launch host browser: ${body}`);
  }

  const data = await response.json() as { port?: number; cdpUrl?: string; downloadDir?: string };

  // Remote providers (e.g. Browserbase) return a CDP URL directly
  if (data.cdpUrl) {
    return { cdpUrl: data.cdpUrl, hostDownloadDir: data.downloadDir || '' };
  }

  // Local providers (e.g. Chrome) return a port — resolve to CDP URL
  if (!data.port) {
    throw new Error('Host browser response missing both cdpUrl and port');
  }

  // Derive the CDP host from HOST_APP_URL - the same address the
  // launch-host-browser request above already reached the host at. Chrome's CDP
  // server validates the Host header and rejects hostnames, so resolveCdpIp
  // returns an IP. Apple containers can't resolve host.docker.internal (no
  // --add-host equivalent), so there HOST_APP_URL is the host gateway IP and no
  // DNS is needed; Docker/Lima/WSL2 keep host.docker.internal, which their
  // runtime maps.
  let cdpIp: string;
  try {
    cdpIp = await resolveCdpIp(hostAppUrl);
  } catch (err) {
    reportHostBrowserLaunchError(hostAppUrl, browserAuthHeaders, 'resolve-cdp-host', err);
    throw err;
  }

  // Chrome's CDP requires connecting to the full debugger WebSocket URL
  // (ws://host:port/devtools/browser/<id>), not just ws://host:port.
  // Query Chrome's /json/version endpoint to discover it.
  const cdpHost = `${cdpIp}:${data.port}`;
  // A network-level failure here (vs. an HTTP error) means the host browser
  // launched but this container can't reach its debugging port — on Windows
  // that is almost always the host firewall dropping container→host traffic.
  // Surface that diagnosis instead of an opaque "fetch failed".
  let versionRes: Response;
  try {
    versionRes = await fetch(`http://${cdpHost}/json/version`);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const error = new Error(
      `The host browser launched, but its debugging endpoint at ${cdpHost} is unreachable from inside the agent container (${cause}). ` +
      `This usually means a firewall on the host machine is blocking container-to-host connections ` +
      `(on Windows: Windows Defender Firewall or antivirus blocking the app on the "vEthernet (WSL)" network). ` +
      `Ask the user to allow the app through their firewall, or to switch Browser Host to the built-in browser in Settings.`
    );
    reportHostBrowserLaunchError(hostAppUrl, browserAuthHeaders, 'cdp-endpoint-unreachable', error);
    throw error;
  }
  if (!versionRes.ok) {
    throw new Error(`Failed to query CDP /json/version: ${versionRes.status}`);
  }
  const versionData = await versionRes.json() as { webSocketDebuggerUrl: string };

  // The URL returned by Chrome uses the IP we connected with, so it's
  // already usable. Replace the host portion just in case Chrome returns
  // localhost or a different address.
  const debuggerUrl = versionData.webSocketDebuggerUrl.replace(
    /^ws:\/\/[^/]+/,
    `ws://${cdpHost}`
  );
  return { cdpUrl: debuggerUrl, hostDownloadDir: data.downloadDir || '' };
}

// Use CDP to tell Chrome where to save downloads. This must be called AFTER
// agent-browser has connected (via --cdp) so our call is the last to set
// the download behavior, overriding Playwright's internal interception.
async function setDownloadBehaviorViaCDP(cdpUrl: string, downloadPath: string): Promise<void> {
  if (!downloadPath) return;

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(cdpUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('CDP setDownloadBehavior timed out'));
    }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Browser.setDownloadBehavior',
        params: {
          behavior: 'allowAndName',
          downloadPath,
          eventsEnabled: false,
        },
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === 1) {
        clearTimeout(timeout);
        ws.close();
        if (msg.error) {
          reject(new Error(`CDP error: ${msg.error.message}`));
        } else {
          resolve();
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// The CDP download path applied for the current browser (host path in host
// mode, /workspace/downloads locally). Playwright connections made mid-session
// (browser_upload/browser_download) can clobber Browser.setDownloadBehavior,
// so we remember what we applied and re-apply it after those calls.
let appliedCdpDownloadPath: string | null = null;

async function reapplyDownloadBehavior(): Promise<void> {
  if (!browserState.cdpUrl || !appliedCdpDownloadPath) return;
  try {
    await setDownloadBehaviorViaCDP(browserState.cdpUrl, appliedCdpDownloadPath);
  } catch (err) {
    console.error('[Browser] Failed to re-apply download behavior via CDP:', err);
  }
}

// Tell the host to stop the Chrome process for this agent.
async function stopHostBrowserIfNeeded(location: BrowserRuntimeLocation | null): Promise<void> {
  if (location !== 'host') return;

  const hostAppUrl = process.env.HOST_APP_URL;
  if (!hostAppUrl) return;

  const agentId = process.env.AGENT_ID || 'default';

  try {
    const proxyToken = process.env.PROXY_TOKEN;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (proxyToken) headers['Authorization'] = `Bearer ${proxyToken}`;

    await fetch(`${hostAppUrl}/api/browser/stop-host-browser`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId }),
    });
  } catch (error) {
    console.error('[Browser] Error stopping host browser:', error);
  }
}

// Broadcast a browser_active event to a session's WebSocket subscribers, under
// every id it has had: the host subscribed under the first.
function broadcastBrowserEvent(active: boolean, s: BrowserSession): void {
  for (const sessionId of s.ids()) {
    // Broadcast through the session manager's subscriber system
    sessionManager.broadcast(sessionId, {
      type: 'browser_active',
      active,
      timestamp: new Date().toISOString(),
    });
  }
}

// GET /browser/status - Check if browser is running, and which sessions use
// it. `generation` names this opening of it: a saved-session watch on the host
// tells a browser closed and opened again between two of its looks.
app.get('/browser/status', (c) => {
  return c.json({ ..._getBrowserState(), sessionIds: browserSessions().flatMap(s => s.ids()), generation: browserOpenGeneration });
});

/**
 * Launches, attaches and closes run one at a time: a session attaching while
 * another closes the browser, or two attaching to a Chrome that just launched
 * (agent-browser#1762: refs then silently miss), would each see the browser
 * half done.
 */
let browserLifecycle: Promise<unknown> = Promise.resolve();
function inBrowserLifecycle<T>(work: () => Promise<T>): Promise<T> {
  const run = browserLifecycle.then(work, work);
  browserLifecycle = run.catch(() => {});
  return run;
}

/** Page targets that are blank: what a launched Chrome starts with, and what an attaching session's instance opens. */
function isBlankPage(url: string): boolean {
  return url === 'about:blank' || url.startsWith('chrome://newtab') || url.startsWith('chrome://new-tab-page');
}

/** Run `work` over a short-lived connection to the browser itself. */
async function withBrowserConnection<T>(work: (cdp: CdpConnection) => Promise<T>): Promise<T> {
  const cdp = await CdpConnection.openBrowser(await browserWsUrl());
  try {
    return await work(cdp);
  } finally {
    cdp.close();
  }
}

/** Close tabs by CDP target id, over one browser-level connection; best-effort. */
async function closeTargets(targetIds: string[]): Promise<void> {
  if (targetIds.length === 0) return;
  await withBrowserConnection(async (cdp) => {
    for (const targetId of targetIds) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }).catch((err) => console.error('[Browser] Could not close tabs:', err instanceof Error ? err.message : err));
}

/**
 * Bring a tab to the front of its window. Target.activateTarget, unlike
 * Page.bringToFront, does not steal the OS window focus.
 */
function activateTarget(targetId: string): Promise<void> {
  return withBrowserConnection(async (cdp) => { await cdp.send('Target.activateTarget', { targetId }); });
}

/** Every session's current tab, by CDP target id. A session whose instance does not answer has none. */
async function currentTabs(sessions: BrowserSession[]): Promise<Map<string, BrowserSession>> {
  const current = new Map<string, BrowserSession>();
  await Promise.all(sessions.map(async (s) => {
    const targetId = (await tabManager.queryTabs(s.key).catch(() => [])).find(t => t.active)?.targetId;
    if (targetId) current.set(targetId, s);
  }));
  return current;
}

/** The session that opened a tab, or undefined when none we know of did. */
function openerOf(targetId: string): BrowserSession | undefined {
  return browserSessions().find(s => s.opened.has(targetId));
}

/**
 * Start the agent's browser where `location` says: the container's own Chrome,
 * launched by the owner instance, or the host's. Its first tabs are blank
 * pages nobody opened; once a session has a tab of its own, they go
 * (closeLaunchTabs), so a session sees only the tabs that were opened for it.
 */
async function launchBrowser(location: BrowserRuntimeLocation): Promise<{ closeLaunchTabs: () => Promise<void> }> {
  const hostBrowser = await launchHostBrowserIfNeeded(location);
  const profile = process.env.AGENT_BROWSER_PROFILE || '/workspace/.browser-profile';

  // Create /workspace/downloads and name it in the profile's preferences. The
  // headless shell does not read those preferences: the Chrome agent-browser
  // launches saves there because of AGENT_BROWSER_DOWNLOAD_PATH (Dockerfile),
  // and a host browser because of setDownloadBehaviorViaCDP below.
  await ensureBrowserDownloadPreferences(profile, WORKSPACE_DOWNLOADS_DIR);

  // Clear leftover instances first. While a browser is active they hold the
  // container's Chrome, so this cleanup (which pkills agent-browser and
  // headless Chrome) runs only here.
  cleanupAgentBrowserDaemon();

  let cdpUrl = hostBrowser?.cdpUrl;
  if (!cdpUrl) {
    const launch = () => execOwner(['open', 'about:blank', '--profile', profile]);
    let result = await launch();
    // Retry once on failure — agent-browser daemon startup can be flaky
    if (result.exitCode !== 0) {
      console.error('[Browser] First launch attempt failed, retrying:', result.stdout);
      cleanupAgentBrowserDaemon();
      await sleep(1000);
      result = await launch();
    }
    const endpoint = result.exitCode === 0 ? await execOwner(['get', 'cdp-url']) : result;
    if (endpoint.exitCode !== 0 || !/^wss?:\/\//.test(endpoint.stdout.trim())) {
      throw new Error(`${endpoint.stdout} [location=${location}, attempts=2]`);
    }
    cdpUrl = endpoint.stdout.trim();
  }

  // Override Playwright's download interception via CDP so downloads go to workspace.
  // For host browser: use the host-filesystem path (volume-mounted as /workspace).
  appliedCdpDownloadPath = null;
  if (hostBrowser) {
    try {
      await setDownloadBehaviorViaCDP(cdpUrl, hostBrowser.hostDownloadDir || WORKSPACE_DOWNLOADS_DIR);
      appliedCdpDownloadPath = hostBrowser.hostDownloadDir || WORKSPACE_DOWNLOADS_DIR;
    } catch (err) {
      console.error('[Browser] Failed to set download behavior via CDP:', err);
    }
  }

  browserOpenGeneration++;
  _setBrowserState({ active: true, cdpUrl, location });
  const launchTabs = (await getAllPageTargets()).filter(t => isBlankPage(t.url)).map(t => t.id);
  return { closeLaunchTabs: () => closeTargets(launchTabs) };
}

/**
 * The session starts using the active browser: its instance attaches and,
 * pinned, opens a blank tab of its own (the tab `open` then navigates). The
 * attach is a command of its own, so the lifecycle lock is held only that long.
 */
async function attachSession(sessionId: string): Promise<BrowserSession> {
  const s = attachBrowserSession(sessionId);
  // The session's tab goes in a window of its own. A Chrome with windows (a
  // host's) shows one tab per window, and in a tab behind another some clicks
  // report success but never land (agent-browser#2146). The instance opens its
  // tab in the window last opened: a placeholder's, which then closes.
  const placeholder = await openWindow();
  let attached = await execBrowser(['get', 'url'], s);
  // Retry once on failure — agent-browser daemon startup can be flaky
  if (attached.exitCode !== 0) {
    console.error(`[Browser] Session ${sessionId} could not attach, retrying:`, attached.stdout);
    await execBrowser(['close'], s);
    await sleep(1000);
    attached = await execBrowser(['get', 'url'], s);
  }
  if (placeholder) await closeTargets([placeholder]);
  if (attached.exitCode !== 0) {
    detachBrowserSession(s);
    await execBrowser(['close'], s);
    throw new Error(attached.stdout);
  }
  await noteOpenedTab(s);
  return s;
}

/** A blank page in a new window, by CDP target id; null when the browser would not open one. */
async function openWindow(): Promise<string | null> {
  return withBrowserConnection((cdp) => cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: true }))
    .then(({ targetId }) => targetId, (err) => {
      console.error('[Browser] Could not open a window:', err instanceof Error ? err.message : err);
      return null;
    });
}

/**
 * Chrome opens a new tab (`tab new`) in the window last brought forward,
 * which may hold another session's tab. It lands in this session's window:
 * the one its tab is in, brought forward first, or one of its own when it is
 * on no tab (a placeholder's, closed once the tab is in). Returns what to do
 * once the tab is open.
 */
async function prepareNewTabWindow(s: BrowserSession): Promise<() => Promise<void>> {
  const current = (await tabManager.queryTabs(s.key).catch(() => [])).find(t => t.active)?.targetId;
  if (current) {
    // Best-effort: the tab then opens where Chrome puts it.
    await activateTarget(current).catch(() => {});
    return async () => {};
  }
  const placeholder = await openWindow();
  return async () => { if (placeholder) await closeTargets([placeholder]); };
}

/** The tab the session just attached on is one it opened; the browser's other tabs are not new to it. */
async function noteOpenedTab(s: BrowserSession): Promise<void> {
  const tabs = await tabManager.queryTabs(s.key).catch(() => []);
  s.seenTabs = new Set(tabs.flatMap(t => (t.targetId ? [t.targetId] : [])));
  const current = tabs.find(t => t.active)?.targetId;
  if (current && !openerOf(current)) s.opened.add(current);
  s.tabCount = ownTabCount(tabs, s.opened);
}

/** Count the session's tabs as its instance lists them now. */
async function syncTabCount(s: BrowserSession): Promise<void> {
  const tabs = await tabManager.queryTabs(s.key).catch(() => null);
  if (tabs) s.tabCount = ownTabCount(tabs, s.opened);
}

/** The browser's tabs as the session sees them now (session-tabs.ts). */
async function tabsAsSeen(s: BrowserSession): Promise<TabsAsSeen> {
  const [tabs, inUse] = await Promise.all([
    tabManager.queryTabs(s.key).catch(() => []),
    currentTabs(browserSessions().filter(other => other !== s)),
  ]);
  return {
    tabs,
    openedBy: (targetId) => {
      const opener = openerOf(targetId);
      return opener ? (opener === s ? 'this' : 'another') : null;
    },
    inUseByAnother: (targetId) => inUse.has(targetId),
  };
}

/** A pinned instance whose own tab it closed is left on no tab: move the session as agent-browser unpinned did. */
async function moveOffClosedTab(s: BrowserSession, closedAt: number): Promise<void> {
  const next = tabAfterClose(await tabsAsSeen(s), closedAt);
  if (next) await execBrowser(['tab', next], s);
}

/** Each page's opener (the tab it was opened from), by CDP target id. */
async function pageOpeners(): Promise<Map<string, string>> {
  const { targetInfos } = await withBrowserConnection((cdp) => cdp.send<{ targetInfos: Array<{ targetId: string; type: string; openerId?: string }> }>('Target.getTargets'));
  return new Map(targetInfos.flatMap(t => (t.type === 'page' && t.openerId ? [[t.targetId, t.openerId] as const] : [])));
}

/**
 * A tab this session opened since it last looked: with its own `tab new`, or
 * a page one of its tabs opened (a target="_blank" link, window.open). A
 * pinned instance stays on its tab when a page opens, so the session is moved
 * to the newest such page here: where an agent that clicked such a link has
 * always found itself. Tabs other sessions or the user opened are not this
 * session's, and it stays where it is.
 */
async function detectNewTab(s: BrowserSession): Promise<NewTabResult | null> {
  try {
    const tabs = await tabManager.queryTabs(s.key);
    s.tabCount = ownTabCount(tabs, s.opened);
    const fresh = tabs.filter(t => t.targetId && !s.seenTabs.has(t.targetId));
    s.seenTabs = new Set(tabs.flatMap(t => (t.targetId ? [t.targetId] : [])));
    if (fresh.length === 0) return null;

    let tab = fresh.find(t => t.active);
    let mine = tab ? [tab] : [];
    if (!tab) {
      mine = popupsOf(fresh, tabs.find(t => t.active)?.targetId, s.opened, await pageOpeners());
      tab = mine[mine.length - 1];
      if (!tab) return null;
      const switched = await execBrowser(['tab', tab.targetId!], s);
      if (switched.exitCode !== 0) return null;
    }
    for (const t of mine) if (!openerOf(t.targetId!)) s.opened.add(t.targetId!);
    s.tabCount = ownTabCount(tabs, s.opened);
    return { newTab: true, activeId: tab.tabId, activeUrl: tab.url, tabCount: s.tabCount };
  } catch {
    // Tab detection is best-effort — don't fail the action if the daemon is unavailable
    return null;
  }
}

/**
 * A session stops using the browser while others go on: its instance lets go
 * of its tab, and the tabs it opened that no other session is on now close.
 */
async function detachSession(s: BrowserSession, reason: string): Promise<void> {
  // In one synchronous block, as a whole-browser close does: a hand-off the
  // session asks for from here on finds no browser of its own.
  detachBrowserSession(s);
  cleanupCdpScreencast(s);
  broadcastBrowserEvent(false, s);
  for (const id of s.ids()) closePreparedLogins(id);
  for (const id of s.ids()) rejectBrowserBoundInputs(reason, id);
  await execBrowser(['close'], s);
  const inUse = await currentTabs(browserSessions());
  await closeTargets([...s.opened].filter(id => !inUse.has(id)));
  const remaining = browserSessions()[0];
  if (remaining) await syncTabCount(remaining);
  notifyBrowserAction();
  console.log(`[Browser] Session ${s.sessionId} stopped using the browser (${browserSessions().length} still on it)`);
}

/** Close the agent's browser: Chrome itself, and every session's use of it. */
async function closeBrowser(reason: string): Promise<void> {
  const { location } = browserState;
  const sessions = browserSessions();
  if (location === 'container') await execOwner(['close']);
  cleanupAgentBrowserDaemon();
  await stopHostBrowserIfNeeded(location);
  cleanupCdpScreencast();
  for (const s of sessions) broadcastBrowserEvent(false, s);
  _setBrowserState({ active: false, cdpUrl: null, location: null });
  resetPerBrowserState();
  rejectBrowserBoundInputs(reason);
}

// A session that ended (deleted, evicted while idle, an automated turn done)
// stops using the browser. The last one leaves the browser running
// (browser-state.ts), with its instance and tabs, as before sessions shared it.
onBrowserSessionReleased((s, last) => {
  if (last) {
    cleanupCdpScreencast(s);
    broadcastBrowserEvent(false, s);
    return;
  }
  void inBrowserLifecycle(() => detachSession(s, 'The session ended before the user completed this request')).catch((err) => {
    console.error(`[Browser] Releasing session ${s.sessionId} failed:`, err);
  });
});


/** A URL's #fragment, '' when it has none or does not parse. */
function urlHash(url: string): string {
  try { return new URL(url).hash; } catch { return ''; }
}

// POST /browser/open - Start browser and navigate to URL
app.post('/browser/open', async (c) => {
  try {
    const body = await c.req.json<{
      sessionId: string;
      url: string;
      location?: BrowserOpenLocation;
    }>();

    if (!body.sessionId || !body.url) {
      return c.json({ error: 'sessionId and url are required' }, 400);
    }
    if (body.location !== undefined && !BROWSER_OPEN_LOCATIONS.some(value => value === body.location)) {
      return c.json({ error: `location must be one of: ${BROWSER_OPEN_LOCATIONS.join(', ')}` }, 400);
    }

    const location = resolveBrowserRuntimeLocation(body.location, browserState.location);
    if (shouldRefuseImplicitHostLoopback(body.url, body.location, location)) {
      return c.json({
        error:
          'This loopback URL would open on the host machine because no browser location was specified. ' +
          'Retry with location="container" for a service inside the agent container, or explicitly pass ' +
          'location="configured" to open the host browser\'s loopback interface. The current browser was left unchanged.',
      }, 400);
    }
    let switchedFrom: BrowserRuntimeLocation | null = null;

    let s = browserSessionOf(body.sessionId);
    // A browser net-new to this session (it just attached: to a browser it
    // launched, or one another session uses) is the one moment the
    // browser-guide hint belongs on the result.
    let launched = false;
    // A session's first open lands in the tab its instance opened on attaching.
    const attaching = !s || requiresBrowserLocationSwitch(browserState.location, location);
    if (attaching) {
      s = await inBrowserLifecycle(async () => {
        // The browser tools expose one active browser abstraction. Changing its
        // process location therefore closes the old provider before launching the
        // new one, rather than leaving an unreachable browser consuming resources.
        if (requiresBrowserLocationSwitch(browserState.location, location)) {
          if (browserState.active && browserSessions().some(other => other.sessionId !== body.sessionId)) {
            const where = browserState.location === 'container' ? 'the agent container' : 'the configured browser provider';
            throw new BrowserOpenRefusal(
              `Another session of this agent is using the browser in ${where}, and opening at location="${body.location}" would close it. ` +
              'The browser was left unchanged; omit location to open the page in it.',
            );
          }
          switchedFrom = browserState.location;
          await closeBrowser('The browser provider changed before the user completed this request');
        }
        const existing = browserSessionOf(body.sessionId);
        if (existing) return existing;
        let closeLaunchTabs: (() => Promise<void>) | null = null;
        if (!browserState.active) ({ closeLaunchTabs } = await launchBrowser(location));
        try {
          const session = await attachSession(body.sessionId);
          launched = true;
          await closeLaunchTabs?.();
          return session;
        } catch (error) {
          // A browser launched for this session, with no session on it.
          if (closeLaunchTabs) await closeBrowser('The browser failed to open');
          throw error;
        }
      });
    }
    if (!s) throw new Error('The browser session is missing');
    if (!attaching) {
      // A tab already at this URL, unless another session is on it now (its
      // instance holds that tab: the switch would fail).
      const inUse = await currentTabs(browserSessions().filter(other => other !== s));
      const matchingTab = await tabManager.findMatchingTab(s.key, body.url, (tab) => !inUse.has(tab.targetId ?? ''));
      if (matchingTab) {
        if (!matchingTab.active) {
          await execBrowser(['tab', matchingTab.tabId], s);
          await syncTabCount(s);
          // The tree baseline is the session's tab's; the same tab keeps its own.
          s.trees.reset();
        }
        s.urls.observe(matchingTab.url); // seed URL baseline for post-action digests
        // An anchor the tab is not at (#section-b on a tab at #section-a):
        // the tab is now active, and the open below takes it there.
        const wantHash = urlHash(body.url);
        if (!wantHash || wantHash === urlHash(matchingTab.url)) {
          notifyBrowserAction();
          return c.json({
            success: true,
            switchedToExisting: true,
            tabId: matchingTab.tabId,
            url: matchingTab.url,
            location,
          });
        }
      }
    }

    let result = await execBrowser(['open', body.url], s);
    // The session's tab was closed under it (by another session, or the
    // user): the page opens in a new tab of its own.
    if (result.exitCode !== 0 && /tab_gone/.test(result.stdout)) {
      const opened = await prepareNewTabWindow(s);
      result = await execBrowser(['tab', 'new', body.url], s);
      await opened();
      if (result.exitCode === 0) await noteOpenedTab(s);
    }

    // A navigation Chrome answered with its own error page (refused
    // connection, unknown host, TLS failure) is the browser working: the CLI
    // exits non-zero, but the tab is on Chrome's error document for that
    // address, and the landing report below says so.
    const navNetError = result.exitCode !== 0 ? navigationNetError(result.stdout) : null;
    if (result.exitCode !== 0 && !navNetError) {
      return c.json({ error: `${result.stdout} [location=${location}]`, success: false }, 500);
    }

    // The daemon's count, not the one from before: the launch tabs closed
    // after the session attached, and a stale count reads as a tab more.
    await syncTabCount(s);
    s.urls.reset();
    // A new document: no tree from before it can be diffed against.
    s.trees.reset();
    // Read the landing page once: it seeds the URL baseline so the FIRST
    // post-action digest can distinguish "navigated" from "unchanged", and it
    // tells the tool where the browser actually ended up — final URL, title,
    // HTTP status, challenge wall, net error — instead of echoing the requested
    // URL (transcript-mining theme 2: a 429, a login redirect and about:blank
    // all used to read "Browser opened and navigating to <url>").
    const observed = await observeNow(s, { previewChars: THIN_TREE_PREVIEW_CHARS });
    // The headless shell's error page carries no ERR_ code in its text; the
    // CLI's navigation error does.
    const page = navNetError && observed.url && (!observed.netError || observed.netError === 'net error')
      ? { ...observed, netError: navNetError }
      : observed;
    noteChallenge(page);
    if (page.url) {
      s.urls.observe(page.url);
    } else {
      const fallback = await execBrowser(['get', 'url'], s);
      if (fallback.exitCode === 0 && fallback.stdout.trim()) s.urls.observe(await addressBarUrl(s, fallback.stdout.trim()));
    }
    broadcastBrowserEvent(true, s);
    notifyBrowserAction();

    return c.json({ success: true, location, switchedFrom, page, launched });
  } catch (error: any) {
    if (error instanceof BrowserOpenRefusal) return c.json({ error: error.message }, 409);
    console.error('[Browser] Error opening browser:', error);
    return c.json({ error: error.message || 'Failed to open browser' }, 500);
  }
});

/** An open the browser's other sessions rule out; nothing was changed. */
class BrowserOpenRefusal extends Error {}

// POST /browser/close - Stop browser
app.post('/browser/close', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    // A browser_input request is only answerable while the browser exists —
    // and it may belong to a background subagent parked on a login while the
    // main agent closes the browser. Both closes reject them, so blocked
    // awaiters unblock instead of hanging for the 24h human-input TTL behind a
    // card the user can no longer act on.
    const reason = 'The browser was closed before the user completed this request';
    const othersStay = await inBrowserLifecycle(async () => {
      const s = browserSessionOf(body.sessionId);
      // Other sessions still use it: only this session lets go, and its tabs close.
      if (s && browserSessions().some(other => other !== s)) {
        await detachSession(s, reason);
        return true;
      }
      // The last one (or a close with no browser of this session's, as from the
      // viewer's close button after a restart): Chrome itself goes.
      if (s || browserSessions().length === 0) await closeBrowser(reason);
      return browserSessions().length > 0;
    });

    return c.json({ success: true, othersStay });
  } catch (error: any) {
    console.error('[Browser] Error closing browser:', error);
    return c.json({ error: error.message || 'Failed to close browser' }, 500);
  }
});

// POST /browser/release - The session stops using the browser without closing it.
// Used by automated sessions (cron/webhook) on exit: the browser, its cookies
// and the other sessions' tabs stay.
app.post('/browser/release', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const released = releaseBrowserSession(body.sessionId);
    if (released) {
      console.log(`[Browser] Released by session ${body.sessionId} (browser still running)`);
    }
    return c.json({ success: true, released });
  } catch (error: any) {
    console.error('[Browser] Error releasing browser:', error);
    return c.json({ error: error.message || 'Failed to release browser' }, 500);
  }
});

/**
 * Drop every trace of a browser the user closed on us.
 *
 * Reached two ways: the host telling us Chrome's process died, and the
 * screencast finding no page left to stream (macOS keeps Chrome alive after
 * its last window closes, so only the second one catches that). Until this
 * runs, /browser/status keeps answering "active" and the viewer keeps
 * reconnecting to a browser that no longer exists.
 *
 * The state reset is synchronous: callers that also close a viewer socket rely
 * on the status endpoint already answering "inactive" by the time they do.
 */
async function handleExternalBrowserClose(
  reason: string,
  options: { stopHostBrowser: boolean },
): Promise<void> {
  const sessions = browserSessions();
  const location = browserState.location;

  if (location) {
    cleanupAgentBrowserDaemon();
    cleanupCdpScreencast();
    for (const s of sessions) broadcastBrowserEvent(false, s);
    _setBrowserState({ active: false, cdpUrl: null, location: null });
    resetPerBrowserState();
    console.log(`[Browser] Browser closed externally (${reason}), state cleaned up`);
  }
  // Outside the guard: an external close can race the active flag, and a
  // pending browser_input is unanswerable once the browser is gone either way.
  rejectBrowserBoundInputs('The browser was closed before the user completed this request');

  // Only when we detected this ourselves. A host-driven close has already torn
  // the process down — the window is gone but, on macOS, the app it belonged
  // to is still running and still holding the profile.
  if (location && options.stopHostBrowser) {
    await stopHostBrowserIfNeeded(location);
  }
}

// POST /browser/notify-closed - Host browser was closed externally, clean up state
app.post('/browser/notify-closed', async (c) => {
  await handleExternalBrowserClose('host reported the process exited', { stopHostBrowser: false });
  return c.json({ success: true });
});

// POST /browser/snapshot - Get accessibility tree snapshot
app.post('/browser/snapshot', async (c) => {
  try {
    const body = await c.req.json<{
      sessionId: string;
      interactive?: boolean;
      compact?: boolean;
      json?: boolean;
      scope?: string;
      fullText?: boolean;
      includeUrls?: boolean;
    }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    const snapshotArgs = ['snapshot'];
    if (body.json) snapshotArgs.push('--json');
    // fullText drops BOTH -i and -c: each independently strips static text
    // (validation errors, prices, instructions) — audit P5.
    if (!body.fullText) {
      if (body.interactive !== false) snapshotArgs.push('-i');
      if (body.compact !== false) snapshotArgs.push('-c');
    }
    if (body.scope) snapshotArgs.push('-s', body.scope);
    if (body.includeUrls) snapshotArgs.push('--urls');

    // Observe the page and hold briefly while the document is still loading
    // (a snapshot right after `Enter` used to return `loading · 0 refs`). The
    // last observation feeds the status line, the text footer and the iframe
    // placeholders, so this is the snapshot's only page-side read. The long
    // preview is taken every time and trimmed below unless the tree turns out
    // to be thin.
    const { obs: observed, waitedMs } = await waitForLoaded(async () => {
      const out = await observePage(s, observerScript({ previewChars: THIN_TREE_PREVIEW_CHARS }));
      return out === null ? null : parseObservation(out);
    });
    const probe = observed ? await withAddressBarUrl(s, observed) : EMPTY_OBSERVATION;
    noteChallenge(probe);
    // What the agent now sees is the URL the next action is compared with: a
    // site that rewrote its URL after load must not make that action read as
    // a navigation (bench, Meta Ad Library: "Page NAVIGATED" on a dialog click).
    if (probe.url) s.urls.observe(probe.url);

    // The snapshot has its own cap (capSnapshot) that reports the true size;
    // the exec-level cap must not truncate first.
    const result = await readSnapshot(s, snapshotArgs, { outputCap: MAX_SNAPSHOT_RAW_CHARS });

    if (result.exitCode !== 0) {
      // A failed snapshot leaves the CLI's refs as they were (0.44+,
      // upstream #2666): a scope that matched nothing no longer resets them.
      return c.json({ error: result.stdout, success: false }, 500);
    }

    // A thin tree keeps the long text preview: `(no interactive elements)`
    // looks the same for a 401 body, a challenge wall and a hydrating SPA —
    // the text tells them apart (transcript-mining themes 1 and 2).
    const refCount = countRefs(result.stdout);
    const previewChars = refCount < THIN_TREE_REFS ? THIN_TREE_PREVIEW_CHARS : PREVIEW_CHARS;
    const iframes = probe.iframes;

    if (body.json) {
      // Try to parse JSON output
      try {
        const parsed = JSON.parse(result.stdout);
        return c.json({ ...parsed, iframes, tabCount: s.tabCount });
      } catch {
        return c.json({ snapshot: result.stdout, iframes, tabCount: s.tabCount });
      }
    }

    // fullText fetches the unfiltered tree (the CLI's -i and -c each strip
    // static text), so compaction has to happen here to stay text-preserving.
    const fullText = Boolean(body.fullText);
    const tree = fullText && body.compact !== false ? compactWithText(result.stdout) : result.stdout;

    // The tree the agent now holds is what the next action is diffed
    // against. Refs are assigned page-wide in every mode, so the default and
    // the fullText views both serve; a scoped tree holds only part of the
    // page and would read as everything else having been removed.
    if (!body.scope && probe.url) s.trees.set(probe.url, result.stdout, 'snapshot', Date.now(), probe.docStart);

    // With a frame selected the tree is that frame's (the CLI's snapshot
    // follows the selection): the page line says where the page is, the frame
    // line where the tree is from, and the page's text footer and frame
    // placeholders, which describe the page, are left out.
    const frame = await selectedFrame(s);
    const header = frame
      ? `${formatStatusLine(probe, null, { waitedMs })}\n${formatFrameLine(frame, refCount)}`
      : formatStatusLine(probe, refCount, { waitedMs });
    return c.json({
      snapshot:
        (header ? `${header}\n\n` : '') +
        capSnapshot(tree, Boolean(body.scope), frame ? undefined : probe.top.find(t => t.kind === 'dialog' || t.kind === 'alertdialog')) +
        (frame ? '' : formatTextFooter(probe, { fullText, scoped: Boolean(body.scope), previewChars }) + formatIframePlaceholders(iframes, tree)),
      iframes,
      page: { ...probe, preview: probe.preview.slice(0, previewChars) },
      ...(frame && { frame }),
      tabCount: s.tabCount,
    });
  } catch (error: any) {
    console.error('[Browser] Error taking snapshot:', error);
    return c.json({ error: error.message || 'Failed to take snapshot' }, 500);
  }
});

// POST /browser/click - Click element by ref
app.post('/browser/click', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; ref: string }>();

    if (!body.sessionId || !body.ref) {
      return c.json({ error: 'sessionId and ref are required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    // On a challenge wall, and on a site that served one, the click moves the
    // mouse along a human-like path first (challenge-input.ts).
    let humanInput = false;
    // Focus landing in a text field ends a click's wait only when the field is
    // what was clicked: a dialog's "Done" that hands focus back to a date
    // field is still closing (bench: Google Hotels).
    const target = s.trees.get((await tabManager.queryTabs(s.key).catch(() => [])).find(t => t.active)?.url ?? '')?.seen.get(body.ref.replace(/^@/, '')) ?? '';
    const clickedField = target === '' || /^(textbox|searchbox|combobox|textarea)\b/.test(target);
    const { result, digest, effect, settleMs, treeDiff } = await runWithEffect(
      s,
      (before) => {
        humanInput = useHumanInput(before);
        return withRefRestore(s, body.ref, () => execBrowser(['click', body.ref, ...(humanInput ? ['--human'] : [])], s));
      },
      clickedField ? ACTION_POLICIES.click : { ...ACTION_POLICIES.click, recheck: () => true },
    );

    if (result.exitCode !== 0) {
      return c.json({ error: await explainUnknownRef(s, result.stdout, body.ref), success: false }, 500);
    }

    const tabInfo = await detectNewTab(s);
    notifyBrowserAction();
    return c.json({ success: true, settleMs, ...(digest && { digest }), ...(effect && { effect }), ...(treeDiff && { treeDiff }), ...(tabInfo && { tabInfo }), ...(humanInput ? { humanInput: true } : {}) });
  } catch (error: any) {
    console.error('[Browser] Error clicking:', error);
    return c.json({ error: error.message || 'Failed to click' }, 500);
  }
});

// POST /browser/fill - Fill input by ref
app.post('/browser/fill', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; ref: string; value: string }>();

    if (!body.sessionId || !body.ref || body.value === undefined) {
      return c.json({ error: 'sessionId, ref, and value are required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    // Through the settle like a click: a fill can open a suggestion list,
    // raise a validation message or reveal fields, and the result should say
    // so. The field's own line is left out of the tree diff — the read-back
    // below reports it.
    const { result, digest, effect, settleMs, treeDiff, docStart } = await runWithEffect(
      s,
      // The value after `--`: "-v", "--json" or "--" are text to fill, not
      // flags (the CLI reads a flag-shaped argument before `--` as its own).
      () => withRefRestore(s, body.ref, () => execBrowser(['fill', body.ref, '--', body.value], s)),
      ACTION_POLICIES.fill,
      { excludeRefs: [body.ref] },
    );

    if (result.exitCode !== 0) {
      return c.json({ error: await explainUnknownRef(s, result.stdout, body.ref), success: false }, 500);
    }

    // Read the value back after the settle: the CLI reports success regardless
    // of what the page kept (maxlength truncation, JS reformatting,
    // keystroke-only widgets — audit F6).
    const committedValue = await readCommittedFieldValue(s, body.ref);
    // The agent now knows this field's value: the next tree diff must not
    // report it as a change since the baseline.
    if (digest) s.trees.acknowledge(digest.url, body.ref, committedValue, docStart);

    notifyBrowserAction();
    return c.json({ success: true, settleMs, ...(committedValue !== null && { committedValue }), ...(effect && { effect }), ...(treeDiff && { treeDiff }) });
  } catch (error: any) {
    console.error('[Browser] Error filling:', error);
    return c.json({ error: error.message || 'Failed to fill' }, 500);
  }
});

// POST /browser/scroll - Scroll page
/** How long a scroll that reached the bottom waits for a page that loads more on scroll. */
const SCROLL_BOTTOM_RECHECK_MS = 1_500;

app.post('/browser/scroll', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; direction: string; amount?: number }>();

    if (!body.sessionId || !body.direction) {
      return c.json({ error: 'sessionId and direction are required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    const scrollArgs = ['scroll', body.direction];
    if (body.amount !== undefined) scrollArgs.push(String(body.amount));

    const result = await execBrowser(scrollArgs, s);

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    const readScroll = async (): Promise<ScrollInfo | null> => {
      const probe = await probeTopFrame(s, 'JSON.stringify({y:window.scrollY,vh:window.innerHeight,h:document.documentElement.scrollHeight})');
      return probe.exitCode === 0 ? parseScrollInfo(probe.stdout) : null;
    };
    let scrollInfo = await readScroll();
    // At the bottom after scrolling down: a feed that loads more on scroll
    // grows a moment later (live: "(bottom of page)" 8 ms after the scroll,
    // the next batch 1.5 s after). One more look before saying so.
    if (scrollInfo && body.direction === 'down' && scrollInfo.y + scrollInfo.viewportHeight >= scrollInfo.pageHeight) {
      await new Promise(r => setTimeout(r, SCROLL_BOTTOM_RECHECK_MS));
      scrollInfo = (await readScroll()) ?? scrollInfo;
    }

    notifyBrowserAction();
    return c.json({ success: true, ...(scrollInfo && { scrollInfo }) });
  } catch (error: any) {
    console.error('[Browser] Error scrolling:', error);
    return c.json({ error: error.message || 'Failed to scroll' }, 500);
  }
});

// POST /browser/wait - Wait for condition
/** The longest sleep browser_wait takes; a longer one sleeps this long and says how long it waited. */
const WAIT_MS_MAX = 120_000;

app.post('/browser/wait', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; for: string }>();

    if (!body.sessionId || !body.for) {
      return c.json({ error: 'sessionId and for are required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    const target = classifyWaitTarget(body.for);
    if (target.kind === 'rejected') {
      return c.json({ error: target.reason, success: false }, 400);
    }

    const started = Date.now();
    // A sleep runs as long as it was asked to: the exec ceiling (30 s) cut a
    // 45 s wait off as an error. Capped so one call cannot hold the browser.
    const timeoutMs = target.kind === 'ms' ? Math.max(BROWSER_EXEC_TIMEOUT_MS, Math.min(target.ms, WAIT_MS_MAX) + 5_000) : undefined;
    const result = await execBrowser(target.kind === 'ms' && target.ms > WAIT_MS_MAX ? ['wait', String(WAIT_MS_MAX)] : target.args, s, timeoutMs ? { timeoutMs } : {});
    const elapsedMs = Date.now() - started;

    // Where the page is now, read through a short budget of its own: a wait
    // that hung the exec ceiling must not be followed by a probe that hangs
    // it again (review: one hang could cost ~60 s). A browser that does not
    // answer in time simply yields no page line.
    const probePage = async (): Promise<{ url: string; readyState: string } | null> => {
      const probe = await probeTopFrame(s, WAIT_PAGE_PROBE_SCRIPT, { timeoutMs: WAIT_PAGE_PROBE_TIMEOUT_MS });
      const page = probe.exitCode === 0 ? parseWaitPageProbe(probe.stdout) : null;
      return page ? { ...page, url: await addressBarUrl(s, page.url) } : null;
    };

    if (result.exitCode !== 0) {
      // Load state waits (especially networkidle) often time out on real-world
      // pages with continuous ad/analytics traffic. browser_open already waited
      // for 'load', so the page is usable — not an error, but the result says
      // the state was not reached rather than pretending it was.
      if (target.kind === 'load') {
        return c.json({ success: true, elapsedMs, timedOut: true });
      }
      // Only when the CLI itself reported the timeout (so the browser was
      // answering) is it worth asking where the page is and whether the
      // document had finished loading — a fact about this page at this moment.
      const cliTimedOut = /wait timed out/i.test(result.stdout);
      const page = cliTimedOut ? await probePage() : null;
      const where = page?.url ? `\nPage: ${page.url} · readyState ${page.readyState || 'unknown'}` : '';
      return c.json({ error: `${result.stdout}${where}`, success: false }, 500);
    }

    const page = await probePage();
    return c.json({ success: true, elapsedMs, ...(page?.url && { url: page.url }) });
  } catch (error: any) {
    console.error('[Browser] Error waiting:', error);
    return c.json({ error: error.message || 'Failed to wait' }, 500);
  }
});

// POST /browser/press - Press a keyboard key
app.post('/browser/press', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; key: string }>();

    if (!body.sessionId || !body.key) {
      return c.json({ error: 'sessionId and key are required' }, 400);
    }

    // agent-browser forwards any string to CDP and reports success even for
    // non-keys (typing nothing) — reject up front with typing guidance.
    const keyError = validatePressKey(body.key);
    if (keyError) {
      return c.json({ error: keyError, success: false }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    const { result, digest, effect, settleMs, treeDiff } = await runWithEffect(
      s,
      () => execBrowser(['press', body.key], s),
      pressPolicy(body.key),
    );

    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }

    const tabInfo = await detectNewTab(s);
    notifyBrowserAction();
    return c.json({ success: true, settleMs, ...(digest && { digest }), ...(effect && { effect }), ...(treeDiff && { treeDiff }), ...(tabInfo && { tabInfo }) });
  } catch (error: any) {
    console.error('[Browser] Error pressing key:', error);
    return c.json({ error: error.message || 'Failed to press key' }, 500);
  }
});

// POST /browser/screenshot - Take screenshot
app.post('/browser/screenshot', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; full?: boolean; annotate?: boolean; force?: boolean }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    const capture = async (extra: string[]) => {
      const args = ['screenshot', ...extra];
      if (body.full) args.push('--full');
      if (body.annotate) args.push('--annotate');
      return execBrowser(args, s);
    };

    // An annotated capture is for its labels, and force asks for an image
    // regardless: both always capture.
    if (body.annotate || body.force) {
      const result = await capture([]);
      if (result.exitCode !== 0) {
        return c.json({ error: result.stdout, success: false }, 500);
      }
      return c.json({ success: true, output: result.stdout, cssScale: await screenshotCssScale(s) });
    }

    // Otherwise only when the page looks different from the last image this
    // tab and mode produced (screenshot-memory.ts).
    const key = screenshotKey(await activeTabKey(s), Boolean(body.full));
    const conditional = await capture(['--if-changed', '--json']);
    if (conditional.exitCode !== 0) {
      return c.json({ error: cliJsonError(conditional.stdout), success: false }, 500);
    }
    const shot = parseIfChangedOutput(conditional.stdout);
    if (shot?.changed && shot.path) {
      rememberScreenshot(key, shot.path);
      return c.json({ success: true, path: shot.path, cssScale: await screenshotCssScale(s) });
    }
    if (shot && !shot.changed) {
      const previous = recallScreenshot(key);
      if (previous && fs.existsSync(previous.path)) {
        return c.json({
          success: true,
          unchanged: true,
          previousPath: previous.path,
          previousAgeMs: Date.now() - previous.takenAt,
          pixelChangeRatio: shot.pixelChangeRatio,
        });
      }
    }

    // Unchanged against an image this server cannot name (taken before a
    // restart, swept, or too old to offer), or output it could not read: take
    // a plain capture. When the CLI said "unchanged", the new file shows the
    // same pixels as its baseline, so it is what the next "unchanged" names.
    const result = await capture([]);
    if (result.exitCode !== 0) {
      return c.json({ error: result.stdout, success: false }, 500);
    }
    const path = extractScreenshotPath(result.stdout);
    if (shot && !shot.changed && path.startsWith('/')) rememberScreenshot(key, path);
    return c.json({ success: true, output: result.stdout, cssScale: await screenshotCssScale(s) });
  } catch (error: any) {
    console.error('[Browser] Error taking screenshot:', error);
    return c.json({ error: error.message || 'Failed to take screenshot' }, 500);
  }
});

// POST /browser/read - The page's visible text as light markdown (page-reader.ts)
app.post('/browser/read', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; outline?: boolean; section?: string }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    // Same hold as a snapshot while the document is still loading; the
    // observation also supplies the status line.
    const { obs: observed, waitedMs } = await waitForLoaded(async () => {
      const out = await observePage(s, observerScript());
      return out === null ? null : parseObservation(out);
    });
    const probe = observed ? await withAddressBarUrl(s, observed) : EMPTY_OBSERVATION;
    noteChallenge(probe);
    if (probe.url) s.urls.observe(probe.url);

    // The page's whole text comes back as one JSON string: past the default
    // exec cap it would be cut mid-string and unparseable. With a frame
    // selected (browser_frame) the text is that frame's: the reader runs in it.
    const frame = await selectedFrame(s);
    const raw = frame
      ? await execBrowser(['eval', readerScript()], s, { outputCap: MAX_SNAPSHOT_RAW_CHARS })
      : await probeTopFrame(s, readerScript(), { outputCap: MAX_SNAPSHOT_RAW_CHARS });
    const read = raw.exitCode === 0 ? parseReadResult(raw.stdout) : null;
    if (!read) {
      // No page to answer: the session's tab was closed under it.
      if (/tab_gone/.test(raw.stdout)) return c.json({ error: raw.stdout, success: false }, 500);
      return c.json({ error: 'The page text could not be read (the page did not answer the read script).', success: false }, 500);
    }

    const text = tidyRead(read.text);
    let content: string;
    let note = '';
    if (body.outline) {
      content = outlineOf(text);
      if (!content) note = 'The page has no headings.';
    } else if (body.section && body.section.trim()) {
      content = sectionOf(text, body.section);
      if (!content) {
        const outline = outlineOf(text);
        note = `No heading contains ${JSON.stringify(body.section.trim())}.${outline ? ` Headings on this page:\n${outline}` : ' The page has no headings.'}`;
      }
    } else {
      content = text;
      // Nothing visible is an observation too — not an empty result to read as "no data".
      if (!content && frame) note = 'The reader found no visible text in the selected frame.';
      else if (!content) note = `The reader found no visible text on the page${probe.textChars > 0 ? `; the document's innerText has ${probe.textChars.toLocaleString('en-US')} chars (browser_snapshot with fullText:true shows text beside refs)` : ''}.`;
    }

    // A dialog or banner on top reads like the page's own text; name it.
    const onTop = probe.top.length > 0
      ? `\nOpen on top of the page: ${probe.top.map(t => `${t.kind}${t.name ? ` ${JSON.stringify(t.name)}` : ''}`).join(', ')}`
      : '';
    const header = formatStatusLine(probe, null, { waitedMs }) + (formatStatusLine(probe, null) ? onTop : '') + (frame ? `\n${formatFrameLine(frame, null)}` : '');
    return c.json({
      success: true,
      text: (header ? `${header}\n\n` : '') + (content ? capReadText(content, { collectTruncated: read.truncated && !body.outline && !body.section }) : '') + (note ? `${content ? '\n\n' : ''}${note}` : '') + formatUnreadFrames(read.frames),
      chars: content.length,
    });
  } catch (error: any) {
    console.error('[Browser] Error reading page:', error);
    return c.json({ error: error.message || 'Failed to read page' }, 500);
  }
});

const WORKSPACE_CAPTURES_DIR = '/workspace/captures';

// POST /browser/capture-traffic - Record network traffic to a redacted HAR (traffic-capture.ts)
app.post('/browser/capture-traffic', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; action?: string; label?: string }>();

    if (!body.sessionId || (body.action !== 'start' && body.action !== 'stop')) {
      return c.json({ error: 'sessionId and action ("start" or "stop") are required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    const current = s.capture;
    if (body.action === 'start') {
      if (current) {
        return c.json({ error: `A capture is already recording (started ${Math.round((Date.now() - current.startedAt) / 1000)}s ago). Stop it first.`, success: false }, 409);
      }
      const r = await execBrowser(['network', 'har', 'start', '--content', 'text'], s);
      if (r.exitCode !== 0) {
        return c.json({ error: r.stdout, success: false }, 500);
      }
      const page = await observeNow(s);
      s.capture = { startedAt: Date.now(), url: page.url };
      return c.json({ success: true, started: true, url: page.url });
    }

    if (!current) {
      return c.json({ error: 'No traffic capture is recording. Start one with action "start" before the steps you want recorded.', success: false }, 409);
    }
    const rawPath = path.join('/tmp', `superagent-har-${process.pid}-${Date.now()}.har`);
    const stopped = await execBrowser(['network', 'har', 'stop', rawPath], s);
    s.capture = null;
    try {
      if (stopped.exitCode !== 0) {
        // The session's instance holds no recording (0.44+ #2689; it drops
        // one when it restarts). The CLI's advice names a command
        // browser_run refuses.
        const lost = /no_har_recording:/.test(stopped.stdout);
        const error = lost
          ? 'The browser instance had no recording to stop (agent-browser drops one when its instance restarts), so nothing was saved. browser_capture_traffic with action="start" begins a new one.'
          : stopped.stdout;
        return c.json({ error, success: false }, 500);
      }
      const har = harSchema.parse(JSON.parse(await fs.promises.readFile(rawPath, 'utf-8')));
      // By name (tokens, cookies, auth headers), then by value: a password or
      // code the host injected, in whatever field the site posted it.
      const redacted = redactInjectedSecretsDeep(redactHar(har));
      await fs.promises.mkdir(WORKSPACE_CAPTURES_DIR, { recursive: true });
      const fileName = captureFileName(body.label);
      const outPath = path.join(WORKSPACE_CAPTURES_DIR, fileName);
      await fs.promises.writeFile(outPath, JSON.stringify(redacted, null, 2));
      const { endpoints, more } = summarizeEndpoints(redacted, current.url);

      // Each data endpoint's first response body as its own readable file:
      // the web-browser agent has Read but no jq, and one 50 KB JSON line in
      // the HAR is past what Read returns (bench, SFPL).
      const bodies = new Map<string, string>();
      const bodyDir = path.join(WORKSPACE_CAPTURES_DIR, fileName.replace(/\.har$/, ''));
      let n = 0;
      for (const e of endpoints) {
        // The largest response at that URL (the summary's example).
        const entry = redacted.log.entries
          .filter(x => x.request.method === e.method && x.request.url === e.url && typeof x.response.content.text === 'string')
          .sort((a, b) => (b.response.content.text?.length ?? 0) - (a.response.content.text?.length ?? 0))[0];
        if (!entry?.response.content.text) continue;
        if (n === 0) await fs.promises.mkdir(bodyDir, { recursive: true });
        const file = path.join(bodyDir, bodyFileName(++n, e.url, e.mimeType));
        // Pretty-printing re-serializes JSON, which decodes escapes (`&`)
        // the HAR's redaction could not see through: redact what is written.
        await fs.promises.writeFile(file, redactInjectedSecrets(readableBody(entry.response.content.text)));
        // Its request too, so the headers can be read without opening the
        // whole HAR (bench, USGS: a 62,000-token file read in pieces).
        await fs.promises.writeFile(requestFileName(file), JSON.stringify({
          method: entry.request.method,
          url: entry.request.url,
          headers: entry.request.headers,
          ...(entry.request.postData ? { postData: entry.request.postData } : {}),
        }, null, 2));
        bodies.set(`${e.method} ${e.url}`, file);
      }

      // The cookie names the browser holds for the page's site — never values.
      let cookieNames: string[] | undefined;
      try {
        const site = new URL(current.url).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
        const ck = await execBrowser(['cookies', '--json'], s);
        const parsed = z.object({ data: z.object({ cookies: z.array(z.object({ name: z.string(), domain: z.string() }).passthrough()) }) }).safeParse(JSON.parse(ck.stdout));
        if (ck.exitCode === 0 && parsed.success) {
          cookieNames = [...new Set(parsed.data.data.cookies.filter(k => k.domain.replace(/^\./, '').endsWith(site)).map(k => k.name))];
        }
      } catch { /* no page URL or unreadable output: leave the line out */ }

      return c.json({
        success: true,
        path: outPath,
        requestCount: redacted.log.entries.length,
        summary: formatCaptureSummary({ path: outPath, requestCount: redacted.log.entries.length, endpoints, more, durationMs: Date.now() - current.startedAt, bodies, cookieNames }),
      });
    } finally {
      // The raw file holds live credentials: never leave it behind.
      await fs.promises.rm(rawPath, { force: true });
    }
  } catch (error: any) {
    console.error('[Browser] Error capturing traffic:', error);
    return c.json({ error: error.message || 'Failed to capture traffic' }, 500);
  }
});

// POST /browser/select - Select dropdown option by ref
app.post('/browser/select', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; ref: string; value: string; by?: 'value' | 'label' }>();

    if (!body.sessionId || !body.ref || body.value === undefined) {
      return c.json({ error: 'sessionId, ref, and value are required' }, 400);
    }
    if (body.by !== undefined && body.by !== 'value' && body.by !== 'label') {
      return c.json({ error: 'by must be "value" or "label"' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    // Read a native <select>'s value before and after: the CLI reports
    // "✓ Done" even when the page reverts it (React-controlled selects) —
    // the read-back is what makes the result honest (select-verify.ts).
    const readValue = async (): Promise<string | null> => {
      const r = await execBrowser(['get', 'value', body.ref], s);
      return r.exitCode === 0 ? r.stdout.trim() : null;
    };

    const before = await readValue();

    // The value after `--`: an option text such as "-- Select --" or "-v" is
    // a value, not a flag.
    const selectArgs = ['select', body.ref, ...(body.by ? ['--by', body.by] : []), '--', body.value];
    const { result, digest, effect, settleMs, treeDiff, docStart } = await runWithEffect(
      s,
      () => withRefRestore(s, body.ref, () => execBrowser(selectArgs, s)),
      { ...ACTION_POLICIES.select, settleMs: SELECT_COMMIT_SETTLE_MS },
      { excludeSubtrees: [body.ref] },
    );

    if (result.exitCode !== 0) {
      return c.json({ error: selectRefusalText(await explainUnknownRef(s, result.stdout, body.ref)), success: false }, 500);
    }

    // The select loaded a new document (a sort or language picker that
    // submits its form): the ref is the old document's, and its value
    // cannot be read on the new one.
    if (digest?.navigated && !digest.sameDocument) {
      notifyBrowserAction();
      return c.json({ success: true, navigated: true, digest, settleMs });
    }

    const after = await readValue();

    // Unchanged value that is not the requested string: the agent may have
    // asked by label for the option that was already selected, or the target
    // is a combobox or listbox the CLI operated by clicking its option, which
    // has no value. Read ITS option list: a probe over every <select> on the
    // page could be satisfied by a different dropdown.
    let options: ReturnType<typeof parseSelectOptions> | null = null;
    if (after === null || (after === before && after !== body.value)) {
      // Through the same ref the select and the value read used. No page
      // script: a page-wide search, a focused element or the element at the
      // target's rectangle can all be a different dropdown (each verified the
      // wrong one in review).
      const html = await execBrowser(['get', 'html', body.ref], s);
      options = html.exitCode === 0 ? parseSelectOptions(html.stdout) : null;
    }

    if (options !== null && options.length === 0) {
      // No <option>s: a combobox or listbox the CLI opened and picked the
      // matching role=option in. There is no value to read back; its own
      // tree line is (what a combobox shows, a listbox's selected options),
      // and it becomes the baseline.
      const tree = await readSnapshot(s, ['snapshot', '-i', '-c'], { timeoutMs: TREE_READ_TIMEOUT_MS, outputCap: MAX_SNAPSHOT_RAW_CHARS });
      const id = body.ref.replace(/^@/, '');
      const lines = tree.exitCode === 0 ? parseTreeRefs(tree.stdout).lines : null;
      const line = lines?.get(id);
      const shows = line?.value || undefined;
      const selected = lines && line
        ? [...lines.values()].filter(l => l.parent === id && l.attrs.includes('selected')).map(l => l.name)
        : [];
      if (tree.exitCode === 0 && digest) s.trees.set(digest.url, tree.stdout, 'action', Date.now(), docStart);
      notifyBrowserAction();
      return c.json({ success: true, widget: true, settleMs, ...(shows !== undefined && { shows }), ...(selected.length > 0 && { selected }), ...(effect && { effect }), ...(treeDiff && { treeDiff }) });
    }

    const labelMatches = after !== null && after === before && after !== body.value
      && options !== null && targetOptionMatches(options, body.value, after);
    const judgement = judgeSelectCommit(body.value, before, after, labelMatches);
    if (!judgement.ok) {
      return c.json({ error: judgement.reason, success: false }, 500);
    }
    // The tree shows the chosen option's label, the read-back its value:
    // acknowledge the select (and its options) without comparing.
    if (digest) s.trees.acknowledge(digest.url, body.ref, null, docStart);

    notifyBrowserAction();
    return c.json({ success: true, committedValue: judgement.committed, settleMs, ...(effect && { effect }), ...(treeDiff && { treeDiff }) });
  } catch (error: any) {
    console.error('[Browser] Error selecting:', error);
    return c.json({ error: error.message || 'Failed to select' }, 500);
  }
});

// POST /browser/hover - Hover element by ref
app.post('/browser/hover', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; ref: string }>();

    if (!body.sessionId || !body.ref) {
      return c.json({ error: 'sessionId and ref are required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    const { result, effect, settleMs, treeDiff } = await runWithEffect(
      s,
      () => withRefRestore(s, body.ref, () => execBrowser(['hover', body.ref], s)),
      ACTION_POLICIES.hover,
    );

    if (result.exitCode !== 0) {
      return c.json({ error: await explainUnknownRef(s, result.stdout, body.ref), success: false }, 500);
    }

    notifyBrowserAction();
    return c.json({ success: true, settleMs, ...(effect && { effect }), ...(treeDiff && { treeDiff }) });
  } catch (error: any) {
    console.error('[Browser] Error hovering:', error);
    return c.json({ error: error.message || 'Failed to hover' }, 500);
  }
});

// POST /browser/upload - Upload a local file into an <input type="file">
app.post('/browser/upload', async (c) => {
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    const s = browserSessionOf(String(rawBody?.sessionId ?? ''));
    const result = await runBrowserUpload(rawBody, {
      validateSession: browserSessionRefusal,
      isBrowserActive: () => s !== null,
      getConnectionUrl: () => browserState.cdpUrl || getCdpHttpEndpoint(),
      getActiveTargetUrl: async () => (s ? (await findActivePageTarget(s))?.url ?? null : null),
      urlsMatch: (left, right) => tabManager.urlsMatch(left, right),
    });

    // Playwright's CDP attach can reset Browser.setDownloadBehavior — re-apply
    // ours so click-triggered downloads keep landing in the workspace.
    await reapplyDownloadBehavior();

    if (!result.success) {
      return c.json(result.body, result.status);
    }

    notifyBrowserAction();
    return c.json(result.body);
  } catch (error: any) {
    console.error('[Browser] Error uploading file:', error);
    return c.json({ error: error.message || 'Failed to upload file' }, 500);
  }
});

// POST /browser/download - Download a URL's bytes through the browser session
// into /workspace/downloads. The bytes travel over the CDP wire, so this works
// even when the browser's own filesystem is unreachable (host Chrome, Browserbase).
app.post('/browser/download', async (c) => {
  try {
    const rawBody = await c.req.json().catch(() => ({}));
    const s = browserSessionOf(String(rawBody?.sessionId ?? ''));
    const result = await runBrowserDownload(rawBody, {
      validateSession: browserSessionRefusal,
      isBrowserActive: () => s !== null,
      getConnectionUrl: () => browserState.cdpUrl || getCdpHttpEndpoint(),
      getActiveTargetUrl: async () => (s ? (await findActivePageTarget(s))?.url ?? null : null),
      urlsMatch: (left, right) => tabManager.urlsMatch(left, right),
    });

    // Playwright's CDP attach can reset Browser.setDownloadBehavior — re-apply
    // ours so click-triggered downloads keep landing in the workspace.
    await reapplyDownloadBehavior();

    if (!result.success) {
      return c.json(result.body, result.status);
    }

    notifyBrowserAction();
    return c.json(result.body);
  } catch (error: any) {
    console.error('[Browser] Error downloading file:', error);
    return c.json({ error: error.message || 'Failed to download file' }, 500);
  }
});

// POST /browser/type - Type real keystrokes into the focused element (optionally focusing a ref first)
app.post('/browser/type', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; text: string; ref?: string }>();

    if (!body.sessionId || typeof body.text !== 'string' || body.text.length === 0) {
      return c.json({ error: 'sessionId and text are required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    // `keyboard type` dispatches real key events into whatever has focus —
    // this is what drives keystroke-listening widgets (Stripe card fields,
    // OTP boxes, typeaheads) that programmatic fill cannot. Through the
    // settle, so a suggestion list the typing opened is reported.
    const { result, digest, effect, settleMs, treeDiff, docStart } = await runWithEffect(
      s,
      async () => {
        if (body.ref) {
          const focusResult = await withRefRestore(s, body.ref, () => execBrowser(['focus', body.ref as string], s));
          if (focusResult.exitCode !== 0) return focusResult;
        }
        return execBrowser(['keyboard', 'type', '--', body.text], s);
      },
      ACTION_POLICIES.type,
      { excludeRefs: body.ref ? [body.ref] : [] },
    );

    if (result.exitCode !== 0) {
      return c.json({ error: await explainUnknownRef(s, result.stdout, body.ref), success: false }, 500);
    }

    // When we know the target, read the value back (keyboard type APPENDS to
    // existing content). Focused-element typing without a ref has no readable
    // target by definition (e.g. cross-origin payment iframes).
    let committedValue: string | null = null;
    if (body.ref) {
      committedValue = await readCommittedFieldValue(s, body.ref);
      if (digest) s.trees.acknowledge(digest.url, body.ref, committedValue, docStart);
    }

    notifyBrowserAction();
    return c.json({ success: true, settleMs, ...(committedValue !== null && { committedValue }), ...(effect && { effect }), ...(treeDiff && { treeDiff }) });
  } catch (error: any) {
    console.error('[Browser] Error typing:', error);
    return c.json({ error: error.message || 'Failed to type' }, 500);
  }
});

// POST /browser/eval - Run JavaScript in the page (dedicated eval with guardrails)
app.post('/browser/eval', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; script: string }>();

    if (!body.sessionId || typeof body.script !== 'string' || body.script.trim() === '') {
      return c.json({ error: 'sessionId and script are required' }, 400);
    }

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }

    const { script, wrapped } = prepareEvalScript(body.script);
    const result = await execBrowser(['eval', script], s);

    if (result.exitCode !== 0) {
      return c.json({ error: evalErrorHint(result.stdout), success: false }, 500);
    }

    notifyBrowserAction();
    return c.json({ success: true, output: finalizeEvalOutput(result.stdout), wrapped });
  } catch (error: any) {
    console.error('[Browser] Error running eval:', error);
    return c.json({ error: error.message || 'Failed to run eval' }, 500);
  }
});

/**
 * The page's frames, for browser_frame without a target: the top frame's
 * observer lists the visible iframes, and the page's tree gives each the ref
 * of its `Iframe` line. Read on the top frame whatever frame is selected.
 */
async function pageFrames(s: BrowserSession): Promise<string> {
  // Held while the document loads, like a snapshot: right after an open, a
  // page that mounts its frames late lists them before the tree has them.
  const { obs: observed } = await waitForLoaded(async () => {
    const out = await observePage(s, observerScript());
    return out === null ? null : parseObservation(out);
  });
  const obs = observed ?? EMPTY_OBSERVATION;
  const run = (args: string[]) => execBrowser(args, s, { withinFrameStep: true, timeoutMs: TREE_READ_TIMEOUT_MS, outputCap: MAX_SNAPSHOT_RAW_CHARS });
  const readTree = async (): Promise<string> => {
    const tree = s.frame
      ? await atTopFrame(s, run, () => run(['snapshot', '-i', '-c']))
      : await readSnapshot(s, ['snapshot', '-i', '-c'], { timeoutMs: TREE_READ_TIMEOUT_MS, outputCap: MAX_SNAPSHOT_RAW_CHARS });
    return tree.exitCode === 0 ? tree.stdout : '';
  };
  // A frame is in the DOM (the observer lists it) before the tree has its
  // line: a page that mounts its frames by script (Stripe) showed none in the
  // tree right after load and both 3 s later. Read again while a named frame
  // has no line yet, a few times.
  let entries = frameInventory(obs.iframes, await readTree());
  const unlisted = (): boolean => entries.some(e => e.title && !e.ref && obs.iframes.filter(f => f.title.trim() === e.title).length === 1);
  for (let attempt = 0; attempt < FRAME_TREE_RETRIES && unlisted(); attempt++) {
    await sleep(FRAME_TREE_RETRY_MS);
    entries = frameInventory(obs.iframes, await readTree());
  }
  return formatFrameInventory(entries, s.frame);
}

/** How many more tree reads, how far apart, while a listed frame has no tree line yet. */
const FRAME_TREE_RETRIES = 3;
const FRAME_TREE_RETRY_MS = 800;

// POST /browser/frame - Select an iframe (by ref or selector), go back to the page, or list the frames
app.post('/browser/frame', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; target?: string }>();
    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }
    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    if (!target) {
      // Forget a selection the CLI has dropped before saying which is selected.
      await selectedFrame(s);
      return c.json({ success: true, frames: await pageFrames(s) });
    }
    if (target === 'main' || target === 'top') {
      const r = await execBrowser(['frame', 'main'], s);
      if (r.exitCode !== 0) return c.json({ error: r.stdout, success: false }, 500);
      if (s.frame !== null) s.trees.reset();
      s.frame = null;
      const page = await observeNow(s);
      notifyBrowserAction();
      return c.json({ success: true, main: true, url: page.url, title: page.title });
    }
    let r = await execBrowser(['frame', target], s);
    if (r.exitCode !== 0 && /^@?e\d+$/.test(target) && /Unknown ref/.test(r.stdout)) {
      // A snapshot inside a frame replaced the CLI's refs with that frame's:
      // the page's refs (its Iframe lines among them) come back with a read
      // of the page. Read it there, then select again.
      await execBrowser(['frame', 'main'], s);
      s.frame = null;
      await readSnapshot(s, ['snapshot', '-i', '-c'], { timeoutMs: TREE_READ_TIMEOUT_MS, outputCap: MAX_SNAPSHOT_RAW_CHARS });
      r = await execBrowser(['frame', target], s);
    }
    if (r.exitCode !== 0) {
      // What the page has to select instead: facts, not a guess at which.
      return c.json({ error: `${r.stdout}\n${await pageFrames(s)}`, success: false }, 500);
    }
    if (s.frame !== target) s.trees.reset();
    s.frame = target;
    const frame = await selectedFrame(s);
    notifyBrowserAction();
    return c.json({ success: true, target, ...(frame && { url: frameUrlShown(frame.url), title: frame.title }) });
  } catch (error: any) {
    console.error('[Browser] Error selecting frame:', error);
    return c.json({ error: error.message || 'Failed to select frame' }, 500);
  }
});

// POST /browser/run - Generic catch-all for any agent-browser command
app.post('/browser/run', async (c) => {
  try {
    const body = await c.req.json<{ sessionId: string; command?: string; args?: string[] }>();

    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }

    const resolved = resolveRunCommandArgs(body);
    if (resolved.error !== undefined) {
      return c.json({ error: resolved.error }, 400);
    }
    const commandArgs = resolved.args;

    const s = browserSessionOf(body.sessionId);
    if (!s) {
      return c.json({ error: noBrowserOpen() }, 400);
    }


    const commands = runCommands(commandArgs);
    const staticRefusal = runCommandRefusal(commandArgs);
    const closes = !staticRefusal && closesTabs(commands) ? tabCloses(commands, await tabsAsSeen(s)) : null;
    const refusal = staticRefusal ?? closes?.refusal;
    if (refusal) {
      return c.json({ error: refusal, success: false }, 400);
    }

    const opensTab = commands.some(command => command[0]?.toLowerCase() === 'tab' && command[1]?.toLowerCase() === 'new');
    const tabOpened = opensTab ? await prepareNewTabWindow(s) : null;
    const result = await execBrowser(commandArgs, s);
    await tabOpened?.();
    if (result.exitCode === 0 && closes?.closesOwnTabAt != null) await moveOffClosedTab(s, closes.closesOwnTabAt);
    const verb = commandArgs[0].toLowerCase();
    const joined = commandArgs.join(' ').toLowerCase();
    // A bare `tab` / `tab list` only lists, and `tab keep live|throttled|frozen`
    // only changes how a tab runs in the background: the page in front is the same.
    const tabVerb = verb.startsWith('tab') ? commandArgs[1]?.toLowerCase() : undefined;
    const listsTabs = verb.startsWith('tab') && (commandArgs.length === 1 || tabVerb === 'list');
    const keepsTab = tabVerb === 'keep';
    const navigates = (verb.startsWith('tab') && !listsTabs && !keepsTab) || ['back', 'forward', 'reload', 'open', 'goto', 'navigate'].includes(verb);
    if (result.exitCode === 0) {
      // A navigation or a tab change leaves the CLI on the top frame; a
      // `frame` command (alone or in a batch) selects the agent's frame.
      const selection = frameSelectionOf(commands);
      if (selection !== undefined) {
        // Another frame's tree: the baseline was the frame (or page) left.
        if (selection !== s.frame) s.trees.reset();
        s.frame = selection;
      } else if (navigates) s.frame = null;
    }
    // A navigation Chrome answered with its own error page still happened:
    // `tab new <dead url>` leaves a new tab in front. The error stands, and
    // the bookkeeping below runs as for a success, so the tab is reported now
    // rather than on some later command.
    const navFailed = result.exitCode !== 0 && navigates && navigationNetError(result.stdout) !== null;

    if (result.exitCode !== 0 && !navFailed) {
      // The CLI's tab_locked names this instance's peer and says to close it:
      // what it means here is that another session is on the tab.
      const locked = /tab_locked: tab (\S+) is pinned/.exec(result.stdout);
      const error = !locked
        ? result.stdout
        : keepsTab
          ? `Not changed: tab ${locked[1]} is another session's tab now. This session's tabs are as they were.`
          : `Not switched: another session is on tab ${commandArgs[1] ?? locked[1]} now. This session is still on its own tab.`;
      return c.json({ error, success: false }, 500);
    }

    // A different tab or document: the tree baseline belongs to the old one,
    // and the next action is compared with the URL that is now in front (a
    // tab close used to make the next click read as a navigation).
    if (navigates) {
      s.trees.reset();
      const front = await observeNow(s);
      if (front.url) s.urls.observe(front.url);
      else await observeUrlDigest(s);
      // agent-browser clears its ref table on every tab command (new, switch,
      // close), so the refs the agent holds for the tab now in front all read
      // "Unknown ref" until a snapshot. Refs persist per document, so one read
      // brings them back unchanged.
      if (verb.startsWith('tab') && !listsTabs && !keepsTab) {
        const restore = await readSnapshot(s, ['snapshot', '-i', '-c'], { timeoutMs: TREE_READ_TIMEOUT_MS, outputCap: MAX_SNAPSHOT_RAW_CHARS });
        if (restore.exitCode === 0 && front.url) s.trees.set(front.url, restore.stdout, 'action', Date.now(), front.docStart);
      }
    }
    let tabInfo = null;
    if (verb.startsWith('tab') || verb === 'click' || verb === 'dblclick' || joined.includes('.click(')) {
      tabInfo = await detectNewTab(s);
    }
    if (navFailed) {
      notifyBrowserAction();
      return c.json({ error: `${result.stdout}${tabInfo ? tabManager.formatTabNotification(tabInfo) : ''}`, success: false }, 500);
    }

    // `get url` on Chrome's error page reads chrome-error://; report the
    // address that failed instead, as every other URL the agent sees does.
    const answer = verb === 'get' && commandArgs[1]?.toLowerCase() === 'url' && commandArgs.length === 2
      ? await addressBarUrl(s, result.stdout)
      : listsTabs && !commandArgs.includes('--json')
        ? labelTabList(result.stdout, await tabsAsSeen(s))
        : result.stdout;
    // The CLI's own warnings about what it did (a value truncated or snapped,
    // a page that navigated before the state could be checked). The action
    // tools read the outcome back themselves; a raw command has only these.
    const warnings = result.warnings?.length ? result.warnings.map(w => `⚠ ${w}`).join('\n') : '';
    const output = warnings ? `${answer}\n${warnings}` : answer;

    notifyBrowserAction();
    return c.json({ success: true, output, ...(tabInfo && { tabInfo }) });
  } catch (error: any) {
    console.error('[Browser] Error running command:', error);
    return c.json({ error: error.message || 'Failed to run browser command' }, 500);
  }
});

async function buildFileTree(
  dirPath: string,
  maxDepth: number,
  currentDepth: number
): Promise<any> {
  if (currentDepth >= maxDepth) {
    return null;
  }

  try {
    const stats = await fs.promises.stat(dirPath);
    const name = path.basename(dirPath);
    const relativePath = path.relative('/workspace', dirPath);

    if (!stats.isDirectory()) {
      return {
        name,
        path: relativePath,
        type: 'file',
        size: stats.size,
      };
    }

    const files = await fs.promises.readdir(dirPath);
    const children = await Promise.all(
      files.map((file) =>
        buildFileTree(path.join(dirPath, file), maxDepth, currentDepth + 1)
      )
    );

    return {
      name: name || 'workspace',
      path: relativePath,
      type: 'directory',
      children: children.filter((child) => child !== null),
    };
  } catch (error) {
    return null;
  }
}

// Startup self-heal: older builds could leave /workspace/.env 0o600 and
// owner-flipped, locking one writer out permanently. If WE own the poisoned
// file, only we can fix it — do so before any session starts.
void healEnvFilePermissions('/workspace/.env').then((healed) => {
  if (healed) console.log('[ENV] Healed /workspace/.env permissions back to 0666');
});

// Start the server
const port = parseInt(process.env.PORT || '3000');
const server = serve({
  fetch: app.fetch,
  port,
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Create a separate WebSocket server for browser stream proxying
const browserWss = new WebSocketServer({ noServer: true });

interface DashboardProtocolRequest extends http.IncomingMessage {
  _dashboardProtocol?: string;
}

const dashboardWss = new WebSocketServer({
  noServer: true,
  handleProtocols(protocols, request) {
    const selected = (request as DashboardProtocolRequest)._dashboardProtocol;
    return selected && protocols.has(selected) ? selected : false;
  },
});

function closeDashboardPeer(peer: WebSocket, code?: number, reason?: Buffer): void {
  if (peer.readyState !== WebSocket.OPEN) return;
  const relayCode = code === 1000 || (code !== undefined && code >= 3000) ? code : 1011;
  peer.close(relayCode, reason?.toString().slice(0, 120));
}

function bridgeDashboardWebSocket(browser: WebSocket, dashboard: WebSocket): void {
  dashboard.on('message', (data, isBinary) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
  });
  browser.on('message', (data, isBinary) => {
    if (dashboard.readyState === WebSocket.OPEN) dashboard.send(data, { binary: isBinary });
  });
  dashboard.on('close', (code, reason) => closeDashboardPeer(browser, code, reason));
  browser.on('close', (code, reason) => closeDashboardPeer(dashboard, code, reason));
  dashboard.on('error', (error) => {
    console.error('[Artifacts] Dashboard WebSocket error:', error);
    closeDashboardPeer(browser);
  });
  browser.on('error', () => closeDashboardPeer(dashboard));
}

// Handle WebSocket upgrade
server.on('upgrade', (request: http.IncomingMessage, socket: any, head: Buffer) => {
  // Upgrades bypass the Hono middleware chain — enforce host auth here too.
  const presentedToken = request.headers[HOST_TOKEN_HEADER];
  if (!isValidHostToken(Array.isArray(presentedToken) ? presentedToken[0] : presentedToken)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const pathname = url.pathname;

  // Check if this is a session stream endpoint
  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)\/stream$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      handleWebSocketConnection(ws, sessionId);
    });
    return;
  }

  // Check if this is a browser stream endpoint
  if (pathname === '/browser/stream') {
    // The session whose tab the viewer follows. A viewer that names none gets
    // the browser's only session (or its first), as before sessions shared it.
    const sessionId = url.searchParams.get('sessionId');
    const s = sessionId ? browserSessionOf(sessionId) : browserSessions()[0];
    if (!s) {
      socket.destroy();
      return;
    }

    // The viewer's canvas width rides on the URL so the first screencast already has the right size.
    const viewerWidth = clampViewerWidth(url.searchParams.get('width'));
    browserWss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      if (viewerWidth !== undefined) viewerWidths.set(ws, viewerWidth);
      handleBrowserStreamConnection(ws, s);
    });
    return;
  }

  // Dashboard application sockets and Vite HMR use the same upstream path
  // contract as HTTP after the container artifact prefix is removed.
  const dashboardRoute = parseDashboardProxyRoute(pathname);
  if (dashboardRoute) {
    const dashboardPort = dashboardManager.getDashboardPort(dashboardRoute.slug);
    if (!dashboardPort) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const protocols = requestedWebSocketProtocols(request);
    const upstreamPathMode = dashboardManager.getDashboardUpstreamPathMode(dashboardRoute.slug);
    const upstreamPath = dashboardWebSocketUpstreamPath(
      dashboardRoute.subPath,
      protocols,
      getDashboardBasePath(dashboardRoute.slug),
      upstreamPathMode,
    );
    const upstream = new WebSocket(
      `ws://127.0.0.1:${dashboardPort}${upstreamPath}${url.search}`,
      protocols,
      { headers: dashboardWebSocketForwardHeaders(request, upstreamPathMode) },
    );
    let settled = false;

    const fail = (error?: unknown) => {
      if (settled) return;
      settled = true;
      upstream.terminate();
      if (error) console.error('[Artifacts] Failed to connect dashboard WebSocket:', error);
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    };

    socket.once('close', () => {
      if (!settled) upstream.terminate();
    });
    upstream.once('unexpected-response', (_req, response) => {
      response.resume();
      fail(new Error(`Dashboard refused WebSocket upgrade (${response.statusCode})`));
    });
    upstream.once('error', fail);
    upstream.once('open', () => {
      if (settled || socket.destroyed) {
        upstream.terminate();
        return;
      }
      settled = true;
      (request as DashboardProtocolRequest)._dashboardProtocol = upstream.protocol || undefined;
      dashboardWss.handleUpgrade(request, socket, head, (browser) => {
        bridgeDashboardWebSocket(browser, upstream);
      });
    });
    return;
  }

  socket.destroy();
});

async function handleWebSocketConnection(ws: WebSocket, sessionId: string) {
  console.log(`WebSocket connection established for session ${sessionId}`);

  const session = await sessionManager.getSession(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    ws.close();
    return;
  }

  // Announce the stream contract before relaying any SDK message (WS is FIFO,
  // and this is sent before the subscription below, so it always precedes the
  // first relayed message). session_state_events: this build runs the CLI with
  // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, so the host can treat
  // session_state_changed:'idle' as the idle authority from the first turn —
  // a 'result' alone must not end the session while queued messages keep the
  // runtime going.
  // process_instance: identity of the CLI process backing the session right
  // now. Background tasks are process-local and a fresh process emits no
  // initial background_tasks_changed, so a client reconnecting after a restart
  // it never observed (idle eviction + --resume, container restart — the live
  // process_restarted broadcast fires before any subscriber exists) would
  // otherwise keep bookkeeping for tasks that died with the old process.
  ws.send(JSON.stringify({
    type: 'system',
    subtype: 'capabilities',
    session_state_events: true,
    process_instance: sessionManager.getProcessInstanceId(sessionId),
    timestamp: new Date(),
  }));

  const connectedAt = Date.now();
  let lastSentAt = connectedAt;
  let socketError: string | undefined;

  // Subscribe to session events (SDK messages)
  const unsubscribe = sessionManager.subscribe(sessionId, (message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      lastSentAt = Date.now();
    }
  });

  // Catch-up for turns that ended before this socket attached. createSession
  // returns at `init`, so an instant turn (e.g. a UserPromptSubmit hook
  // blocking the prompt) emits informational/result/idle into the attach gap
  // and nothing re-delivers them — the host would show the session as working
  // forever. Frames are marked `replayed: true`; the host ignores them when it
  // already processed the live copies. Sent after the subscription so a turn
  // starting mid-replay still delivers its live frames afterwards (WS is FIFO).
  for (const frame of sessionManager.getLateJoinReplay(sessionId)) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  // Handle incoming messages
  ws.on('message', async (data: Buffer) => {
    try {
      const payload = JSON.parse(data.toString());
      const content = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content);

      await sessionManager.sendMessage(sessionId, content, payload.uuid, {
        effort: payload.effort,
        speed: speedLevelSchema.parse(payload.speed),
        model: payload.model,
        capabilityPolicies: agentCapabilityPoliciesSchema.parse(payload.capabilityPolicies),
        globalInstructions: globalInstructionsSchema.parse(payload.globalInstructions),
      });
    } catch (error: any) {
      console.error('Error handling WebSocket message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message || 'Failed to process message',
      }));
    }
  });

  // Handle connection close
  ws.on('close', (code: number, reason: Buffer) => {
    unsubscribe();
    const now = Date.now();
    const close = {
      code,
      reason: reason.toString(),
      socketAgeMs: now - connectedAt,
      idleMsBeforeClose: now - lastSentAt,
      socketError,
    };
    console.log(
      `WebSocket connection closed for session ${sessionId} (code=${close.code}, reason=${close.reason || 'none'}, ` +
      `turnInFlight=${sessionManager.isTurnInFlight(sessionId)}, age=${close.socketAgeMs}ms, ` +
      `idle=${close.idleMsBeforeClose}ms, error=${socketError ?? 'none'})`,
    );
    sessionManager.noteStreamClosed(sessionId, close);
  });

  // Handle errors
  ws.on('error', (error: Error & { code?: string }) => {
    console.error(`WebSocket error for session ${sessionId}:`, error);
    socketError = error.code ?? error.message;
    unsubscribe();
  });

  // Send initial connection success message
  ws.send(JSON.stringify({
    type: 'status',
    data: { message: 'Connected to session stream' },
    timestamp: new Date(),
  }));
}

// ============================================================
// CDP-based browser screencast
// Connects directly to Chrome's CDP to stream a session's page,
// bypassing agent-browser's StreamServer which doesn't follow
// tab switches. After each browser action, we ask each viewer's
// session which tab it is on and switch its screencast if needed.
// ============================================================

/** One session's viewer: the screencast of the tab that session is on (or the one the user picked). */
interface Screencast {
  session: BrowserSession;
  clientWs: WebSocket;
  cdpWs: WebSocket;
  currentTargetId: string;
  msgId: number;
  lastDeviceWidth: number;
  lastDeviceHeight: number;
  /** CDP session ID for flattened session mode (remote providers like Browserbase) */
  cdpSessionId: string | null;
  /** Whether the viewer auto-follows the session's tab */
  autoFollow: boolean;
  /** Pending CDP message IDs for get_selection requests */
  pendingSelections: Set<number>;
  navigation: BrowserNavigation;
  screencastStarted: boolean;
}

/** Each session's viewer: one per session, as there was one per browser when the browser had one session. */
const screencasts = new Map<BrowserSession, Screencast>();

/** Canvas width in device pixels each viewer last reported. */
const viewerWidths = new WeakMap<WebSocket, number>();
const VIEWER_WIDTH_DEBOUNCE_MS = 200;

/** CDP can't resize a running screencast, so a new viewer width restarts it. */
function setViewerWidth(ws: WebSocket, width: number): void {
  if (width === viewerWidths.get(ws)) return;
  viewerWidths.set(ws, width);
  const state = [...screencasts.values()].find(viewer => viewer.clientWs === ws);
  // Not started yet (e.g. a remote session still attaching): startScreencast reads the width.
  if (!state || !state.screencastStarted || state.cdpWs.readyState !== WebSocket.OPEN) return;
  state.cdpWs.send(cdpMsg(state, 'Page.stopScreencast'));
  startScreencast(state);
}

/** Stream frames no wider than the viewer's canvas. */
function startScreencast(state: Screencast): void {
  state.cdpWs.send(cdpMsg(state, 'Page.startScreencast', {
    format: 'jpeg', quality: 80, everyNthFrame: 1, ...screencastSize(viewerWidths.get(state.clientWs)),
  }));
  state.screencastStarted = true;
}

/**
 * Derive the CDP HTTP endpoint from the current browser state: the CDP URL's
 * host, over TLS when the URL is (a remote provider's wss:// endpoint carries
 * its credentials in the query, which stays out of it, and may not answer on
 * plain HTTP at all: Steel's never does).
 */
function getCdpHttpEndpoint(): string {
  if (browserState.cdpUrl) {
    const match = browserState.cdpUrl.match(/^(wss?):\/\/([^/?#]+)/);
    if (match) return `${match[1] === 'wss' ? 'https' : 'http'}://${match[2]}`;
  }
  // Local browser: read the dynamic port from Chrome's DevToolsActivePort file
  const port = readChromeDebugPort();
  return `http://localhost:${port || 9222}`;
}

/** A discovered CDP page target */
interface PageTarget {
  id: string;
  url: string;
  title: string;
  /** Chrome's own favicon URL for the page, when it has resolved one. */
  faviconUrl?: string;
  wsUrl: string;
  /** If true, wsUrl is a browser-level URL; connectCdpToTarget must use Target.attachToTarget */
  requiresSession: boolean;
}

/** How long a /json lookup may take: instant on a local Chrome. */
const CDP_JSON_TIMEOUT_MS = 5_000;

/**
 * Whether the browser may serve Chrome's HTTP /json: a local or host Chrome
 * does, and its endpoint is Chrome's own `/devtools/browser/<id>`. A remote
 * provider's (Browserbase, Steel, Tab Tender, over ws:// or wss://) does
 * not, and is not asked.
 */
function cdpServesJson(): boolean {
  return !browserState.cdpUrl || /^ws:\/\/[^/]+\/devtools\/browser\//.test(browserState.cdpUrl);
}

/**
 * Strict variant of the /json lookup: throws when Chrome cannot be reached or
 * answers garbage, so confirmNoPagesLeft can tell "answered: no pages" from
 * "no answer". Remote CDP providers without a /json endpoint land in the
 * throw path on purpose — a headless provider has no window for the user to
 * close, and guessing costs a leaked remote session.
 */
async function listPageTargetsStrict(): Promise<Array<{ type: string }>> {
  if (!cdpServesJson()) throw new Error('A remote browser serves no CDP /json');
  const res = await fetch(`${getCdpHttpEndpoint()}/json`, { signal: AbortSignal.timeout(CDP_JSON_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CDP /json answered ${res.status}`);
  const targets = await res.json() as Array<{ type: string }>;
  return targets.filter(t => t.type === 'page');
}

/** Get ALL CDP page targets across all strategies, except the tabs a saved session is read on */
async function getAllPageTargets(): Promise<PageTarget[]> {
  return (await discoverPageTargets()).filter((target) => !isSessionStubTarget(target.id));
}

/** Page targets from Chrome's HTTP /json; none when it cannot be reached or lists none. */
async function pageTargetsFromJson(): Promise<PageTarget[]> {
  const endpoint = getCdpHttpEndpoint();
  try {
    const res = await fetch(`${endpoint}/json`, { signal: AbortSignal.timeout(CDP_JSON_TIMEOUT_MS) });
    const targets = await res.json() as Array<{ id: string; type: string; url: string; title?: string; faviconUrl?: string; webSocketDebuggerUrl: string }>;
    // Chrome's /json may return webSocketDebuggerUrl with localhost which won't
    // work from inside a Docker container. Rewrite to the host we actually used.
    const cdpHost = endpoint.replace(/^https?:\/\//, '');
    return targets.filter(t => t.type === 'page').map(p => ({
      id: p.id,
      url: p.url,
      title: decodeChromeTargetTitle(p.title || ''),
      faviconUrl: p.faviconUrl || undefined,
      wsUrl: p.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${cdpHost}`),
      requiresSession: false,
    }));
  } catch {
    // HTTP /json not available — the caller falls through to the WebSocket CDP approach
    return [];
  }
}

async function discoverPageTargets(): Promise<PageTarget[]> {
  // Try Chrome's HTTP /json endpoint first (works for local Chrome)
  if (cdpServesJson()) {
    const pages = await pageTargetsFromJson();
    if (pages.length > 0) return pages;
  }

  // For remote CDP providers (e.g. Browserbase), try the host API debug endpoint first.
  const hostAppUrl = process.env.HOST_APP_URL;
  const agentId = process.env.AGENT_ID;
  if (hostAppUrl && agentId) {
    try {
      const debugHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      const proxyToken = process.env.PROXY_TOKEN;
      if (proxyToken) debugHeaders['Authorization'] = `Bearer ${proxyToken}`;

      const debugRes = await fetch(`${hostAppUrl}/api/browser/debug-info`, {
        method: 'POST',
        headers: debugHeaders,
        body: JSON.stringify({ agentId }),
      });
      if (debugRes.ok) {
        const debugInfo = await debugRes.json() as { pages?: Array<{ id: string; url: string; title?: string; wsUrl: string }> };
        const pages = debugInfo.pages || [];
        if (pages.length > 0) {
          return pages.map(p => ({
            id: p.id,
            url: p.url,
            title: p.title || '',
            wsUrl: p.wsUrl,
            requiresSession: false,
          }));
        }
      }
    } catch (err) {
      console.error('[CDP] Debug info request failed:', err);
    }
  }

  // Fallback: Target.getTargets over the browser-level WebSocket (Steel serves
  // neither /json nor page-level endpoints, so its pages are always found here).
  if (!browserState.cdpUrl) return [];
  return findPageTargetsViaCdp(browserState.cdpUrl);
}

/**
 * Find the session's page: the tab its instance is on, and never another (it
 * may be another session's). Credential actions opt into the page its viewer shows.
 */
async function findActivePageTarget(s: BrowserSession, preferViewer = false): Promise<PageTarget | null> {
  const allTargets = await getAllPageTargets();
  if (allTargets.length === 0) return null;

  let daemonTabs: Awaited<ReturnType<typeof tabManager.queryTabs>> = [];
  try {
    daemonTabs = await tabManager.queryTabs(s.key);
  } catch (err) {
    console.error('[CDP] Daemon tab query failed:', err);
  }

  return selectActivePageTarget(
    allTargets,
    daemonTabs,
    (left, right) => tabManager.urlsMatch(left, right),
    preferViewer
      ? { preferViewer: true, viewerTargetId: screencasts.get(s)?.currentTargetId ?? null }
      : {},
  );
}

/**
 * Discover page targets via CDP WebSocket protocol (for remote providers).
 * Every page, in Chrome's order: the active one is picked against the
 * daemon's tabs, as with /json.
 */
function findPageTargetsViaCdp(browserWsUrl: string): Promise<PageTarget[]> {
  return new Promise((resolve) => {
    const ws = new WebSocket(browserWsUrl);
    const timeout = setTimeout(() => { ws.close(); resolve([]); }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();
          const pages = (msg.result?.targetInfos || []).filter(
            (t: { type: string; targetId: string }) => t.type === 'page' && !isSessionStubTarget(t.targetId)
          ) as Array<{ targetId: string; url?: string; title?: string }>;
          resolve(pages.map((target) => ({
            id: target.targetId,
            url: target.url || '',
            title: target.title || '',
            wsUrl: browserWsUrl,
            requiresSession: true,
          })));
        }
      } catch { /* wait for next message */ }
    });

    ws.on('error', () => { clearTimeout(timeout); resolve([]); });
  });
}

interface CredentialAutofillResult {
  ok: boolean;
  reason?: 'origin_changed' | 'no_password_field';
  usernameFilled: boolean;
  passwordFilled: boolean;
}

/**
 * Execute the privileged fill on the active target. The expected-origin check
 * and DOM mutation happen in one JS turn, so a navigation between host lookup
 * and fill cannot receive the credential.
 */
function autofillCredentialViaCdp(
  target: PageTarget,
  username: string,
  password: string,
  expectedOrigin: string,
): Promise<CredentialAutofillResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.wsUrl);
    let sessionId: string | null = null;
    let settled = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Credential autofill timed out'));
    }, 5000);

    const finish = (result?: CredentialAutofillResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      if (error) reject(error);
      else resolve(result || { ok: false, usernameFilled: false, passwordFilled: false });
    };

    const sendGlobalLookup = () => {
      ws.send(JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression: 'globalThis', returnByValue: false },
        ...(sessionId ? { sessionId } : {}),
      }));
    };

    ws.on('open', () => {
      if (target.requiresSession) {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Target.attachToTarget',
          params: { targetId: target.id, flatten: true },
        }));
      } else {
        sendGlobalLookup();
      }
    });

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.id === 1) {
          sessionId = message.result?.sessionId || null;
          if (!sessionId) return finish(undefined, new Error('Could not attach to browser page'));
          sendGlobalLookup();
          return;
        }
        if (message.id === 2) {
          const objectId = message.result?.result?.objectId;
          if (!objectId) return finish(undefined, new Error('Could not access browser page'));
          ws.send(JSON.stringify({
            id: 3,
            method: 'Runtime.callFunctionOn',
            params: {
              objectId,
              functionDeclaration: CREDENTIAL_AUTOFILL_FUNCTION,
              arguments: [
                { value: username },
                { value: password },
                { value: expectedOrigin },
              ],
              returnByValue: true,
              awaitPromise: true,
            },
            ...(sessionId ? { sessionId } : {}),
          }));
          return;
        }
        if (message.id === 3) {
          if (message.error || message.result?.exceptionDetails) {
            return finish(undefined, new Error('Browser rejected credential autofill'));
          }
          const value = message.result?.result?.value as CredentialAutofillResult | undefined;
          if (!value || typeof value.ok !== 'boolean') {
            return finish(undefined, new Error('Browser returned an invalid autofill result'));
          }
          finish(value);
        }
      } catch {
        // Ignore unrelated CDP events and wait for the response IDs above.
      }
    });

    ws.on('error', () => finish(undefined, new Error('Could not connect to browser page')));
  });
}

// Host-only credential endpoints. The global host-token middleware prevents
// the agent's own shell from discovering metadata or injecting secrets.
const credentialAutofillRequestSchema = z.object({
  sessionId: z.string().min(1).max(1024),
  username: z.string().max(4096),
  password: z.string().min(1).max(65536),
  expectedOrigin: z.string().max(2048).refine((value) => {
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === value;
    } catch {
      return false;
    }
  }),
}).strict();

app.get('/browser/credential-context', async (c) => {
  if (!hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503);
  const sessionId = c.req.query('sessionId');
  if (!sessionId) return c.json({ error: 'sessionId is required' }, 400);
  const s = browserSessionOf(sessionId);
  if (!s) return c.json({ error: 'Browser is not active' }, 409);

  const target = await findActivePageTarget(s, true);
  if (!target?.url) return c.json({ error: 'No active browser page was found' }, 409);
  return c.json({ url: target.url });
});

app.post('/browser/fill-credential', async (c) => {
  try {
    if (!hostAuthEnabled()) return c.json({ error: 'Host authentication is required' }, 503);
    const parsedBody = credentialAutofillRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsedBody.success) return c.json({ error: 'Invalid credential autofill request' }, 400);
    const body = parsedBody.data;
    const s = browserSessionOf(body.sessionId);
    if (!s) return c.json({ error: 'Browser is not active' }, 409);

    const target = await findActivePageTarget(s, true);
    if (!target) return c.json({ error: 'No active browser page was found' }, 409);
    // From here the password may be on the page: what the agent reads redacts it.
    rememberInjectedSecret(body.password);
    const result = await autofillCredentialViaCdp(
      target,
      body.username,
      body.password,
      body.expectedOrigin,
    );
    if (!result.ok) {
      const message = result.reason === 'origin_changed'
        ? 'The browser page changed before autofill'
        : 'No visible password field was found';
      return c.json({ error: message, reason: result.reason }, 409);
    }
    return c.json({
      success: true,
      usernameFilled: result.usernameFilled,
      passwordFilled: result.passwordFilled,
    });
  } catch (error) {
    console.error('[Browser] Credential autofill failed:', error instanceof Error ? error.message : 'Unknown error');
    return c.json({ error: 'Credential autofill failed' }, 500);
  }
});

// ── request_login ───────────────────────────────────────────────────────────
// The endpoints live in login-routes.ts; these are their hands on the live
// browser: the CLI for refs, our own CDP connection for the page, and the
// settle-and-observe primitive for the submit.

function loginFillDeps(sessionId: string): LoginFillDeps {
  // Looked up on each call: a session that stopped using the browser has no tab to act on.
  const session = (): BrowserSession => {
    const s = browserSessionOf(sessionId);
    if (!s) throw new Error('This session has no browser open');
    return s;
  };
  return {
    focusRef: async (ref) => {
      const s = session();
      const r = await withRefRestore(s, ref, () => execBrowser(['focus', ref], s));
      // Redacted before it is cut: a cut can split a value past recognition.
      return r.exitCode === 0 ? null : redactInjectedSecrets(r.stdout.split('\n')[0] || 'the CLI reported an error').slice(0, 200);
    },
    boxOfRef: async (ref) => {
      const s = session();
      const r = await withRefRestore(s, ref, () => execBrowser(['get', 'box', ref, '--json'], s));
      if (r.exitCode !== 0) return null;
      const parsed = z.object({
        data: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      }).safeParse((() => { try { return JSON.parse(r.stdout); } catch { return null; } })());
      if (!parsed.success) return null;
      const { x, y, width, height } = parsed.data.data;
      return { x, y, width, height } satisfies FieldBox;
    },
    isEnabled: async (ref) => {
      const r = await execBrowser(['is', 'enabled', ref], session());
      if (r.exitCode !== 0) return null;
      const answer = r.stdout.trim().toLowerCase();
      return answer === 'true' ? true : answer === 'false' ? false : null;
    },
    connect: async () => {
      // The session's tab: the one its refs belong to.
      const target = await findActivePageTarget(session());
      if (!target) throw new Error('No active browser page was found');
      return CdpConnection.open(target);
    },
  };
}

/**
 * Submit a filled sign-in form: click the agent's submit ref through the CLI
 * (trusted input); when a banner covers it, click it from the page instead;
 * with no submit ref, press Enter — only while focus is still in the last
 * field written, so Enter cannot land in another document or field.
 * Right before each try, the page is checked once more: one that moved on by
 * itself gets nothing. (Since 0.44 the CLI refuses a ref of a document the
 * page has replaced rather than resolving it by role and name on whatever
 * page is there, but Enter has no ref, and the in-page click is our own.)
 */
async function submitLoginForm(plan: SubmitPlan, sessionId: string): Promise<SubmitOutcome> {
  const s = browserSessionOf(sessionId);
  if (!s) return { ok: false, error: 'this session has no browser open' };
  let submitted: NonNullable<LoginFillReport['submitted']> | null = null;
  let activity: PageActivity | null = null;
  let error: string | null = null;
  // Redacted before it is cut: a cut can split a value past recognition.
  const firstLine = (text: string) => redactInjectedSecrets(text.split('\n')[0] || 'the CLI reported an error').slice(0, 300);
  const { result, digest, effect, settleMs, treeDiff } = await runWithEffect(
    s,
    async (before) => {
      const { submitRef } = plan;
      activity = await plan.stillCurrent();
      if (activity) return { exitCode: 0, stdout: '' };
      if (submitRef) {
        const click = await clickSubmit(plan, submitRef, (ref) => withRefRestore(s, ref, () => execBrowser(['click', ref, ...(useHumanInput(before) ? ['--human'] : [])], s)));
        if (click.clicked === 'cli') {
          submitted = { via: 'click', ref: submitRef };
          return click.result;
        }
        if (click.clicked === 'in-page') {
          submitted = { via: 'click-in-page', ref: submitRef, clickError: firstLine(click.cliError) };
          return { exitCode: 0, stdout: '' };
        }
        if ('activity' in click) {
          activity = click.activity;
          return { exitCode: 0, stdout: '' };
        }
        error = `clicking ${submitRef} failed: ${firstLine(click.result.stdout)}`;
        return click.result;
      }
      if (!(await plan.enterLandsInField())) {
        error = 'Enter was not pressed: focus is no longer in the last field filled';
        return { exitCode: 1, stdout: error };
      }
      const pressed = await execBrowser(['press', 'Enter'], s);
      if (pressed.exitCode === 0) submitted = { via: 'enter' };
      else error = `pressing Enter failed: ${firstLine(pressed.stdout)}`;
      return pressed;
    },
    // A submit that only shows an error message still changed the page:
    // wait for the settle like a click on a button.
    plan.submitRef ? { ...ACTION_POLICIES.click, recheck: () => true } : pressPolicy('Enter'),
  );
  const observation = { settleMs, ...(digest && { digest }), ...(effect && { effect }), ...(treeDiff && { treeDiff }) };
  if (activity) return { ok: true, submitted: null, activity, observation };
  if (result.exitCode !== 0 || !submitted) return { ok: false, error: error ?? firstLine(result.stdout) };
  const tabInfo = await detectNewTab(s);
  return { ok: true, submitted, observation: { ...observation, ...(tabInfo && { tabInfo }) } };
}

/** The session's URL digest now, for the route modules; null when it has no browser open. */
async function sessionUrlDigest(sessionId: string): Promise<Record<string, unknown> | null> {
  const s = browserSessionOf(sessionId);
  const digest = s ? await observeUrlDigest(s) : null;
  return digest ? { ...digest } : null;
}

registerLoginRoutes(app, {
  hostAuthEnabled,
  validateSession: browserSessionRefusal,
  browserActive: () => browserState.active,
  fillDeps: loginFillDeps,
  submit: submitLoginForm,
  observeUrl: sessionUrlDigest,
  notifyBrowserAction,
  // Declared below with the passkey routes; called only once a request comes in.
  passkeysReady: async () => {
    await passkeyKeeper.ensureArmed();
  },
});

/** The browser's own CDP endpoint, not a page's: a host browser's is the one it launched with. */
async function browserWsUrl(): Promise<string> {
  if (browserState.cdpUrl) return browserState.cdpUrl;
  const endpoint = getCdpHttpEndpoint();
  const response = await fetch(`${endpoint}/json/version`);
  if (!response.ok) throw new Error(`CDP /json/version answered ${response.status}`);
  const { webSocketDebuggerUrl } = await response.json() as { webSocketDebuggerUrl?: string };
  if (!webSocketDebuggerUrl) throw new Error('the browser named no endpoint');
  return webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${endpoint.replace(/^https?:\/\//, '')}`);
}

// ── Passkeys ────────────────────────────────────────────────────────────────
// The endpoints live in passkey-routes.ts: a virtual authenticator on the
// agent's tab, over a browser-level connection of our own that stays open
// while it holds passkeys.

const passkeyKeeper = new PasskeyKeeper({
  connectBrowser: async () => CdpConnection.openBrowser(await browserWsUrl(), { callTimeoutMs: 20_000 }),
});

registerPasskeyRoutes(app, {
  hostAuthEnabled,
  validateSession: browserSessionRefusal,
  browserActive: () => browserState.active,
  keeper: passkeyKeeper,
  activeTab: async (sessionId) => {
    const s = browserSessionOf(sessionId);
    const target = s ? await findActivePageTarget(s) : null;
    return target ? { id: target.id, url: target.url } : null;
  },
});

// ── Saved sessions ──────────────────────────────────────────────────────────
// The endpoints live in session-routes.ts; reading or replacing a site's
// state goes over a browser-level connection of our own.

registerSessionRoutes(app, {
  hostAuthEnabled,
  validateSession: browserSessionRefusal,
  browserActive: () => browserState.active,
  // A remote browser answers slower; a database read is one call.
  connectBrowser: async () => CdpConnection.openBrowser(await browserWsUrl(), { callTimeoutMs: 20_000 }),
  activeTabId: async (sessionId) => {
    const s = browserSessionOf(sessionId);
    return s ? (await findActivePageTarget(s))?.id ?? null : null;
  },
  observeUrl: sessionUrlDigest,
  pageReplaced: (sessionId) => {
    browserSessionOf(sessionId)?.trees.reset();
    notifyBrowserAction();
  },
});

/** Helper to build a CDP message, adding sessionId when in session mode */
function cdpMsg(state: Screencast, method: string, params?: Record<string, unknown>): string {
  const msg: Record<string, unknown> = { id: ++state.msgId, method };
  if (params) msg.params = params;
  if (state.cdpSessionId) msg.sessionId = state.cdpSessionId;
  return JSON.stringify(msg);
}

/** Connect CDP screencast to a page target and forward frames to the client */
function connectCdpToTarget(s: BrowserSession, targetId: string, wsUrl: string, clientWs: WebSocket, requiresSession = false) {
  const cdpWs = new WebSocket(wsUrl);
  const prevAutoFollow = screencasts.get(s)?.autoFollow ?? true;
  const state: Screencast = {
    session: s, clientWs, cdpWs, currentTargetId: targetId, msgId: 0,
    lastDeviceWidth: 0, lastDeviceHeight: 0, cdpSessionId: null,
    autoFollow: prevAutoFollow, pendingSelections: new Set(), screencastStarted: false,
    navigation: createBrowserNavigation({
      targetId,
      sendCommand(method, params) {
        if (screencasts.get(s) !== state || cdpWs.readyState !== WebSocket.OPEN) return;
        cdpWs.send(cdpMsg(state, method, params));
        return state.msgId;
      },
      publish(message) {
        if (screencasts.get(s) === state && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify(message));
        }
      },
    }),
  };
  screencasts.set(s, state);

  cdpWs.on('open', () => {
    if (screencasts.get(s) !== state) { cdpWs.close(); return; }
    if (requiresSession) {
      // Remote CDP: attach to target with flattened session first
      cdpWs.send(JSON.stringify({
        id: ++state.msgId,
        method: 'Target.attachToTarget',
        params: { targetId, flatten: true },
      }));
    } else {
      // Local Chrome: page-level WebSocket, send screencast directly
      startScreencast(state);
      // Enable Page domain to receive navigation lifecycle events
      cdpWs.send(cdpMsg(state, 'Page.enable'));
      // Discover the main frame ID so we only forward loading events for the
      // top-level frame, not iframes/ads that load continuously.
      const frameTreeId = ++state.msgId;
      cdpWs.send(JSON.stringify({ id: frameTreeId, method: 'Page.getFrameTree', ...(state.cdpSessionId ? { sessionId: state.cdpSessionId } : {}) }));
      state.navigation.refresh();
    }
  });

  cdpWs.on('message', (rawData) => {
    if (screencasts.get(s) !== state) return;
    try {
      const msg = JSON.parse(rawData.toString());

      // Handle attachToTarget response — start screencast once we have a session
      if (requiresSession && !state.cdpSessionId && msg.result?.sessionId) {
        state.cdpSessionId = msg.result.sessionId;
        startScreencast(state);
        // Discover the main frame in remote session mode too.
        cdpWs.send(cdpMsg(state, 'Page.enable'));
        cdpWs.send(cdpMsg(state, 'Page.getFrameTree'));
        state.navigation.refresh();
        return;
      }

      // In session mode, only handle messages for our session
      if (state.cdpSessionId && msg.sessionId && msg.sessionId !== state.cdpSessionId) return;
      if (state.navigation.handleMessage(msg)) return;

      if (msg.method === 'Page.screencastFrame') {
        cdpWs.send(cdpMsg(state, 'Page.screencastFrameAck', { sessionId: msg.params.sessionId }));
        if (clientWs.readyState === WebSocket.OPEN) {
          // Send metadata when viewport dimensions change
          const meta = msg.params.metadata;
          if (meta && (meta.deviceWidth !== state.lastDeviceWidth || meta.deviceHeight !== state.lastDeviceHeight)) {
            state.lastDeviceWidth = meta.deviceWidth;
            state.lastDeviceHeight = meta.deviceHeight;
            clientWs.send(JSON.stringify({
              type: 'metadata',
              deviceWidth: meta.deviceWidth,
              deviceHeight: meta.deviceHeight,
            }));
          }
          clientWs.send(Buffer.from(msg.params.data, 'base64'));
        }
      } else if (msg.method === 'Page.frameStartedLoading' || msg.method === 'Page.frameStoppedLoading') {
        // Only forward loading state for the main frame — subframes (ads,
        // analytics, iframes) load continuously and would keep the spinner on.
        const frameId = msg.params?.frameId;
        if (state.navigation.isMainFrame(frameId) && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'page_loading',
            loading: msg.method === 'Page.frameStartedLoading',
          }));
        }
      } else if (msg.id && state.pendingSelections.has(msg.id)) {
        state.pendingSelections.delete(msg.id);
        const text = msg.result?.result?.value;
        if (typeof text === 'string' && text && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'selection_result', text }));
        }
      }
    } catch { /* ignore */ }
  });

  cdpWs.on('close', () => {
    state.navigation.dispose();
    // If this wasn't our active connection (already replaced by a tab switch), ignore
    if (screencasts.get(s)?.cdpWs !== cdpWs) return;

    // Unexpected close — try to recover by switching to the session's tab
    const generationAtDetection = browserOpenGeneration;
    findActivePageTarget(s).then(async target => {
      if (!target) {
        target = await recheckPageTarget(() => findActivePageTarget(s), sleep);
      }
      if (target && screencasts.get(s) === state && clientWs.readyState === WebSocket.OPEN) {
        console.log('[CDP] Recovering from closed target, switching to', target.id);
        state.autoFollow = true;
        switchScreencastTarget(s, target, clientWs);
        broadcastTabList(s);
      } else if (
        !target &&
        (await confirmNoPagesLeft(listPageTargetsStrict)) &&
        browserOpenGeneration === generationAtDetection
      ) {
        // The tab we were streaming was the last one — the user closed the
        // browser. Same ordering rule as the connect path: state first, so the
        // viewer's status check on the socket close answers "inactive".
        const cleanup = handleExternalBrowserClose('streamed page closed with no page left', { stopHostBrowser: true });
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'browser_closed' }));
          clientWs.close();
        }
        await cleanup;
      } else if (clientWs.readyState === WebSocket.OPEN) {
        // Recovery target lost its viewer, or the close couldn't be confirmed
        // (endpoint unreachable / a fresh browser_open won the race). Drop the
        // socket and let the viewer's bounded retry sort out which it was.
        clientWs.close();
      }
    }).catch(() => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });
  });

  cdpWs.on('error', (err) => {
    console.error('[CDP] Screencast error:', err);
  });
}

/** Stop a session's viewer, or every viewer. */
function cleanupCdpScreencast(s?: BrowserSession) {
  for (const state of s ? [screencasts.get(s)].filter(v => v !== undefined) : [...screencasts.values()]) {
    if (state.cdpWs.readyState === WebSocket.OPEN) {
      state.cdpWs.send(cdpMsg(state, 'Page.stopScreencast'));
      state.cdpWs.close();
    }
    screencasts.delete(state.session);
  }
}

/** Switch the CDP screencast to a different target, keeping the client WS alive */
function switchScreencastTarget(s: BrowserSession, target: PageTarget, clientWs: WebSocket): void {
  const viewer = screencasts.get(s);
  if (viewer?.cdpWs.readyState === WebSocket.OPEN) {
    viewer.cdpWs.send(cdpMsg(viewer, 'Page.stopScreencast'));
    viewer.cdpWs.close();
  }
  // Activate the tab in Chrome so it renders (required for screencast).
  // Use Target.activateTarget on a temporary browser-level CDP connection
  // instead of Page.bringToFront, which steals OS window focus.
  activateTargetInBackground(target.id);
  connectCdpToTarget(s, target.id, target.wsUrl, clientWs, target.requiresSession);
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({ type: 'tab_switched', targetId: target.id }));
  }
}

/** Activate a tab in Chrome without stealing OS focus.
 *  Opens a short-lived browser-level CDP connection to send Target.activateTarget. */
function activateTargetInBackground(targetId: string): void {
  activateTarget(targetId).catch(() => { /* best-effort — screencast may just show stale frames */ });
}

/** Broadcast the tab list to a session's viewer: every tab, the session's own marked active.
 *  Accepts pre-fetched data to avoid redundant calls when used alongside findActivePageTarget. */
async function broadcastTabList(s: BrowserSession, prefetched?: { allTargets: PageTarget[]; daemonTabs: Awaited<ReturnType<typeof tabManager.queryTabs>> }): Promise<void> {
  const viewer = screencasts.get(s);
  if (!viewer) return;
  const clientWs = viewer.clientWs;
  if (clientWs.readyState !== WebSocket.OPEN) return;

  try {
    const { allTargets, daemonTabs } = prefetched ?? await readTabSources(
      () => getAllPageTargets(),
      () => tabManager.queryTabs(s.key),
    );

    const claimedTargetIds = new Set<string>();
    let tabs: BrowserTabInfo[] = [];
    for (const dt of daemonTabs) {
      // By target id when the daemon reports it (exact even when two tabs
      // share a URL); by URL otherwise.
      const target = (dt.targetId ? allTargets.find(t => t.id === dt.targetId && !claimedTargetIds.has(t.id)) : undefined)
        ?? allTargets.find(t => tabManager.urlsMatch(t.url, dt.url) && !claimedTargetIds.has(t.id));
      if (!target) continue; // skip tabs with no CDP match (timing edge case, resolves on next poll)
      claimedTargetIds.add(target.id);
      tabs.push({
        targetId: target.id,
        // Positional index for the renderer's display fallback only — the daemon's
        // stable ids (t1, t2, …) are strings and tab switching uses targetId
        index: tabs.length,
        // Chrome's URL is the address bar's; the daemon's can lag a navigation.
        url: target.url || dt.url,
        // Prefer Chrome's title (actual <title> tag) over daemon's (often just domain)
        title: target.title || dt.title || '',
        faviconUrl: target.faviconUrl,
        active: dt.active,
      });
    }

    // If URL-based matching produced no tabs (daemon state is stale — common in
    // --cdp / host browser mode where the daemon doesn't track navigations),
    // fall back to building the tab list directly from Chrome's CDP targets.
    if (tabs.length === 0 && allTargets.length > 0) {
      const currentTargetId = viewer.currentTargetId;
      tabs = allTargets.map((t, i) => ({
        targetId: t.id,
        index: i,
        url: t.url,
        title: t.title || '',
        faviconUrl: t.faviconUrl,
        active: t.id === currentTargetId,
      }));
    }

    const activeEntry = tabs.find(t => t.active);
    const activeTargetId = activeEntry?.targetId;

    // Auto-follow: switch screencast if active target changed (e.g. user clicked a link that opened a new tab)
    if (viewer.autoFollow && activeTargetId && activeTargetId !== viewer.currentTargetId) {
      const target = allTargets.find(t => t.id === activeTargetId);
      if (target) {
        switchScreencastTarget(s, target, clientWs);
      }
    }

    clientWs.send(JSON.stringify({
      type: 'tab_list',
      tabs,
      activeTargetId: activeEntry?.targetId ?? viewer.currentTargetId,
    } satisfies BrowserTabListMessage));
  } catch (err) {
    console.error('[CDP] Failed to broadcast tab list:', err);
  }
}

/**
 * After a browser action, check each viewer's session: switch its screencast if
 * the session's tab changed, and refresh its tab list (another session's action
 * can open or close tabs in it too).
 */
function notifyBrowserAction() {
  for (const viewer of screencasts.values()) followSession(viewer);
}

function followSession(viewer: Screencast) {
  const s = viewer.session;
  const currentClient = viewer.clientWs;
  // Brief delay to let agent-browser update its internal state after the action
  setTimeout(async () => {
    const cdpScreencast = screencasts.get(s);
    if (!cdpScreencast || cdpScreencast.clientWs !== currentClient) return;

    try {
      // Fetch once and share across both operations. Sequential, not
      // Promise.all: the daemon must not be asked for tabs when Chrome has no
      // page — see readTabSources.
      const { allTargets, daemonTabs } = await readTabSources(
        () => getAllPageTargets(),
        () => tabManager.queryTabs(s.key),
      );

      // Resolve where the viewer should move. Do not prefer its current target:
      // a stale daemon URL must retain Chrome's MRU fallback for auto-follow.
      const activeTarget = selectActivePageTarget(
        allTargets,
        daemonTabs,
        (left, right) => tabManager.urlsMatch(left, right),
      );

      // Switch screencast only if auto-following and target changed
      if (activeTarget && activeTarget.id !== cdpScreencast.currentTargetId && cdpScreencast.autoFollow) {
        console.log(`[CDP] Auto-following to target ${activeTarget.id}`);
        switchScreencastTarget(s, activeTarget, currentClient);
      }

      // Always broadcast updated tab list (so frontend sees agent's active tab move)
      broadcastTabList(s, { allTargets, daemonTabs });
    } catch (err) {
      console.error('[CDP] notifyBrowserAction failed:', err);
    }
  }, 300);
}

// Handle browser stream WebSocket - CDP-based screencast
function handleBrowserStreamConnection(ws: WebSocket, s: BrowserSession) {
  // If the session has a viewer already, close it (one viewer per session)
  cleanupCdpScreencast(s);

  const generationAtDetection = browserOpenGeneration;
  findActivePageTarget(s).then(async (target) => {
    if (!target) {
      target = await recheckPageTarget(() => findActivePageTarget(s), sleep);
    }
    if (!target) {
      if (
        (await confirmNoPagesLeft(listPageTargetsStrict)) &&
        browserOpenGeneration === generationAtDetection
      ) {
        // No page anywhere in the browser, twice over, and Chrome itself said
        // so: the user closed it. Reset our state before closing the socket so
        // the viewer's post-close status check sees "inactive" and stops
        // reconnecting to a browser that's gone.
        console.error('[CDP] No page target left — treating the browser as closed');
        const cleanup = handleExternalBrowserClose('no page target left', { stopHostBrowser: true });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'browser_closed' }));
          ws.close();
        }
        await cleanup;
      } else {
        // Couldn't prove the browser is gone (endpoint unreachable, or a fresh
        // browser_open landed mid-detection). Answer like the old code and let
        // the viewer's bounded retry try again once things settle.
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'No browser tab found — the page may still be loading' }));
        }
        ws.close();
      }
      return;
    }
    connectCdpToTarget(s, target.id, target.wsUrl, ws, target.requiresSession);
    broadcastTabList(s);
  }).catch((err) => {
    console.error('[CDP] Failed to start screencast:', err);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to connect to browser' }));
    }
    ws.close();
  });

  // Start tab list polling for this connection (replaces any previous viewer's timer)
  const tabPoll = startTabPolling(() => broadcastTabList(s), undefined, s.key);
  let viewerWidthTimer: ReturnType<typeof setTimeout> | undefined;

  // Forward input events and handle tab control messages from client
  // Protocol: see src/renderer/components/browser/browser-preview.tsx
  ws.on('message', async (rawData) => {
    try {
      const data = JSON.parse(rawData.toString());
      if (data.type === 'viewport') {
        // Applied once reports settle: a dragged panel sends many, and each restart makes Chrome encode a frame.
        const width = clampViewerWidth(data.width);
        if (width !== undefined) {
          clearTimeout(viewerWidthTimer);
          viewerWidthTimer = setTimeout(() => setViewerWidth(ws, width), VIEWER_WIDTH_DEBOUNCE_MS);
        }
        return;
      }
      const cdpScreencast = screencasts.get(s);
      if (!cdpScreencast) return;

      if (data.type === 'switch_tab' && data.targetId) {
        // User wants to view a specific tab
        const allTargets = await getAllPageTargets();
        const target = allTargets.find(t => t.id === data.targetId);
        if (target && screencasts.get(s) === cdpScreencast) {
          cdpScreencast.autoFollow = false;
          switchScreencastTarget(s, target, ws);
        }
      } else if (data.type === 'close_tab' && data.targetId) {
        // Close a tab via CDP Target.closeTarget on a temporary browser-level connection
        try {
          const browserWs = new WebSocket(await browserWsUrl());
          browserWs.on('open', () => {
            browserWs.send(JSON.stringify({
              id: 1,
              method: 'Target.closeTarget',
              params: { targetId: data.targetId },
            }));
          });
          browserWs.on('message', async (raw) => {
            browserWs.close();
            const reply = JSON.parse(raw.toString()) as { error?: unknown };
            const listPageTargets = reply.error
              ? getAllPageTargets
              : listPageTargetsExcept(getAllPageTargets, data.targetId);
            try {
              const sources = await readTabSources(listPageTargets, () => tabManager.queryTabs(s.key));
              // If we just closed the tab we were screencasting, switch to another
              if (screencasts.get(s)?.currentTargetId === data.targetId) {
                const target = selectActivePageTarget(
                  sources.allTargets,
                  sources.daemonTabs,
                  (left, right) => tabManager.urlsMatch(left, right),
                );
                if (target && screencasts.get(s)) {
                  switchScreencastTarget(s, target, ws);
                }
              }
              broadcastTabList(s, sources);
              // The other sessions' viewers list the tab too.
              notifyBrowserAction();
            } catch (err) {
              console.error('[CDP] Failed to refresh tabs after close:', err);
            }
          });
          browserWs.on('error', () => {});
          setTimeout(() => browserWs.close(), 3000);
        } catch {
          console.error('[CDP] Failed to close tab', data.targetId);
        }
      } else if (data.type === 'follow_agent') {
        cdpScreencast.autoFollow = data.enabled !== false;
        if (cdpScreencast.autoFollow) {
          // Snap to the session's tab immediately
          const target = await findActivePageTarget(s);
          if (target && screencasts.get(s) === cdpScreencast && target.id !== cdpScreencast.currentTargetId) {
            switchScreencastTarget(s, target, ws);
          }
        }
      } else if (cdpScreencast.cdpWs.readyState === WebSocket.OPEN) {
        if (data.type === 'navigate') {
          // Viewer's back / forward / reload buttons, acting on the tab being viewed.
          if (data.action === 'reload' || data.action === 'back' || data.action === 'forward') {
            cdpScreencast.navigation.navigate(data.action);
          }
        } else if (data.type === 'input_mouse') {
          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.dispatchMouseEvent', {
            type: data.eventType,
            x: Math.round(data.x),
            y: Math.round(data.y),
            button: data.button,
            clickCount: data.clickCount || 0,
            deltaX: data.deltaX || 0,
            deltaY: data.deltaY || 0,
            modifiers: data.modifiers || 0,
          }));
        } else if (data.type === 'input_keyboard') {
          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.dispatchKeyEvent', {
            type: data.eventType,
            key: data.key,
            code: data.code,
            text: data.text,
            windowsVirtualKeyCode: data.keyCode || 0,
            nativeVirtualKeyCode: data.keyCode || 0,
            modifiers: data.modifiers || 0,
          }));
        } else if (data.type === 'input_press') {
          // Playwright-style key press: look up editing commands from Playwright's
          // macEditingCommands map and include them in the CDP event. This is required
          // for Chrome to trigger keyboard shortcuts (selectAll, cut, undo, etc.) via CDP.
          const mods = data.modifiers || 0;
          const isPrintable = data.key && data.key.length === 1;
          const commands = getEditingCommands(data.code, mods);

          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.dispatchKeyEvent', {
            type: isPrintable ? 'keyDown' : 'rawKeyDown',
            key: data.key, code: data.code,
            text: isPrintable ? data.key : '',
            unmodifiedText: isPrintable ? data.key : '',
            windowsVirtualKeyCode: data.keyCode || 0,
            nativeVirtualKeyCode: data.keyCode || 0,
            modifiers: mods,
            commands,
          }));

          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key: data.key, code: data.code,
            windowsVirtualKeyCode: data.keyCode || 0,
            nativeVirtualKeyCode: data.keyCode || 0,
            modifiers: mods,
          }));
        } else if (data.type === 'input_paste' && data.text) {
          cdpScreencast.cdpWs.send(cdpMsg(cdpScreencast, 'Input.insertText', {
            text: data.text,
          }));
        } else if (data.type === 'get_selection') {
          // Capture the message ID before cdpMsg increments it, to avoid re-parsing
          const msgId = cdpScreencast.msgId + 1;
          const msgStr = cdpMsg(cdpScreencast, 'Runtime.evaluate', {
            expression: 'window.getSelection().toString()',
            returnByValue: true,
          });
          cdpScreencast.pendingSelections.add(msgId);
          cdpScreencast.cdpWs.send(msgStr);
        }
      }
    } catch { /* ignore parse errors for non-JSON frames */ }
  });

  ws.on('close', () => {
    stopTabPolling(tabPoll);
    clearTimeout(viewerWidthTimer);
    if (screencasts.get(s)?.clientWs === ws) cleanupCdpScreencast(s);
  });

  ws.on('error', () => {
    stopTabPolling(tabPoll);
    clearTimeout(viewerWidthTimer);
    if (screencasts.get(s)?.clientWs === ws) cleanupCdpScreencast(s);
  });
}

// Spawn a CLI subprocess for the shape of the last session this workspace ran,
// so the first session after a wake doesn't pay the boot cost inline. No-op
// until a session has been created here at least once. Kicked off before the
// dashboard scan below: on a cold container the two compete for the same two
// CPUs, and only this one is in front of a waiting user.
// Both wait for volumes to mount: the warm CLI keeps the prompt it starts with, which lists them.
volumesMounted.then(() => {
  if (isShuttingDown) return;
  sessionManager.prewarmFromLastProfile();

  // Start dashboard processes asynchronously (don't block server startup)
  dashboardManager.scanAndStartAll().catch((error) => {
    console.error('[DashboardManager] Failed to scan and start dashboards:', error);
  });
});

// Sweep abandoned input requests. Entries the host never answers (session
// deleted mid-prompt, app closed, request card ignored) would otherwise live
// forever — pinning dead tool-handler closures and, via the early-result
// buffer, secret values. TTLs are type-aware inside cleanupStale.
setInterval(() => inputManager.cleanupStale(), 60_000).unref();

// Pin agent-browser's screenshot directory and sweep stale files (boot +
// hourly). Every screenshot is a uniquely named PNG nothing else deletes.
startScreenshotJanitor();

pinBrowserScaleArgs();

console.log(`Server running on http://localhost:${port}`);
console.log('Available endpoints:');
console.log('  POST   /sessions');
console.log('  GET    /sessions/:id');
console.log('  GET    /sessions');
console.log('  DELETE /sessions/:id');
console.log('  POST   /sessions/:id/interrupt');
console.log('  GET    /sessions/:id/context');
console.log('  POST   /sessions/:id/tasks/:taskId/stop');
console.log('  POST   /sessions/:id/messages');
console.log('  WS     /sessions/:id/stream');
console.log('  GET    /files/*');
console.log('  GET    /files/*/content');
console.log('  POST   /files/*/upload');
console.log('  DELETE /files/*');
console.log('  POST   /files/*/mkdir');
console.log('  GET    /files/tree');
console.log('  POST   /inputs/:toolUseId/resolve');
console.log('  POST   /inputs/:toolUseId/reject');
console.log('  GET    /inputs/pending');
console.log('  POST   /env');
console.log('  GET    /artifacts');
console.log('  POST   /artifacts/:slug/create');
console.log('  POST   /artifacts/:slug/start');
console.log('  GET    /artifacts/:slug/logs');
console.log('  ALL    /artifacts/:slug/*');
console.log('  GET    /browser/status');
console.log('  POST   /browser/open');
console.log('  POST   /browser/close');
console.log('  POST   /browser/snapshot');
console.log('  POST   /browser/click');
console.log('  POST   /browser/fill');
console.log('  POST   /browser/scroll');
console.log('  POST   /browser/wait');
console.log('  WS     /browser/stream');

// Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  // The host stops containers with a 5s grace, then kills them.
  const uploadDeadline = Date.now() + 4_000;

  // Close the browser even if the last session using it was released.
  if (browserState.location) {
    try {
      await closeBrowser('The agent container shut down before the user completed this request');
    } catch (error) {
      console.error('Error closing browser:', error);
    }
  }

  // Stop all dashboard processes
  try {
    await dashboardManager.stopAll();
  } catch (error) {
    console.error('Error stopping dashboards:', error);
  }

  // Stop all sessions (stops Claude Code processes)
  try {
    await sessionManager.stopAll();
  } catch (error) {
    console.error('Error stopping sessions:', error);
  }

  // After sessions stop, so nothing is still writing to a volume.
  await unmountVolumes(uploadDeadline);

  // Close WebSocket servers
  browserWss.close(() => {
    console.log('Browser WebSocket server closed.');
  });
  wss.close(() => {
    console.log('WebSocket server closed.');
  });

  // Close HTTP server
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
