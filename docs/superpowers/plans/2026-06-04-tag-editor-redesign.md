# 标签编辑器三栏布局重设计 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将标签编辑器从两栏堆叠布局重构为三栏布局，右栏持久编辑、顶部单行工具栏、底部状态栏，同时修复后端安全漏洞

**Architecture:** Alpine.js SPA mixin 模式。左侧标签云筛选（可折叠），中间图片网格，右侧持久编辑面板（单图/批量自适应）。后端 API 保持不变，仅修复 `/save` 路径穿越和 `scan_images` 性能

**Tech Stack:** Alpine.js 3.x · FastAPI · CSS 自定义属性 · i18n (zh-CN.json / en-US.json)

---

## Task 1: 修复后端 /tageditor/save 路径穿越 (B1)

**Files:**
- Modify: `backend/tageditor/routes.py:166-177`

- [ ] **Step 1: 添加路径校验**

将 `save_image_tags` 函数中的路径校验改为与 `/save-all` 一致的父目录检查：

```python
@router.post("/tageditor/save")
async def save_image_tags(data: dict):
    """保存单张图片的标签"""
    img_path = data.get("path", "")
    tags = data.get("tags", "")
    if not img_path or not os.path.isfile(img_path):
        return {"status": "error", "message": "图片路径无效"}
    p = Path(img_path).resolve()
    cap = find_caption(p) or p.with_suffix(".txt")
    cap = cap.resolve()
    # 安全检查：确保标签文件与图片在同一目录下
    if cap.parent != p.parent:
        return {"status": "error", "message": "路径无效"}
    if not write_tags(cap, tags):
        return {"status": "error", "message": "写入标签文件失败"}
    _invalidate_cache(p.parent)
    return {"status": "success", "message": "已保存"}
```

- [ ] **Step 2: 语法验证**

```bash
python -m py_compile backend/tageditor/routes.py
```

- [ ] **Step 3: 提交**

```bash
git add backend/tageditor/routes.py
git commit -m "fix: 修复 /tageditor/save 路径穿越漏洞"
```

---

## Task 2: 修复后端 scan_images 性能 (P1)

**Files:**
- Modify: `backend/tageditor/core.py:68-92`
- Modify: `backend/tageditor/core.py:105-118`

- [ ] **Step 1: 优化 scan_images 单次扫描**

```python
def scan_images(dir_path: Path, recursive: bool = True) -> list[dict]:
    """扫描目录下所有图片及对应标签"""
    images = []
    glob_method = dir_path.rglob if recursive else dir_path.glob
    img_exts = set(IMAGE_EXTENSIONS)
    for p in glob_method("*"):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.suffix.lower() not in img_exts:
            continue
        cap = find_caption(p)
        tags = read_tags(cap) if cap else ""
        try:
            rel = str(p.relative_to(dir_path)).replace("\\", "/")
        except ValueError:
            rel = p.name
        images.append({
            "name": p.name,
            "path": str(p),
            "rel_path": rel,
            "tags": tags,
            "has_caption": cap is not None,
            "thumbnail": thumbnail_url(p),
        })
    images.sort(key=lambda x: x["name"])
    return images
```

- [ ] **Step 2: 优化 count_tags 单次扫描**

```python
def count_tags(dir_path: Path, recursive: bool = True) -> tuple[list[dict], int]:
    """统计所有标签出现频率"""
    counter: Counter = Counter()
    total_images = 0
    glob_method = dir_path.rglob if recursive else dir_path.glob
    img_exts = set(IMAGE_EXTENSIONS)
    for p in glob_method("*"):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.suffix.lower() not in img_exts:
            continue
        total_images += 1
        cap = find_caption(p)
        if cap:
            tags = tag_list(read_tags(cap))
            counter.update(tags)
    sorted_freq = [{"tag": tag, "count": count} for tag, count in
                   sorted(counter.items(), key=lambda x: x[1], reverse=True)]
    return sorted_freq, total_images
```

- [ ] **Step 3: 语法验证 + 提交**

```bash
python -m py_compile backend/tageditor/core.py
git add backend/tageditor/core.py
git commit -m "perf: 优化 scan_images/count_tags 单次 rglob 扫描"
```

---

## Task 3: 重写标签编辑器 CSS（三栏布局 + 新组件样式）

**Files:**
- Modify: `frontend/css/app.css:1687-2076`（替换整个 Tag Editor 样式区）

- [ ] **Step 1: 删除旧样式块，写入新三栏 CSS**

将 `frontend/css/app.css` 中从 `/* ── Tag Editor ────────────────────────────────────────── */`（第 1687 行）到 `.w-full { width: 100%; }`（第 2076 行）之间的所有内容替换为以下新样式。旧版 `.tag-editor`、`.tag-editor-grid`、`.tag-editor-item` 等样式全部移除，保留三栏布局需要的新样式。

在 1687 行替换为：

