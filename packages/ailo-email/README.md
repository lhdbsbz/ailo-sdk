# @lmcl/ailo-mcp-email

Ailo 邮件通道：IMAP 收信 + SMTP 发信。**自带配置界面**：启动后打开网页填写邮件与 Ailo 连接信息，保存即可生效。

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

配置通过两种方式提供：

1. **网页配置界面**（推荐）：启动后访问 http://127.0.0.1:19803 ，填写并保存后自动生效，配置存储在 `config.json`
2. **环境变量**：通过 `IMAP_HOST` 等注入，优先级高于 config.json，适合容器化部署

## 在 Ailo 中添加

通过 **Ailo 端点管理后台** 配置并添加：

1. 在 Ailo 管理端「端点密钥」创建 API Key
2. 在「端点配置」添加端点：endpoint_id=email，command=npx，args=[@lmcl/ailo-mcp-email]，选择密钥，env 填入 IMAP_HOST、IMAP_USER、IMAP_PASSWORD 等
3. 启用后由 Ailo 自动拉起

## 本地开发

```bash
npm install
npm run build
npm start
# 打开 http://127.0.0.1:19803 填写配置
```
