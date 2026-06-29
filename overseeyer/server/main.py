"""OVERSEEYER API — standalone stack control plane."""

import asyncio
import json
import threading
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import checks
import overseer
import supertonic_ops
import supabase_ops
import trial_ops

app = FastAPI(title="OVERSEEYER", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class StackStartPayload(BaseModel):
    portal: bool = False
    backoffice: bool = False
    bootstrap: bool = False


class MigrationCreatePayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    sql_body: str | None = None


class MigrationApplyPayload(BaseModel):
    mode: Literal["up", "reset"] = "up"
    confirm: bool = False


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "platform": "OVERSEEYER",
        "version": "1.1.0",
        "features": [
            "observability",
            "logs",
            "sse",
            "memgraph-bootstrap",
            "supertonic-start",
            "trial-ops",
            "map-tile-verify",
            "async-migrations",
        ],
    }


@app.get("/")
async def root():
    from fastapi.responses import RedirectResponse

    web_port = __import__("os").getenv("OVERSEYER_WEB_PORT", "5191")
    return RedirectResponse(url=f"http://127.0.0.1:{web_port}/", status_code=302)


@app.get("/api/status")
async def status():
    return overseer.stack_status()


@app.get("/api/observability")
async def observability():
    return await asyncio.to_thread(checks.observability_snapshot)


@app.get("/api/observability/stream")
async def observability_stream():
    async def event_generator():
        while True:
            payload = await asyncio.to_thread(checks.observability_snapshot)
            yield f"data: {json.dumps(payload)}\n\n"
            await asyncio.sleep(5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/logs")
async def list_logs():
    return {"logs": checks.list_log_files()}


@app.get("/api/logs/{name}")
async def get_log_tail(name: str, tail: int = Query(default=200, ge=1, le=2000)):
    try:
        return checks.tail_log_file(name, tail=tail)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/services/{service_id}/start")
async def start_service(service_id: str):
    try:
        return overseer.start_service(service_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/services/{service_id}/stop")
async def stop_service(service_id: str):
    try:
        return overseer.stop_service(service_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/services/{service_id}/restart")
async def restart_service(service_id: str):
    try:
        return overseer.restart_service(service_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/stack/start")
async def start_stack(payload: StackStartPayload):
    try:
        return overseer.start_stack(
            portal=payload.portal,
            backoffice=payload.backoffice,
            bootstrap=payload.bootstrap,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/migrations")
async def list_migrations():
    return overseer.list_migrations()


@app.get("/api/verify/map-tiles")
async def verify_map_tiles():
    return checks.check_map_tile_views(fast=False)


@app.post("/api/migrations")
async def create_migration(payload: MigrationCreatePayload):
    try:
        return overseer.create_migration(payload.name, payload.sql_body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/migrations/apply")
async def apply_migrations(payload: MigrationApplyPayload):
    if payload.mode == "reset" and not payload.confirm:
        raise HTTPException(
            status_code=400,
            detail="db reset is destructive — set confirm=true",
        )
    try:
        return overseer.start_apply_migrations(payload.mode)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/migrations/apply/status")
async def migration_apply_status():
    return overseer.migration_apply_status()


@app.get("/api/memgraph/bootstrap/status")
async def memgraph_bootstrap_status():
    return overseer.bootstrap_memgraph_status()


@app.get("/api/supabase/diagnose")
async def supabase_diagnose():
    return supabase_ops.diagnose()


@app.get("/api/supertonic/status")
async def supertonic_status():
    return supertonic_ops.supertonic_status()


@app.get("/api/supertonic/start/stream")
async def supertonic_start_stream():
    if supertonic_ops.supertonic_status().get("start_job_running"):
        raise HTTPException(status_code=409, detail="Supertonic start already running")

    async def event_generator():
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def worker() -> None:
            try:
                for event in supertonic_ops.iter_start_supertonic():
                    asyncio.run_coroutine_threadsafe(queue.put(event), loop).result()
            except Exception as exc:
                asyncio.run_coroutine_threadsafe(
                    queue.put({"type": "error", "text": str(exc)}),
                    loop,
                ).result()
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(None), loop).result()

        threading.Thread(target=worker, daemon=True).start()

        while True:
            event = await queue.get()
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/trial/status")
async def trial_status():
    return trial_ops.trial_status()


@app.get("/api/trial/backups")
async def trial_backups():
    return trial_ops.list_backups()


@app.get("/api/trial/run/stream")
async def trial_run_stream(
    action: str,
    confirm: bool = False,
    empty_master: bool = False,
    fresh_staging: bool = False,
    dump_file: str | None = None,
    count: int = Query(default=20, ge=1, le=500),
    run_validation: bool = False,
):
    if trial_ops.trial_status()["running"]:
        raise HTTPException(status_code=409, detail="Trial job already running")

    async def event_generator():
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def worker() -> None:
            try:
                for event in trial_ops.iter_trial_job(
                    action,
                    confirm=confirm,
                    empty_master=empty_master,
                    fresh_staging=fresh_staging,
                    dump_file=dump_file,
                    count=count,
                    run_validation=run_validation,
                ):
                    asyncio.run_coroutine_threadsafe(queue.put(event), loop).result()
            except Exception as exc:
                asyncio.run_coroutine_threadsafe(
                    queue.put({"type": "error", "text": str(exc)}),
                    loop,
                ).result()
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(None), loop).result()

        threading.Thread(target=worker, daemon=True).start()

        while True:
            event = await queue.get()
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/memgraph/bootstrap/stream")
async def memgraph_bootstrap_stream():
    if overseer.bootstrap_memgraph_status()["running"]:
        raise HTTPException(status_code=409, detail="Memgraph bootstrap already running")

    async def event_generator():
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def worker() -> None:
            try:
                for event in overseer.iter_bootstrap_memgraph():
                    asyncio.run_coroutine_threadsafe(queue.put(event), loop).result()
            except Exception as exc:
                asyncio.run_coroutine_threadsafe(
                    queue.put({"type": "error", "text": str(exc)}),
                    loop,
                ).result()
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(None), loop).result()

        threading.Thread(target=worker, daemon=True).start()

        while True:
            event = await queue.get()
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    port = int(__import__("os").getenv("OVERSEYER_API_PORT", "5190"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
