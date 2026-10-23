"""ASGI entry point: `uvicorn server:app`. All wiring lives in `src/bootstrap/`."""

from bootstrap.app import app

__all__ = ["app"]
