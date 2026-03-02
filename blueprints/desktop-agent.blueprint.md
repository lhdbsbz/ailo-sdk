---
name: desktop-agent
version: 1.2.0
description: 桌面 Agent，提供截图、浏览器自动化、文件系统、命令执行、代码执行、定时任务和本地 MCP 管理能力
tools:
  - name: screenshot
    description: 截取当前桌面屏幕，返回图片供视觉分析。macOS 支持 capture_window 选择窗口截图
    timeout: 15
    parameters:
      type: object
      properties:
        capture_window: { type: boolean, description: "true 时选择窗口截图（仅 macOS）" }

  - name: get_current_time
    description: 获取当前本地时间、星期和时区
    timeout: 5

  - name: read_file
    description: 按行范围读取本地文件内容（带行号）
    timeout: 30
    parameters:
      type: object
      properties:
        path: { type: string, description: "文件路径" }
        offset: { type: number, description: "起始行（1-indexed）" }
        limit: { type: number, description: "读取行数" }
      required: [path]

  - name: write_file
    description: 创建或覆写本地文件，自动创建父目录
    timeout: 30
    parameters:
      type: object
      properties:
        path: { type: string, description: "文件路径" }
        content: { type: string, description: "文件内容" }
      required: [path, content]

  - name: edit_file
    description: 在本地文件中精确替换字符串
    timeout: 30
    parameters:
      type: object
      properties:
        path: { type: string, description: "文件路径" }
        old_string: { type: string, description: "要替换的原始字符串" }
        new_string: { type: string, description: "替换后的字符串" }
        replace_all: { type: boolean, description: "是否全局替换" }
      required: [path, old_string, new_string]

  - name: append_file
    description: 向本地文件追加内容，文件不存在则创建
    timeout: 30
    parameters:
      type: object
      properties:
        path: { type: string, description: "文件路径" }
        content: { type: string, description: "追加内容" }
      required: [path, content]

  - name: list_directory
    description: 列出本地目录内容
    timeout: 15
    parameters:
      type: object
      properties:
        path: { type: string, description: "目录路径" }
      required: [path]

  - name: find_files
    description: 按文件名模式搜索本地文件
    timeout: 30
    parameters:
      type: object
      properties:
        pattern: { type: string, description: "搜索模式（如 *.ts）" }
        directory: { type: string, description: "搜索目录" }
        max_results: { type: number, description: "最大结果数" }
      required: [pattern]

  - name: search_content
    description: 在本地文件中搜索内容（支持正则）
    timeout: 60
    parameters:
      type: object
      properties:
        query: { type: string, description: "搜索内容" }
        directory: { type: string, description: "搜索目录" }
        regex: { type: boolean, description: "是否正则匹配" }
        ignore_case: { type: boolean, description: "是否忽略大小写" }
        context_lines: { type: number, description: "上下文行数" }
      required: [query]

  - name: delete_file
    description: 删除本地文件或目录
    timeout: 15
    parameters:
      type: object
      properties:
        path: { type: string, description: "文件或目录路径" }
        recursive: { type: boolean, description: "是否递归删除目录" }
      required: [path]

  - name: move_file
    description: 移动或重命名本地文件
    timeout: 15
    parameters:
      type: object
      properties:
        source: { type: string, description: "源路径" }
        destination: { type: string, description: "目标路径" }
      required: [source, destination]

  - name: copy_file
    description: 复制本地文件或目录
    timeout: 15
    parameters:
      type: object
      properties:
        source: { type: string, description: "源路径" }
        destination: { type: string, description: "目标路径" }
      required: [source, destination]

  - name: execute_code
    description: 在本地执行 Python 或 JavaScript 代码，用于计算、数据处理、脚本等
    timeout: 120
    parameters:
      type: object
      properties:
        language: { type: string, enum: [python, javascript], description: "编程语言" }
        code: { type: string, description: "要执行的代码" }
        timeout: { type: number, description: "超时毫秒数（默认 60000）" }
      required: [language, code]

  - name: exec
    description: 在本地机器执行 shell 命令（action：run/poll/stop/list/write）
    timeout: 120
    parameters:
      type: object
      properties:
        action: { type: string, enum: [run, poll, stop, list, write], description: "操作类型" }
        command: { type: string, description: "要执行的命令（action=run 时必填）" }
        task_id: { type: string, description: "后台任务 ID（action=poll/stop/write 时需要）" }
        timeout: { type: number, description: "超时秒数（默认 30）" }
        data: { type: string, description: "stdin 输入内容（action=write 时需要）" }
        cwd: { type: string, description: "工作目录（action=run 时可选）" }
      required: [action]

  - name: mcp_manage
    description: 管理本地 MCP 服务（list/create/delete/start/stop）。start 后自动向 Ailo 注册新工具
    timeout: 300
    parameters:
      type: object
      properties:
        action: { type: string, enum: [list, create, delete, start, stop], description: "操作类型" }
        name: { type: string, description: "服务名称" }
        transport: { type: string, enum: [stdio, http], description: "传输方式" }
        command: { type: string, description: "stdio 方式的命令（如 npx、uvx）" }
        args: { type: array, items: { type: string }, description: "命令参数" }
        url: { type: string, description: "http 方式的 SSE 端点地址" }
        env: { type: object, description: "服务所需环境变量" }
      required: [action]

  - name: browser_use
    description: 控制浏览器进行网页浏览、交互和信息提取。流程：start → open(url) → snapshot 获取 refs → click/type 等。支持多标签页
    timeout: 120
    parameters:
      type: object
      properties:
        action: { type: string, enum: [start, stop, open, navigate, navigate_back, snapshot, screenshot, click, type, eval, evaluate, resize, console_messages, handle_dialog, file_upload, fill_form, press_key, network_requests, drag, hover, select_option, tabs, wait_for, pdf, close, install], description: "操作类型" }
        url: { type: string, description: "URL（action=open/navigate 时必填）" }
        page_id: { type: string, description: "页面/标签 ID，默认 default" }
        selector: { type: string, description: "CSS 选择器（优先用 ref）" }
        ref: { type: string, description: "snapshot 输出中的元素引用（如 e1, e2）" }
        text: { type: string, description: "输入文本（action=type）或等待文本（action=wait_for）" }
        code: { type: string, description: "JavaScript 代码（action=eval/evaluate）" }
        path: { type: string, description: "截图保存路径或 PDF 导出路径" }
        headed: { type: boolean, description: "true 时打开可见浏览器窗口（action=start）" }
        full_page: { type: boolean, description: "全页截图（action=screenshot）" }
        submit: { type: boolean, description: "输入后按回车（action=type）" }
        slowly: { type: boolean, description: "逐字符输入（action=type）" }
        wait: { type: number, description: "点击前等待毫秒数（action=click）" }
        double_click: { type: boolean, description: "双击（action=click）" }
        button: { type: string, description: "鼠标按键：left/right/middle" }
        key: { type: string, description: "按键名称，如 Enter, Control+a（action=press_key）" }
        width: { type: number, description: "视口宽度（action=resize）" }
        height: { type: number, description: "视口高度（action=resize）" }
        tab_action: { type: string, enum: [list, new, close, select], description: "标签操作类型（action=tabs）" }
        index: { type: number, description: "标签索引（action=tabs）" }
        wait_time: { type: number, description: "等待秒数（action=wait_for）" }
        text_gone: { type: string, description: "等待此文本消失（action=wait_for）" }
        frame_selector: { type: string, description: "iframe 选择器" }
        fields_json: { type: string, description: "表单字段 JSON（action=fill_form）" }
        paths_json: { type: string, description: "文件路径 JSON 数组（action=file_upload）" }
        modifiers_json: { type: string, description: "修饰键 JSON 数组（action=click）" }
        values_json: { type: string, description: "选项值 JSON（action=select_option）" }
        start_ref: { type: string, description: "拖拽起点 ref（action=drag）" }
        end_ref: { type: string, description: "拖拽终点 ref（action=drag）" }
        filename: { type: string, description: "保存文件名" }
        screenshot_type: { type: string, enum: [png, jpeg], description: "截图格式" }
        level: { type: string, description: "控制台日志级别过滤（action=console_messages）" }
        include_static: { type: boolean, description: "包含静态资源请求（action=network_requests）" }
        accept: { type: boolean, description: "接受对话框（action=handle_dialog）" }
        prompt_text: { type: string, description: "prompt 对话框输入（action=handle_dialog）" }
      required: [action]

  - name: mouse_keyboard
    description: 控制鼠标和键盘进行桌面 GUI 操作。支持像素坐标(x/y)和 UI-TARS 归一化坐标(norm_x/norm_y, 0-1000)。操作后可自动截图验证
    timeout: 10
    parameters:
      type: object
      properties:
        action:
          type: string
          enum: [click, double_click, right_click, move, drag, type, hotkey, scroll, get_screen_size]
          description: "操作类型"
        x: { type: number, description: "X 像素坐标" }
        y: { type: number, description: "Y 像素坐标" }
        norm_x: { type: number, description: "UI-TARS 归一化 X 坐标 (0-1000)" }
        norm_y: { type: number, description: "UI-TARS 归一化 Y 坐标 (0-1000)" }
        button: { type: string, enum: [left, right, middle], description: "鼠标按键（默认 left）" }
        start_x: { type: number, description: "拖拽起点 X 像素" }
        start_y: { type: number, description: "拖拽起点 Y 像素" }
        end_x: { type: number, description: "拖拽终点 X 像素" }
        end_y: { type: number, description: "拖拽终点 Y 像素" }
        start_norm_x: { type: number, description: "拖拽起点归一化 X" }
        start_norm_y: { type: number, description: "拖拽起点归一化 Y" }
        end_norm_x: { type: number, description: "拖拽终点归一化 X" }
        end_norm_y: { type: number, description: "拖拽终点归一化 Y" }
        text: { type: string, description: "输入文本（action=type）" }
        keys: { type: string, description: "快捷键组合，空格分隔（如 ctrl c）" }
        direction: { type: string, enum: [up, down], description: "滚动方向" }
        amount: { type: number, description: "滚动量（默认 3）" }
        screenshot_after: { type: boolean, description: "操作后自动截图（默认 false）" }
      required: [action]

  - name: send_file
    description: 将本地文件发送给当前对话用户
    timeout: 30
    parameters:
      type: object
      properties:
        path: { type: string, description: "本地文件绝对路径" }
      required: [path]