```css
/* ── Tag Editor v3: 3-Column Layout ──────────────────────── */

/* ===== Layout ===== */
.te-v3 { display: flex; flex-direction: column; height: calc(100vh - 56px - 1px); overflow: hidden; }
.te-v3-top { flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 6px 0; flex-wrap: wrap; min-height: 36px; }
.te-v3-main { flex: 1; display: flex; gap: 0; min-height: 0; overflow: hidden; }
.te-v3-bottom { flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 4px 0; font-size: 11px; color: var(--text-tertiary); border-top: 1px solid var(--border-subtle); flex-wrap: wrap; }

/* ===== Left Panel: Tag Cloud (200px) ===== */
.te-v3-left { width: 220px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; overflow: hidden; border-right: 1px solid var(--border-subtle); padding-right: 10px; transition: width 0.2s var(--ease-out), padding 0.2s var(--ease-out), border 0.2s var(--ease-out); }
.te-v3-left.collapsed { width: 0; padding-right: 0; border-right: none; overflow: hidden; }
.te-v3-left-dir { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
.te-v3-left-dir span { font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.te-v3-left-dir button { flex-shrink: 0; width: 24px; height: 24px; border: none; background: none; color: var(--text-tertiary); cursor: pointer; border-radius: var(--radius-sm); font-size: 14px; display: flex; align-items: center; justify-content: center; }
.te-v3-left-dir button:hover { background: var(--hover-overlay); color: var(--text-primary); }
.te-v3-left-undo { display: flex; gap: 2px; flex-shrink: 0; }
.te-v3-left-undo button { height: 24px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; font-size: 13px; padding: 0 6px; transition: all 0.15s; }
.te-v3-left-undo button:hover { border-color: var(--accent); color: var(--accent); }
.te-v3-left-undo button:disabled { opacity: 0.3; cursor: not-allowed; border-color: var(--border-default); color: var(--text-tertiary); }
.te-v3-left-search { position: relative; flex-shrink: 0; }
.te-v3-left-search input { width: 100%; font-size: 12px; padding: 5px 24px 5px 8px; border: 1px solid var(--border-input); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); outline: none; }
.te-v3-left-search input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--accent-soft); }
.te-v3-left-search-clear { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; border: none; background: none; color: var(--text-tertiary); cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; border-radius: 50%; }
.te-v3-left-search-clear:hover { color: var(--text-primary); background: var(--hover-overlay); }
.te-v3-left-logic { display: flex; gap: 2px; flex-shrink: 0; }
.te-v3-left-logic button { flex: 1; font-size: 10px; font-weight: 700; padding: 3px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; transition: all 0.15s; }
.te-v3-left-logic button.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.te-v3-left-filters { display: flex; flex-wrap: wrap; gap: 3px; flex-shrink: 0; }
.te-v3-left-cloud { flex: 1; overflow-y: auto; min-height: 0; scrollbar-width: thin; scrollbar-color: var(--border-default) transparent; }
.te-v3-left-cloud::-webkit-scrollbar { width: 6px; }
.te-v3-left-cloud::-webkit-scrollbar-track { background: transparent; }
.te-v3-left-cloud::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 3px; }
.te-v3-left-empty { font-size: 11px; color: var(--text-tertiary); text-align: center; padding: 20px 8px; }
.te-v3-left-more { flex-shrink: 0; padding: 4px 0; text-align: center; }
.te-v3-left-more button { font-size: 11px; width: 100%; padding: 4px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: transparent; color: var(--text-tertiary); cursor: pointer; }
.te-v3-left-more button:hover { color: var(--accent); border-color: var(--accent); }

/* ===== Center: Image Grid ===== */
.te-v3-center { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; padding: 0 10px; }
.te-v3-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; flex: 1; overflow-y: auto; padding-bottom: 8px; align-content: start; scrollbar-width: thin; scrollbar-color: var(--border-default) transparent; }
.te-v3-grid::-webkit-scrollbar { width: 6px; }
.te-v3-grid::-webkit-scrollbar-track { background: transparent; }
.te-v3-grid::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 3px; }

.te-v3-card { border: 2px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-surface); transition: all 0.15s; position: relative; aspect-ratio: 1; cursor: pointer; overflow: hidden; }
.te-v3-card:hover { border-color: var(--border-focus); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
.te-v3-card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.te-v3-card.modified { border-left: 4px solid var(--warning); }
.te-v3-card-thumb { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: var(--bg-preview); }
.te-v3-card-thumb img { width: 100%; height: 100%; object-fit: contain; opacity: 0; transition: opacity 0.25s ease; }
.te-v3-card-thumb img[src] { opacity: 1; }
.te-v3-card-check { position: absolute; top: 8px; left: 8px; z-index: 3; }
.te-v3-card-check input[type=checkbox] { width: 20px; height: 20px; border-radius: 4px; border: 2px solid rgba(255,255,255,0.6); background: rgba(0,0,0,0.3); accent-color: var(--accent); cursor: pointer; appearance: none; -webkit-appearance: none; position: relative; }
.te-v3-card-check input[type=checkbox]:checked { background: var(--accent); border-color: var(--accent); }
.te-v3-card-check input[type=checkbox]:checked::after { content: ''; position: absolute; left: 5px; top: 1px; width: 5px; height: 10px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.te-v3-card-modified { position: absolute; top: 8px; right: 8px; font-size: 9px; padding: 2px 6px; border-radius: 8px; background: rgba(234,88,12,0.2); color: var(--warning); font-weight: 700; z-index: 3; pointer-events: none; }
.te-v3-card-overlay { position: absolute; bottom: 0; left: 0; right: 0; padding: 6px 8px; background: linear-gradient(transparent, rgba(0,0,0,0.8)); z-index: 2; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
.te-v3-card:hover .te-v3-card-overlay { opacity: 1; }
.te-v3-card-filename { font-size: 10px; color: rgba(255,255,255,0.9); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; margin-bottom: 2px; }
.te-v3-card-tags { display: flex; flex-wrap: wrap; gap: 2px; }
.te-v3-card-tag-pill { font-size: 9px; padding: 1px 5px; border-radius: 8px; background: rgba(255,255,255,0.2); color: rgba(255,255,255,0.85); white-space: nowrap; }

/* ===== Right Panel: Editor (320px) ===== */
.te-v3-right { width: 340px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; border-left: 1px solid var(--border-subtle); padding-left: 10px; transition: width 0.2s var(--ease-out), padding 0.2s var(--ease-out), border 0.2s var(--ease-out); }
.te-v3-right.collapsed { width: 0; padding-left: 0; border-left: none; overflow: hidden; }
.te-v3-right-section { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: 12px; }
.te-v3-right-header { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.te-v3-right-filename { font-size: 12px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.te-v3-right-nav { display: flex; gap: 2px; }
.te-v3-right-nav button { width: 24px; height: 24px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
.te-v3-right-nav button:hover { border-color: var(--accent); color: var(--accent); }
.te-v3-right-nav button:disabled { opacity: 0.3; cursor: not-allowed; border-color: var(--border-default); color: var(--text-tertiary); }
.te-v3-right-preview { width: 100%; aspect-ratio: 1; border-radius: var(--radius-sm); background: var(--bg-preview); display: flex; align-items: center; justify-content: center; margin-bottom: 8px; overflow: hidden; }
.te-v3-right-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
.te-v3-right-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.te-v3-right-tag { display: inline-flex; align-items: center; gap: 0; font-size: 12px; padding: 3px 8px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); cursor: grab; transition: all 0.15s; user-select: none; }
.te-v3-right-tag:active { cursor: grabbing; }
.te-v3-right-tag-del { font-size: 14px; color: var(--text-tertiary); cursor: pointer; padding: 0 3px; opacity: 0; transition: opacity 0.1s, color 0.1s; font-weight: 700; margin-left: 2px; }
.te-v3-right-tag:hover .te-v3-right-tag-del { opacity: 0.6; }
.te-v3-right-tag-del:hover { color: var(--danger); opacity: 1 !important; }
.te-v3-right-add { display: flex; gap: 4px; margin-bottom: 8px; }
.te-v3-right-add input { flex: 1; min-width: 0; font-size: 12px; padding: 6px 8px; border: 1px solid var(--border-input); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); outline: none; position: relative; }
.te-v3-right-add input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--accent-soft); }
.te-v3-right-add button { font-size: 12px; padding: 6px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-secondary); cursor: pointer; font-weight: 600; white-space: nowrap; transition: all 0.15s; }
.te-v3-right-add button:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
.te-v3-right-add-suggest { position: absolute; z-index: 20; background: var(--bg-surface); border: 1px solid var(--border-focus); border-radius: var(--radius-sm); box-shadow: var(--shadow-md); max-height: 160px; overflow-y: auto; }
.te-v3-right-add-suggest-item { padding: 6px 10px; font-size: 12px; color: var(--text-primary); cursor: pointer; }
.te-v3-right-add-suggest-item:hover { background: var(--accent-soft); color: var(--accent); }
.te-v3-right-view-toggle { display: flex; gap: 2px; margin-bottom: 8px; }
.te-v3-right-view-toggle button { flex: 1; font-size: 11px; padding: 4px; border: 1px solid var(--border-default); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; border-radius: var(--radius-sm); transition: all 0.15s; }
.te-v3-right-view-toggle button.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.te-v3-right-textarea { width: 100%; font-size: 12px; font-family: var(--font-mono); padding: 8px; min-height: 100px; resize: vertical; border: 1px solid var(--border-input); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); outline: none; }
.te-v3-right-textarea:focus { border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--accent-soft); }
.te-v3-right-actions { display: flex; gap: 4px; margin-bottom: 8px; }
.te-v3-right-actions button { font-size: 10px; padding: 3px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; transition: all 0.15s; }
.te-v3-right-actions button:hover { border-color: var(--accent); color: var(--accent); }
.te-v3-right-actions button:disabled { opacity: 0.3; cursor: not-allowed; }

/* Right panel placeholder */
.te-v3-right-placeholder { text-align: center; padding: 40px 20px; color: var(--text-tertiary); }
.te-v3-right-placeholder-icon { font-size: 36px; margin-bottom: 8px; opacity: 0.4; }
.te-v3-right-placeholder-text { font-size: 12px; }

/* ===== Top Bar ===== */
.te-v3-top-search { position: relative; flex: 0 1 240px; min-width: 140px; }
.te-v3-top-search input { width: 100%; font-size: 12px; padding: 6px 28px 6px 10px; border: 1px solid var(--border-input); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); outline: none; }
.te-v3-top-search input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--accent-soft); }
.te-v3-top-regex { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); font-size: 10px; font-weight: 700; padding: 2px 6px; border: 1px solid var(--border-default); border-radius: 4px; background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; }
.te-v3-top-regex.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.te-v3-top-filters { display: flex; gap: 2px; }
.te-v3-top-filters button { font-size: 11px; padding: 4px 10px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; font-weight: 500; transition: all 0.15s; }
.te-v3-top-filters button:hover { border-color: var(--accent); color: var(--accent); }
.te-v3-top-filters button.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.te-v3-top-filters button .badge { display: inline-block; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: rgba(255,255,255,0.2); font-size: 9px; line-height: 16px; text-align: center; margin-left: 4px; }
.te-v3-top-filters button:not(.active) .badge { background: var(--accent-soft); color: var(--accent); }
.te-v3-top-sort { position: relative; }
.te-v3-top-sort select { font-size: 11px; padding: 4px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); cursor: pointer; outline: none; }
.te-v3-top-divider { width: 1px; height: 22px; background: var(--border-default); flex-shrink: 0; }
.te-v3-top-sel-btn { font-size: 11px; padding: 4px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; transition: all 0.15s; }
.te-v3-top-sel-btn:hover { border-color: var(--accent); color: var(--accent); }
.te-v3-top-save { font-size: 11px; padding: 4px 14px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; font-weight: 600; transition: all 0.15s; }
.te-v3-top-save.has-changes { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.te-v3-top-save.has-changes:hover { background: var(--accent); color: #fff; }
.te-v3-top-toggle { width: 28px; height: 28px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
.te-v3-top-toggle:hover { border-color: var(--accent); color: var(--accent); }

/* ===== Bottom Bar ===== */
.te-v3-bottom-stat { display: flex; align-items: center; gap: 4px; }
.te-v3-bottom-stat strong { color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.te-v3-bottom-divider { width: 1px; height: 14px; background: var(--border-default); }
.te-v3-bottom-pages { display: flex; align-items: center; gap: 4px; }
.te-v3-bottom-pages button { width: 24px; height: 24px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
.te-v3-bottom-pages button:hover { border-color: var(--accent); color: var(--accent); }
.te-v3-bottom-pages button:disabled { opacity: 0.3; cursor: not-allowed; }
.te-v3-bottom-pages button.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 700; }
.te-v3-bottom-pages select { font-size: 11px; padding: 3px 4px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); cursor: pointer; }
.te-v3-bottom-saving { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.te-v3-bottom-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.te-v3-bottom-dot.warn { background: var(--warning); animation: te-pulse 1s infinite; }
.te-v3-bottom-dot.ok { background: var(--success); }

/* ===== Batch Editor (in right panel) ===== */
.te-v3-batch-scope { display: flex; gap: 2px; margin-bottom: 10px; }
.te-v3-batch-scope button { flex: 1; font-size: 10px; padding: 3px 6px; border: 1px solid var(--border-default); background: var(--bg-input); color: var(--text-tertiary); cursor: pointer; border-radius: var(--radius-sm); transition: all 0.15s; }
.te-v3-batch-scope button.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.te-v3-batch-row { display: flex; gap: 4px; margin-bottom: 6px; align-items: center; }
.te-v3-batch-row label { font-size: 11px; font-weight: 600; color: var(--text-secondary); width: 36px; flex-shrink: 0; }
.te-v3-batch-row input { flex: 1; min-width: 0; font-size: 11px; padding: 4px 8px; border: 1px solid var(--border-input); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); outline: none; }
.te-v3-batch-row input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--accent-soft); }
.te-v3-batch-row button { font-size: 10px; padding: 4px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-secondary); cursor: pointer; white-space: nowrap; transition: all 0.15s; font-weight: 600; }
.te-v3-batch-row button:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
.te-v3-batch-pos { display: flex; gap: 1px; padding: 2px; background: var(--bg-sunken); border: 1px solid var(--border-subtle); border-radius: 4px; flex-shrink: 0; }
.te-v3-batch-pos button { font-size: 10px; padding: 2px 7px; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; border-radius: 3px; font-weight: 600; transition: all 0.15s; }
.te-v3-batch-pos button.active { background: var(--bg-canvas); color: var(--accent); box-shadow: inset 0 0 0 1px color-mix(in oklch,var(--accent) 30%,var(--border-default)); }
.te-v3-batch-stats { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-subtle); }
.te-v3-batch-stats-title { font-size: 11px; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; }
.te-v3-batch-stats-list { max-height: 160px; overflow-y: auto; }
.te-v3-batch-stats-row { display: flex; align-items: center; gap: 4px; padding: 2px 0; font-size: 11px; }
.te-v3-batch-stats-tag { flex: 1; color: var(--text-primary); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.te-v3-batch-stats-tag:hover { color: var(--accent); }
.te-v3-batch-stats-cnt { color: var(--text-tertiary); font-family: var(--font-mono); font-size: 10px; }
.te-v3-batch-stats-del { border: none; background: none; color: var(--text-tertiary); cursor: pointer; font-size: 14px; padding: 0; opacity: 0; }
.te-v3-batch-stats-row:hover .te-v3-batch-stats-del { opacity: 0.7; }
.te-v3-batch-stats-del:hover { color: var(--danger); opacity: 1; }
.te-v3-batch-apply { display: flex; gap: 4px; margin-top: 8px; }
.te-v3-batch-apply button { flex: 1; font-size: 12px; padding: 6px 12px; border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--accent); color: #fff; cursor: pointer; font-weight: 600; transition: all 0.15s; }
.te-v3-batch-apply button:hover { opacity: 0.85; }
.te-v3-batch-apply button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
.te-v3-batch-apply button.danger:hover { background: var(--danger); color: #fff; }

/* ===== Autocomplete ===== */
.te-v3-suggest { position: absolute; z-index: 50; background: var(--bg-surface); border: 1px solid var(--border-focus); border-radius: var(--radius-sm); box-shadow: var(--shadow-md); max-height: 160px; overflow-y: auto; }
.te-v3-suggest-item { padding: 6px 10px; font-size: 12px; color: var(--text-primary); cursor: pointer; }
.te-v3-suggest-item:hover { background: var(--accent-soft); color: var(--accent); }

/* ===== Filter Chips ===== */
.te-v3-chip { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
.te-v3-chip.include { background: var(--accent-soft); color: var(--accent); }
.te-v3-chip.exclude { background: rgba(220,38,38,0.1); color: var(--danger); }
.te-v3-chip-x { cursor: pointer; font-size: 14px; margin-left: 2px; opacity: 0.6; }
.te-v3-chip-x:hover { opacity: 1; }

/* ===== Tag Cloud Item ===== */
.te-v3-tag-row { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: var(--radius-sm); font-size: 12px; cursor: pointer; position: relative; overflow: hidden; transition: background 0.1s; }
.te-v3-tag-row:hover { background: var(--hover-overlay); }
.te-v3-tag-row.selected { background: var(--accent-soft); }
.te-v3-tag-row.excluded { background: rgba(220,38,38,0.06); }
.te-v3-tag-row .bar { position: absolute; left: 0; top: 0; bottom: 0; pointer-events: none; opacity: 0.12; transition: width 0.3s var(--ease-out); }
.te-v3-tag-row.selected .bar { background: var(--accent); opacity: 0.2; }
.te-v3-tag-row.excluded .bar { background: var(--danger); opacity: 0.08; }
.te-v3-tag-row:not(.selected):not(.excluded) .bar { background: var(--accent); }
.te-v3-tag-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
.te-v3-tag-row .count { font-size: 10px; color: var(--text-secondary); min-width: 24px; text-align: right; font-variant-numeric: tabular-nums; }
.te-v3-tag-row .excl { font-size: 14px; color: var(--text-tertiary); cursor: pointer; opacity: 0; padding: 0 2px; transition: opacity 0.1s; }
.te-v3-tag-row:hover .excl { opacity: 0.6; }
.te-v3-tag-row .excl:hover { color: var(--danger); opacity: 1; }

/* ===== Context Menu ===== */
.te-v3-ctx { position: fixed; z-index: 3000; min-width: 160px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); padding: 4px; animation: fade-in 0.1s var(--ease-out); }
.te-v3-ctx-item { display: flex; align-items: center; gap: 6px; padding: 7px 10px; font-size: 12px; color: var(--text-primary); cursor: pointer; border-radius: var(--radius-sm); }
.te-v3-ctx-item:hover { background: var(--accent-soft); color: var(--accent); }
.te-v3-ctx-divider { height: 1px; background: var(--border-default); margin: 3px 6px; }

/* ===== Empty State ===== */
.te-v3-empty { text-align: center; padding: 48px 20px; }
.te-v3-empty-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.6; }
.te-v3-empty-title { font-size: 15px; font-weight: 600; color: var(--text-secondary); margin-bottom: 6px; }
.te-v3-empty-desc { font-size: 12px; color: var(--text-tertiary); margin-bottom: 20px; }
.te-v3-empty-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; align-items: center; }
.te-v3-empty-actions input { font-size: 12px; padding: 6px 10px; border: 1px solid var(--border-input); border-radius: var(--radius-sm); background: var(--bg-input); color: var(--text-primary); width: 300px; max-width: 100%; outline: none; }
.te-v3-empty-actions input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--accent-soft); }
.te-v3-empty-actions button { font-size: 12px; padding: 6px 16px; }

/* ===== Loading / Skeleton ===== */
@keyframes te-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.te-v3-skeleton { background: linear-gradient(90deg, var(--bg-surface-raised) 25%, var(--bg-surface) 50%, var(--bg-surface-raised) 75%); background-size: 200% 100%; animation: te-shimmer 1.5s infinite; border-radius: var(--radius-md); }
.te-v3-skeleton-card { aspect-ratio: 1; }

/* ===== Drag Selection ===== */
.te-v3-drag-rect { position: fixed; border: 2px dashed var(--accent); background: var(--accent-soft); pointer-events: none; z-index: 500; border-radius: 2px; }

/* ===== Confirm Dialog ===== */
.te-v3-confirm { position: fixed; inset: 0; z-index: 2500; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; animation: fade-in 0.15s var(--ease-out); }
.te-v3-confirm-box { background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: 24px; max-width: 420px; width: 90vw; animation: modal-in 0.2s var(--ease-out); }
.te-v3-confirm-msg { font-size: 14px; color: var(--text-primary); margin-bottom: 20px; line-height: 1.5; }
.te-v3-confirm-btns { display: flex; gap: 8px; justify-content: flex-end; }

/* ===== Saving Overlay ===== */
.te-v3-saving-overlay { position: absolute; inset: 0; background: rgba(255,255,255,0.6); z-index: 100; display: flex; align-items: center; justify-content: center; font-size: 14px; color: var(--accent); font-weight: 600; }
[data-theme="dark"] .te-v3-saving-overlay { background: rgba(0,0,0,0.5); }

/* ===== Responsive ===== */
@media (max-width: 1200px) {
  .te-v3-left { width: 180px; }
  .te-v3-right { width: 280px; }
}
@media (max-width: 900px) {
  .te-v3-left { width: 140px; }
  .te-v3-right { width: 260px; }
}
@media (max-width: 700px) {
  .te-v3-main { flex-direction: column; }
  .te-v3-left { width: 100%; max-height: 40vh; border-right: none; border-bottom: 1px solid var(--border-subtle); padding-right: 0; padding-bottom: 8px; }
  .te-v3-right { width: 100%; border-left: none; border-top: 1px solid var(--border-subtle); padding-left: 0; padding-top: 8px; }
  .te-v3-center { padding: 0; }
}
```

