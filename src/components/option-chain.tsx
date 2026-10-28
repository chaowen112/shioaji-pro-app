import { RefreshButton } from './refresh-button';
import { useLiveSnapshots } from '../hooks/use-live-snapshots';
// src/components/option-chain.tsx — 臺指選擇權 T 字報價表（月選＋週選）.
// Loads the TAIEX option contracts once per Taipei day: the monthly TXO root
// plus every weekly root discovered from options/roots (issue #152).
// Expiries are keyed by (root, delivery_date); shows strikes around the
// underlying index (fallback TXFR1, then the median strike) for the
// selected expiry and refreshes quotes via batched snapshots.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '../hooks/use-query';
import { useQuote } from '../hooks/use-stream';
import { ensureContract } from '../lib/contracts-cache';
import {
    buildExpiries,
    chainUnderlying,
    chooseAtmReference,
    contractsForExpiry,
    identifiedChainRoots,
    isChainContract,
    migrateLegacyMonth,
    MONTHLY_ROOT,
    msUntilNextBoundary,
    pickChainRoots,
    resolveExpiry,
    taipeiClock,
    underlyingLabel,
    unverifiedContracts,
    type ChainContract,
    type ExpiryClock,
} from '../lib/option-expiry';
import { pickOptionLeg } from '../lib/option-pick';
import { fetchOptionRoots, fetchOptions, fetchSnapshots } from '../lib/shioaji';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice, fmtSigned } from '../lib/utils/format';
import {
    fetchTaiwanOptionChain,
    refreshTaiwanOptions,
    fetchTaiwanVixHistory,
    type TaiwanOptionAnalysis,
    type TaiwanVixObservation,
} from '../lib/taiwan-analysis';
import * as dock from './bottom-dock.css';
import * as styles from './option-chain.css';
import { AsyncStatus } from './async-status';
import { OptionExpiryPicker } from './option-expiry-picker';
import * as panel from './panel.css';

type OptContract = ChainContract;

// 各商品代碼的合約每個台北交易日載一次（週選每週掛牌／到期）。快取在
// 模組層級、只存在於單一視窗：彈出視窗是獨立的 webview，各自每天載一次。
// 只快取有資料的成功結果與已知的占位代碼；其他失敗（一次性 500、逾時）
// 與空結果都不快取，下次載入會重試。
interface RootRows {
    rows: OptContract[];
    // 回應中不是有效選擇權合約（缺到期日、履約價等欄位）的筆數
    invalid: number;
}
const rootCache = new Map<string, { day: string } & RootRows>();
let rootsCache: { day: string; roots: string[]; identified: string[] } | null =
    null;
const inflight = new Map<string, Promise<ChainLoad>>();
// resetChainContractsCache 之後，先前發出的請求晚到也不能寫回快取
let generation = 0;
// 跨午夜時舊交易日晚到的回應不能蓋掉較新交易日的快取（YYYY-MM-DD 可直接比字串）
const canCache = (cached: string | undefined, day: string, gen: number) =>
    gen === generation && (cached ?? '') <= day;

/** 測試用：清掉跨掛載的合約快取。 */
export function resetChainContractsCache() {
    generation += 1;
    rootCache.clear();
    rootsCache = null;
    inflight.clear();
}

// 合約查詢逾時（比照 kbars／capability 訂閱的 10 秒）；sidecar 懸住不回時
// 把該代碼當成讀取失敗，不讓整條 T 字卡在載入中
export const CHAIN_LOAD_TIMEOUT_MS = 10_000;

// 週選清單（options/roots）讀取失敗時在狀態列顯示的名稱
export const ROOTS_LABEL = '週選清單';

export interface ChainFailure {
    root: string; // 商品代碼，或 ROOTS_LABEL
    timeout: boolean;
}

export interface ChainLoad {
    rows: OptContract[];
    // false：roots 或某些代碼讀取失敗（非占位），可以重試
    complete: boolean;
    failures: ChainFailure[];
    // 可確認為臺指選擇權的代碼；合約缺 underlying_code 時只列這些
    identified: string[];
    // 可確認身分的代碼回應中欄位不完整、無法列出的合約數
    invalid: number;
}

