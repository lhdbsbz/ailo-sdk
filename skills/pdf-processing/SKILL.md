---
name: pdf-processing
description: 使用桌面工具处理 PDF 文件——合并、拆分、提取文本、转换格式等
---

# PDF 文件处理

利用桌面 Agent 的 `execute_code`（Python）和 `exec` 工具处理 PDF 文件。

## 常用操作

### 提取文本
```python
# 使用 pdfplumber 提取文本
import pdfplumber
with pdfplumber.open("input.pdf") as pdf:
    for page in pdf.pages:
        print(page.extract_text())
```

### 合并 PDF
```python
from pypdf import PdfMerger
merger = PdfMerger()
for f in ["file1.pdf", "file2.pdf"]:
    merger.append(f)
merger.write("merged.pdf")
merger.close()
```

### 拆分 PDF
```python
from pypdf import PdfReader, PdfWriter
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    writer.write(f"page_{i+1}.pdf")
```

### 提取表格
```python
import pdfplumber
with pdfplumber.open("input.pdf") as pdf:
    for page in pdf.pages:
        for table in page.extract_tables():
            for row in table:
                print(row)
```

## 依赖

使用前确保已安装 Python 依赖：
```
pip install pypdf pdfplumber reportlab
```

## 工作流程

1. 用 `read_file` 确认 PDF 文件存在
2. 用 `execute_code(language="python")` 执行处理脚本
3. 处理结果保存为文件后，用 `send_file` 发送给用户

大 PDF（页数很多）建议分段处理或限制单次页数，避免内存压力。
