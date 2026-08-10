"""Aggregate HTTP router for commands and static status reads.

Realtime job state is intentionally absent here: it is bootstrapped through
``/api/realtime/snapshot`` and incrementally delivered by ``/ws/realtime``.
The child routers have no prefixes because ``application.py`` mounts this
aggregate at ``/api``.
"""

from fastapi import APIRouter

from backend.server.routes.environment import router as environment_router
from backend.server.routes.docs import router as docs_router
from backend.server.routes.system import router as system_router
from backend.server.routes.tagger import router as tagger_router
from backend.server.routes.image_preview import router as image_preview_router


router = APIRouter()
router.include_router(system_router)
router.include_router(tagger_router)
router.include_router(image_preview_router)
router.include_router(environment_router)
router.include_router(docs_router)