- [ ] **Step 2: CSS 变量检查**

```bash
Select-String -Path 'frontend/css/app.css' -Pattern 'var\(--border-color\)'
Select-String -Path 'frontend/css/app.css' -Pattern 'var\(--radius\)(?!-)'
Select-String -Path 'frontend/css/app.css' -Pattern 'var\(--primary\)(?!-)'
```

预期：全部为空（无匹配）

- [ ] **Step 3: 提交**

```bash
git add frontend/css/app.css
git commit -m "style: 重写标签编辑器 CSS 为三栏布局 v3"
```

---

## Task 4: 重写标签编辑器 HTML 模板

**Files:**
- Modify: `frontend/index.html:385-896`

- [ ] **Step 1: 读取旧模板起止行，确认替换范围**

```bash
# 第 385 行附近是以 <!-- Tag Editor --> 或 @tagEditor 开始
# 第 896 行附近是 tagEditor 路由模板结束，下一个路由开始
```

- [ ] **Step 2: 写入新三栏 HTML 模板**

找到 `index.html` 中标签编辑器的 `<template x-if="currentRoute === 'tagEditor'">` 块，将其整个内部内容替换为以下模板。**保留外围的** `<template x-if="currentRoute === 'tagEditor'">` **标签不变**。

```html
<!-- ===== Tag Editor v3: 3-Column Layout ===== -->

  <!-- Saved indicator (no modal) — remains at top level -->
  <div x-show="tagEditorSaving" class="te-v3-saving-overlay" x-transition>
    <span x-text="t('tagEditor.saving')"></span>
  </div>

  <!-- Confirm dialog -->
  <div x-show="tagEditorConfirmOpen" class="te-v3-confirm" @click.self="tagEditorConfirmOpen = false" x-transition>
    <div class="te-v3-confirm-box">
      <div class="te-v3-confirm-msg" x-text="tagEditorConfirmMsg"></div>
      <div class="te-v3-confirm-btns">
        <button class="btn btn-ghost btn-sm" @click="tagEditorConfirmOpen = false; tagEditorConfirmCb = null"
          x-text="t('common.cancel')"></button>
        <button class="btn btn-primary btn-sm" @click="let cb = tagEditorConfirmCb; tagEditorConfirmOpen = false; tagEditorConfirmCb = null; if (cb) cb()"
          x-text="t('common.confirm')"></button>
      </div>
    </div>
  </div>

  <!-- Context menu -->
  <div x-show="tagEditorContextMenu" class="te-v3-ctx"
    :style="'left:' + (tagEditorContextMenu?.x || 0) + 'px; top:' + (tagEditorContextMenu?.y || 0) + 'px'"
    @click.away="tagEditorContextMenu = null" @keydown.escape.window="tagEditorContextMenu = null">
    <div class="te-v3-ctx-item" @click="tagEditorCtxInclude()" x-text="t('tagEditor.contextInclude')"></div>
    <div class="te-v3-ctx-item" @click="tagEditorCtxExclude()" x-text="t('tagEditor.contextExclude')"></div>
    <div class="te-v3-ctx-divider"></div>
    <div class="te-v3-ctx-item" @click="tagEditorCtxCopy()" x-text="t('tagEditor.contextCopy')"></div>
    <div class="te-v3-ctx-item" @click="tagEditorCtxAddAll()" x-text="t('tagEditor.contextAddAll')"></div>
  </div>

  <!-- Drag selection rectangle -->
  <div x-show="tagEditorDragRect" class="te-v3-drag-rect"
    :style="'left:' + (tagEditorDragRect?.left || 0) + 'px; top:' + (tagEditorDragRect?.top || 0) + 'px; width:' + (tagEditorDragRect?.width || 0) + 'px; height:' + (tagEditorDragRect?.height || 0) + 'px'"></div>

  <!-- ===== Empty State ===== -->
  <div x-show="tagEditorImages.length === 0 && !tagEditorLoading" class="te-v3-empty">
    <div class="te-v3-empty-icon">&#x1F5BC;</div>
    <div class="te-v3-empty-title" x-text="t('tagEditor.noImages')"></div>
    <div class="te-v3-empty-desc" x-text="t('tagEditor.datasetDirPlaceholder')"></div>
    <div class="te-v3-empty-actions">
      <input type="text" x-model="tagEditorDir" :placeholder="t('tagEditor.datasetDirPlaceholder')"
        @keydown.enter="tagEditorLoad(tagEditorDir)">
      <button class="btn btn-primary btn-sm" @click="tagEditorLoad(tagEditorDir)" x-text="t('tagEditor.loadImages')"></button>
      <button class="btn btn-ghost btn-sm" @click="tagEditorLoad()" x-text="t('tagEditor.loadFromTraining')"></button>
    </div>
  </div>

  <!-- ===== Loading State ===== -->
  <div x-show="tagEditorLoading" class="te-v3" style="display:flex">
    <div class="te-v3-top"></div>
    <div class="te-v3-main">
      <div class="te-v3-center">
        <div class="te-v3-grid">
          <template x-for="i in 12" :key="i">
            <div class="te-v3-skeleton te-v3-skeleton-card"></div>
          </template>
        </div>
      </div>
    </div>
  </div>

  <!-- ===== Main Layout (loaded) ===== -->
  <div x-show="tagEditorImages.length > 0 && !tagEditorLoading" class="te-v3" style="display:flex"
    @mousedown="tagEditorGridMouseDown($event)" @mousemove="tagEditorGridMouseMove($event)"
    @mouseup="tagEditorGridMouseUp($event)">

    <!-- Top Bar -->
    <div class="te-v3-top">
      <button class="te-v3-top-toggle" @click="tagEditorLeftCollapsed = !tagEditorLeftCollapsed" title="切换标签云">
        &#x2630;
      </button>
      <div class="te-v3-top-search">
        <input type="text" x-model="tagEditorSearchQuery"
          :placeholder="tagEditorUseRegex ? t('tagEditor.regexSearchPlaceholder') : t('tagEditor.searchPlaceholder')"
          @keydown.escape="tagEditorSearchQuery = ''">
        <button class="te-v3-top-regex" :class="{ active: tagEditorUseRegex }"
          @click="tagEditorUseRegex = !tagEditorUseRegex" x-text="'.*'"></button>
      </div>
      <div class="te-v3-top-filters">
        <button :class="{ active: tagEditorQuickFilter === 'all' }"
          @click="tagEditorQuickFilter = 'all'">
          <span x-text="t('tagEditor.selection')"></span>
          <span class="badge" x-text="tagEditorGetFiltered().length"></span>
        </button>
        <button :class="{ active: tagEditorQuickFilter === 'notag' }"
          @click="tagEditorQuickFilter = (tagEditorQuickFilter === 'notag' ? 'all' : 'notag')">
          <span x-text="t('tagEditor.noTag')"></span>
          <span class="badge" x-text="tagEditorGetQuickCount('notag')"></span>
        </button>
        <button :class="{ active: tagEditorQuickFilter === 'modified' }"
          @click="tagEditorQuickFilter = (tagEditorQuickFilter === 'modified' ? 'all' : 'modified')">
          <span x-text="t('tagEditor.unsavedChanges')"></span>
          <span class="badge" x-text="tagEditorGetQuickCount('modified')"></span>
        </button>
      </div>
      <div class="te-v3-top-sort">
        <select x-model="tagEditorSortBy" @change="tagEditorSortAsc = true">
          <option value="name" x-text="t('tagEditor.sortName')"></option>
          <option value="tagCount" x-text="t('tagEditor.sortTagCount')"></option>
          <option value="modified" x-text="t('tagEditor.modified')"></option>
        </select>
      </div>
      <div class="te-v3-top-divider"></div>
      <button class="te-v3-top-sel-btn" @click="tagEditorSelectAll()" x-text="t('tagEditor.selectAll')"></button>
      <button class="te-v3-top-sel-btn" @click="tagEditorSelectInvert()" x-text="t('tagEditor.selectInvert')"></button>
      <button class="te-v3-top-sel-btn" @click="tagEditorSelected = []" x-text="t('tagEditor.selectNone')"></button>
      <div class="te-v3-top-divider"></div>
      <button class="te-v3-top-save" :class="{ 'has-changes': tagEditorModifiedCount() > 0 }"
        @click="tagEditorSaveAll()">
        <span x-text="t('common.save')"></span>
        <template x-if="tagEditorModifiedCount() > 0">
          <span x-text="' (' + tagEditorModifiedCount() + ')'"></span>
        </template>
      </button>
      <div class="te-v3-top-divider"></div>
      <button class="te-v3-top-toggle" @click="tagEditorRightCollapsed = !tagEditorRightCollapsed" title="切换编辑面板">
        &#x25C0;
      </button>
    </div>

    <!-- Main: 3 Columns -->
    <div class="te-v3-main">
      <!-- Left: Tag Cloud -->
      <div class="te-v3-left" :class="{ collapsed: tagEditorLeftCollapsed }">
        <div class="te-v3-left-dir">
          <span x-text="tagEditorDir || '...'" :title="tagEditorDir"></span>
          <button @click="tagEditorLoad(tagEditorDir)" title="重新加载">&#x21BB;</button>
        </div>
        <div class="te-v3-left-undo">
          <button @click="tagEditorUndo()" :disabled="tagEditorHistoryIdx < 0" title="撤销 Ctrl+Z">&#x21A9;</button>
          <button @click="tagEditorRedo()" :disabled="tagEditorHistoryIdx >= tagEditorHistory.length - 1" title="重做 Ctrl+Shift+Z">&#x21AA;</button>
        </div>
        <div class="te-v3-left-search">
          <input type="text" x-model="tagEditorTagSearch" :placeholder="t('tagEditor.searchTags')">
          <button class="te-v3-left-search-clear" x-show="tagEditorTagSearch"
            @click="tagEditorTagSearch = ''">&times;</button>
        </div>
        <div class="te-v3-left-logic">
          <button :class="{ active: tagEditorTagLogic === 'AND' }" @click="tagEditorTagLogic = 'AND'"
            :title="t('tagEditor.logicAndHint')">AND</button>
          <button :class="{ active: tagEditorTagLogic === 'OR' }" @click="tagEditorTagLogic = 'OR'"
            :title="t('tagEditor.logicOrHint')">OR</button>
        </div>
        <div class="te-v3-left-filters" x-show="tagEditorTagSelection.length > 0 || tagEditorExcludedTags.length > 0">
          <template x-for="tag in tagEditorTagSelection" :key="'inc-' + tag">
            <span class="te-v3-chip include">
              <span x-text="tag"></span>
              <span class="te-v3-chip-x" @click="tagEditorTagSelection = tagEditorTagSelection.filter(function(t) { return t !== tag })">&times;</span>
            </span>
          </template>
          <template x-for="tag in tagEditorExcludedTags" :key="'exc-' + tag">
            <span class="te-v3-chip exclude">
              <span x-text="tag"></span>
              <span class="te-v3-chip-x" @click="tagEditorExcludedTags = tagEditorExcludedTags.filter(function(t) { return t !== tag })">&times;</span>
            </span>
          </template>
        </div>
        <div class="te-v3-left-cloud">
          <template x-if="tagEditorGetFilteredTagFreq().length === 0">
            <div class="te-v3-left-empty" x-text="tagEditorTagSearch ? t('common.noResults') : t('tagEditor.noTag')"></div>
          </template>
          <template x-for="item in tagEditorGetDisplayFreq()" :key="item.tag">
            <div class="te-v3-tag-row"
              :class="{ selected: tagEditorTagSelection.includes(item.tag), excluded: tagEditorExcludedTags.includes(item.tag) }"
              @click="tagEditorSelectTag(item.tag)"
              @contextmenu.prevent="tagEditorTagCtx($event, item.tag)">
              <div class="bar" :style="'width:' + (tagEditorMaxFreq > 0 ? (item.count / tagEditorMaxFreq * 100) : 0) + '%'"></div>
              <span class="name" x-text="item.tag"></span>
              <span class="count" x-text="item.count"></span>
              <span class="excl" @click.stop="tagEditorExcludeTag(item.tag)">&times;</span>
            </div>
          </template>
        </div>
        <div class="te-v3-left-more" x-show="tagEditorGetFilteredTagFreq().length > tagEditorTagCloudLimit">
          <button @click="tagEditorTagCloudExpanded = !tagEditorTagCloudExpanded"
            x-text="tagEditorTagCloudExpanded ? t('tagEditor.showLess') : t('tagEditor.showMore')"></button>
        </div>
      </div>

      <!-- Center: Image Grid -->
      <div class="te-v3-center">
        <div class="te-v3-grid" id="teGrid">
          <template x-for="(img, idx) in tagEditorGetPaged()" :key="img.path">
            <div class="te-v3-card"
              :class="{ selected: tagEditorSelected.includes(img.path), modified: img.tags !== tagEditorOriginal[img.path] }"
              @click="tagEditorCardClick(img, idx, $event)"
              @dblclick="tagEditorCardDblClick(img, idx, $event)"
              @contextmenu.prevent="tagEditorCardCtx(img, $event)">
              <div class="te-v3-card-thumb">
                <img :src="img.thumbnail" :alt="img.name" loading="lazy" @load="$el.src = $el.src">
              </div>
              <div class="te-v3-card-check" @click.stop>
                <input type="checkbox" :checked="tagEditorSelected.includes(img.path)"
                  @change="tagEditorToggleSelect(img.path, $event)">
              </div>
              <div class="te-v3-card-modified" x-show="img.tags !== tagEditorOriginal[img.path]">M</div>
              <div class="te-v3-card-overlay">
                <div class="te-v3-card-filename" x-text="img.name"></div>
                <div class="te-v3-card-tags" x-show="img.tags">
                  <template x-for="tag in (img.tags || '').split(',').slice(0, 3)" :key="tag">
                    <span class="te-v3-card-tag-pill" x-text="tag.trim()"></span>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Right: Editor Panel -->
      <div class="te-v3-right" :class="{ collapsed: tagEditorRightCollapsed || tagEditorSelected.length === 0 }">

        <!-- Single Image Editor (selected === 1) -->
        <template x-if="tagEditorSelected.length === 1">
          <div>
            <div class="te-v3-right-section">
              <div class="te-v3-right-header">
                <span class="te-v3-right-filename" x-text="tagEditorGetSelectedImg()?.name || ''"></span>
                <div class="te-v3-right-nav">
                  <button @click="tagEditorNavDetail(-1)" :disabled="!tagEditorCanNavDetail(-1)"
                    title="上一张">&larr;</button>
                  <button @click="tagEditorNavDetail(1)" :disabled="!tagEditorCanNavDetail(1)"
                    title="下一张">&rarr;</button>
                </div>
              </div>
              <div class="te-v3-right-preview">
                <img :src="tagEditorGetSelectedImg()?.thumbnail" :alt="tagEditorGetSelectedImg()?.name">
              </div>
              <div class="te-v3-right-tags"
                @dragover.prevent="tagEditorDetailDragOver($event)"
                @drop="tagEditorDetailDrop($event)">
                <template x-for="(tag, ti) in tagEditorGetSelectedTags()" :key="tag + '-' + ti">
                  <span class="te-v3-right-tag"
                    draggable="true"
                    @dragstart="tagEditorDetailDragStart($event, ti)"
                    @dragend="$el.classList.remove('te-pill-drag-src')"
                    @dblclick="tagEditorDetailEditTag(ti)">
                    <span x-text="tag"></span>
                    <span class="te-v3-right-tag-del"
                      @click.stop="tagEditorRemoveTagFromSelected(tag)"
                      @dblclick.stop
                      title="移除标签">&times;</span>
                  </span>
                </template>
              </div>
              <div class="te-v3-right-add" style="position:relative">
                <input type="text" x-model="tagEditorAddInput" :placeholder="t('tagEditor.addTagPlaceholder')"
                  @keydown.enter="tagEditorAddTagToSelected()"
                  @input="tagEditorGetSuggestions(tagEditorAddInput)"
                  @focus="tagEditorGetSuggestions(tagEditorAddInput)"
                  @blur="tagEditorBlurSuggest()">
                <button @click="tagEditorAddTagToSelected()">+</button>
                <div class="te-v3-suggest" x-show="tagEditorSuggestions.length > 0"
                  style="top:100%; left:0; right:40px; margin-top:2px;">
                  <template x-for="s in tagEditorSuggestions" :key="s">
                    <div class="te-v3-suggest-item" @mousedown.prevent="tagEditorSelectSuggestion(s)"
                      x-text="s"></div>
                  </template>
                </div>
              </div>
              <div class="te-v3-right-actions">
                <button @click="tagEditorSortSelectedTags()" x-text="t('tagEditor.sort')"></button>
                <button @click="tagEditorCopySelectedTags()" x-text="t('tagEditor.copyTags')"></button>
                <button @click="tagEditorPasteTagsToSelected()" x-text="t('tagEditor.pasteTags')"
                  :disabled="tagEditorCopiedTags.length === 0"></button>
              </div>
              <div class="te-v3-right-view-toggle">
                <button :class="{ active: tagEditorDetailView === 'chip' }"
                  @click="tagEditorDetailView = 'chip'" x-text="t('tagEditor.viewChip')"></button>
                <button :class="{ active: tagEditorDetailView === 'text' }"
                  @click="tagEditorDetailView = 'text'" x-text="t('tagEditor.viewText')"></button>
              </div>
              <textarea class="te-v3-right-textarea" x-show="tagEditorDetailView === 'text'"
                x-model="tagEditorDetailText"
                @input="tagEditorDetailTextChange()"></textarea>
            </div>
          </div>
        </template>

        <!-- Batch Editor (selected >= 2) -->
        <template x-if="tagEditorSelected.length >= 2">
          <div>
            <div class="te-v3-right-section">
              <div class="te-v3-right-header">
                <span x-text="t('tagEditor.selected').replace('{n}', tagEditorSelected.length)"></span>
              </div>

              <!-- Batch scope -->
              <div class="te-v3-batch-scope">
                <button :class="{ active: tagEditorBatchScope === 'selected' }"
                  @click="tagEditorBatchScope = 'selected'" x-text="t('tagEditor.scopeSelected')"></button>
                <button :class="{ active: tagEditorBatchScope === 'filtered' }"
                  @click="tagEditorBatchScope = 'filtered'" x-text="t('tagEditor.scopeFiltered')"></button>
                <button :class="{ active: tagEditorBatchScope === 'all' }"
                  @click="tagEditorBatchScope = 'all'" x-text="t('tagEditor.scopeAll')"></button>
              </div>

              <!-- Add tags -->
              <div class="te-v3-batch-row">
                <label x-text="t('bulkAction.add')"></label>
                <input type="text" x-model="batchAddInput" :placeholder="t('tagEditor.batchPlaceholder')"
                  @input="tagEditorBatchSuggest('add')" @focus="tagEditorBatchSuggest('add')"
                  @blur="tagEditorBatchBlur()" @keydown.enter="tagEditorBatchAdd()">
                <div class="te-v3-batch-pos">
                  <button :class="{ active: batchPos === 'front' }" @click="batchPos = 'front'"
                    x-text="t('bulkAction.posFront')"></button>
                  <button :class="{ active: batchPos === 'back' }" @click="batchPos = 'back'"
                    x-text="t('bulkAction.posBack')"></button>
                </div>
                <button @click="tagEditorBatchAdd()" x-text="t('common.apply')"></button>
                <div class="te-v3-suggest" x-show="batchSuggestOpen"
                  style="top:100%; left:40px; right:80px; margin-top:2px;">
                  <template x-for="s in batchSuggestItems" :key="s">
                    <div class="te-v3-suggest-item" @mousedown.prevent="tagEditorBatchSelectSuggestion(s)"
                      x-text="s"></div>
                  </template>
                </div>
              </div>

              <!-- Remove tags -->
              <div class="te-v3-batch-row">
                <label x-text="t('bulkAction.removeTag')"></label>
                <input type="text" x-model="batchRemoveInput" :placeholder="t('tagEditor.batchPlaceholder')"
                  @input="tagEditorBatchSuggest('remove')" @focus="tagEditorBatchSuggest('remove')"
                  @blur="tagEditorBatchBlur()" @keydown.enter="tagEditorBatchRemove()">
                <button @click="tagEditorBatchRemove()" x-text="t('common.apply')"></button>
              </div>

              <!-- Replace tags -->
              <div class="te-v3-batch-row">
                <label x-text="t('bulkAction.replace')"></label>
                <input type="text" x-model="batchOldTag" :placeholder="t('tagEditor.batchPlaceholder')"
                  @input="tagEditorBatchSuggest('old')" @focus="tagEditorBatchSuggest('old')"
                  @blur="tagEditorBatchBlur()">
                <span style="font-size:11px;color:var(--text-tertiary)">&rarr;</span>
                <input type="text" x-model="batchNewTag" :placeholder="t('tagEditor.batchPlaceholder2')"
                  @keydown.enter="tagEditorBatchReplace()">
                <button @click="tagEditorBatchReplace()" x-text="t('common.apply')"></button>
              </div>

              <!-- Dedupe + Sort -->
              <div class="te-v3-batch-row">
                <button @click="tagEditorBatchDedup()" x-text="t('bulkAction.dedupe')"></button>
                <button @click="tagEditorBatchSort()" x-text="t('tagEditor.sort')"></button>
              </div>
            </div>

            <!-- Tag stats for selected -->
            <div class="te-v3-right-section te-v3-batch-stats" x-show="tagEditorGetSelectedStats().length > 0">
              <div class="te-v3-batch-stats-title" x-text="t('tagEditor.tagCloud')"></div>
              <div class="te-v3-batch-stats-list">
                <template x-for="item in tagEditorGetSelectedStats()" :key="item.tag">
                  <div class="te-v3-batch-stats-row">
                    <span class="te-v3-batch-stats-tag" @click="batchRemoveInput = item.tag"
                      x-text="item.tag" :title="t('tagEditor.clickToDelete')"></span>
                    <span class="te-v3-batch-stats-cnt" x-text="item.count"></span>
                    <button class="te-v3-batch-stats-del"
                      @click="tagEditorBatchRemoveTag(item.tag)">&times;</button>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </template>

        <!-- No selection placeholder -->
        <template x-if="tagEditorSelected.length === 0 && !tagEditorRightCollapsed">
          <div class="te-v3-right-placeholder">
            <div class="te-v3-right-placeholder-icon">&#x1F4DD;</div>
            <div class="te-v3-right-placeholder-text" x-text="t('tagEditor.selectOneImage')"></div>
          </div>
        </template>
      </div>
    </div>

    <!-- Bottom Bar -->
    <div class="te-v3-bottom">
      <div class="te-v3-bottom-stat">
        <span x-text="t('tagEditor.imageCount')"></span>
        <strong x-text="tagEditorImages.length"></strong>
      </div>
      <div class="te-v3-bottom-divider"></div>
      <div class="te-v3-bottom-stat">
        <span x-text="t('tagEditor.tagCloud')"></span>
        <strong x-text="tagEditorTagFreq.length"></strong>
      </div>
      <template x-if="tagEditorGetFiltered().length !== tagEditorImages.length">
        <span>
          <div class="te-v3-bottom-divider"></div>
          <span style="color:var(--text-tertiary)"><span x-text="tagEditorGetFiltered().length"></span> 筛选</span>
        </span>
      </template>
      <template x-if="tagEditorSelected.length > 0">
        <span>
          <div class="te-v3-bottom-divider"></div>
          <span x-text="t('tagEditor.selected').replace('{n}', tagEditorSelected.length)"></span>
        </span>
      </template>
      <template x-if="tagEditorModifiedCount() > 0">
        <span>
          <div class="te-v3-bottom-divider"></div>
          <span style="color:var(--warning)">
            <span class="te-v3-bottom-dot warn" style="margin-right:4px"></span>
            <span x-text="tagEditorModifiedCount()"></span> <span x-text="t('tagEditor.unsavedChanges')"></span>
          </span>
        </span>
      </template>
      <div style="flex:1"></div>
      <div class="te-v3-bottom-pages">
        <button @click="tagEditorPage = 1" :disabled="tagEditorPage === 1">&laquo;</button>
        <button @click="tagEditorPage--" :disabled="tagEditorPage === 1">&lsaquo;</button>
        <template x-for="p in tagEditorGetPageNumbers()" :key="p">
          <button v-if="typeof p === 'number'" :class="{ active: p === tagEditorPage }"
            @click="tagEditorPage = p" x-text="p"></button>
          <span v-else x-text="p" style="padding:0 4px;color:var(--text-tertiary)"></span>
        </template>
        <button @click="tagEditorPage++" :disabled="tagEditorPage >= tagEditorTotalPages()">&rsaquo;</button>
        <button @click="tagEditorPage = tagEditorTotalPages()" :disabled="tagEditorPage >= tagEditorTotalPages()">&raquo;</button>
        <select x-model="tagEditorPageSize" @change="tagEditorPage = 1">
          <option v-for="s in [30, 60, 120, 240]" :key="s" :value="s" x-text="s"></option>
        </select>
        <span style="font-size:11px;color:var(--text-tertiary)" x-text="t('tagEditor.perPage')"></span>
      </div>
      <div class="te-v3-bottom-divider"></div>
      <div class="te-v3-bottom-saving">
        <span class="te-v3-bottom-dot" :class="tagEditorModifiedCount() > 0 ? 'warn' : 'ok'"></span>
        <span x-text="tagEditorModifiedCount() > 0 ? t('tagEditor.pendingModifications').replace('{n}', tagEditorModifiedCount()) : t('common.saved')"></span>
      </div>
    </div>
  </div>

<!-- End Tag Editor v3 -->
```

