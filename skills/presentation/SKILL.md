---
name: presentation
description: 使用 Python 创建和编辑 PowerPoint 演示文稿
---

# PPT 演示文稿处理

利用 `execute_code` 工具使用 python-pptx 处理 PowerPoint 文件。

## 创建演示文稿

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()

# 标题页
slide = prs.slides.add_slide(prs.slide_layouts[0])
slide.shapes.title.text = "项目汇报"
slide.placeholders[1].text = "2024年度总结"

# 内容页
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "核心成果"
body = slide.placeholders[1]
body.text = "完成了三大目标"
body.text_frame.add_paragraph().text = "1. 用户增长 50%"
body.text_frame.add_paragraph().text = "2. 收入翻倍"
body.text_frame.add_paragraph().text = "3. 技术架构升级"

prs.save("presentation.pptx")
```

## 读取演示文稿

```python
from pptx import Presentation

prs = Presentation("input.pptx")
for i, slide in enumerate(prs.slides, 1):
    print(f"--- Slide {i} ---")
    for shape in slide.shapes:
        if shape.has_text_frame:
            print(shape.text)
```

## 添加图片

```python
from pptx import Presentation
from pptx.util import Inches

prs = Presentation("existing.pptx")
slide = prs.slides.add_slide(prs.slide_layouts[6])  # 空白版式
slide.shapes.add_picture("chart.png", Inches(1), Inches(1), Inches(8), Inches(5))
prs.save("with_image.pptx")
```

## 依赖

```
pip install python-pptx
```

## 工作流程

1. 了解用户对 PPT 的需求（内容大纲、风格）
2. 用 `execute_code(language="python")` 生成 PPT
3. 如需截图预览，用 LibreOffice 转 PDF 再转图片
4. 用 `send_file` 发送最终文件
