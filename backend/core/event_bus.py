"""
线程安全的事件总线：支持从同步线程发布事件到异步SSE连接。

使用方式：
    bus = EventBus()
    
    # SSE 连接订阅
    queue = await bus.subscribe("task_123")
    event = await queue.get()
    
    # 发布事件（可从任意线程调用）
    await bus.publish("task_123", {"type": "progress", "data": {...}})
    
    # 取消订阅
    bus.unsubscribe("task_123", queue)
"""
from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)


class EventBus:
    """线程安全的事件总线"""
    
    def __init__(self, max_queue_size: int = 100):
        self._lock = threading.Lock()
        self._subscribers: dict[str, list[asyncio.Queue[dict[str, Any]]]] = {}
        self._max_queue_size = max_queue_size
        self._loop: asyncio.AbstractEventLoop | None = None
    
    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """在 FastAPI 启动时调用，绑定主事件循环"""
        with self._lock:
            self._loop = loop
    
    async def subscribe(self, channel: str) -> asyncio.Queue[dict[str, Any]]:
        """订阅频道，返回异步队列"""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._max_queue_size)
        with self._lock:
            if channel not in self._subscribers:
                self._subscribers[channel] = []
            self._subscribers[channel].append(queue)
        logger.debug(f"订阅频道 {channel}，当前订阅者: {len(self._subscribers.get(channel, []))}")
        return queue
    
    def unsubscribe(self, channel: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        """取消订阅"""
        with self._lock:
            if channel in self._subscribers:
                try:
                    self._subscribers[channel].remove(queue)
                    if not self._subscribers[channel]:
                        del self._subscribers[channel]
                    logger.debug(f"取消订阅频道 {channel}")
                except ValueError:
                    pass
    
    async def publish(self, channel: str, event: dict[str, Any]) -> None:
        """发布事件到频道"""
        with self._lock:
            subscribers = list(self._subscribers.get(channel, []))
        
        for queue in subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:
                    logger.warning(
                        f"事件总线慢消费者: 频道 {channel} 队列已满，丢弃事件类型={event.get('type', '?')}"
                    )
    
    def publish_sync(self, channel: str, event: dict[str, Any]) -> None:
        """线程安全的同步发布（从同步线程调用）"""
        with self._lock:
            loop = self._loop
        
        if not loop:
            logger.warning("事件总线未初始化，无法发布事件")
            return
        
        try:
            asyncio.run_coroutine_threadsafe(
                self.publish(channel, event), loop
            )
        except RuntimeError as e:
            logger.error(f"发布事件失败: {e}")
    
    def get_subscriber_count(self, channel: str) -> int:
        """获取频道订阅者数量"""
        with self._lock:
            return len(self._subscribers.get(channel, []))
    
    def get_all_channels(self) -> list[str]:
        """获取所有频道"""
        with self._lock:
            return list(self._subscribers.keys())


# 全局事件总线实例
event_bus = EventBus()
