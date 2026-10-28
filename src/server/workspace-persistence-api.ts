import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { Pool, type PoolClient } from 'pg';

// Keep this outside /api: Vite's Shioaji proxy owns /api and would forward
// workspace requests before this middleware can handle them.
const PREFIX = '/workspace';
const COOKIE = 'sj-pro-install-id';
const MAX_BODY_BYTES = 1024 * 1024;
const MIGRATION = path.resolve(process.cwd(), 'services/taiwan-analysis/migrations/002_workspace_persistence.sql');
const pool = loadDatabase();
let schemaReady: Promise<void> | null = null;

type JsonObject = Record<string, unknown>;
type Stored = { workspace: JsonObject; profiles: unknown[]; revision: number; updated_at: string };

function loadDatabase(): Pool | null {
    const envFile = process.env.HERMES_ENV_FILE ?? path.join(os.homedir(), '.hermes/.env');
    try {
        for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
            const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
            if (match?.[1] && !process.env[match[1]] && match[2] !== undefined) {
                process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
            }
        }
    } catch { /* optional environment file */ }
    return process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }) : null;
}

function sendJson(response: ServerResponse, status: number, body: JsonObject): void {
    const payload = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Length', Buffer.byteLength(payload));
    response.end(payload);
}

function cookieValue(request: IncomingMessage): string | null {
    const raw = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    const value = raw?.slice(COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function identity(request: IncomingMessage, response: ServerResponse): string {
    const existing = cookieValue(request);
    if (existing) return existing;
    const value = randomBytes(32).toString('hex');
    const secure = request.headers['x-forwarded-proto'] === 'https' || request.headers.host?.startsWith('https://') === true;
    response.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`);
    return value;
}

async function ensureSchema(): Promise<void> {
    if (!pool) return;
    schemaReady ??= fs.promises.readFile(MIGRATION, 'utf8').then((sql) => pool.query(sql)).then(() => undefined).catch((error) => { schemaReady = null; throw error; });
    return schemaReady;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
    const length = Number(request.headers['content-length']);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw Object.assign(new Error('too_large'), { status: 413 });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error('too_large'), { status: 413 });
        chunks.push(buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

function validWorkspace(value: unknown): value is JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const workspace = value as { blocks?: unknown; layout?: unknown };
    return Array.isArray(workspace.blocks) && workspace.blocks.length > 0 && Array.isArray(workspace.layout);
}
function validPayload(value: unknown): value is { workspace: JsonObject; profiles: unknown[]; expectedRevision: number } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const body = value as Record<string, unknown>;
    return validWorkspace(body.workspace) && Array.isArray(body.profiles) && Number.isInteger(body.expectedRevision) && Number(body.expectedRevision) >= 0;
}
function row(row: { workspace: unknown; profiles: unknown; revision: unknown; updated_at: unknown }): Stored {
    return { workspace: row.workspace as JsonObject, profiles: row.profiles as unknown[], revision: Number(row.revision), updated_at: new Date(String(row.updated_at)).toISOString() };
}
async function current(client: PoolClient, key: string): Promise<Stored | null> {
    const result = await client.query('SELECT workspace, profiles, revision, updated_at FROM workspace_persistence WHERE identity_kind = $1 AND identity_key = $2', ['install', key]);
    return result.rows[0] ? row(result.rows[0]) : null;
}

export function workspacePersistenceApi(): Plugin {
    return {
        name: 'workspace-persistence-api',
        configureServer(server: ViteDevServer) {
            server.middlewares.use(async (request, response, next) => {
                if (!request.url || new URL(request.url, 'http://vite.local').pathname !== PREFIX) return next();
                const key = identity(request, response);
                try {
                    if (!pool) return sendJson(response, 503, { error: 'database_unavailable' });
                    await ensureSchema();
                    const client = await pool.connect();
                    try {
                        if (request.method === 'GET') {
                            const stored = await current(client, key);
                            return stored ? sendJson(response, 200, stored) : sendJson(response, 404, { error: 'not_found' });
                        }
                        if (request.method !== 'PUT') return sendJson(response, 405, { error: 'method_not_allowed' });
                        if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return sendJson(response, 415, { error: 'content_type_required' });
                        const body = await readBody(request);
                        if (!validPayload(body)) return sendJson(response, 400, { error: 'invalid_payload' });
                        const data = body as { workspace: JsonObject; profiles: unknown[]; expectedRevision: number };
                        if (data.expectedRevision === 0) {
                            try {
                                const inserted = await client.query('INSERT INTO workspace_persistence (identity_kind, identity_key, workspace, profiles, revision) VALUES ($1, $2, $3::jsonb, $4::jsonb, 1) RETURNING workspace, profiles, revision, updated_at', ['install', key, JSON.stringify(data.workspace), JSON.stringify(data.profiles)]);
                                return sendJson(response, 200, row(inserted.rows[0]));
                            } catch (error) {
                                if ((error as { code?: string }).code !== '23505') throw error;
                                const existing = await current(client, key);
                                return sendJson(response, 409, { error: 'revision_conflict', ...existing });
                            }
                        }
                        const updated = await client.query('UPDATE workspace_persistence SET workspace = $3::jsonb, profiles = $4::jsonb, revision = revision + 1, updated_at = now() WHERE identity_kind = $1 AND identity_key = $2 AND revision = $5 RETURNING workspace, profiles, revision, updated_at', ['install', key, JSON.stringify(data.workspace), JSON.stringify(data.profiles), data.expectedRevision]);
                        if (updated.rows[0]) return sendJson(response, 200, row(updated.rows[0]));
                        const existing = await current(client, key);
                        return sendJson(response, 409, { error: 'revision_conflict', ...(existing ?? {}) });
                    } finally { client.release(); }
                } catch (error) {
                    const status = (error as { status?: number }).status ?? 503;
                    return sendJson(response, status, { error: status === 413 ? 'payload_too_large' : status === 400 ? 'invalid_json' : 'database_unavailable' });
                }
            });
        },
    };
}