- [ ] **Step 3: 提交**

```bash
git add frontend/index.html
git commit -m "feat: 重写标签编辑器 HTML 模板为三栏布局"
```

---

## Task 5: 重写 tag-editor.js — 核心状态 + 数据加载 + 保存

**Files:**
- Modify: `frontend/js/tag-editor.js`（完全重写）

- [ ] **Step 1: 写入新的 tag-editor.js**

完全替换 `frontend/js/tag-editor.js` 全部内容：

```javascript
/* ================================================================
   tag-editor.js — Tag Editor v3: 3-Column Layout
   Alpine.js mixin: left tag cloud, center image grid, right editor panel
   ================================================================ */

window.tagEditorMixin = {

  // ===== Core State =====
  tagEditorDir: '',
  tagEditorImages: [],
  tagEditorOriginal: {},
  tagEditorModified: false,
  tagEditorTagFreq: [],
  tagEditorMaxFreq: 0,
  tagEditorLoading: false,
  tagEditorSaving: false,

  // ===== Filters & Search =====
  tagEditorSearchQuery: '',
  tagEditorUseRegex: false,
  tagEditorQuickFilter: 'all',
  tagEditorSortBy: 'name',
  tagEditorSortAsc: true,
  tagEditorTagSearch: '',
  tagEditorTagLogic: 'AND',
  tagEditorTagSelection: [],
  tagEditorExcludedTags: [],
  tagEditorTagSortBy: 'freq',
  tagEditorTagSortAsc: false,
  tagEditorTagCloudLimit: 200,
  tagEditorTagCloudExpanded: false,

  // ===== Selection & Grid =====
  tagEditorSelected: [],
  tagEditorPage: 1,
  tagEditorPageSize: 60,
  tagEditorDragSelect: false,
  tagEditorDragStart: null,
  tagEditorDragRect: null,
  tagEditorContextMenu: null,
  tagEditorLeftCollapsed: false,
  tagEditorRightCollapsed: false,

  // ===== Right Panel Editor =====
  tagEditorDetailView: 'chip',
  tagEditorDetailText: '',
  tagEditorAddInput: '',
  tagEditorSuggestions: [],
  _teSuggestTimer: null,
  _teBlurTimer: null,
  tagEditorDetailDragOverIdx: -1,
  tagEditorDetailDragSrcIdx: -1,

  // ===== Batch Operations =====
  tagEditorBatchScope: 'filtered',
  batchAddInput: '',
  batchRemoveInput: '',
  batchOldTag: '',
  batchNewTag: '',
  batchPos: 'front',
  batchSuggestOpen: null,
  batchSuggestItems: [],
  _teBatchSuggestTimer: null,
  _teBatchBlurTimer: null,

  // ===== Clipboard =====
  tagEditorCopiedTags: [],

  // ===== Undo/Redo =====
  tagEditorHistory: [],
  tagEditorHistoryIdx: -1,

  // ===== Confirm Dialog =====
  tagEditorConfirmOpen: false,
  tagEditorConfirmMsg: '',
  tagEditorConfirmCb: null,

  // ===== Auto-save =====
  _teAutoSaveInterval: null,
  _tePendingTextEdits: {},

  // ===== Cache =====
  _teFilteredCacheKey: '',
  _teFreqCacheKey: '',
  _teCachedFiltered: null,

  // ===== Lifecycle =====
  tagEditorCleanup() {
    this._teStopAutoSave();
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    if (this._teBlurTimer) { clearTimeout(this._teBlurTimer); this._teBlurTimer = null; }
    if (this._teBatchSuggestTimer) { clearTimeout(this._teBatchSuggestTimer); this._teBatchSuggestTimer = null; }
    if (this._teBatchBlurTimer) { clearTimeout(this._teBatchBlurTimer); this._teBatchBlurTimer = null; }
    Object.keys(this._tePendingTextEdits).forEach(function(k) {
      clearTimeout(this._tePendingTextEdits[k]);
    }, this);
    this._tePendingTextEdits = {};
  },

  // ===== Data Loading =====
  async tagEditorLoad(dir) {
    if (!dir && !this.tagEditorDir) {
      var cached = null;
      try { cached = sessionStorage.getItem('tagEditor_lastDir'); } catch (e) {}
      if (cached) { dir = cached; }
    }
    var d = dir || this.tagEditorDir || (this.form && this.form.train_data_dir) || '';
    if (!d) { this.toast(this.t('common.specifyDir') || 'Please specify a directory', 'warning'); return; }
    this.tagEditorDir = d;
    this.tagEditorLoading = true;
    this._teStopAutoSave();
    this.startProgress();
    try {
      var r = await fetch('/api/tageditor/images?dir=' + encodeURIComponent(d));
      var j = await r.json();
      if (j.status === 'success') {
        try { sessionStorage.setItem('tagEditor_lastDir', d); } catch (e) {}
        this.tagEditorImages = j.data.images || [];
        this.tagEditorOriginal = {};
        var self = this;
        this.tagEditorImages.forEach(function(img) { self.tagEditorOriginal[img.path] = img.tags; });
        this.tagEditorModified = false;
        this.tagEditorSelected = [];
        this.tagEditorPage = 1;
        this.tagEditorHistory = [];
        this.tagEditorHistoryIdx = -1;
        this.tagEditorTagSelection = [];
        this.tagEditorExcludedTags = [];
        this._teFilteredCacheKey = '';
        await this.tagEditorLoadTagFreq();
        this._teCheckDraft();
        this._teStartAutoSave();
      } else {
        this.toast(j.message || this.t('common.error'), 'error');
      }
    } catch (e) {
      this.toast(this.t('common.networkError'), 'error');
    } finally {
      this.tagEditorLoading = false;
      this.finishProgress();
    }
  },

  async tagEditorLoadTagFreq() {
    if (!this.tagEditorDir) return;
    try {
      var r = await fetch('/api/tageditor/tags?dir=' + encodeURIComponent(this.tagEditorDir));
      var j = await r.json();
      if (j.status === 'success') {
        this.tagEditorTagFreq = j.data.freq || [];
        this.tagEditorMaxFreq = this.tagEditorTagFreq.length > 0 ? this.tagEditorTagFreq[0].count : 0;
        this._teFreqCacheKey = '';
      }
    } catch (e) { /* silent */ }
  },

  // ===== Filtering & Sorting =====
  tagEditorGetFiltered() {
    var cacheKey = this.tagEditorSearchQuery + '|' + this.tagEditorQuickFilter + '|' +
      this.tagEditorTagSelection.join(',') + '|' + this.tagEditorExcludedTags.join(',') + '|' +
      this.tagEditorTagLogic + '|' + this.tagEditorSortBy + '|' + this.tagEditorSortAsc;
    if (cacheKey === this._teFilteredCacheKey && this._teCachedFiltered) return this._teCachedFiltered;

    var images = this.tagEditorImages.slice();

    // Quick filter
    if (this.tagEditorQuickFilter === 'notag') {
      images = images.filter(function(img) { return !img.tags || img.tags.trim() === ''; });
    } else if (this.tagEditorQuickFilter === 'modified') {
      var orig = this.tagEditorOriginal;
      images = images.filter(function(img) { return img.tags !== orig[img.path]; });
    }

    // Text search
    if (this.tagEditorSearchQuery) {
      var q = this.tagEditorSearchQuery.toLowerCase();
      if (this.tagEditorUseRegex) {
        try {
          var re = new RegExp(this.tagEditorSearchQuery, 'i');
          images = images.filter(function(img) {
            return re.test(img.name) || re.test(img.tags || '');
          });
        } catch (e) { /* invalid regex, show all */ }
      } else {
        images = images.filter(function(img) {
          return img.name.toLowerCase().indexOf(q) !== -1 ||
            (img.tags || '').toLowerCase().indexOf(q) !== -1;
        });
      }
    }

    // Tag cloud filter
    if (this.tagEditorTagSelection.length > 0) {
      var sel = this.tagEditorTagSelection;
      if (this.tagEditorTagLogic === 'AND') {
        images = images.filter(function(img) {
          var tags = (img.tags || '').toLowerCase();
          return sel.every(function(s) {
            var sl = s.toLowerCase();
            var parts = tags.split(',').map(function(t) { return t.trim().toLowerCase(); });
            return parts.indexOf(sl) !== -1;
          });
        });
      } else {
        images = images.filter(function(img) {
          var tags = (img.tags || '').toLowerCase();
          return sel.some(function(s) {
            var sl = s.toLowerCase();
            var parts = tags.split(',').map(function(t) { return t.trim().toLowerCase(); });
            return parts.indexOf(sl) !== -1;
          });
        });
      }
    }

    // Excluded tags
    if (this.tagEditorExcludedTags.length > 0) {
      var exc = this.tagEditorExcludedTags;
      images = images.filter(function(img) {
        var tags = (img.tags || '').toLowerCase();
        return !exc.some(function(s) {
          var sl = s.toLowerCase();
          var parts = tags.split(',').map(function(t) { return t.trim().toLowerCase(); });
          return parts.indexOf(sl) !== -1;
        });
      });
    }

    // Sort
    var sortBy = this.tagEditorSortBy;
    var asc = this.tagEditorSortAsc;
    images.sort(function(a, b) {
      if (sortBy === 'tagCount') {
        var ca = a.tags ? a.tags.split(',').filter(function(t) { return t.trim(); }).length : 0;
        var cb = b.tags ? b.tags.split(',').filter(function(t) { return t.trim(); }).length : 0;
        return asc ? ca - cb : cb - ca;
      } else if (sortBy === 'modified') {
        var ma = a.tags !== this.tagEditorOriginal[a.path] ? 1 : 0;
        var mb = b.tags !== this.tagEditorOriginal[b.path] ? 1 : 0;
        return asc ? ma - mb : mb - ma;
      }
      return asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    }.bind(this));

    this._teFilteredCacheKey = cacheKey;
    this._teCachedFiltered = images;
    return images;
  },

  tagEditorGetPaged() {
    var filtered = this.tagEditorGetFiltered();
    var start = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    return filtered.slice(start, start + this.tagEditorPageSize);
  },

  tagEditorTotalPages() {
    return Math.max(1, Math.ceil(this.tagEditorGetFiltered().length / this.tagEditorPageSize));
  },

  tagEditorGetPageNumbers() {
    var total = this.tagEditorTotalPages();
    var current = this.tagEditorPage;
    var pages = [];
    if (total <= 7) {
      for (var i = 1; i <= total; i++) pages.push(i);
    } else {
      pages.push(1);
      if (current > 3) pages.push('...');
      var start = Math.max(2, current - 1);
      var end = Math.min(total - 1, current + 1);
      for (var i2 = start; i2 <= end; i2++) pages.push(i2);
      if (current < total - 2) pages.push('...');
      pages.push(total);
    }
    return pages;
  },

  tagEditorGetQuickCount(type) {
    if (type === 'notag') {
      return this.tagEditorImages.filter(function(img) { return !img.tags || img.tags.trim() === ''; }).length;
    }
    if (type === 'modified') {
      var orig = this.tagEditorOriginal;
      return this.tagEditorImages.filter(function(img) { return img.tags !== orig[img.path]; }).length;
    }
    return 0;
  },

  // ===== Tag Cloud =====
  tagEditorGetFilteredTagFreq() {
    var cacheKey = this.tagEditorTagSearch + '|' + this.tagEditorTagSortBy + '|' + this.tagEditorTagSortAsc +
      '|' + this.tagEditorTagSelection.join(',') + '|' + this.tagEditorExcludedTags.join(',');
    if (cacheKey === this._teFreqCacheKey && this._teCachedFreqResult) return this._teCachedFreqResult;

    var freq = this.tagEditorTagFreq.slice();
    if (this.tagEditorTagSearch) {
      var q = this.tagEditorTagSearch.toLowerCase();
      freq = freq.filter(function(item) { return item.tag.toLowerCase().indexOf(q) !== -1; });
    }
    var sortBy = this.tagEditorTagSortBy;
    var asc = this.tagEditorTagSortAsc;
    freq.sort(function(a, b) {
      if (sortBy === 'alpha') return asc ? a.tag.localeCompare(b.tag) : b.tag.localeCompare(a.tag);
      if (sortBy === 'length') return asc ? a.tag.length - b.tag.length : b.tag.length - a.tag.length;
      return asc ? a.count - b.count : b.count - a.count;
    });

    this._teFreqCacheKey = cacheKey;
    this._teCachedFreqResult = freq;
    return freq;
  },

  tagEditorGetDisplayFreq() {
    var freq = this.tagEditorGetFilteredTagFreq();
    var limit = this.tagEditorTagCloudExpanded ? 1200 : this.tagEditorTagCloudLimit;
    return freq.slice(0, limit);
  },

  tagEditorSelectTag(tag) {
    var idx = this.tagEditorTagSelection.indexOf(tag);
    if (idx === -1) {
      this.tagEditorTagSelection.push(tag);
    } else {
      this.tagEditorTagSelection.splice(idx, 1);
    }
    this._teFilteredCacheKey = '';
    this.tagEditorPage = 1;
  },

  tagEditorExcludeTag(tag) {
    var idx = this.tagEditorExcludedTags.indexOf(tag);
    if (idx === -1) {
      this.tagEditorExcludedTags.push(tag);
    } else {
      this.tagEditorExcludedTags.splice(idx, 1);
    }
    this._teFilteredCacheKey = '';
    this.tagEditorPage = 1;
  },

  tagEditorTagCtx(e, tag) {
    this.tagEditorContextMenu = { x: e.clientX, y: e.clientY, tag: tag };
  },

  tagEditorCtxInclude() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag && this.tagEditorTagSelection.indexOf(tag) === -1) {
      this.tagEditorTagSelection.push(tag);
      this._teFilteredCacheKey = '';
      this.tagEditorPage = 1;
    }
    this.tagEditorContextMenu = null;
  },

  tagEditorCtxExclude() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag && this.tagEditorExcludedTags.indexOf(tag) === -1) {
      this.tagEditorExcludedTags.push(tag);
      this._teFilteredCacheKey = '';
      this.tagEditorPage = 1;
    }
    this.tagEditorContextMenu = null;
  },

  tagEditorCtxCopy() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag) {
      navigator.clipboard.writeText(tag).catch(function() {});
      this.toast(this.t('tagEditor.singleTagCopied').replace('{tag}', tag));
    }
    this.tagEditorContextMenu = null;
  },

  tagEditorCtxAddAll() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag) {
      var self = this;
      this.tagEditorImages.forEach(function(img) {
        var tags = (img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
        if (tags.indexOf(tag) === -1) {
          tags.push(tag);
          self._teUpdateImageTags(img, tags.join(', '));
        }
      });
    }
    this.tagEditorContextMenu = null;
  },

  // ===== Card Interactions =====
  tagEditorCardClick(img, idx, e) {
    var filtered = this.tagEditorGetFiltered();
    var pageStart = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    var globalIdx = pageStart + idx;

    if (e.shiftKey && this._teLastSelected) {
      var lastIdx = this._teLastSelected;
      var start2 = Math.min(lastIdx, globalIdx);
      var end2 = Math.max(lastIdx, globalIdx);
      this.tagEditorSelected = [];
      for (var i = start2; i <= end2; i++) {
        if (filtered[i]) this.tagEditorSelected.push(filtered[i].path);
      }
    } else {
      this.tagEditorToggleSelect(img.path, null);
    }
    this._teLastSelected = globalIdx;
    this._updateRightPanel();
  },

  tagEditorCardDblClick(img, idx, e) {
    // Focus right panel on double click
    this.tagEditorRightCollapsed = false;
  },

  tagEditorCardCtx(img, e) {
    this.tagEditorContextMenu = { x: e.clientX, y: e.clientY, img: img };
  },

  tagEditorToggleSelect(path, e) {
    var idx = this.tagEditorSelected.indexOf(path);
    if (idx === -1) {
      if (e && e.shiftKey && this._teLastSelected) {
        // handled in cardClick
      } else {
        this.tagEditorSelected.push(path);
      }
    } else {
      this.tagEditorSelected.splice(idx, 1);
    }
    this._updateRightPanel();
  },

  tagEditorSelectAll() {
    var filtered = this.tagEditorGetFiltered();
    var pageStart = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    var pageEnd = Math.min(filtered.length, pageStart + this.tagEditorPageSize);
    this.tagEditorSelected = [];
    for (var i = pageStart; i < pageEnd; i++) {
      this.tagEditorSelected.push(filtered[i].path);
    }
    this._updateRightPanel();
  },

  tagEditorSelectInvert() {
    var selected = this.tagEditorSelected;
    this.tagEditorSelectAll();
    var allCurrent = this.tagEditorSelected.slice();
    this.tagEditorSelected = allCurrent.filter(function(p) { return selected.indexOf(p) === -1; });
    this._updateRightPanel();
  },

  _updateRightPanel() {
    if (this.tagEditorSelected.length === 0) {
      // Collapse right panel when nothing selected
    } else if (this.tagEditorSelected.length === 1) {
      this.tagEditorRightCollapsed = false;
      var img = this.tagEditorGetSelectedImg();
      if (img) {
        this.tagEditorDetailText = img.tags || '';
        this.tagEditorDetailView = 'chip';
      }
    } else {
      this.tagEditorRightCollapsed = false;
    }
  },

  tagEditorGetSelectedImg() {
    if (this.tagEditorSelected.length < 1) return null;
    var path = this.tagEditorSelected[0];
    for (var i = 0; i < this.tagEditorImages.length; i++) {
      if (this.tagEditorImages[i].path === path) return this.tagEditorImages[i];
    }
    return null;
  },

  tagEditorGetSelectedTags() {
    var img = this.tagEditorGetSelectedImg();
    if (!img || !img.tags) return [];
    return img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
  },

  // ===== Drag Selection =====
  tagEditorGridMouseDown(e) {
    if (e.target.closest('.te-v3-card')) return;
    if (e.target.closest('.te-v3-card-check')) return;
    this.tagEditorDragSelect = true;
    this.tagEditorDragStart = { x: e.clientX, y: e.clientY };
    this.tagEditorDragRect = null;
  },

  tagEditorGridMouseMove(e) {
    if (!this.tagEditorDragSelect || !this.tagEditorDragStart) return;
    var x1 = this.tagEditorDragStart.x, y1 = this.tagEditorDragStart.y;
    var x2 = e.clientX, y2 = e.clientY;
    this.tagEditorDragRect = {
      left: Math.min(x1, x2), top: Math.min(y1, y2),
      width: Math.abs(x2 - x1), height: Math.abs(y2 - y1)
    };
  },

  tagEditorGridMouseUp(e) {
    if (!this.tagEditorDragSelect) return;
    this.tagEditorDragSelect = false;
    this.tagEditorDragStart = null;
    // Check which cards intersect the drag rect
    if (this.tagEditorDragRect) {
      var rect = this.tagEditorDragRect;
      var self = this;
      document.querySelectorAll('.te-v3-card').forEach(function(card) {
        var cr = card.getBoundingClientRect();
        var ix = rect.left < cr.right && rect.left + rect.width > cr.left &&
          rect.top < cr.bottom && rect.top + rect.height > cr.top;
        if (ix) {
          var path = card.getAttribute('data-path') || '';
          if (path && self.tagEditorSelected.indexOf(path) === -1) {
            self.tagEditorSelected.push(path);
          }
        }
      });
      this._updateRightPanel();
    }
    this.tagEditorDragRect = null;
  },

  // ===== Single Image Editor =====
  tagEditorAddTagToSelected() {
    var val = this.tagEditorAddInput.trim();
    if (!val || this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var newTags = val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    var existing = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var added = [];
    var self = this;
    newTags.forEach(function(t) {
      if (existing.indexOf(t) === -1) { existing.push(t); added.push(t); }
    });
    if (added.length > 0) {
      this._tePushHistory();
      self._teUpdateImageTags(img, existing.join(', '));
    }
    this.tagEditorAddInput = '';
    this.tagEditorSuggestions = [];
  },

  tagEditorRemoveTagFromSelected(tag) {
    if (this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var idx = tags.indexOf(tag);
    if (idx !== -1) {
      this._tePushHistory();
      tags.splice(idx, 1);
      this._teUpdateImageTags(img, tags.join(', '));
    }
  },

  tagEditorSortSelectedTags() {
    if (this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    if (tags.length <= 1) return;
    this._tePushHistory();
    tags.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    this._teUpdateImageTags(img, tags.join(', '));
  },

  tagEditorDetailDragStart(e, idx) {
    this.tagEditorDetailDragSrcIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    var el = e.target.closest('.te-v3-right-tag');
    if (el) { setTimeout(function() { el.style.opacity = '0.4'; }, 0); }
  },

  tagEditorDetailDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  },

  tagEditorDetailDrop(e) {
    e.preventDefault();
    var srcIdx = this.tagEditorDetailDragSrcIdx;
    if (srcIdx < 0) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    if (srcIdx >= tags.length) { this.tagEditorDetailDragSrcIdx = -1; return; }
    var moving = tags.splice(srcIdx, 1)[0];
    // Find drop position: insert before the closest tag element
    var dropTarget = e.target.closest('.te-v3-right-tag');
    var destIdx = tags.length;
    if (dropTarget) {
      var tagText = dropTarget.querySelector('span')?.textContent?.trim();
      var foundIdx = tags.indexOf(tagText);
      if (foundIdx !== -1) destIdx = foundIdx;
    }
    this._tePushHistory();
    tags.splice(destIdx, 0, moving);
    this._teUpdateImageTags(img, tags.join(', '));
    this.tagEditorDetailDragSrcIdx = -1;
    this.tagEditorDetailDragOverIdx = -1;
  },

  tagEditorDetailEditTag(ti) {
    // Double-click to edit: switch to text view for advanced editing
    this.tagEditorDetailView = 'text';
  },

  tagEditorDetailTextChange() {
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var self = this;
    var path = img.path;
    if (this._tePendingTextEdits[path]) clearTimeout(this._tePendingTextEdits[path]);
    this._tePendingTextEdits[path] = setTimeout(function() {
      self._tePushHistory();
      self._teUpdateImageTags(img, self.tagEditorDetailText);
      delete self._tePendingTextEdits[path];
    }, 500);
  },

  tagEditorCopySelectedTags() {
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    this.tagEditorCopiedTags = tags.slice();
    this.toast(this.t('tagEditor.tagsCopied').replace('{n}', tags.length));
  },

  tagEditorPasteTagsToSelected() {
    if (this.tagEditorCopiedTags.length === 0) return;
    if (this.tagEditorSelected.length !== 1) {
      this.toast(this.t('tagEditor.selectOneImage'), 'warning');
      return;
    }
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var existing = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var added = [];
    var self = this;
    this.tagEditorCopiedTags.forEach(function(t) {
      if (existing.indexOf(t) === -1) { existing.push(t); added.push(t); }
    });
    if (added.length > 0) {
      this._tePushHistory();
      self._teUpdateImageTags(img, existing.join(', '));
      this.toast(this.t('tagEditor.tagsPasted').replace('{n}', added.length));
    }
  },

  tagEditorNavDetail(dir) {
    if (this.tagEditorSelected.length !== 1) return;
    var filtered = this.tagEditorGetFiltered();
    var currentPath = this.tagEditorSelected[0];
    var currentIdx = -1;
    for (var i = 0; i < filtered.length; i++) {
      if (filtered[i].path === currentPath) { currentIdx = i; break; }
    }
    var newIdx = currentIdx + dir;
    if (newIdx >= 0 && newIdx < filtered.length) {
      this.tagEditorSelected = [filtered[newIdx].path];
      this._updateRightPanel();
      this.tagEditorPage = Math.floor(newIdx / this.tagEditorPageSize) + 1;
    }
  },

  tagEditorCanNavDetail(dir) {
    if (this.tagEditorSelected.length !== 1) return false;
    var filtered = this.tagEditorGetFiltered();
    var currentPath = this.tagEditorSelected[0];
    var currentIdx = -1;
    for (var i = 0; i < filtered.length; i++) {
      if (filtered[i].path === currentPath) { currentIdx = i; break; }
    }
    var newIdx = currentIdx + dir;
    return newIdx >= 0 && newIdx < filtered.length;
  },

  // ===== Autocomplete =====
  tagEditorGetSuggestions(val) {
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    if (this._teBlurTimer) { clearTimeout(this._teBlurTimer); this._teBlurTimer = null; }
    var v = (val || this.tagEditorAddInput || '').trim();
    if (!v) { this.tagEditorSuggestions = []; return; }
    var self = this;
    this._teSuggestTimer = setTimeout(function() {
      var parts = v.split(',');
      var last = parts[parts.length - 1].trim().toLowerCase();
      if (!last) { self.tagEditorSuggestions = []; return; }
      self.tagEditorSuggestions = self.tagEditorTagFreq
        .filter(function(item) { return item.tag.toLowerCase().indexOf(last) !== -1; })
        .slice(0, 8)
        .map(function(item) { return item.tag; });
    }, 50);
  },

  tagEditorBlurSuggest() {
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    var self = this;
    this._teBlurTimer = setTimeout(function() {
      self.tagEditorSuggestions = [];
    }, 200);
  },

  tagEditorSelectSuggestion(s) {
    var parts = (this.tagEditorAddInput || '').split(',');
    parts.pop();
    parts.push(' ' + s);
    this.tagEditorAddInput = parts.join(',') + ', ';
    this.tagEditorSuggestions = [];
    this.tagEditorGetSuggestions(this.tagEditorAddInput);
  },

  // ===== Batch Operations =====
  tagEditorBatchSuggest(field) {
    if (this._teBatchSuggestTimer) { clearTimeout(this._teBatchSuggestTimer); this._teBatchSuggestTimer = null; }
    if (this._teBatchBlurTimer) { clearTimeout(this._teBatchBlurTimer); this._teBatchBlurTimer = null; }
    var val = '';
    if (field === 'add') val = this.batchAddInput;
    else if (field === 'remove') val = this.batchRemoveInput;
    else if (field === 'old') val = this.batchOldTag;
    if (!val || !val.trim()) { this.batchSuggestOpen = null; this.batchSuggestItems = []; return; }
    var self = this;
    var v = val.trim().toLowerCase();
    this._teBatchSuggestTimer = setTimeout(function() {
      self.batchSuggestItems = self.tagEditorTagFreq
        .filter(function(item) { return item.tag.toLowerCase().indexOf(v) !== -1; })
        .slice(0, 6)
        .map(function(item) { return item.tag; });
      self.batchSuggestOpen = field;
    }, 50);
  },

  tagEditorBatchBlur() {
    if (this._teBatchSuggestTimer) { clearTimeout(this._teBatchSuggestTimer); this._teBatchSuggestTimer = null; }
    var self = this;
    this._teBatchBlurTimer = setTimeout(function() {
      self.batchSuggestOpen = null;
    }, 200);
  },

  tagEditorBatchSelectSuggestion(s) {
    var field = this.batchSuggestOpen;
    if (field === 'add') this.batchAddInput = s;
    else if (field === 'remove') this.batchRemoveInput = s;
    else if (field === 'old') this.batchOldTag = s;
    this.batchSuggestOpen = null;
    this.batchSuggestItems = [];
  },

  tagEditorGetBatchTargets() {
    if (this.tagEditorBatchScope === 'all') return this.tagEditorImages;
    if (this.tagEditorBatchScope === 'selected') {
      var sel = this.tagEditorSelected;
      return this.tagEditorImages.filter(function(img) { return sel.indexOf(img.path) !== -1; });
    }
    return this.tagEditorGetFiltered();
  },

  tagEditorBatchAdd() {
    var val = this.batchAddInput.trim();
    if (!val) return;
    var newTags = val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    if (newTags.length === 0) return;
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
    targets.forEach(function(img) {
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      var changed = false;
      newTags.forEach(function(t) {
        if (tags.indexOf(t) === -1) {
          if (self.batchPos === 'front') tags.unshift(t);
          else tags.push(t);
          changed = true;
        }
      });
      if (changed) self._teUpdateImageTags(img, tags.join(', '));
    });
    this.batchAddInput = '';
    this.toast(this.t('tagEditor.batchDone'));
  },

  tagEditorBatchRemove() {
    var val = this.batchRemoveInput.trim();
    if (!val) return;
    var rmTags = val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    if (rmTags.length === 0) return;
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
    targets.forEach(function(img) {
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      var before = tags.length;
      tags = tags.filter(function(t) { return rmTags.indexOf(t) === -1; });
      if (tags.length !== before) self._teUpdateImageTags(img, tags.join(', '));
    });
    this.batchRemoveInput = '';
    this.toast(this.t('tagEditor.batchDone'));
  },

  tagEditorBatchReplace() {
    var oldTag = this.batchOldTag.trim();
    var newTag = this.batchNewTag.trim();
    if (!oldTag || !newTag) return;
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
    targets.forEach(function(img) {
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      var idx = tags.indexOf(oldTag);
      if (idx !== -1) {
        tags[idx] = newTag;
        self._teUpdateImageTags(img, self._teDedupTags(tags).join(', '));
      }
    });
    this.batchOldTag = ''; this.batchNewTag = '';
    this.toast(this.t('tagEditor.batchDone'));
  },

  tagEditorBatchDedup() {
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
    targets.forEach(function(img) {
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      var deduped = self._teDedupTags(tags);
      if (deduped.length !== tags.length) self._teUpdateImageTags(img, deduped.join(', '));
    });
    this.toast(this.t('tagEditor.batchDone'));
  },

  tagEditorBatchSort() {
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
    targets.forEach(function(img) {
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      if (tags.length <= 1) return;
      var sorted = tags.slice().sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
      if (sorted.join(',') !== tags.join(',')) self._teUpdateImageTags(img, sorted.join(', '));
    });
    this.toast(this.t('tagEditor.batchDone'));
  },

  tagEditorBatchRemoveTag(tag) {
    this.batchRemoveInput = tag;
    this.tagEditorBatchRemove();
  },

  tagEditorGetSelectedStats() {
    if (this.tagEditorSelected.length < 2) return [];
    var counter = {};
    var sel = this.tagEditorSelected;
    var self = this;
    this.tagEditorImages.forEach(function(img) {
      if (sel.indexOf(img.path) === -1) return;
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      tags.forEach(function(t) {
        counter[t] = (counter[t] || 0) + 1;
      });
    });
    return Object.keys(counter).map(function(k) { return { tag: k, count: counter[k] }; })
      .sort(function(a, b) { return b.count - a.count; });
  },

  _teDedupTags(tags) {
    var seen = {};
    return tags.filter(function(t) {
      var lower = t.trim().toLowerCase();
      if (seen[lower]) return false;
      seen[lower] = true;
      return true;
    });
  },

  // ===== Undo/Redo =====
  _tePushHistory() {
    // Remove any redo entries after current position
    if (this.tagEditorHistoryIdx < this.tagEditorHistory.length - 1) {
      this.tagEditorHistory = this.tagEditorHistory.slice(0, this.tagEditorHistoryIdx + 1);
    }
    // Capture current state as a snapshot of all modified images
    var snapshot = {};
    var orig = this.tagEditorOriginal;
    var self = this;
    this.tagEditorImages.forEach(function(img) {
      if (img.tags !== orig[img.path]) {
        snapshot[img.path] = { old: orig[img.path], new: img.tags };
      }
    });
    if (Object.keys(snapshot).length === 0) return; // nothing to undo
    this.tagEditorHistory.push(snapshot);
    if (this.tagEditorHistory.length > 200) this.tagEditorHistory.shift();
    this.tagEditorHistoryIdx = this.tagEditorHistory.length - 1;
  },

  tagEditorUndo() {
    if (this.tagEditorHistoryIdx < 0) return;
    var snapshot = this.tagEditorHistory[this.tagEditorHistoryIdx];
    this.tagEditorHistoryIdx--;
    this._teApplySnapshot(snapshot);
  },

  tagEditorRedo() {
    if (this.tagEditorHistoryIdx >= this.tagEditorHistory.length - 1) return;
    this.tagEditorHistoryIdx++;
    var snapshot = this.tagEditorHistory[this.tagEditorHistoryIdx];
    this._teApplySnapshot(snapshot);
  },

  _teApplySnapshot(snapshot) {
    var self = this;
    var hasAnyMod = false;
    this.tagEditorImages.forEach(function(img) {
      if (snapshot.hasOwnProperty(img.path)) {
        var s = snapshot[img.path];
        img.tags = s.old;
        self.tagEditorOriginal[img.path] = s.old;
        hasAnyMod = true;
      } else {
        img.tags = self.tagEditorOriginal[img.path];
      }
    });
    this.tagEditorModified = hasAnyMod;
    this._teFilteredCacheKey = '';
    this._teFreqCacheKey = '';
    this._updateRightPanel();
  },

  // ===== Core Edit Helper =====
  _teUpdateImageTags(img, newTagsStr) {
    var oldTags = img.tags || '';
    img.tags = newTagsStr;
    this.tagEditorModified = this.tagEditorImages.some(function(i) {
      return i.tags !== this.tagEditorOriginal[i.path];
    }.bind(this));
    this._teFilteredCacheKey = '';
    this.tagEditorDetailText = newTagsStr;

    // Incremental frequency update
    var oldList = oldTags ? oldTags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var newList = newTagsStr ? newTagsStr.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var removed = oldList.filter(function(t) { return newList.indexOf(t) === -1; });
    var added = newList.filter(function(t) { return oldList.indexOf(t) === -1; });
    if (removed.length > 0 || added.length > 0) {
      var self = this;
      removed.forEach(function(t) {
        var item = self.tagEditorTagFreq.find(function(f) { return f.tag === t; });
        if (item && item.count > 0) item.count--;
      });
      added.forEach(function(t) {
        var item = self.tagEditorTagFreq.find(function(f) { return f.tag === t; });
        if (item) { item.count++; } else { self.tagEditorTagFreq.push({ tag: t, count: 1 }); }
      });
      this._teFreqCacheKey = '';
      this.tagEditorMaxFreq = Math.max.apply(null, this.tagEditorTagFreq.map(function(f) { return f.count; }));
    }
  },

  tagEditorModifiedCount() {
    var orig = this.tagEditorOriginal;
    return this.tagEditorImages.filter(function(img) { return img.tags !== orig[img.path]; }).length;
  },

  // ===== Save =====
  async tagEditorSaveAll() {
    var modified = this.tagEditorImages.filter(function(img) {
      return img.tags !== this.tagEditorOriginal[img.path];
    }.bind(this));
    if (modified.length === 0) { this.toast(this.t('tagEditor.batchNoChanges')); return; }
    this.tagEditorConfirmMsg = this.t('tagEditor.batchConfirmAll').replace('{n}', modified.length);
    var self = this;
    this.tagEditorConfirmCb = function() { self._doSaveAll(modified); };
    this.tagEditorConfirmOpen = true;
  },

  async _doSaveAll(modified) {
    this.tagEditorSaving = true;
    try {
      var payload = modified.map(function(img) {
        return { path: img.path, tags: img.tags };
      });
      var r = await fetch('/api/tageditor/save-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: payload })
      });
      var j = await r.json();
      if (j.status === 'success') {
        var orig = this.tagEditorOriginal;
        modified.forEach(function(img) { orig[img.path] = img.tags; });
        this.tagEditorModified = false;
        this.tagEditorHistory = [];
        this.tagEditorHistoryIdx = -1;
        this.tagEditorSaving = false;
        this.toast(this.t('common.saved'));
        this._teRemoveDraft();
      } else {
        this.tagEditorSaving = false;
        this.toast(j.message || this.t('common.error'), 'error');
      }
    } catch (e) {
      this.tagEditorSaving = false;
      this.toast(this.t('common.networkError'), 'error');
    }
  },

  // ===== Auto-save Draft =====
  _teStartAutoSave() {
    this._teStopAutoSave();
    var self = this;
    this._teAutoSaveInterval = setInterval(function() {
      self._teSaveDraft();
    }, 30000);
  },

  _teStopAutoSave() {
    if (this._teAutoSaveInterval) { clearInterval(this._teAutoSaveInterval); this._teAutoSaveInterval = null; }
  },

  _teSaveDraft() {
    if (!this.tagEditorModified) return;
    try {
      var key = 'tagEditor_draft_' + this.tagEditorDir;
      var data = this.tagEditorImages.map(function(img) {
        return { path: img.path, tags: img.tags, original: this.tagEditorOriginal[img.path] };
      }.bind(this));
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) { /* quota exceeded, ignore */ }
  },

  _teCheckDraft() {
    try {
      var key = 'tagEditor_draft_' + this.tagEditorDir;
      var raw = localStorage.getItem(key);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && data.length > 0) {
          var self = this;
          this.tagEditorConfirmMsg = this.t('tagEditor.draftFound');
          this.tagEditorConfirmCb = function() {
            data.forEach(function(item) {
              var img = self.tagEditorImages.find(function(i) { return i.path === item.path; });
              if (img) { img.tags = item.tags; self.tagEditorOriginal[img.path] = item.original; }
            });
            self.tagEditorModified = true;
            self._teFilteredCacheKey = '';
            self.toast(self.t('tagEditor.autoSaveRestored'));
          };
          this.tagEditorConfirmOpen = true;
        }
      }
    } catch (e) { /* ignore */ }
  },

  _teRemoveDraft() {
    try {
      var key = 'tagEditor_draft_' + this.tagEditorDir;
      localStorage.removeItem(key);
    } catch (e) { /* ignore */ }
  },

  // ===== Navigation Guard =====
  _teConfirmNav(route) {
    if (this.currentRoute !== 'tagEditor') return true;
    if (!this.tagEditorModified) return true;
    return window.confirm(this.t('tagEditor.unsavedConfirm'));
  },

  // ===== Keyboard Shortcuts =====
  tagEditorHandleKeydown(e) {
    // Ctrl+S: Save
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      this.tagEditorSaveAll();
      return;
    }
    // Ctrl+Z: Undo
    if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      this.tagEditorUndo();
      return;
    }
    // Ctrl+Shift+Z: Redo
    if (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      this.tagEditorRedo();
      return;
    }
    // Ctrl+A: Select All
    if (e.ctrlKey && e.key === 'a') {
      var target = e.target;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      this.tagEditorSelectAll();
      return;
    }
    // Ctrl+C: Copy tags
    if (e.ctrlKey && e.key === 'c') {
      var target2 = e.target;
      if (target2.tagName === 'INPUT' || target2.tagName === 'TEXTAREA') return;
      if (this.tagEditorSelected.length === 1) {
        e.preventDefault();
        this.tagEditorCopySelectedTags();
      }
      return;
    }
    // Ctrl+V: Paste tags
    if (e.ctrlKey && e.key === 'v') {
      var target3 = e.target;
      if (target3.tagName === 'INPUT' || target3.tagName === 'TEXTAREA') return;
      if (this.tagEditorSelected.length === 1 && this.tagEditorCopiedTags.length > 0) {
        e.preventDefault();
        this.tagEditorPasteTagsToSelected();
      }
      return;
    }
    // Escape: Clear selection
    if (e.key === 'Escape') {
      var target4 = e.target;
      if (target4.tagName === 'INPUT' || target4.tagName === 'TEXTAREA') {
        target4.blur();
      }
      this.tagEditorSelected = [];
      this.tagEditorRightCollapsed = true;
      return;
    }
    // Arrow keys: Navigate detail
    if (e.key === 'ArrowLeft' && this.tagEditorSelected.length === 1) {
      e.preventDefault();
      this.tagEditorNavDetail(-1);
      return;
    }
    if (e.key === 'ArrowRight' && this.tagEditorSelected.length === 1) {
      e.preventDefault();
      this.tagEditorNavDetail(1);
      return;
    }
    // Ctrl+F: Focus search
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      var searchInput = document.querySelector('.te-v3-top-search input');
      if (searchInput) searchInput.focus();
      return;
    }
  }
};
```

