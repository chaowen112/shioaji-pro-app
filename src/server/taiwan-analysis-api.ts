import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { Pool } from 'pg';

const PREFIX = '/api/taiwan-analysis';
const BASE_URL = 'http://127.0.0.1:21323';
const STALE_SECONDS = Number(process.env.TAIWAN_ANALYSIS_STALE_SECONDS ?? 15);
const MIGRATION = path.resolve(process.cwd(), 'services/taiwan-analysis/migrations/001_taiwan_options_vix.sql');

type Json = Record<string, unknown>;
type OptionType = 'call' | 'put';
type Contract = { code: string; root: string | null; underlying_code: string | null; expiry: string; strike: number; option_type: OptionType; multiplier: number; raw: Record<string, unknown> };
type Quote = { code: string; observedAt: string | null; bid: number | null; ask: number | null; last: number | null; bidSize: number | null; askSize: number | null; volume: number | null; openInterest: number | null; stale: boolean; quality: string; raw: Record<string, unknown> };

function loadServerEnv(): void {
    const files = [process.env.HERMES_ENV_FILE, path.join(os.homedir(), '.hermes/.env')].filter(Boolean) as string[];
    for (const file of files) {
        try {
            for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
                const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
                const key = match?.[1];
                const value = match?.[2];
                if (!key || process.env[key] || value === undefined) continue;
                process.env[key] = value.replace(/^(['"])(.*)\1$/, '$2');
            }
        } catch { /* optional */ }
    }
}
loadServerEnv();
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }) : null;
let schemaReady: Promise<void> | null = null;

