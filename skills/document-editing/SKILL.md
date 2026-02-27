---
name: document-editing
description: 使用 Python 创建和编辑 Word 文档（.docx）
---

# Word 文档处理

利用 `execute_code` 工具使用 python-docx 处理 Word 文档。

## 创建文档

```python
from docx import Document

doc = Document()
doc.add_heading("项目报告", level=0)
doc.add_paragraph("这是一份自动生成的报告。")
doc.add_heading("第一章 概述", level=1)
doc.add_paragraph("项目于2024年启动...")

# 添加表格
table = doc.add_table(rows=3, cols=3)
table.style = "Table Grid"
headers = table.rows[0].cells
headers[0].text = "项目"
headers[1].text = "状态"
headers[2].text = "进度"

doc.save("report.docx")
```

## 读取文档

```python
from docx import Document

doc = Document("input.docx")
for para in doc.paragraphs:
    if para.text.strip():
        print(f"[{para.style.name}] {para.text}")
```

## 修改文档

```python
from docx import Document

doc = Document("input.docx")
for para in doc.paragraphs:
    if "旧文本" in para.text:
        para.text = para.text.replace("旧文本", "新文本")
doc.save("modified.docx")
```

## 转换为 PDF

需要 LibreOffice：
```bash
soffice --headless --convert-to pdf input.docx
```

## 依赖

```
pip install python-docx
```

## 工作流程

1. 明确用户需求（创建/读取/修改）
2. 用 `execute_code(language="python")` 执行 python-docx 脚本
3. 用 `send_file` 将结果文档发送给用户