/** 交易所預留、尚未有合約資料的週選代碼（sidecar 回 500 no info_hash）。 */
export function isPlaceholderRootError(e: unknown): boolean {
    const status = (e as { status?: number } | null)?.status;
    return status === 500 && /info_hash/i.test(String((e as Error)?.message ?? e));
}

function isTimeout(e: unknown): boolean {
    return (e as { timeout?: boolean } | null)?.timeout === true;
}

/** 限時執行；逾時即中止請求並以 { timeout: true } 的錯誤拒絕，晚到的回應一律丟棄。 */
function withDeadline<T>(
    what: string,
    run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(
                Object.assign(
                    new Error(
                        `${what} 查詢逾時（${CHAIN_LOAD_TIMEOUT_MS / 1000} 秒）`,
                    ),
                    { timeout: true },
                ),
            );
            controller.abort();
        }, CHAIN_LOAD_TIMEOUT_MS);
        run(controller.signal).then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e: unknown) => {
                clearTimeout(timer);
                reject(e);
            },
        );
    });
}

async function loadRoot(
    root: string,
    day: string,
    gen: number,
): Promise<RootRows> {
    const hit = rootCache.get(root);
    if (hit?.day === day) return hit;
    try {
        const raw = (
            await withDeadline(root, (signal) =>
                fetchOptions(root, {}, { signal }),
            )
        ).map((c) => (c.root ? c : { ...c, root }));
        const rows = raw.filter(isChainContract);
        const result = { rows, invalid: raw.length - rows.length };
        if (rows.length && canCache(rootCache.get(root)?.day, day, gen))
            rootCache.set(root, { day, ...result });
        return result;
    } catch (e) {
        if (isPlaceholderRootError(e)) {
            if (canCache(rootCache.get(root)?.day, day, gen))
                rootCache.set(root, { day, rows: [], invalid: 0 });
            return { rows: [], invalid: 0 };
        }
        throw e;
    }
}

export function loadChainContracts(day: string): Promise<ChainLoad> {
    const pending = inflight.get(day);
    if (pending) return pending;
    const gen = generation;
    const p = (async (): Promise<ChainLoad> => {
        const failures: ChainFailure[] = [];
        // 月選不依賴 roots，先發出；roots 懸住時月選仍能在時限內載完
        const monthly = loadRoot(MONTHLY_ROOT, day, gen);
        monthly.catch(() => {}); // 下方 allSettled 會處理
        let wanted: string[];
        let identified: string[];
        if (rootsCache?.day === day)
            ({ roots: wanted, identified } = rootsCache);
        else {
            try {
                const roots = await withDeadline(ROOTS_LABEL, (signal) =>
                    fetchOptionRoots({ signal }),
                );
                // 空清單不是正常狀態（至少有月選）：當成失敗、不快取
                if (roots.length === 0) throw new Error('empty roots');
                wanted = pickChainRoots(roots);
                identified = identifiedChainRoots(roots);
                if (canCache(rootsCache?.day, day, gen))
                    rootsCache = { day, roots: wanted, identified };
            } catch (e) {
                // roots 查不到時先只載月選，下次載入再重試
                wanted = [MONTHLY_ROOT];
                identified = [MONTHLY_ROOT];
                failures.push({ root: ROOTS_LABEL, timeout: isTimeout(e) });
            }
        }
        const settled = await Promise.allSettled(
            wanted.map((root) =>
                root === MONTHLY_ROOT ? monthly : loadRoot(root, day, gen),
            ),
        );
        settled.forEach((r, i) => {
            if (r.status === 'rejected')
                failures.push({ root: wanted[i]!, timeout: isTimeout(r.reason) });
        });
        const failed = settled.filter((r) => r.status === 'rejected');
        if (failed.length === settled.length)
            throw (failed[0] as PromiseRejectedResult).reason;
        const idSet = new Set(identified);
        let rows: OptContract[] = [];
        let invalid = 0;
        settled.forEach((r, i) => {
            if (r.status !== 'fulfilled') return;
            rows = rows.concat(r.value.rows);
            if (idSet.has(wanted[i]!)) invalid += r.value.invalid;
        });
        return {
            rows,
            complete: failures.length === 0,
            failures,
            identified,
            invalid,
        };
    })();
    inflight.set(day, p);
    return p.finally(() => {
        if (inflight.get(day) === p) inflight.delete(day);
    });
}

