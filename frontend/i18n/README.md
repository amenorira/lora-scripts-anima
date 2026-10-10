# 界面本地化

界面目前支持 `zh-CN`、`en-US`、`ja-JP`。语言由已保存的选择、浏览器语言、英文默认值依次决定。切换后同步更新界面、页面语言和内置指南，并保存选择。

新增或调整语言时：

1. 保持三个 JSON 的键一致，保留变量占位符、参数名、算法名、数值和适用条件。
2. 新语言在 `frontend/js/i18n.js` 注册代码和原生名称；修改文案后更新 `MESSAGES_VERSION`，修改脚本后更新 `frontend/index.html` 的资源版本。
3. 内置指南在 `backend/server/routes/docs.py` 注册标题、摘要和文件。保留 `doc-anchor`，截图使用对应语言的实际界面。
4. 运行 `node --test tests/frontend/i18n.test.cjs` 和 `./venv/Scripts/python.exe -m unittest discover -s tests/application -p 'test_docs.py'`（Linux 使用 `./venv/bin/python`），再验证语言菜单、刷新、文档跳转及常规桌面／桌面窄窗口。

## 日语用语

目标是含义准确、表达自然简洁、术语一致。按钮和标签用短语，说明通常用です・ます体。简洁不能删掉限制、默认行为或重要的副作用。用户数据、标签内容、配置代码和原始日志保留原文；Danbooru 辞典目前提供中文释义，应明确标注「中国語」。

| 含义 | 统一用语 |
| --- | --- |
| 训练 | 学習 |
| 数据集 | データセット |
| 图像描述文本 | キャプション |
| 描述中的标签 | タグ |
| 正则图 | 正則化画像 |
| 分桶 | バケット |
| 优化器 | オプティマイザ |
| 调度器 | スケジューラ |
| 学习率 | 学習率 |
| 文本编码器 | テキストエンコーダ |
| 时间步 | タイムステップ |
| 梯度累积 | 勾配累積 |
| 损失 | 損失 |
| 权重衰减 | 重み減衰 |
| 阈值 | しきい値 |
| 文件夹 | フォルダ |
| GPU 显存 | VRAM |

用语参考：

- [kohya / sd-scripts 日语训练文档](https://github.com/kohya-ss/sd-scripts/blob/main/docs/train_README-ja.md)：学習、キャプション、正則化画像、学習率、サンプラー等。
- [日本社区的 Anima LoRA 学习教程](https://note.com/studiomasakaki/n/nf39775327336)：Anima 场景中的オプティマイザ、テキストエンコーダ等用语。
- [日本社区的 LoRA 学习记录](https://gist.github.com/bokujuu/47e8605d093ca4e127279efeaf594cc7)：バケット、オプティマイザ等用语。

技术含义以当前项目实现为准。社区写法用于确认自然表达，不能替代对参数行为的核对。
