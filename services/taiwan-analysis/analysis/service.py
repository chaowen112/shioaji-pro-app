from __future__ import annotations

import json
import os
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

try:
    from .calculations import Quote, black76, implied_volatility, quote_mid, taiwan_vix
except ImportError:  # direct `python analysis/service.py` execution
    from calculations import Quote, black76, implied_volatility, quote_mid, taiwan_vix

STALE_SECONDS = int(os.getenv("TAIWAN_ANALYSIS_STALE_SECONDS", "15"))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None


class ShioajiClient:
    """Read-only adapter to the existing Shioaji HTTP server."""

    def __init__(self) -> None:
        self.base = os.getenv("SHIOAJI_BASE_URL", "http://127.0.0.1:21323").rstrip("/")
        self.auth = os.getenv("SHIOAJI_AUTH")

    def get(self, path: str) -> Any:
        request = urllib.request.Request(self.base + path, headers={"Accept": "application/json"})
        if self.auth:
            request.add_header("Authorization", "Bearer " + self.auth)
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def options(self, root: str) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"root": root, "region": "TW"})
        return self.get("/api/v1/data/contracts/options?" + query)

    def roots(self) -> list[dict[str, Any]]:
        return self.get("/api/v1/data/contracts/options/roots?region=TW")

    def snapshots(self, contracts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        body = json.dumps({"contracts": contracts}).encode()
        request = urllib.request.Request(self.base + "/api/v1/data/snapshots", data=body,
                                         headers={"Content-Type": "application/json"}, method="POST")
        if self.auth:
            request.add_header("Authorization", "Bearer " + self.auth)
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)


