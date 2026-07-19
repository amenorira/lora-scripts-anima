"""Compatibility API router composed from focused route modules.

Keep importing :data:`router` from this module stable for the application and
any external integrations.  The child routers deliberately have no prefixes:
``application.py`` continues to mount this aggregate at ``/api``.
"""

from fastapi import APIRouter

from backend.server.routes.environment import router as environment_router
from backend.server.routes.system import router as system_router
from backend.server.routes.tagger import router as tagger_router


router = APIRouter()
router.include_router(system_router)
router.include_router(tagger_router)
router.include_router(environment_router)