function sendJson(response: ServerResponse, status: number, body: Json): void {
    const payload = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Length', Buffer.byteLength(payload));
    response.end(payload);
}
function isMissingSchema(error: unknown): boolean { return typeof error === 'object' && error !== null && (error as { code?: string }).code === '42P01'; }
function n(value: unknown): number | null { const result = typeof value === 'number' ? value : Number(value); return Number.isFinite(result) ? result : null; }
function numberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
}
function json(value: unknown): string { return JSON.stringify(value ?? {}); }
function routeFor(request: IncomingMessage): { path: string; query: URLSearchParams } | null {
    if (!request.url) return null;
    const url = new URL(request.url, 'http://vite.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
    return { path: url.pathname.slice(PREFIX.length) || '/', query: url.searchParams };
}
async function ensureSchema(): Promise<void> {
    if (!pool) return;
    schemaReady ??= fs.promises.readFile(MIGRATION, 'utf8').then(sql => pool.query(sql)).then(() => undefined).catch(error => { schemaReady = null; throw error; });
    return schemaReady;
}
function authHeaders(): Record<string, string> {
    const key = process.env.SJ_API_KEY; const secret = process.env.SJ_SEC_KEY;
    if (!key || !secret) return { Accept: 'application/json' };
    return { Authorization: 'Bearer ' + key + ':' + secret, Accept: 'application/json' };
}
async function sjGet<T>(pathname: string): Promise<T> {
    const response = await fetch(`${BASE_URL}${pathname}`, { headers: authHeaders(), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'shioaji_auth' : 'shioaji_unavailable');
    return response.json() as Promise<T>;
}
async function sjPost<T>(pathname: string, body: unknown): Promise<T> {
    const response = await fetch(`${BASE_URL}${pathname}`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'shioaji_auth' : 'shioaji_unavailable');
    return response.json() as Promise<T>;
}
function normalizeContract(raw: Record<string, unknown>): Contract | null {
    const code = String(raw.code ?? '').trim(); const expiry = String(raw.delivery_date ?? raw.expiry_date ?? '').slice(0, 10); const strike = n(raw.strike_price ?? raw.strike); const right = String(raw.option_right ?? raw.call_put ?? raw.option_type ?? '').toUpperCase();
    if (!code || String(raw.security_type ?? 'OPT').toUpperCase() !== 'OPT' || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || strike === null || strike <= 0 || !/^[CP]/.test(right)) return null;
    return { code, root: raw.root ? String(raw.root) : null, underlying_code: raw.underlying_code ? String(raw.underlying_code) : null, expiry, strike, option_type: right.startsWith('C') ? 'call' : 'put', multiplier: n(raw.multiplier ?? raw.contract_size) ?? 1, raw };
}
function timestamp(value: unknown): string | null { if (!value) return null; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function normalizeQuote(raw: Record<string, unknown>, code: string, asOf: Date): Quote {
    const bid = n(raw.buy_price ?? raw.bid ?? raw.bid_price); const ask = n(raw.sell_price ?? raw.ask ?? raw.ask_price); const last = n(raw.close ?? raw.last ?? raw.last_price); const observedAt = timestamp(raw.datetime ?? raw.timestamp ?? raw.time);
    const stale = !observedAt || (asOf.getTime() - new Date(observedAt).getTime()) / 1000 > STALE_SECONDS;
    const quality = bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid ? (stale ? 'stale' : 'ok') : (bid === null && ask === null ? 'missing_bid_ask' : 'invalid_bid_ask');
    return { code, observedAt, bid, ask, last, bidSize: n(raw.buy_volume ?? raw.bid_size), askSize: n(raw.sell_volume ?? raw.ask_size), volume: n(raw.volume), openInterest: n(raw.open_interest), stale, quality, raw };
}
function erf(x: number): number { const sign = x < 0 ? -1 : 1; const a = Math.abs(x); const t = 1 / (1 + 0.3275911 * a); return sign * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)); }
function cdf(x: number): number { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function pdf(x: number): number { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function black76(F: number, K: number, sigma: number, T: number, r: number, type: OptionType) {
    if (![F, K, sigma, T, r].every(Number.isFinite) || F <= 0 || K <= 0 || sigma <= 0 || T <= 0) return null;
    const df = Math.exp(-r * T); const root = Math.sqrt(T); const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * root); const d2 = d1 - sigma * root;
    const price = type === 'call' ? df * (F * cdf(d1) - K * cdf(d2)) : df * (K * cdf(-d2) - F * cdf(-d1));
    return { price, delta: type === 'call' ? df * cdf(d1) : df * (cdf(d1) - 1), gamma: df * pdf(d1) / (F * sigma * root), vega: df * F * pdf(d1) * root, theta: -df * F * pdf(d1) * sigma / (2 * root) + r * price, rho: type === 'call' ? -T * price : T * price };
}
function impliedVol(price: number | null, F: number, K: number, T: number, r: number, type: OptionType): number | null {
    if (price === null || price <= 0 || F <= 0 || K <= 0 || T <= 0) return null;
    const df = Math.exp(-r * T); const intrinsic = df * (type === 'call' ? Math.max(F - K, 0) : Math.max(K - F, 0)); const upper = df * (type === 'call' ? F : K);
    if (price < intrinsic - 1e-9 || price > upper + 1e-9) return null;
    let lo = 1e-8; let hi = 8; if ((black76(F, K, hi, T, r, type)?.price ?? 0) < price) return null;
    for (let i = 0; i < 90; i++) { const mid = (lo + hi) / 2; if ((black76(F, K, mid, T, r, type)?.price ?? 0) < price) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
}
function expiryTime(expiry: string, asOf: Date): number { return (new Date(`${expiry}T06:00:00.000Z`).getTime() - asOf.getTime()) / (365 * 86400000); }

async function refresh(): Promise<Json> {
    if (!pool) throw new Error('database_unavailable');
    if (!process.env.SJ_API_KEY || !process.env.SJ_SEC_KEY) throw new Error('shioaji_credentials_missing');
    await ensureSchema(); const asOf = new Date();
    const roots = await sjGet<Record<string, unknown>[]>('/api/v1/data/contracts/options/roots?region=TW');
    // The roots endpoint also returns TX futures roots (TX1/TX2/TX4/TXU/TXZ).
    // TXO is the only option root; requesting the futures roots from the
    // options endpoint makes the whole refresh fail before any DB write.
    const txo = roots.filter(root => String(root.root ?? '').toUpperCase() === 'TXO');
    const raw = (await Promise.all(txo.map(root => sjGet<Record<string, unknown>[]>(`/api/v1/data/contracts/options?root=${encodeURIComponent(String(root.root))}&region=TW`)))).flat();
    const contracts = raw.map(normalizeContract).filter((x): x is Contract => x !== null);
    // Shioaji limits snapshot request size; batch the full TXO surface so one
    // oversized request cannot turn a valid market-data refresh into a 503.
    const snapshots: Record<string, unknown>[] = [];
    for (let i = 0; i < contracts.length; i += 100) {
        snapshots.push(...await sjPost<Record<string, unknown>[]>('/api/v1/data/snapshots', {
            contracts: contracts.slice(i, i + 100).map(c => ({ code: c.code, security_type: 'OPT', exchange: 'TAIFEX', region: 'TW' })),
        }));
    }
    const byCode = new Map(snapshots.map(s => [String(s.code ?? ''), s])); const quotes = contracts.map(c => normalizeQuote(byCode.get(c.code) ?? {}, c.code, asOf)); const quoteByCode = new Map(quotes.map(q => [q.code, q]));
    const greekRows: Array<{ c: Contract; q: Quote; F: number; T: number; iv: number | null; model: ReturnType<typeof black76> }> = [];
    for (const expiry of [...new Set(contracts.map(c => c.expiry))]) {
        const group = contracts.filter(c => c.expiry === expiry); const T = expiryTime(expiry, asOf); if (T <= 0) continue;
        const pairs = new Map<number, { call?: number; put?: number }>();
        // Stale quotes remain usable for a marked/stale calculation when bid/ask
        // are internally valid. Excluding them entirely makes every Greek blank
        // after a delayed market-data response, while treating them as LIVE
        // would be misleading.
        for (const c of group) { const q = quoteByCode.get(c.code); const mid = q && q.bid !== null && q.ask !== null && q.bid > 0 && q.ask >= q.bid ? (q.bid + q.ask) / 2 : null; if (mid !== null) { const p = pairs.get(c.strike) ?? {}; p[c.option_type] = mid; pairs.set(c.strike, p); } }
        const parity = [...pairs.entries()].filter((entry): entry is [number, { call: number; put: number }] => entry[1].call !== undefined && entry[1].put !== undefined); if (!parity.length) continue;
        const first = parity[0]; if (!first) continue;
        const [F] = parity.reduce<[number, number]>((best, [K, p]) => { const f = K + p.call - p.put; return Math.abs(f - K) < Math.abs(best[0] - best[1]) ? [f, K] : best; }, [first[0] + first[1].call - first[1].put, first[0]]);
        for (const c of group) { const q = quoteByCode.get(c.code)!; const mid = q.bid !== null && q.ask !== null && q.bid > 0 && q.ask >= q.bid ? (q.bid + q.ask) / 2 : null; const iv = impliedVol(mid, F, c.strike, T, 0, c.option_type); greekRows.push({ c, q, F, T, iv, model: iv === null ? null : black76(F, c.strike, iv, T, 0, c.option_type) }); }
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); const ids = new Map<string, number>();
        for (const c of contracts) { const result = await client.query<{ id: number }>(`INSERT INTO market.option_contracts (provider_code,root,underlying_code,expiry_date,strike_points,option_type,multiplier,currency,raw_metadata,active,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'TWD',$8::jsonb,true,$9) ON CONFLICT (provider_code) DO UPDATE SET root=EXCLUDED.root,underlying_code=EXCLUDED.underlying_code,expiry_date=EXCLUDED.expiry_date,strike_points=EXCLUDED.strike_points,option_type=EXCLUDED.option_type,multiplier=EXCLUDED.multiplier,raw_metadata=EXCLUDED.raw_metadata,active=true,last_seen_at=EXCLUDED.last_seen_at RETURNING id`, [c.code, c.root, c.underlying_code, c.expiry, c.strike, c.option_type, c.multiplier, json(c.raw), asOf]); const id = result.rows[0]?.id; if (id === undefined) throw new Error('contract_upsert_failed'); ids.set(c.code, id); }
        for (const q of quotes) { await client.query(`INSERT INTO market.option_quote_snapshots (contract_id,provider_code,observed_at,received_at,bid_points,ask_points,last_points,bid_size,ask_size,volume,open_interest,stale,quality,raw_quote) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`, [ids.get(q.code), q.code, q.observedAt, asOf, q.bid, q.ask, q.last, q.bidSize, q.askSize, q.volume, q.openInterest, q.stale, q.quality, json(q.raw)]); await client.query(`INSERT INTO market.option_quotes_current (provider_code,observed_at,received_at,bid_points,ask_points,last_points,bid_size,ask_size,volume,open_interest,stale,quality,raw_quote) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT (provider_code) DO UPDATE SET observed_at=EXCLUDED.observed_at,received_at=EXCLUDED.received_at,bid_points=EXCLUDED.bid_points,ask_points=EXCLUDED.ask_points,last_points=EXCLUDED.last_points,bid_size=EXCLUDED.bid_size,ask_size=EXCLUDED.ask_size,volume=EXCLUDED.volume,open_interest=EXCLUDED.open_interest,stale=EXCLUDED.stale,quality=EXCLUDED.quality,raw_quote=EXCLUDED.raw_quote`, [q.code, q.observedAt, asOf, q.bid, q.ask, q.last, q.bidSize, q.askSize, q.volume, q.openInterest, q.stale, q.quality, json(q.raw)]); }
        for (const row of greekRows) { const m = row.model; await client.query(`INSERT INTO market.option_greeks (provider_code,quote_snapshot_id,calculated_at,model,forward_points,strike_points,time_to_expiry_years,rate_decimal,implied_volatility_decimal,delta_per_point,gamma_per_point_squared,vega_per_vol_decimal,vega_per_vol_point,theta_per_year,theta_per_day,rho_per_rate_decimal,stale,quality,warnings) VALUES ($1,(SELECT id FROM market.option_quote_snapshots WHERE provider_code=$1 ORDER BY id DESC LIMIT 1),$2,'black-76',$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`, [row.c.code, asOf, row.F, row.c.strike, row.T, row.iv, m?.delta ?? null, m?.gamma ?? null, m?.vega ?? null, m ? m.vega / 100 : null, m?.theta ?? null, m ? m.theta / 365 : null, m?.rho ?? null, row.q.stale, m ? 'ok' : 'iv_unavailable', json(m ? [] : ['iv_unavailable'])]); }
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return { contracts: contracts.length, quotes: quotes.length, greeks: greekRows.length, status: contracts.length && greekRows.some(row => row.model) ? 'LIVE' : quotes.some(q => q.stale) ? 'STALE' : 'INSUFFICIENT_DATA', as_of: asOf.toISOString() };
}
async function chain(expiry: string | null): Promise<Json> {
    if (!pool) return { as_of: new Date().toISOString(), contracts: [], quotes: [], greeks: [], status: 'INSUFFICIENT_DATA', expiry };
    await ensureSchema(); const result = await pool.query(`SELECT c.provider_code AS code,c.expiry_date AS delivery_date,c.strike_points AS strike_price,c.option_type,q.bid_points AS bid,q.ask_points AS ask,q.last_points AS last,q.quality,q.stale,g.implied_volatility_decimal AS implied_volatility,g.delta_per_point AS delta_per_index_point,g.gamma_per_point_squared,g.vega_per_vol_point AS vega_per_1_vol_point,g.theta_per_day,g.rho_per_rate_decimal,g.quality AS greek_quality FROM market.option_contracts c LEFT JOIN market.option_quotes_current q ON q.provider_code=c.provider_code LEFT JOIN LATERAL (SELECT * FROM market.option_greeks g0 WHERE g0.provider_code=c.provider_code ORDER BY calculated_at DESC LIMIT 1) g ON true WHERE c.active AND ($1::date IS NULL OR c.expiry_date=$1::date) ORDER BY c.expiry_date,c.strike_points,c.option_type`, [expiry]);
    const contracts = result.rows.map(r => ({ code: r.code, delivery_date: String(r.delivery_date), strike_price: numberOrNull(r.strike_price), option_type: r.option_type })); const quotes = result.rows.filter(r => r.bid !== null || r.ask !== null || r.last !== null).map(r => ({ code: r.code, bid: numberOrNull(r.bid), ask: numberOrNull(r.ask), last: numberOrNull(r.last), quality: r.quality, stale: Boolean(r.stale) })); const greeks = result.rows.filter(r => r.implied_volatility !== null || r.delta_per_index_point !== null).map(r => ({ code: r.code, implied_volatility: numberOrNull(r.implied_volatility), delta_per_index_point: numberOrNull(r.delta_per_index_point), gamma_per_index_point_squared: numberOrNull(r.gamma_per_point_squared), vega_per_1_vol_point: numberOrNull(r.vega_per_1_vol_point), theta_per_day: numberOrNull(r.theta_per_day), rho_per_rate_decimal: numberOrNull(r.rho_per_rate_decimal), quality: r.greek_quality ?? 'unknown', stale: Boolean(r.stale) }));
    return { as_of: new Date().toISOString(), contracts, quotes, greeks, status: contracts.length ? 'LIVE' : 'INSUFFICIENT_DATA', expiry };
}
export function taiwanAnalysisApi(): Plugin { return { name: 'taiwan-analysis-api', configureServer(server: ViteDevServer) { server.middlewares.use(async (request, response, next) => { const route = routeFor(request); if (!route) return next(); try { if (request.method === 'GET' && route.path === '/health') return sendJson(response, 200, { status: 'ok', source: 'vite-process', database: Boolean(pool) }); if (request.method === 'GET' && route.path === '/vix/taiwan/history') { if (!pool) return sendJson(response, 200, { methodology: 'self-calculated', official: false, observations: [], status: 'INSUFFICIENT_DATA' }); await ensureSchema(); const result = await pool.query('SELECT observed_at,vix_value AS value,methodology,official,quality,stale,warnings FROM market.taiwan_vix_observations ORDER BY observed_at DESC LIMIT 500'); return sendJson(response, 200, { methodology: 'self-calculated', official: false, observations: result.rows, status: result.rows.length ? 'LIVE' : 'INSUFFICIENT_DATA' }); } if (request.method === 'GET' && route.path === '/options/txo/chain') return sendJson(response, 200, await chain(route.query.get('expiry'))); if (request.method === 'POST' && route.path === '/options/txo/refresh') return sendJson(response, 200, await refresh()); return sendJson(response, 404, { error: 'not_found' }); } catch (error) { if (isMissingSchema(error)) return sendJson(response, 503, { error: 'database_schema_unavailable', status: 'INVALID' }); const code = error instanceof Error ? error.message : ''; const status = code === 'shioaji_auth' ? 502 : 503; return sendJson(response, status, { error: code === 'shioaji_credentials_missing' ? 'server_credentials_missing' : code === 'database_unavailable' ? 'database_unavailable' : code === 'shioaji_auth' ? 'provider_auth_failed' : 'provider_unavailable', status: 'INVALID' }); } }); } }; }
export async function initializeTaiwanAnalysisSchema(): Promise<void> { await ensureSchema(); }
