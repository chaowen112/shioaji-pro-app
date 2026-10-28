import type { Profile, Workspace } from './workspace';

export type WorkspaceEnvelope = {
    workspace: Workspace;
    profiles: Profile[];
    revision: number;
    updated_at: string;
};

export class WorkspaceSyncError extends Error {
    constructor(public readonly kind: 'offline' | 'conflict' | 'invalid', public readonly envelope?: WorkspaceEnvelope) {
        super(kind);
    }
}

async function jsonResponse(response: Response): Promise<unknown> {
    try { return await response.json(); } catch { return null; }
}

function envelope(value: unknown): WorkspaceEnvelope | null {
    if (!value || typeof value !== 'object') return null;
    const body = value as Record<string, unknown>;
    if (!body.workspace || !Array.isArray(body.profiles) || !Number.isInteger(body.revision) || typeof body.updated_at !== 'string') return null;
    return body as unknown as WorkspaceEnvelope;
}

export async function fetchWorkspace(): Promise<WorkspaceEnvelope | null> {
    let response: Response;
    try { response = await fetch('/workspace', { credentials: 'same-origin', cache: 'no-store' }); }
    catch { throw new WorkspaceSyncError('offline'); }
    if (response.status === 404) return null;
    const body = envelope(await jsonResponse(response));
    if (!response.ok || !body) throw new WorkspaceSyncError('invalid');
    return body;
}

export async function putWorkspace(workspace: Workspace, profiles: Profile[], expectedRevision: number): Promise<WorkspaceEnvelope> {
    let response: Response;
    try {
        response = await fetch('/workspace', {
            method: 'PUT', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspace, profiles, expectedRevision }),
        });
    } catch { throw new WorkspaceSyncError('offline'); }
    const body = envelope(await jsonResponse(response));
    if (response.status === 409 && body) throw new WorkspaceSyncError('conflict', body);
    if (!response.ok || !body) throw new WorkspaceSyncError('invalid');
    return body;
}
