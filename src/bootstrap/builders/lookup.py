"""Online lookup service and its health probes."""

from __future__ import annotations

import os

from core.logging_config import logger
from schemas.config_schemas import AppConfig
from service.lookup.health_service import HealthProbe, LookupHealthService
from service.lookup.lookup_service import LookupService
from service.lookup.registry import FactProviderRegistry
from service.lookup.ttl_cache import TtlCache
from tpa.online.http_client import AllowListedHttpClient
from tpa.online.providers.forecast import ForecastProvider
from tpa.online.providers.fx import FxProvider
from tpa.online.providers.geocode import GeocodingProvider
from tpa.online.providers.tavily import TavilyProvider
from tpa.online.providers.weather import WeatherProvider


# Tool -> provider category, for per-category cache TTLs taken from the tool manifests.
_TOOL_CATEGORY = {"get_weather": "weather", "get_weather_forecast": "forecast", "convert_currency": "fx", "web_search": "search"}
_GEOCODE_TTL_SEC = 24 * 3600


def build_lookup(cfg: AppConfig, tool_manifests: dict) -> tuple[LookupService, TavilyProvider]:
    allow_list = frozenset(cfg.privacy.online.allowlist)
    http_client = AllowListedHttpClient(allow_list=allow_list)
    registry = FactProviderRegistry(allow_list=allow_list)
    key_env = cfg.privacy.online.search_api_key_env
    search = TavilyProvider(http_client, api_key_provider=lambda: os.environ.get(key_env))
    for provider in (WeatherProvider(http_client), ForecastProvider(http_client), GeocodingProvider(http_client), FxProvider(http_client), search):
        try:
            registry.register(provider)
        except ValueError as e:
            logger.warning(f"[lookup] provider '{provider.category}' not registered: {e}")
    ttl = {_TOOL_CATEGORY[n]: m.cache_ttl_sec for n, m in tool_manifests.items() if n in _TOOL_CATEGORY}
    ttl["geocode"] = _GEOCODE_TTL_SEC
    service = LookupService(registry=registry, allow_list=allow_list, cache=TtlCache(), ttl_by_category=ttl)
    return service, search


def build_lookup_health(lookup: LookupService, search: TavilyProvider, key_env: str) -> LookupHealthService:
    """Probes for `veda doctor`. One entry per online dependency."""
    from domain.entities.fact_query import FactQuery

    def _probe(category: str, params: dict, describe):
        async def _check() -> str:
            return describe(await lookup.fetch(FactQuery(category=category, params=params)))
        return _check

    return LookupHealthService([
        HealthProbe("geocoding", _probe("geocode", {"name": "Hyderabad"}, lambda a: a.text.split(";")[0])),
        HealthProbe("weather", _probe("weather", {"lat": 17.385, "lon": 78.487}, lambda a: a.text)),
        HealthProbe("currency", _probe("fx", {"from": "USD", "to": "INR"}, lambda a: a.text)),
        HealthProbe(
            "web_search", _probe("search", {"query": "today's date", "topic": "general"}, lambda a: a.text.splitlines()[0][:100]),
            configured=search.is_configured, missing_hint=f"set {key_env} in .env to enable web search",
        ),
    ])
