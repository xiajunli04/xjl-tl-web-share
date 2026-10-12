from fastapi import APIRouter, Depends, Request

from app.core.config import APP_VERSION
from app.core.errors import ok
from app.core.security import verify_internal_token

router = APIRouter(prefix="/internal", tags=["internal"], dependencies=[Depends(verify_internal_token)])


@router.get("/health")
async def health(request: Request) -> dict:
    db_up = await request.app.state.db.ping()
    return ok({"status": "UP", "version": APP_VERSION, "db": "UP" if db_up else "DOWN"})