- [ ] **Step 2: 提交**

```bash
git add frontend/js/tag-editor.js
git commit -m "feat: 重写标签编辑器 JS 为三栏布局 v3"
```

---

## Task 6: 更新 i18n 翻译

**Files:**
- Modify: `frontend/i18n/zh-CN.json`（`tagEditor` 段 + `bulkAction` 段）
- Modify: `frontend/i18n/en-US.json`（对应段）

- [ ] **Step 1: 更新 zh-CN.json**

在 `zh-CN.json` 中替换 `tagEditor` 段和 `bulkAction` 段，保留现有 key 不变，增加新三栏布局所需的 key：

```json
"tagEditor": {
  "title": "标签编辑器",
  "subtitle": "编辑图片的标签和标注文本",
  "openEditor": "打开标签编辑器",
  "datasetDir": "数据集目录",
  "datasetDirPlaceholder": "输入数据集目录路径...",
  "loadImages": "加载",
  "noImages": "暂无图片，请先加载数据集目录",
  "imageCount": "张图片",
  "uniqueTags": " 个标签",
  "unsavedChanges": "已修改",
  "noTagImages": "无标签",
  "tagCloud": "标签云",
  "searchTags": "搜索标签...",
  "searchPlaceholder": "搜索文件名或标签...",
  "clearFilters": "清除筛选",
  "showMore": "显示更多...",
  "showLess": "收起",
  "selection": "全部",
  "selectAll": "全选",
  "selectPage": "选当前页",
  "selectNone": "全不选",
  "selectInvert": "反选",
  "selected": "{n} 已选中",
  "noTag": "无标签",
  "modified": "已修改",
  "addPrefix": "前缀",
  "addSuffix": "后缀",
  "findReplace": "替换",
  "deleteTag": "删除",
  "dedup": "去重",
  "sort": "排序",
  "injectTrigger": "触发词",
  "removeTrigger": "移除触发词",
  "clickToDelete": "点击移除标签",
  "addTagPlaceholder": "添加标签...",
  "batchPlaceholder": "值",
  "batchPlaceholder2": "替换为",
  "batchDone": "批量操作完成",
  "batchConfirm": "确认执行",
  "batchConfirmOn": "作用于",
  "scopeAll": "全部",
  "scopeSelected": "已选中",
  "scopeFiltered": "筛选结果",
  "restoreBackup": "还原备份",
  "restoreConfirm": "确定从 .bak 备份还原所有标签文件吗？",
  "restored": "已还原",
  "tokenCount": "Token 数",
  "previewHint": "点击外部或 Esc 关闭",
  "detailHint": "← → 翻页 · Esc 关闭 · 点击标签移除",
  "shortcuts": "Ctrl+S 保存 · Ctrl+Z 撤销",
  "unsavedConfirm": "有未保存的修改，确定要离开吗？",
  "revertConfirm": "确定丢弃所有未保存的修改？此操作不可撤销。",
  "backToGrid": "返回网格",
  "logicAndHint": "筛选同时含所有标签的图片",
  "logicOrHint": "筛选含任意标签的图片",
  "batchErrors": "错误",
  "loadFromTraining": "从训练设置",
  "perPage": "/页",
  "batchPreview": "预览变更",
  "batchPreviewTitle": "批量操作预览",
  "batchPreviewNone": "没有图片会被修改",
  "batchPreviewDiff": "{n} 张图片将被修改",
  "batchPreviewConfirm": "确认应用",
  "batchPreviewBefore": "修改前",
  "batchPreviewAfter": "修改后",
  "copyTags": "复制标签",
  "pasteTags": "粘贴标签",
  "tagsCopied": "已复制 {n} 个标签",
  "tagsPasted": "已粘贴 {n} 个标签",
  "singleTagCopied": "已复制标签: {tag}",
  "autoSave": "自动保存",
  "autoSaveRestored": "已自动恢复未保存的修改",
  "draftSaved": "草稿已保存",
  "draftFound": "检测到未保存的草稿，是否恢复？",
  "regexSearch": "正则",
  "regexSearchPlaceholder": "正则表达式搜索...",
  "viewChip": "Chip",
  "viewText": "Text",
  "viewDetail": "查看详情",
  "clickToSelectHint": "点击选中 · 双击详情 · 右键排除",
  "addTagToSelected": "批量添加标签",
  "removeSelectedTag": "批量移除标签",
  "pendingModifications": "{n} 张修改未保存",
  "historyPanel": "编辑历史",
  "historyUndefined": "没有可撤销的操作",
  "contextInclude": "包含此标签",
  "contextExclude": "排除此标签",
  "contextCopy": "复制标签名",
  "contextAddAll": "添加到所有图片",
  "saving": "保存中...",
  "preview": "预览",
  "noTagsToExport": "没有可导出的标签",
  "copyFailed": "复制失败",
  "batchPreviewMore": "... 还有 {n} 张",
  "replaceTag": "合并标签",
  "batchConfirmAll": "⚠ 警告：此操作将影响全部 {n} 张图片，确定继续吗？",
  "sortFreq": "频",
  "sortAlpha": "名",
  "sortLength": "长",
  "sortName": "名称",
  "sortTagCount": "标签数",
  "batchScope": "范围",
  "batchNoChanges": "没有需要应用的更改",
  "selectOneImage": "点击图片开始编辑",
  "exitEditor": "退出编辑器"
},
"bulkAction": {
  "add": "添加",
  "removeTag": "移除",
  "replace": "替换",
  "dedupe": "去重",
  "dedupeRowHint": "移除每张图片中重复的标签",
  "posFront": "开头",
  "posBack": "结尾"
},
```