---

桌面 Agent 运行在用户本地机器上，代理 Ailo 云端无法直接执行的本地能力。

调用所有工具时，须通过 `endpointId` 参数指定目标机器（如 `desktop-agent:screenshot(endpointId="macbook-zhangsan")`）。

## 工具说明

### screenshot
截取当前桌面屏幕。截图会以图片形式直接注入 LLM 上下文（通过 tool_response.content 的 image ContentPart）。
macOS 支持 `capture_window=true` 选择窗口截图。

### get_current_time
返回本地时间、星期和时区，如 `2026-03-01 17:30:45 Saturday (UTC+0800)`。

### execute_code
在本地执行 Python 或 JavaScript 代码。写入临时文件后执行，返回 stdout、stderr 和退出码。用于数据计算、脚本自动化等。

### append_file
向文件末尾追加内容。文件不存在时自动创建（含父目录）。

### exec
五种操作：
- `run`：执行命令，超时后转后台运行，返回 taskId
- `poll`：查看后台任务输出（需 taskId）
- `stop`：终止任务
- `list`：列出所有运行中的任务
- `write`：向交互式任务发送 stdin 输入

### mcp_manage
管理本地 MCP 服务。执行 `start` 后，端点会自动重连 Ailo 并注册新发现的工具。
新 MCP 工具命名为 `endpointId:serverName:toolName`。
重连期间约有 1-2 秒工具不可用窗口，属正常现象。

