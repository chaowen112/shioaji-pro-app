"""Deterministic Black-76 and Taiwan VIX calculations.

All prices/strikes are index points, volatility is annualized decimal volatility,
T is years, rates are continuously compounded annual decimals. Greeks are per
one index point unless a multiplier-scaled field is explicitly requested.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from math import erf, exp, isfinite, log, pi, sqrt
from typing import Iterable, Literal

OptionType = Literal["call", "put"]


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + erf(x / sqrt(2.0)))


def _validate(F: float, K: float, sigma: float, T: float) -> None:
    if not all(isfinite(x) for x in (F, K, sigma, T)) or F <= 0 or K <= 0 or sigma <= 0 or T <= 0:
        raise ValueError("Black-76 requires finite F/K/sigma/T with F,K,sigma,T > 0")


def black76(F: float, K: float, sigma: float, T: float, r: float = 0.0,
            option_type: OptionType = "call", multiplier: float = 1.0) -> dict:
    """Return discounted price and Greeks, with explicit unit fields."""
    _validate(F, K, sigma, T)
    if option_type not in ("call", "put") or not isfinite(r) or multiplier <= 0:
        raise ValueError("invalid option type, rate, or multiplier")
    df = exp(-r * T)
    root_t = sqrt(T)
    d1 = (log(F / K) + 0.5 * sigma * sigma * T) / (sigma * root_t)
    d2 = d1 - sigma * root_t
    n1, n2 = _norm_cdf(d1), _norm_cdf(d2)
    if option_type == "call":
        price = df * (F * n1 - K * n2)
        delta = df * n1
        theta = (-df * (F * _norm_pdf(d1) * sigma / (2 * root_t)) + r * price)
        rho = -T * price
    else:
        price = df * (K * _norm_cdf(-d2) - F * _norm_cdf(-d1))
        delta = df * (n1 - 1.0)
        theta = (-df * (F * _norm_pdf(d1) * sigma / (2 * root_t)) + r * price)
        rho = T * price
    gamma = df * _norm_pdf(d1) / (F * sigma * root_t)
    vega = df * F * _norm_pdf(d1) * root_t
    return {
        "price_points": price,
        "delta_per_index_point": delta,
        "gamma_per_index_point_squared": gamma,
        "vega_per_1_vol_decimal": vega,
        "vega_per_1_vol_point": vega / 100.0,
        "theta_per_year": theta,
        "theta_per_day": theta / 365.0,
        "rho_per_1_rate_decimal": rho,
        "multiplier": multiplier,
        "price_currency": price * multiplier,
        "delta_currency_per_index_point": delta * multiplier,
        "gamma_currency_per_point_squared": gamma * multiplier,
        "vega_currency_per_1_vol_decimal": vega * multiplier,
        "d1": d1, "d2": d2, "discount_factor": df,
    }


def _norm_pdf(x: float) -> float:
    return exp(-0.5 * x * x) / sqrt(2.0 * pi)


def implied_volatility(price: float, F: float, K: float, T: float, r: float,
                       option_type: OptionType, *, max_sigma: float = 8.0) -> float | None:
    if not isfinite(price) or price <= 0:
        return None
    df = exp(-r * T)
    intrinsic = df * max(F - K, 0) if option_type == "call" else df * max(K - F, 0)
    upper = df * F if option_type == "call" else df * K
    if price < intrinsic - 1e-9 or price > upper + 1e-9:
        return None
    lo, hi = 1e-8, max_sigma
    if black76(F, K, hi, T, r, option_type)["price_points"] < price:
        return None
    for _ in range(90):
        mid = (lo + hi) / 2
        value = black76(F, K, mid, T, r, option_type)["price_points"]
        if value < price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


@dataclass(frozen=True)
class Quote:
    strike: float
    option_type: OptionType
    mid: float | None
    bid: float | None = None
    ask: float | None = None
    stale: bool = False
    quality: str = "ok"


def quote_mid(bid: float | None, ask: float | None) -> tuple[float | None, str]:
    if bid is None or ask is None or not isfinite(bid) or not isfinite(ask):
        return None, "missing_bid_ask"
    if bid <= 0 or ask <= 0:
        return None, "nonpositive_bid_ask"
    if ask < bid:
        return None, "crossed_market"
    return (bid + ask) / 2.0, "ok"


def _variance(expiry: str, T: float, r: float, quotes: Iterable[Quote], min_strikes: int = 3) -> dict:
    all_quotes = list(quotes)
    usable = [q for q in all_quotes if q.mid is not None and q.mid > 0 and not q.stale and q.quality == "ok"]
    strikes = sorted({q.strike for q in usable})
    bid_by = {(q.strike, q.option_type): q.bid for q in all_quotes}
    if len(strikes) < min_strikes:
        raise ValueError("insufficient valid strikes")
    by = {(q.strike, q.option_type): q.mid for q in usable}
    pairs = [k for k in strikes if (k, "call") in by and (k, "put") in by]
    if not pairs:
        raise ValueError("no valid put-call parity pair")
    forward_candidates = [(k + exp(r * T) * (by[(k, "call")] - by[(k, "put")]), k) for k in pairs]
    F, parity_strike = min(forward_candidates, key=lambda x: abs(x[0] - x[1]))
    k0_candidates = [k for k in strikes if k <= F]
    K0 = max(k0_candidates) if k0_candidates else strikes[0]
    selected: list[tuple[float, float]] = []
    excluded: list[dict] = []
    zero_bid_seen = {"put": False, "call": False}
    for k in strikes:
        if k < K0:
            typ = "put"
        elif k > K0:
            typ = "call"
        else:
            typ = "both"
        if typ in ("put", "call"):
            bid = bid_by.get((k, typ))
            if zero_bid_seen[typ]:
                excluded.append({"strike": k, "reason": "zero_bid_cutoff"})
                continue
            if bid is not None and bid <= 0:
                zero_bid_seen[typ] = True
                excluded.append({"strike": k, "reason": "zero_bid_cutoff"})
                continue
        if typ == "both":
            vals = [by.get((k, "put")), by.get((k, "call"))]
            vals = [v for v in vals if v is not None]
            q = sum(vals) / len(vals) if vals else None
        else:
            q = by.get((k, typ))
        if q is None:
            excluded.append({"strike": k, "reason": "missing_otm_quote"})
            continue
        i = strikes.index(k)
        dk = (strikes[i + 1] - k if i == 0 else strikes[i] - strikes[i - 1] if i == len(strikes) - 1 else (strikes[i + 1] - strikes[i - 1]) / 2)
        if dk <= 0:
            excluded.append({"strike": k, "reason": "invalid_strike_spacing"})
            continue
        selected.append((k, dk * q / (k * k)))
    if len(selected) < min_strikes:
        raise ValueError("insufficient selected OTM strikes")
    variance = (2.0 / T) * exp(r * T) * sum(v for _, v in selected) - ((F / K0 - 1.0) ** 2) / T
    if variance < -1e-10:
        raise ValueError("negative variance")
    return {"expiry": expiry, "forward_points": F, "parity_strike": parity_strike, "k0": K0,
            "variance": max(0.0, variance), "selected": [{"strike": k, "delta_k_q_over_k2": v} for k, v in selected],
            "excluded": excluded}


def taiwan_vix(near: dict, nxt: dict, target_days: float = 30.0, r: float = 0.0) -> dict:
    """Calculate Taiwan VIX from the nearest two valid expiries.

    The caller supplies already-selected expiries. Quotes are index points; a
    provided bid of zero is a cutoff signal and is never included.
    """
    def normalize(q): return q if isinstance(q, Quote) else Quote(**q)
    if near["T_years"] <= 0 or nxt["T_years"] <= near["T_years"]:
        raise ValueError("invalid expiry ordering")
    a = _variance(near["expiry"], near["T_years"], r, [normalize(q) for q in near["quotes"]])
    b = _variance(nxt["expiry"], nxt["T_years"], r, [normalize(q) for q in nxt["quotes"]])
    target = target_days / 365.0
    w = (nxt["T_years"] - target) / (nxt["T_years"] - near["T_years"])
    w = min(1.0, max(0.0, w))
    interpolated = w * a["variance"] + (1.0 - w) * b["variance"]
    return {"value": 100.0 * sqrt(interpolated), "variance_30d": interpolated,
            "methodology": "self-calculated", "official": False,
            "target_days": target_days, "near": a, "next": b, "interpolation_weight_near": w,
            "quality": "ok"}


def jsonable(value):
    if hasattr(value, "__dataclass_fields__"): return asdict(value)
    return value
