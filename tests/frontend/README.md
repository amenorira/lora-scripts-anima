# 前端监控回归验证

运行自动测试：

```bash
node --test tests/frontend/monitor-*.test.cjs
venv/Scripts/python.exe -m pytest tests/monitor -q
```

桌面交互验证使用 `monitor-fixture.html`：它复用正式页面模板、样式和监控模块，
仅在浏览器内提供模拟 API 数据，不启动训练或修改运行记录。

```bash
venv/Scripts/python.exe -m http.server 8899 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8899/tests/frontend/monitor-fixture.html`，在 1440×900
和 1024×768 桌面视口验证四个子页、搜索与多选、图片加载取消/恢复、灯箱对照及
键盘焦点。顶部按钮可模拟终态或缩小内容区。Linux 下使用 `venv/bin/python`。