/** 台北日期／收盤時刻；跨 13:45 或午夜時更新，讓到期列表與合約重新計算。 */
function useExpiryClock(): ExpiryClock {
    const [clock, setClock] = useState(() => taipeiClock());
    useEffect(() => {
        const timer = setTimeout(
            () => setClock(taipeiClock()),
            msUntilNextBoundary() + 1000,
        );
        return () => clearTimeout(timer);
    }, [clock]);
    return clock;
}

/** 部分失敗狀態列：哪些代碼讀取失敗／逾時，以及未列出的合約數。 */
export function chainStatusText(
    complete: boolean,
    failures: ChainFailure[],
    unlisted: number,
): string {
    const parts: string[] = [];
    if (!complete) {
        const which = failures
            .map((f) => (f.timeout ? `${f.root} 逾時` : f.root))
            .join('、');
        parts.push(
            `部分合約載入失敗${which ? `（${which}）` : ''}，按更新報價重試`,
        );
    }
    if (unlisted > 0) parts.push(`${unlisted} 筆合約資料不完整或標的不符，未列出`);
    return parts.join('；');
}

function isCall(c: OptContract): boolean {
    return c.option_right.toUpperCase().startsWith('C');
}

// 記住 `${root}:${delivery_date}`
export const EXPIRY_KEY = 'sj-pro-optchain-expiry';
// 舊版只記月份（YYYYMM）；第一次載入時遷移成該月的月選後移除
export const LEGACY_MONTH_KEY = 'sj-pro-optchain-month';

