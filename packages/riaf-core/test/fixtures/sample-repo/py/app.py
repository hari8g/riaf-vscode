import json
from .utils import add_numbers, circle_area


def handle_request(payload: str) -> str:
    """Parse a JSON payload and compute a shipping estimate."""
    data = json.loads(payload)
    total = add_numbers(data["base"], data["surcharge"])
    return json.dumps({"total": total, "area": circle_area(data.get("radius", 1.0))})


class ShippingEstimator:
    def __init__(self, rate: float) -> None:
        self.rate = rate

    def estimate(self, weight_kg: float) -> float:
        return add_numbers(weight_kg * self.rate, 2.5)
