async function analysisGet<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`analysis request failed: ${response.status}`);
    return response.json() as Promise<T>;
}

async function analysisPost<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`analysis request failed: ${response.status}`);
    return response.json() as Promise<T>;
}

export type TaiwanAnalysisStatus = 'LIVE' | 'STALE' | 'INVALID' | 'INSUFFICIENT_DATA';

export interface TaiwanVixObservation {
    observed_at: string;
    value: number | null;
    methodology: 'self-calculated';
    official: false;
    quality: string;
    status?: TaiwanAnalysisStatus;
    stale: boolean;
    reason?: string;
}

export interface TaiwanVixHistory {
    methodology: 'self-calculated';
    official: false;
    observations: TaiwanVixObservation[];
}

// Browser requests stay on this same-origin API prefix. The existing Vite
// process handles this route; credentials never enter the browser.
const ANALYSIS_BASE = '/api/taiwan-analysis';

function base(): string {
    return ANALYSIS_BASE;
}

export function fetchTaiwanVixHistory(): Promise<TaiwanVixHistory> {
    return analysisGet<TaiwanVixHistory>(`${base()}/vix/taiwan/history`);
}

export interface TaiwanOptionAnalysis {
    code: string;
    implied_volatility?: number | null;
    delta_per_index_point?: number | null;
    gamma_per_index_point_squared?: number | null;
    vega_per_1_vol_point?: number | null;
    theta_per_day?: number | null;
    rho_per_rate_decimal?: number | null;
    quality: string;
    stale: boolean;
}

export interface TaiwanOptionChainResponse {
    as_of: string;
    contracts: Array<{ code: string; delivery_date: string; strike_price: number; option_type: string }>;
    quotes: Array<{ code: string; mid?: number | null; quality: string; stale: boolean }>;
    greeks: TaiwanOptionAnalysis[];
}

export function fetchTaiwanOptionChain(expiry?: string): Promise<TaiwanOptionChainResponse> {
    const query = expiry ? `?expiry=${encodeURIComponent(expiry)}` : '';
    return analysisGet<TaiwanOptionChainResponse>(`${base()}/options/txo/chain${query}`);
}

export function refreshTaiwanOptions(): Promise<{ contracts: number; quotes: number; greeks: number; as_of: string }> {
    return analysisPost(`${base()}/options/txo/refresh`, {});
}
