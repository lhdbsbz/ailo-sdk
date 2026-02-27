---
name: news-summary
description: 从网页抓取最新新闻，生成摘要，支持多种新闻分类
---

# 新闻抓取与摘要

利用 `browser_use` 工具从新闻网站抓取最新资讯。

## 工作流程

1. 用 `browser_use(action="start")` 启动浏览器
2. 用 `browser_use(action="open", url="新闻网站URL")` 打开目标网站
3. 用 `browser_use(action="snapshot")` 获取页面结构
4. 提取新闻标题、摘要和链接
5. 整理为结构化摘要

## 推荐新闻源

| 分类 | 推荐网站 |
|------|---------|
| 综合 | news.qq.com, news.sina.com.cn |
| 科技 | 36kr.com, techcrunch.com |
| 财经 | wallstreetcn.com, finance.sina.com.cn |
| 国际 | bbc.com/news, reuters.com |

## 注意事项

- 使用无头浏览器模式即可，无需可见窗口；若需用户看到抓取过程，可使用 `browser_use(action="start", headed=true)` 启动可见窗口
- 抓取完成后用 `browser_use(action="stop")` 关闭浏览器
- 如果需要翻页，用 snapshot 找到分页元素，用 click 操作
- 注意遵守网站的使用条款
