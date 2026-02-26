# @lmcl/ailo-mcp-email

Ailo 邮件通道 MCP：IMAP 收信 + SMTP 发信。


## 配置

| 变量 | 必填 | 说明 |
|------|------|------|
| IMAP_HOST | 是 | IMAP 服务器（如 imap.qq.com） |
| IMAP_USER | 是 | 邮箱账号 |
| IMAP_PASSWORD | 是 | 密码或授权码 |
| IMAP_PORT | 否 | 默认 993 |
| SMTP_HOST | 否 | 不填则从 IMAP 推测（如 smtp.qq.com） |
| SMTP_PORT | 否 | 默认 465 |
| SMTP_USER | 否 | 不填则用 IMAP_USER |
| SMTP_PASSWORD | 否 | 不填则用 IMAP_PASSWORD |
| TLS_REJECT_UNAUTHORIZED | 否 | 默认 true 验证证书；自签名可设为 false |

## 在 Ailo 中添加

通过 **Ailo 端点管理后台** 配置并添加（与 MCP 分离，不走 mcp_manage）：

1. 在 Ailo 管理端「端点密钥」创建 API Key
2. 在「端点配置」添加端点：endpoint_id=email，command=npx，args=[@lmcl/ailo-mcp-email]，选择密钥，env 填入 IMAP_HOST、IMAP_USER、IMAP_PASSWORD 等
3. 启用后由 Ailo 自动拉起

## 本地开发

创建 `.env` 文件，填入配置后启动：

```bash
# .env 示例（必填：IMAP_HOST、IMAP_USER、IMAP_PASSWORD）
IMAP_HOST=imap.qq.com
IMAP_PORT=993
IMAP_USER=your@email.com
IMAP_PASSWORD=your_auth_code
# SMTP_HOST=...
# SMTP_PORT=465
# TLS_REJECT_UNAUTHORIZED=false  # 自签名证书时

npm install
npm run build
npm start
```
