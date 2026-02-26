#!/usr/bin/env node
import { runMcpChannel } from "@lmcl/ailo-channel-sdk";
import "dotenv/config";
import { EmailHandler } from "./email-handler.js";
import { createEmailMcpServer } from "./mcp-server.js";

const IMAP_HOST = process.env.IMAP_HOST ?? "";
const IMAP_USER = process.env.IMAP_USER ?? "";
const IMAP_PASSWORD = process.env.IMAP_PASSWORD ?? "";
const IMAP_PORT = parseInt(process.env.IMAP_PORT ?? "993", 10);

if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
  console.error("Missing IMAP_HOST, IMAP_USER or IMAP_PASSWORD");
  process.exit(1);
}

const handler = new EmailHandler({
  imapHost: IMAP_HOST,
  imapPort: IMAP_PORT,
  imapUser: IMAP_USER,
  imapPassword: IMAP_PASSWORD,
  smtpHost: process.env.SMTP_HOST || undefined,
  smtpPort: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined,
  smtpUser: process.env.SMTP_USER || undefined,
  smtpPassword: process.env.SMTP_PASSWORD || undefined,
  tlsRejectUnauthorized: process.env.TLS_REJECT_UNAUTHORIZED !== "false",
});

function emailBuildChannelInstructions(): string {
  return `邮件通道：chat_id 为发件人邮箱地址，用于标识邮件会话流。回复邮件时使用 email 工具（action=send），to 填对方邮箱地址。`;
}

const mcpServer = createEmailMcpServer(handler);

runMcpChannel({
  handler,
  displayName: "邮件",
  defaultRequiresResponse: true,
  buildChannelInstructions: emailBuildChannelInstructions,
  mcpServer,
});
