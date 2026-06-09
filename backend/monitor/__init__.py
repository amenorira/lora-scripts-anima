"""
Monitor — 训练监控包

提供 GPU/系统监控、训练进度解析、TensorBoard Loss 读取、
预览样本扫描、历史记录、SSE 实时流等。
"""
from backend.monitor.routes import router
from backend.monitor.sse import router as sse_router

# 合并两个路由
router.include_router(sse_router)

__all__ = ["router"]
