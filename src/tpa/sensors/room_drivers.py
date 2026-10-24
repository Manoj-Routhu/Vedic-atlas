"""Room sensor drivers. `mock` returns fixed values (a laptop has no sensor); `dht11` reads the real one on the Pi.

The DHT11 library is imported only when that driver is built, so a laptop never needs it. Install it on the Pi with
`pip install -e .[hardware-room-sensor]`."""

from __future__ import annotations

from core.logging_config import logger


class MockRoomDriver:
    def __init__(self, temperature_c: float = 28.0, humidity_pct: float = 55.0):
        self._reading = (temperature_c, humidity_pct)

    def read(self) -> tuple[float, float]:
        return self._reading


class Dht11RoomDriver:
    def __init__(self, gpio_pin: int):
        import adafruit_dht   # type: ignore[import-not-found]
        import board          # type: ignore[import-not-found]

        self._device = adafruit_dht.DHT11(getattr(board, f"D{gpio_pin}"))

    def read(self) -> tuple[float, float]:
        # The library raises RuntimeError on a checksum or timing failure, which is routine for a DHT11; the sensor
        # treats any exception as "no reading this time".
        temperature, humidity = self._device.temperature, self._device.humidity
        if temperature is None or humidity is None:
            raise RuntimeError("DHT11 returned no value")
        return float(temperature), float(humidity)

    def close(self) -> None:
        try:
            self._device.exit()
        except Exception as e:
            logger.debug(f"[room] DHT11 close: {e}")


def build_room_driver(driver: str, *, gpio_pin: int, mock_temperature_c: float, mock_humidity_pct: float):
    if driver == "dht11":
        return Dht11RoomDriver(gpio_pin)
    return MockRoomDriver(mock_temperature_c, mock_humidity_pct)