- [ ] **Step 2: 更新 en-US.json**

将 `en-US.json` 中的 `tagEditor` 段同步更新（新增 key 提供英文翻译）：

```json
"tagEditor": {
  "title": "Tag Editor",
  "subtitle": "Edit image tags and captions",
  "openEditor": "Open Tag Editor",
  "datasetDir": "Dataset Directory",
  "datasetDirPlaceholder": "Enter dataset directory path...",
  "loadImages": "Load",
  "noImages": "No images yet, load a dataset directory first",
  "imageCount": " images",
  "uniqueTags": " tags",
  "unsavedChanges": "modified",
  "noTagImages": "No Tag",
  "tagCloud": "Tag Cloud",
  "searchTags": "Search tags...",
  "searchPlaceholder": "Search filename or tags...",
  "clearFilters": "Clear Filters",
  "showMore": "Show more...",
  "showLess": "Show less",
  "selection": "All",
  "selectAll": "Select All",
  "selectPage": "Select Page",
  "selectNone": "Deselect All",
  "selectInvert": "Invert",
  "selected": "{n} selected",
  "noTag": "No Tag",
  "modified": "Modified",
  "addPrefix": "Prefix",
  "addSuffix": "Suffix",
  "findReplace": "Replace",
  "deleteTag": "Delete",
  "dedup": "Dedup",
  "sort": "Sort",
  "injectTrigger": "Trigger",
  "removeTrigger": "Remove Trigger",
  "clickToDelete": "Click to remove tag",
  "addTagPlaceholder": "Add tag...",
  "batchPlaceholder": "Value",
  "batchPlaceholder2": "Replace with",
  "batchDone": "Batch operation complete",
  "batchConfirm": "Confirm",
  "batchConfirmOn": "Scope",
  "scopeAll": "All",
  "scopeSelected": "Selected",
  "scopeFiltered": "Filtered",
  "restoreBackup": "Restore Backup",
  "restoreConfirm": "Restore all tag files from .bak backups?",
  "restored": "Restored",
  "tokenCount": "Token Count",
  "previewHint": "Click outside or Esc to close",
  "detailHint": "← → Navigate · Esc Close · Click tag to remove",
  "shortcuts": "Ctrl+S Save · Ctrl+Z Undo",
  "unsavedConfirm": "You have unsaved changes. Leave anyway?",
  "revertConfirm": "Discard all unsaved changes? This cannot be undone.",
  "backToGrid": "Back to Grid",
  "logicAndHint": "Filter images containing ALL selected tags",
  "logicOrHint": "Filter images containing ANY selected tag",
  "batchErrors": "Errors",
  "loadFromTraining": "From Training",
  "perPage": "/page",
  "batchPreview": "Preview Changes",
  "batchPreviewTitle": "Batch Operation Preview",
  "batchPreviewNone": "No images will be modified",
  "batchPreviewDiff": "{n} images will be modified",
  "batchPreviewConfirm": "Confirm Apply",
  "batchPreviewBefore": "Before",
  "batchPreviewAfter": "After",
  "copyTags": "Copy Tags",
  "pasteTags": "Paste Tags",
  "tagsCopied": "Copied {n} tags",
  "tagsPasted": "Pasted {n} tags",
  "singleTagCopied": "Copied tag: {tag}",
  "autoSave": "Auto Save",
  "autoSaveRestored": "Auto-saved changes restored",
  "draftSaved": "Draft saved",
  "draftFound": "Unsaved draft found. Restore?",
  "regexSearch": "Regex",
  "regexSearchPlaceholder": "Regex search...",
  "viewChip": "Chip",
  "viewText": "Text",
  "viewDetail": "View Details",
  "clickToSelectHint": "Click to select · Double-click for detail · Right-click to exclude",
  "addTagToSelected": "Batch add tag",
  "removeSelectedTag": "Batch remove tag",
  "pendingModifications": "{n} images modified",
  "historyPanel": "Edit History",
  "historyUndefined": "No undo history",
  "contextInclude": "Include this tag",
  "contextExclude": "Exclude this tag",
  "contextCopy": "Copy tag name",
  "contextAddAll": "Add to all images",
  "saving": "Saving...",
  "preview": "Preview",
  "noTagsToExport": "No tags to export",
  "copyFailed": "Copy failed",
  "batchPreviewMore": "... and {n} more",
  "replaceTag": "Merge Tag",
  "batchConfirmAll": "⚠ Warning: this will affect all {n} images. Continue?",
  "sortFreq": "Freq",
  "sortAlpha": "Alpha",
  "sortLength": "Len",
  "sortName": "Name",
  "sortTagCount": "Tag Count",
  "batchScope": "Scope",
  "batchNoChanges": "No changes to apply",
  "selectOneImage": "Click an image to start editing",
  "exitEditor": "Exit Editor"
},
```

