"""Unit tests for Redis cache helpers (no live Redis required)."""

from __future__ import annotations

import json
import threading
from unittest.mock import MagicMock, patch

import redis_cache


def test_encode_decode_roundtrip_small_payload():
    value = {"nodes": [{"mrid": "a"}]}
    raw = redis_cache._encode_cache_value(value)
    assert raw == json.dumps(value, separators=(",", ":"), default=str)
    assert redis_cache._decode_cache_raw(raw) == value


def test_encode_decode_roundtrip_compressed_payload():
    value = {"nodes": [{"mrid": f"n-{i}", "x": "y" * 200} for i in range(80)]}
    with patch.object(redis_cache, "REDIS_COMPRESS_MIN_BYTES", 256):
        raw = redis_cache._encode_cache_value(value)
    assert '"__giop_enc":"gzip"' in raw or '"__giop_enc": "gzip"' in raw
    assert redis_cache._decode_cache_raw(raw) == value


def test_delete_pattern_batches_unlink():
    client = MagicMock()
    pipe = MagicMock()
    client.pipeline.return_value = pipe
    client.scan_iter.return_value = [f"giop:chunk:{i}" for i in range(1200)]
    pipe.execute.return_value = [1] * 500

    with patch.object(redis_cache, "_connect", return_value=client):
        with patch.object(redis_cache, "REDIS_DELETE_BATCH_SIZE", 500):
            deleted = redis_cache.delete_pattern("giop:chunk:*")

    assert deleted == 1500
    assert client.pipeline.call_count == 3
    assert pipe.unlink.call_count == 1200


def test_delete_patterns_sums_counts():
    with patch.object(redis_cache, "delete_pattern", side_effect=[10, 5, 0]) as mock_delete:
        total = redis_cache.delete_patterns(["a:*", "b:*", "c:*"])
    assert total == 15
    assert mock_delete.call_count == 3


def test_status_includes_pool_config_when_available():
    with patch.object(redis_cache, "is_available", return_value=True):
        with patch.object(redis_cache, "cache_stats", return_value={"keys": 42}):
            payload = redis_cache.status()
    assert payload["available"] is True
    assert payload["max_connections"] == redis_cache.REDIS_MAX_CONNECTIONS
    assert payload["keys"] == 42


def test_cached_json_singleflight_coalesces_builder():
    calls = {"n": 0}
    leader_started = threading.Event()

    def builder():
        calls["n"] += 1
        leader_started.set()
        threading.Event().wait(0.15)
        return {"ok": True}

    stored: dict[str, object] = {}

    def fake_get(key: str):
        return stored.get(key)

    def fake_set(key: str, value, ttl_sec=None):
        stored[key] = value
        return True

    with patch.object(redis_cache, "get_json", side_effect=fake_get):
        with patch.object(redis_cache, "set_json", side_effect=fake_set):
            results: list[dict[str, object]] = []
            errors: list[BaseException] = []

            def worker():
                try:
                    results.append(redis_cache.cached_json("giop:test:singleflight", builder, 60))
                except BaseException as exc:
                    errors.append(exc)

            threads = [threading.Thread(target=worker) for _ in range(3)]
            for thread in threads:
                thread.start()
            leader_started.wait(timeout=5)
            for thread in threads:
                thread.join(timeout=10)

    assert not errors
    assert calls["n"] == 1
    assert len(results) == 3
    assert all(result == {"ok": True} for result in results)
