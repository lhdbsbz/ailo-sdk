---
name: file-reader
description: 读取和摘要文本类文件（txt, md, json, yaml, csv, log, 代码文件等）
---

# 文本文件读取与摘要

专注于文本类文件的读取和内容摘要。PDF、Office 文档由其他 Skill 处理。

## 支持的文件类型

- 纯文本：`.txt`, `.md`, `.rst`
- 数据：`.json`, `.yaml`, `.yml`, `.toml`, `.csv`, `.tsv`
- 日志：`.log`
- 代码：`.py`, `.js`, `.ts`, `.go`, `.java`, `.c`, `.cpp`, `.rs`, `.rb`, `.php`, `.sh`, `.sql`
- 配置：`.ini`, `.cfg`, `.conf`, `.env`, `.properties`
- Web：`.html`, `.css`, `.xml`, `.svg`

## 工作流程

1. 用 `read_file` 读取文件内容
2. 如果文件很大（>1000 行），先用 `read_file(offset, limit)` 分段读取；单次处理建议控制规模（如单文件不超过数千行），避免内存与超时
3. 根据文件类型和用户需求，提取关键信息或生成摘要
4. 对于代码文件，可以分析结构、找出关键函数和类

## 排除的文件类型

以下文件不由本 Skill 处理：
- PDF → 使用 `pdf-processing` Skill
- Word/Excel/PPT → 使用 `spreadsheet` Skill（Excel）
- 图片、音频、视频 → 使用 `screenshot` 或 `send_file`
- 二进制文件 → 不支持
