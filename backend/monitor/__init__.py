"""
Monitor — 训练监控包

提供 GPU/系统监控、训练进度解析、TensorBoard Loss 读取、
预览样本扫描、历史记录等。
"""
from backend.monitor.routes import router

__all__ = ["router"]