### browser_use
控制 Chromium 浏览器。使用流程：
1. `start`：启动浏览器（默认无头模式，`headed=true` 打开可见窗口）
2. `open(url)`：打开网页，返回 page_id
3. `snapshot`：获取页面 ARIA 树和可交互元素 refs（如 e1, e2）
4. 用 `ref` 进行 `click`、`type`、`hover` 等交互
5. `screenshot`：截取页面图片
6. `stop`：关闭浏览器

支持多标签页（用不同 `page_id`）、iframe（用 `frame_selector`）。
优先使用 `ref` 而非 CSS 选择器，因为 ref 在 snapshot 后是稳定的。

**可见模式**：当用户需要看到浏览器的实际操作过程时，使用 `browser_use(action="start", headed=true)` 启动。桌面上会出现真实 Chromium 窗口，后续 open、click、type 等操作都在该窗口中执行，用户可实时观看。适用场景：演示或观察自动化过程、调试网页交互、需用户介入的半自动（如验证码）。可见模式下 PDF 导出不可用；若浏览器已在无头模式运行，传入 `headed=true` 会重启为可见模式。

### mouse_keyboard
控制桌面鼠标和键盘，用于 GUI 自动化操作。支持两种坐标输入：
- 像素坐标（`x`/`y`）：直接指定屏幕像素位置
- 归一化坐标（`norm_x`/`norm_y`，0-1000）：由 UI-TARS 等视觉模型输出，工具内自动转换为实际像素

典型 GUI 操作流程：
1. `screenshot`：截取当前屏幕
2. `gui_operate(intent="点击确认按钮")`：分析截图，获取精确坐标
3. `mouse_keyboard(action=click, norm_x=197, norm_y=525, screenshot_after=true)`：执行点击并自动截图验证

`screenshot_after=true` 时操作完成后自动截图返回，可省去额外的 screenshot 调用。

### send_file
将本地文件推送给当前对话用户。文件通过主动上行（endpoint.accept）直接发送给用户所在频道。

## 约束
- screenshot 需要操作系统权限（macOS 需屏幕录制权限）
- exec 超时默认 30 秒，最长 300 秒
- send_file 的文件路径必须是绝对路径
- browser_use 需要安装 Playwright 浏览器（首次使用前需执行 `npx playwright install chromium`）
- browser_use 的 pdf 导出仅在无头模式下可用