- [ ] **Step 3: i18n 一致性检查**

```bash
python -c "
import json
zh = json.load(open('frontend/i18n/zh-CN.json', encoding='utf-8'))
en = json.load(open('frontend/i18n/en-US.json', encoding='utf-8'))
def keys(d, p=''): return {f'{p}.{k}' if p else k for k,v in d.items()} | \
    {sk for k,v in d.items() if isinstance(v,dict) for sk in keys(v, f'{p}.{k}' if p else k)}
only_zh = keys(zh)-keys(en); only_en = keys(en)-keys(zh)
print('Only zh:', only_zh or 'none'); print('Only en:', only_en or 'none')
"
```

预期：均为 none

- [ ] **Step 4: 提交**

```bash
git add frontend/i18n/zh-CN.json frontend/i18n/en-US.json
git commit -m "i18n: 更新标签编辑器 v3 翻译 key"
```

---

## Task 7: 验证与集成测试

**Files:** 无新文件，运行验证命令

- [ ] **Step 1: 后端语法检查**

```bash
python -m py_compile backend/tageditor/routes.py
python -m py_compile backend/tageditor/core.py
```

- [ ] **Step 2: CSS 变量检查**

```bash
Select-String -Path 'frontend/css/app.css' -Pattern 'var\(--border-color\)'
Select-String -Path 'frontend/css/app.css' -Pattern 'var\(--radius\)(?!-)'
Select-String -Path 'frontend/css/app.css' -Pattern 'var\(--primary\)(?!-)'
```