function readStored(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function saveExpiry(key: string) {
    try {
        localStorage.setItem(EXPIRY_KEY, key);
    } catch {
        // 無法寫入（隱私模式等）時只是不記住
    }
}

function dropLegacyMonth() {
    try {
        localStorage.removeItem(LEGACY_MONTH_KEY);
    } catch {
        // ignore
    }
}

export function OptionChain({
    onPick,
}: {
    onPick?: (code: string) => void;
}) {
    const [contracts, setContracts] = useState<OptContract[]>([]);
    const [identified, setIdentified] = useState<string[]>([MONTHLY_ROOT]);
    const [complete, setComplete] = useState(true);
    const [failures, setFailures] = useState<ChainFailure[]>([]);
    const [invalid, setInvalid] = useState(0);
    const [reloadSeq, setReloadSeq] = useState(0);
    const [reloading, setReloading] = useState(false);
    const [choice, setChoice] = useState<string | null>(() =>
        readStored(EXPIRY_KEY),
    );
    const [legacyMonth, setLegacyMonth] = useState<string | null>(() =>
        readStored(LEGACY_MONTH_KEY),
    );
    const [loading, setLoading] = useState(true);
    const [vix, setVix] = useState<TaiwanVixObservation | null>(null);
    const [greeks, setGreeks] = useState<Map<string, TaiwanOptionAnalysis>>(new Map());
    const [greeksLoading, setGreeksLoading] = useState(false);
    const [greeksError, setGreeksError] = useState<string | null>(null);
    // Taiwan analysis uses the same-origin dedicated Vite proxy prefix.
    const analysisConfigured = true;
    const clock = useExpiryClock();

    useEffect(() => {
        let active = true;
        void fetchTaiwanVixHistory()
            .then((history) => {
                if (active) setVix(history.observations[history.observations.length - 1] ?? null);
            })
            .catch(() => { if (active) setVix(null); });
        return () => { active = false; };
    }, []);

    // 台北日期改變（面板一直開著跨日）或手動重試時重新載入合約
    useEffect(() => {
        let stale = false;
        loadChainContracts(clock.date)
            .then((r) => {
                if (stale) return;
                setContracts(r.rows);
                setIdentified(r.identified);
                setComplete(r.complete);
                setFailures(r.failures);
                setInvalid(r.invalid);
            })
            .catch(() => {
                if (stale) return;
                // 全部失敗：保留上次成功的合約，狀態列改為一般失敗訊息
                setComplete(false);
                setFailures([]);
            })
            .finally(() => {
                if (stale) return;
                setLoading(false);
                setReloading(false);
            });
        return () => {
            stale = true;
        };
    }, [clock.date, reloadSeq]);

    const expiries = useMemo(
        () => buildExpiries(contracts, clock, { identified }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [contracts, identified, clock.date, clock.minutes],
    );

    // 可確認身分的代碼中，因欄位缺漏／標的不符而未列出的合約
    const unlisted = useMemo(
        () => invalid + unverifiedContracts(contracts, clock, { identified }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [invalid, contracts, identified, clock.date, clock.minutes],
    );

    // 舊版月份記憶：遷移成該月月選（新值優先），之後移除舊 key
    useEffect(() => {
        if (legacyMonth === null || expiries.length === 0) return;
        if (choice === null) {
            const key = migrateLegacyMonth(expiries, legacyMonth);
            if (key) {
                setChoice(key);
                saveExpiry(key);
            }
        }
        dropLegacyMonth();
        setLegacyMonth(null);
    }, [expiries, legacyMonth, choice]);

    // 記住的到期若已到期或不再列出，改選最近到期的
    const expiry = resolveExpiry(expiries, choice);
    const inExpiry = useMemo(
        () => contractsForExpiry(contracts, expiry),
        [contracts, expiry],
    );

    useEffect(() => {
        if (!analysisConfigured || !expiry) {
            setGreeks(new Map());
            setGreeksError(null);
            setGreeksLoading(false);
            return;
        }
        let active = true;
        setGreeksLoading(true);
        setGreeksError(null);
        const expiryDate = expiry.split(':').at(-1);
        void fetchTaiwanOptionChain(expiryDate)
            .then((response) => {
                if (active) setGreeks(new Map(response.greeks.map((g) => [g.code, g])));
            })
            .catch(() => { if (active) setGreeksError('Greeks 暫不可用'); })
            .finally(() => { if (active) setGreeksLoading(false); });
        return () => { active = false; };
    }, [analysisConfigured, expiry]);

    // 置中基準：合約標的指數（IX0001 加權）→ 台指期近月 → 履約價中位數
    const underlying =
        inExpiry.find((c) => c.underlying_code)?.underlying_code ??
        chainUnderlying(contracts, { identified }) ??
        'IX0001';
    const indexLive = useQuote(underlying);
    const txf = useQuote('TXFR1');
    const refQuery = useQuery<Snapshot[]>(
        useCallback(async () => {
            const cs = await Promise.all([
                ensureContract(underlying, 'IND'),
                ensureContract('TXFR1', 'FUT'),
            ]);
            return fetchSnapshots(cs);
        }, [underlying]),
        `optchain-atm-ref:${underlying}`,
    );
    const indexSnap = refQuery.data?.find((s) => s.code === underlying);
    const txfSnap = refQuery.data?.find((s) => s.code !== underlying);
    const ref = chooseAtmReference([
        {
            label: underlyingLabel(underlying),
            value: indexLive?.index
                ? Number(indexLive.index.close)
                : indexSnap?.close,
            change: indexLive?.index
                ? Number(indexLive.index.close) -
                  Number(indexLive.index.reference)
                : indexSnap?.change_price,
        },
        {
            label: 'TXF',
            value: txf?.tick ? Number(txf.tick.close) : txfSnap?.close,
            change: txf?.tick?.price_chg
                ? Number(txf.tick.price_chg)
                : txfSnap?.change_price,
        },
    ]);
    const atm = ref?.value ?? null;

    // strikes around ATM for the selected expiry
    const rows = useMemo(() => {
        const inMonth = inExpiry;
        const strikes = [
            ...new Set(inMonth.map((c) => c.strike_price)),
        ].sort((a, b) => a - b);
        if (strikes.length === 0) return [];
        // Render the complete dynamic chain. ATM is used only for highlighting,
        // never to truncate the returned expiry surface.
        return strikes.map((strike) => ({
            strike,
            call: inMonth.find(
                (c) => c.strike_price === strike && isCall(c),
            ),
            put: inMonth.find(
                (c) => c.strike_price === strike && !isCall(c),
            ),
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inExpiry]);

    const { snapshots: snaps, refresh: refreshQuotes, loading: quotesLoading, error: quotesError } = useLiveSnapshots(rows.flatMap(r => [r.call, r.put]).filter((c): c is OptContract => !!c));

    // the strike closest to ATM — exact, not a fixed point distance
    const nearestStrike = useMemo(() => {
        if (atm === null || rows.length === 0) return null;
        let best: number | null = null;
        let bestDist = Infinity;
        for (const r of rows) {
            const d = Math.abs(r.strike - atm);
            if (d < bestDist) {
                bestDist = d;
                best = r.strike;
            }
        }
        return best;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, atm === null ? 0 : Math.round(atm / 10)]);

    if (loading) {
        return <div className={dock.emptyState}>
                <AsyncStatus phase='loading' text='載入臺指選擇權合約…' />
            </div>;
    }
    const reloadContracts = () => {
        setReloading(true);
        setReloadSeq((n) => n + 1);
    };

    if (rows.length === 0) {
        // 全部讀取失敗時也要留重試入口，不能讓使用者卡在空畫面
        return (
            <div className={dock.emptyState}>
                <AsyncStatus
                    phase={complete ? 'empty' : 'error'}
                    text={complete ? '無可用合約' : '臺指選擇權合約載入失敗'}
                    action={<RefreshButton
                        label="重新載入合約"
                        loading={reloading}
                        onClick={() => {
                            // 已成功但真的沒有合約時，清掉當日快取重新查
                            if (complete) resetChainContractsCache();
                            reloadContracts();
                        }}
                    />}
                />
            </div>
        );
    }

    const Cell = ({ code }: { code?: string }) => {
        const s = code ? snaps.get(code) : undefined;
        const greek = code ? greeks.get(code) : undefined;
        const fixed = (value: unknown, digits: number): string => {
            const numeric = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(numeric) ? numeric.toFixed(digits) : '—';
        };
        const percent = (value: unknown, digits: number): string => {
            const numeric = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(digits)}%` : '—';
        };
        const loadingText = analysisConfigured && greeksLoading ? '…' : '—';
        const greekCells = (
            <>
                <td className={styles.td} title={greek?.quality ?? greeksError ?? undefined}>
                    {greek ? percent(greek.implied_volatility, 2) : loadingText}
                </td>
                <td className={styles.td}>{fixed(greek?.delta_per_index_point, 3)}</td>
                <td className={styles.td}>{fixed(greek?.gamma_per_index_point_squared, 5)}</td>
                <td className={styles.td}>{fixed(greek?.vega_per_1_vol_point, 2)}</td>
                <td className={styles.td}>{fixed(greek?.theta_per_day, 2)}</td>
                <td className={styles.td}>{fixed(greek?.rho_per_rate_decimal, 2)}</td>
            </>
        );
        if (!s) {
            return (
                <>
                    <td className={styles.td}>—</td>
                    <td className={styles.td}>—</td>
                    <td className={styles.td}>—</td>
                    {greekCells}
                </>
            );
        }
        const dir =
            s.change_price > 0 ? 'up' : s.change_price < 0 ? 'down' : 'flat';
        return (
            <>
                <td className={`${styles.td} ${panel.dirText[dir]}`}>
                    {s.close ? fmtPrice(s.close, 0) : '—'}
                </td>
                <td className={styles.td}>
                    {s.buy_price ? fmtPrice(s.buy_price, 0) : '—'}
                </td>
                <td className={styles.td}>
                    {s.sell_price ? fmtPrice(s.sell_price, 0) : '—'}
                </td>
                {greekCells}
            </>
        );
    };

    return (
        <div className={styles.wrap}>
                {quotesError && <span role="status">{quotesError}；保留上次報價</span>}
            <div className={styles.toolbar}>
                <OptionExpiryPicker
                    expiries={expiries}
                    value={expiry}
                    onChange={(key) => {
                        setChoice(key);
                        saveExpiry(key);
                    }}
                />
                <span className={styles.status} title="Taiwan VIX（自算，非 TAIFEX 官方值）">
                    Taiwan VIX（自算，非 TAIFEX 官方值）：{vix?.value == null ? '—' : vix.value.toFixed(2)} {vix?.status ?? 'INSUFFICIENT_DATA'}
                </span>
                <span
                    className={styles.atm}
                    title={
                        ref
                            ? `${ref.label} ${fmtPrice(ref.value, 0)}${
                                  ref.change !== undefined ? ` ${fmtSigned(ref.change, 0)}` : ''
                              }，履約價以 ${ref.label} 為中心`
                            : '尚無標的報價，履約價以中位數為中心'
                    }
                >
                    {ref ? (
                        <>
                            {ref.label} {fmtPrice(ref.value, 0)}{' '}
                            {ref.change !== undefined &&
                                fmtSigned(ref.change, 0)}
                        </>
                    ) : (
                        '中位數置中'
                    )}
                </span>
                <RefreshButton
                    label="更新報價"
                    loading={quotesLoading || greeksLoading}
                    onClick={() => {
                        const expiryDate = expiry?.split(':').at(-1);
                        setGreeksLoading(true);
                        setGreeksError(null);
                        void refreshTaiwanOptions()
                            .then(() => expiryDate ? fetchTaiwanOptionChain(expiryDate) : null)
                            .then((response) => {
                                if (response) setGreeks(new Map(response.greeks.map((g) => [g.code, g])));
                            })
                            .catch(() => setGreeksError('Greeks 更新失敗'))
                            .finally(() => {
                                setGreeksLoading(false);
                                void refreshQuotes();
                                void refQuery.refresh();
                                if (!complete) reloadContracts();
                            });
                    }}
                />
            </div>
            {/* 狀態訊息獨立一列並截斷，不擠壓到期選擇器與更新報價；全文見 tooltip */}
            {(!complete || unlisted > 0) && (
                <div
                    role="status"
                    className={styles.status}
                    title={chainStatusText(complete, failures, unlisted)}
                >
                    {chainStatusText(complete, failures, unlisted)}
                </div>
            )}
            <div className={panel.panelBody}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th className={styles.th} colSpan={9}>
                                CALL 買權
                            </th>
                            <th className={`${styles.th} ${styles.strikeTh}`}>
                                履約價
                            </th>
                            <th className={styles.th} colSpan={9}>
                                PUT 賣權
                            </th>
                        </tr>
                        <tr>
                            <th className={styles.th}>成交</th>
                            <th className={styles.th}>買</th>
                            <th className={styles.th}>賣</th>
                            <th className={styles.th} title="Implied volatility, annualized">IV</th>
                            <th className={styles.th} title="Delta per index point">Δ</th>
                            <th className={styles.th} title="Gamma per index point squared">Γ</th>
                            <th className={styles.th} title="Vega per 1 volatility point">Vega</th>
                            <th className={styles.th} title="Theta per day">Theta/day</th>
                            <th className={styles.th} title="Rho per rate decimal">Rho</th>
                            <th className={`${styles.th} ${styles.strikeTh}`}/>
                            <th className={styles.th}>成交</th>
                            <th className={styles.th}>買</th>
                            <th className={styles.th}>賣</th>
                            <th className={styles.th} title="Implied volatility, annualized">IV</th>
                            <th className={styles.th} title="Delta per index point">Δ</th>
                            <th className={styles.th} title="Gamma per index point squared">Γ</th>
                            <th className={styles.th} title="Vega per 1 volatility point">Vega</th>
                            <th className={styles.th} title="Theta per day">Theta/day</th>
                            <th className={styles.th} title="Rho per rate decimal">Rho</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr
                                key={r.strike}
                                className={onPick ? styles.pickableRow : ''}
                                title={
                                    onPick
                                        ? '點 CALL 側連動買權、PUT 側連動賣權'
                                        : undefined
                                }
                                onClick={(e) => {
                                    if (!onPick) return;
                                    // left half of the row → call, right → put
                                    const rect = (
                                        e.currentTarget as HTMLElement
                                    ).getBoundingClientRect();
                                    const left =
                                        e.clientX - rect.left <
                                        rect.width / 2;
                                    const code = left
                                        ? r.call?.code
                                        : r.put?.code;
                                    if (code) {
                                        onPick(code);
                                        // also offer it to a combo panel in
                                        // 連動 mode (issue #1)
                                        pickOptionLeg(code);
                                    }
                                }}
                            >
                                <Cell code={r.call?.code} />
                                <td
                                    className={`${styles.strike} ${
                                        r.strike === nearestStrike
                                            ? styles.atmStrike
                                            : ''
                                    }`}
                                >
                                    {fmtPrice(r.strike, 0)}
                                </td>
                                <Cell code={r.put?.code} />
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
