---
name: spreadsheet
description: 使用 Python 创建、编辑和分析 Excel 电子表格
---

# 电子表格处理

利用 `execute_code` 工具使用 Python 处理 Excel 文件。

## 数据分析

```python
import pandas as pd

df = pd.read_excel("data.xlsx")
print(df.describe())
print(df.head(20))
```

## 创建 Excel

```python
import openpyxl

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "数据"
ws.append(["姓名", "年龄", "城市"])
ws.append(["张三", 28, "北京"])
ws.append(["李四", 32, "上海"])
wb.save("output.xlsx")
```

## 数据筛选与汇总

```python
import pandas as pd

df = pd.read_excel("sales.xlsx")
# 按部门汇总
summary = df.groupby("部门")["销售额"].agg(["sum", "mean", "count"])
summary.to_excel("summary.xlsx")
```

## 图表生成

```python
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_excel("data.xlsx")
df.plot(kind="bar", x="类别", y="数量")
plt.savefig("chart.png", dpi=150, bbox_inches="tight")
```

## 依赖

```
pip install pandas openpyxl matplotlib
```

## 工作流程

1. 用 `read_file` 或 `list_directory` 确认文件位置
2. 用 `execute_code(language="python")` 处理数据
3. 用 `send_file` 将结果发送给用户

大表（行数很多）建议分块读取或采样，避免一次性加载导致超时或内存不足。