预期：全部空

- [ ] **Step 3: i18n 一致性检查**

```bash
python -c "
import json
zh = json.load(open('frontend/i18n/zh-CN.json', encoding='utf-8'))
en = json.load(open('frontend/i18n/en-US.json', encoding='utf-8'))
def keys(d, p=''): return {f'{p}.{k}' if p else k for k,v in d.items()} | \
    {sk for k,v in d.items() if isinstance(v,dict) for sk in keys(v, f'{p}.{k}' if p else k)}
only_zh = keys(zh)-keys(en); only_en = keys(en)-keys(zh)
print('Only zh:', only_zh or 'none'); print('Only en:', only_en or 'none')
"
```

- [ ] **Step 4: JavaScript 语法检查**

```bash
node -e "require('./frontend/js/tag-editor.js'); console.log('OK')"
```

注意：如果 Node.js 不可用，跳过此步。Alpine.js mixin 赋值 `window.tagEditorMixin = {...}` 不需要导入。

- [ ] **Step 5: 启服务验证**

```bash
# 启动后端
venv\Scripts\Activate.ps1; if ($?) { python gui.py }
```

在浏览器中访问 `http://localhost:18888/#tagEditor`，验证：
1. 加载数据集目录后三栏布局正常显示
2. 左侧标签云可正常筛选
3. 中间图片网格可以点击选中，hover 显示标签预览
4. 右侧编辑面板选中单张时显示标签芯片，可添加/删除/拖拽
5. 多选时右侧切为批量操作模式
6. 快捷键 Ctrl+S/Z/A/C/V 正常
7. 保存后修改标记清除
8. 浏览器关闭时 beforeunload 拦截

- [ ] **Step 6: 提交最终验证结果**

```bash
git add .
git commit -m "chore: 三栏布局重设计最终验证通过"
```

---

## 完成检查

实施结束后确认：
- [ ] 后端 B1 路径穿越已修复（与 `/save-all` 一致）
- [ ] 后端 scan_images 性能优化（单次 rglob）
- [ ] 三栏布局在 1080p 下正常工作
- [ ] CSS 未使用非法变量（`--border-color`, `--radius`, `--primary`）
- [ ] i18n 中英 key 完全一致
- [ ] 所有现有功能不降级（筛选、排序、批量、撤销、自动保存）
- [ ] `vendor/sd-scripts/` 无任何修改