class Store:
    def __init__(self) -> None:
        self.dsn = os.getenv("DATABASE_URL")
        self.lock = threading.Lock()
        self.memory_quotes: dict[str, dict[str, Any]] = {}
        self.memory_contracts: dict[str, dict[str, Any]] = {}
        self.memory_vix: list[dict[str, Any]] = []
        self.memory_greeks: dict[str, dict[str, Any]] = {}

    def connection(self):
        if not self.dsn:
            return None
        import psycopg
        # Do not silently downgrade a configured production database to memory.
        return psycopg.connect(self.dsn)

    def chain(self, expiry: str | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        conn = self.connection()
        if conn:
            try:
                with conn.cursor() as cur:
                    query = """SELECT c.provider_code, c.root, c.underlying_code, c.expiry_date,
                                      c.strike_points, c.option_type,
                                      q.bid_points, q.ask_points, q.last_points, q.observed_at,
                                      q.quality AS quote_quality, q.stale,
                                      g.implied_volatility_decimal, g.delta_per_point,
                                      g.gamma_per_point_squared, g.vega_per_vol_point,
                                      g.theta_per_day, g.quality AS greek_quality, g.calculated_at
                               FROM market.option_contracts c
                               LEFT JOIN market.option_quotes_current q ON q.provider_code = c.provider_code
                               LEFT JOIN LATERAL (SELECT * FROM market.option_greeks g0
                                  WHERE g0.provider_code = c.provider_code ORDER BY calculated_at DESC LIMIT 1) g ON TRUE
                               WHERE c.active AND (%s IS NULL OR c.expiry_date = %s)
                               ORDER BY c.expiry_date, c.strike_points, c.option_type"""
                    cur.execute(query, (expiry, expiry))
                    contracts, quotes, greeks = [], [], []
                    for row in cur.fetchall():
                        (code, root, underlying, expiry_date, strike, option_type, bid, ask, last,
                         observed_at, quote_quality, stale, iv, delta, gamma, vega, theta, greek_quality, calculated_at) = row
                        contracts.append({"code": code, "root": root, "underlying_code": underlying,
                                          "delivery_date": str(expiry_date), "strike_price": float(strike),
                                          "option_type": option_type})
                        if bid is not None or ask is not None or last is not None:
                            quotes.append({"code": code, "bid": bid, "ask": ask, "last": last,
                                           "observed_at": observed_at, "quality": quote_quality, "stale": stale})
                        if iv is not None or delta is not None:
                            greeks.append({"code": code, "implied_volatility": iv,
                                           "delta_per_index_point": delta, "gamma_per_index_point_squared": gamma,
                                           "vega_per_1_vol_point": vega, "theta_per_day": theta,
                                           "quality": greek_quality, "calculated_at": calculated_at,
                                           "stale": stale})
                    return contracts, quotes, greeks
            finally:
                conn.close()
        rows = [c for c in self.memory_contracts.values() if expiry is None or c["delivery_date"] == expiry]
        return rows, [self.memory_quotes[c["code"]] for c in rows if c["code"] in self.memory_quotes], [self.memory_greeks[c["code"]] for c in rows if c["code"] in self.memory_greeks]

    def persist(self, contracts: list[dict[str, Any]], quotes: list[dict[str, Any]], vix: dict[str, Any] | None,
                greeks: list[dict[str, Any]] | None = None) -> None:
        with self.lock:
            for contract in contracts:
                self.memory_contracts[contract["code"]] = contract
            for quote in quotes:
                self.memory_quotes[quote["code"]] = quote
            if vix:
                self.memory_vix.append(vix)
                self.memory_vix = self.memory_vix[-5000:]
            conn = self.connection()
            if not conn:
                return
            try:
                with conn.cursor() as cur:
                    for c in contracts:
                        cur.execute("""INSERT INTO market.option_contracts
                            (provider_code, root, underlying_code, expiry_date, strike_points, option_type,
                             multiplier, currency, raw_metadata, first_seen_at, last_seen_at)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,now(),now())
                            ON CONFLICT (provider_code) DO UPDATE SET raw_metadata=EXCLUDED.raw_metadata,
                            last_seen_at=now(), active=true""",
                            (c["code"], c.get("root"), c.get("underlying_code"), c.get("delivery_date"),
                             c.get("strike_price"), c.get("option_type"), c.get("multiplier"), c.get("currency", "TWD"), json.dumps(c)))
                    for q in quotes:
                        cur.execute("""INSERT INTO market.option_quote_snapshots
                            (provider_code, observed_at, received_at, bid_points, ask_points, last_points,
                             bid_size, ask_size, volume, open_interest, stale, quality, raw_quote)
                            VALUES (%s,%s,now(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                            (q["code"], q.get("quote_timestamp"), q.get("bid"), q.get("ask"), q.get("last"),
                             q.get("bid_size"), q.get("ask_size"), q.get("volume"), q.get("open_interest"),
                             q["stale"], q["quality"], json.dumps(q)))
                        cur.execute("""INSERT INTO market.option_quotes_current
                            (provider_code, observed_at, received_at, bid_points, ask_points, last_points,
                             bid_size, ask_size, volume, open_interest, stale, quality, raw_quote)
                            VALUES (%s,%s,now(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                            ON CONFLICT (provider_code) DO UPDATE SET observed_at=EXCLUDED.observed_at,
                            received_at=now(), bid_points=EXCLUDED.bid_points, ask_points=EXCLUDED.ask_points,
                            last_points=EXCLUDED.last_points, bid_size=EXCLUDED.bid_size, ask_size=EXCLUDED.ask_size,
                            volume=EXCLUDED.volume, open_interest=EXCLUDED.open_interest, stale=EXCLUDED.stale,
                            quality=EXCLUDED.quality, raw_quote=EXCLUDED.raw_quote""",
                            (q["code"], q.get("quote_timestamp"), q.get("bid"), q.get("ask"), q.get("last"),
                             q.get("bid_size"), q.get("ask_size"), q.get("volume"), q.get("open_interest"),
                             q["stale"], q["quality"], json.dumps(q)))
                for g in greeks or []:
                    cur.execute("""INSERT INTO market.option_greeks
                        (provider_code, forward_points, strike_points, time_to_expiry_years,
                         implied_volatility_decimal, delta_per_point, gamma_per_point_squared,
                         vega_per_vol_decimal, vega_per_vol_point, theta_per_year, theta_per_day,
                         rho_per_rate_decimal, stale, quality, warnings)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                        (g["code"], g.get("forward_points"), g.get("strike_points"),
                         g.get("time_to_expiry_years"), g.get("implied_volatility"),
                         g.get("delta_per_index_point"), g.get("gamma_per_index_point_squared"),
                         g.get("vega_per_1_vol_decimal"), g.get("vega_per_1_vol_point"),
                         g.get("theta_per_year"), g.get("theta_per_day"),
                         g.get("rho_per_1_rate_decimal"), g.get("stale", False),
                         g.get("quality", "unknown"), json.dumps(g.get("warnings", []))))

                if vix:
                    cur.execute("""INSERT INTO market.taiwan_vix_observations
                            (observed_at, near_expiry, next_expiry, near_variance, next_variance,
                             interpolated_variance, vix_value, methodology, official, quality, stale, warnings)
                            VALUES (now(),%s,%s,%s,%s,%s,%s,%s,false,%s,false,%s)
                            RETURNING id""",
                            (vix["near"]["expiry"], vix["next"]["expiry"], vix["near"]["variance"],
                             vix["next"]["variance"], vix["variance_30d"], vix["value"], vix["methodology"],
                             vix["quality"], json.dumps(vix.get("warnings", []))))
                    observation_id = cur.fetchone()[0]
                    for input_data in (vix["near"], vix["next"]):
                        cur.execute("""INSERT INTO market.taiwan_vix_inputs
                            (observation_id, expiry_date, maturity_years, rate_decimal, forward_points, k0_points,
                             selected_strikes, exclusions)
                            VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb)""",
                            (observation_id, input_data["expiry"], input_data.get("T_years", 0), 0,
                             input_data["forward_points"], input_data["k0"], json.dumps(input_data["selected"]),
                             json.dumps(input_data.get("excluded", []))))
                conn.commit()
            finally:
                conn.close()

    def history(self) -> list[dict[str, Any]]:
        conn = self.connection()
        if conn:
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT observed_at, vix_value, methodology, official, quality, stale, warnings FROM market.taiwan_vix_observations ORDER BY observed_at DESC LIMIT 500")
                    return [dict(zip(("observed_at", "value", "methodology", "official", "quality", "stale", "warnings"), row)) | {"status": "LIVE" if row[4] == "ok" and not row[5] else row[4].upper()} for row in cur.fetchall()]
            finally:
                conn.close()
        return list(reversed(self.memory_vix))


def normalize_contract(c: dict[str, Any]) -> dict[str, Any] | None:
    if c.get("security_type") != "OPT" or not c.get("code") or not c.get("delivery_date") or _number(c.get("strike_price")) is None:
        return None
    right = str(c.get("option_right", c.get("call_put", ""))).upper()
    if not right.startswith(("C", "P")):
        return None
    return {"code": c["code"], "root": c.get("root"), "underlying_code": c.get("underlying_code"),
            "delivery_date": c["delivery_date"], "strike_price": _number(c["strike_price"]),
            "option_type": "call" if right.startswith("C") else "put",
            "multiplier": _number(c.get("multiplier") or c.get("contract_size")) or 1.0,
            "currency": c.get("currency", "TWD"), "metadata": c}


def normalize_quote(s: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    bid, ask = _number(s.get("buy_price")), _number(s.get("sell_price"))
    last = _number(s.get("close"))
    mid, quality = quote_mid(bid, ask)
    timestamp = s.get("datetime")
    stale = True
    if timestamp:
        try:
            observed = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
            if observed.tzinfo is None:
                observed = observed.replace(tzinfo=timezone.utc)
            stale = (utc_now() - observed.astimezone(timezone.utc)).total_seconds() > STALE_SECONDS
        except ValueError:
            quality = "invalid_timestamp"
    if stale and quality == "ok": quality = "stale"
    return {"code": contract["code"], "bid": bid, "ask": ask, "last": last, "mid": mid,
            "quote_timestamp": timestamp, "stale": stale, "quality": quality,
            "volume": _number(s.get("volume")), "open_interest": _number(s.get("open_interest")),
            "bid_size": _number(s.get("buy_volume")), "ask_size": _number(s.get("sell_volume"))}


def calculate_greeks(contract: dict[str, Any], quote: dict[str, Any], F: float, T: float, r: float = 0.0) -> dict[str, Any]:
    price = quote.get("mid") if quote.get("quality") == "ok" and not quote.get("stale") else None
    iv = implied_volatility(price, F, contract["strike_price"], T, r, contract["option_type"]) if price else None
    result: dict[str, Any] = {"code": contract["code"], "forward_points": F, "strike_points": contract["strike_price"], "time_to_expiry_years": T, "rate_decimal": r, "quality": "iv_unavailable", "stale": quote["stale"], "implied_volatility": iv}

    if quote.get("quality") != "ok":
        result["warnings"] = [quote.get("quality", "invalid_quote")]
    elif quote.get("stale"):
        result["warnings"] = ["stale_quote"]
    else:
        result["warnings"] = []

    if price is None:
        return result
    if iv is not None:
        result.update(black76(F, contract["strike_price"], iv, T, r, contract["option_type"], contract["multiplier"]))
        result["quality"] = "stale" if quote["stale"] else "ok"
    return result


def make_handler(client: ShioajiClient, store: Store):
    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status: int, payload: Any) -> None:
            data = json.dumps(payload, default=str).encode()
            self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            route = parsed.path.removeprefix("/api/taiwan-analysis") or "/"
            if route == "/health": return self.send_json(200, {"status": "ok", "database": bool(store.dsn)})
            if route == "/api/vix/taiwan/history" or route == "/vix/taiwan/history": return self.send_json(200, {"methodology": "self-calculated", "official": False, "observations": store.history()})
            if route == "/api/options/txo/chain" or route == "/options/txo/chain":
                parsed_query = parsed.query

                expiry = urllib.parse.parse_qs(parsed.query).get("expiry", [None])[0]
                if expiry is not None:
                    try:
                        datetime.fromisoformat(expiry)
                    except ValueError:
                        return self.send_json(400, {"error": "invalid_expiry"})
                contracts, quotes, greeks = store.chain(expiry)
                return self.send_json(200, {"as_of": utc_now().isoformat(), "contracts": contracts, "quotes": quotes, "greeks": greeks})
            self.send_json(404, {"error": "not_found"})

        def do_POST(self) -> None:
            route = urllib.parse.urlparse(self.path).path
            if route in ("/api/taiwan-analysis/options/txo/refresh", "/api/options/txo/refresh", "/options/txo/refresh"):
                pass
            else:
                return self.send_json(404, {"error": "not_found"})
            try:
                roots = client.roots(); raw = []
                for root in roots:
                    if str(root.get("root", "")).startswith("TX"):
                        raw.extend(client.options(root["root"]))
                contracts = [x for c in raw if (x := normalize_contract(c))]
                snapshots = client.snapshots([{"code": c["code"], "security_type": "OPT", "exchange": "TAIFEX", "region": "TW"} for c in contracts])
                by_code = {x.get("code"): x for x in snapshots}
                quotes = [normalize_quote(by_code[c["code"]], c) for c in contracts if c["code"] in by_code]
                quote_by_code = {q["code"]: q for q in quotes}
                now = utc_now()
                by_expiry: dict[str, list[dict[str, Any]]] = {}
                for contract in contracts:
                    by_expiry.setdefault(contract["delivery_date"], []).append(contract)
                greeks: list[dict[str, Any]] = []
                vix_expiries: list[dict[str, Any]] = []
                for expiry, expiry_contracts in sorted(by_expiry.items()):
                    try:
                        expiry_dt = datetime.fromisoformat(expiry).replace(tzinfo=timezone.utc)
                        T = (expiry_dt - now).total_seconds() / (365.0 * 86400.0)
                        if T <= 0:
                            continue
                        pairs = {}
                        for contract in expiry_contracts:
                            q = quote_by_code.get(contract["code"])
                            if q and q["quality"] == "ok" and not q["stale"] and q["mid"]:
                                pairs.setdefault(contract["strike_price"], {})[contract["option_type"]] = q["mid"]
                        parity = [(k, vals) for k, vals in pairs.items() if "call" in vals and "put" in vals]
                        if not parity:
                            continue
                        F, _ = min(((k + vals["call"] - vals["put"], k) for k, vals in parity), key=lambda item: abs(item[0] - item[1]))
                        vix_quotes = []
                        for contract in expiry_contracts:
                            q = quote_by_code.get(contract["code"])
                            if q:
                                vix_quotes.append(Quote(contract["strike_price"], contract["option_type"], q["mid"], q["bid"], q["ask"], q["stale"], q["quality"]))
                                greeks.append(calculate_greeks(contract, q, F, T))
                        vix_expiries.append({"expiry": expiry, "T_years": T, "quotes": vix_quotes})
                    except (ValueError, TypeError):
                        continue
                vix = None
                if len(vix_expiries) >= 2:
                    try:
                        vix = taiwan_vix(vix_expiries[0], vix_expiries[1])
                        vix["observed_at"] = now.isoformat()
                    except ValueError:
                        vix = None
                status = "LIVE" if vix is not None else (
                    "INVALID" if raw and not contracts else
                    "STALE" if quotes and all(q["stale"] for q in quotes) else
                    "INSUFFICIENT_DATA"
                )
                if vix is not None:
                    vix["status"] = status
                store.persist(contracts, quotes, vix, greeks)
                for greek in greeks:
                    store.memory_greeks[greek["code"]] = greek
                return self.send_json(200, {"contracts": len(contracts), "quotes": len(quotes), "greeks": len(greeks), "vix": vix, "status": status, "as_of": now.isoformat()})
            except Exception:
                # Provider/database details stay server-side; never reflect DSNs,
                # auth headers, or driver diagnostics to the browser.
                return self.send_json(503, {"error": "provider_unavailable", "status": "INVALID"})

        def log_message(self, *_args: Any) -> None: return
    return Handler


def main() -> None:
    port = int(os.getenv("PORT", "21400"))
    server = ThreadingHTTPServer((os.getenv("HOST", "127.0.0.1"), port), make_handler(ShioajiClient(), Store()))
    print(f"taiwan-analysis listening on {server.server_address[0]}:{port}")
    server.serve_forever()


if __name__ == "__main__": main()
