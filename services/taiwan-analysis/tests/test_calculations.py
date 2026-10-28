import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from analysis.calculations import Quote, black76, quote_mid, taiwan_vix


class CalculationTests(unittest.TestCase):
    def test_black76_call_fixture_and_units(self):
        result = black76(100, 100, 0.2, 1, 0.05, "call", multiplier=50)
        self.assertTrue(math.isclose(result["price_points"], 7.5770821464, rel_tol=1e-9))
        self.assertTrue(math.isclose(result["price_currency"], result["price_points"] * 50))
        self.assertTrue(math.isclose(result["vega_per_1_vol_point"], result["vega_per_1_vol_decimal"] / 100))
        self.assertGreater(result["gamma_per_index_point_squared"], 0)

    def test_black76_put_call_parity_and_delta_signs(self):
        call = black76(100, 105, 0.25, 0.5, 0.01, "call")
        put = black76(100, 105, 0.25, 0.5, 0.01, "put")
        self.assertTrue(math.isclose(call["price_points"] - put["price_points"], math.exp(-0.005) * (100 - 105), rel_tol=1e-9))
        self.assertGreater(call["delta_per_index_point"], 0)
        self.assertLess(put["delta_per_index_point"], 0)

    def test_invalid_black76_inputs_and_quote_quality(self):
        with self.assertRaises(ValueError):
            black76(100, 100, 0, 1)
        self.assertEqual(quote_mid(0, 2), (None, "nonpositive_bid_ask"))
        self.assertEqual(quote_mid(3, 2), (None, "crossed_market"))

    def quotes(self, level, stale_strike=None):
        result = []
        for k in (90, 95, 100, 105, 110):
            for typ in ("call", "put"):
                # Put-call parity for F=100: C-P = F-K.
                base = level + abs(k - 100) * 0.01
                value = base + (100 - k) / 2 if typ == "call" else base - (100 - k) / 2
                result.append(Quote(k, typ, value, stale=k == stale_strike))
        return result

    def test_taiwan_vix_is_variance_interpolated_and_non_official(self):
        result = taiwan_vix(
            {"expiry": "2027-01-15", "T_years": 20 / 365, "quotes": self.quotes(5)},
            {"expiry": "2027-02-19", "T_years": 45 / 365, "quotes": self.quotes(6)},
        )
        self.assertFalse(result["official"])
        self.assertEqual(result["methodology"], "self-calculated")
        self.assertGreater(result["value"], 0)
        self.assertEqual(result["near"]["k0"], 100)

    def test_taiwan_vix_rejects_insufficient_or_stale_quotes(self):
        with self.assertRaises(ValueError):
            taiwan_vix(
                {"expiry": "2027-01-15", "T_years": 20 / 365, "quotes": [q for q in self.quotes(5) if q.strike not in (90, 95, 100, 105, 110)]},
                {"expiry": "2027-02-19", "T_years": 45 / 365, "quotes": [q for q in self.quotes(6) if q.strike not in (90, 95, 100, 105, 110)]},
            )


if __name__ == "__main__":
    unittest.main()
