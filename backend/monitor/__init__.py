"""
Monitor — 训练监控包

提供 GPU/系统监控、训练进度解析、TensorBoard Loss 读取、
预览样本扫描与历史记录。实时推送由同源 WebSocket 提供。
"""
from backend.monitor.routes import router

__all__ = ["router"]
