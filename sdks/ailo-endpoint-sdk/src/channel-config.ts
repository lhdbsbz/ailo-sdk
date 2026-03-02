/**
 * Generic channel config server factory.
 *
 * Provides a web UI + REST API for configuring any channel endpoint:
 *  - Ailo connection fields (common to all channels)
 *  - Platform-specific fields (declared via platformFields)
 *  - Reads/writes config.json, merges with env vars
 *  - Env-overridden fields shown as readonly in the UI
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";
import { readConfig, writeConfig, mergeWithEnv, getNestedValue, setNestedValue } from "./config-io.js";
import { AILO_ENV_MAPPING } from "./connection-util.js";
import type { EnvMapping } from "./config-io.js";

export interface ConfigField {
  key: string;
  label: string;
  envVar?: string;
  type?: "text" | "password" | "number";
  placeholder?: string;
  required?: boolean;
}

export interface ChannelConfigServerOptions {
  channelName: string;
  defaultPort: number;
  configPath?: string;
  platformFields: ConfigField[];
  envMapping?: EnvMapping[];
  getConnectionStatus: () => { connected: boolean; endpointId: string; displayName: string };
  onConfigSaved?: (config: Record<string, unknown>) => Promise<void>;
}

function json(res: ServerResponse, data: unknown): void {
  if (res.headersSent) return;
  let body: string;
  try {
    body = JSON.stringify(data, null, 2);
  } catch {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "序列化响应失败" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const MAX_BODY_SIZE = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_SIZE) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function buildEnvMapping(platformFields: ConfigField[], extra?: EnvMapping[]): EnvMapping[] {
  const mapping = [...AILO_ENV_MAPPING];
  for (const f of platformFields) {
    if (f.envVar) mapping.push({ envVar: f.envVar, configPath: f.key });
  }
  if (extra) mapping.push(...extra);
  return mapping;
}

export function startChannelConfigServer(options: ChannelConfigServerOptions): void {
  const {
    channelName,
    defaultPort,
    platformFields,
    getConnectionStatus,
    onConfigSaved,
  } = options;
  const configPath = options.configPath ?? join(process.cwd(), "config.json");
  const envMapping = buildEnvMapping(platformFields, options.envMapping);

  function loadMergedConfig(): { merged: Record<string, unknown>; envOverrides: Set<string> } {
    const raw = readConfig(configPath);
    return mergeWithEnv(raw, envMapping);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${defaultPort}`);
    const path = (url.pathname || "/").replace(/\/+$/, "") || "/";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildUIHTML(channelName, platformFields));
        return;
      }
      if (path === "/api/status" && req.method === "GET") {
        let status: { connected: boolean; endpointId: string; displayName: string };
        try { status = getConnectionStatus(); } catch {
          status = { connected: false, endpointId: "", displayName: channelName };
        }
        return json(res, status);
      }
      if (path === "/api/config" && req.method === "GET") {
        const { merged, envOverrides } = loadMergedConfig();
        return json(res, { config: merged, envOverrides: Array.from(envOverrides) });
      }
      if (path === "/api/config" && req.method === "POST") {
        try {
          const bodyStr = await readBody(req);
          const incoming = JSON.parse(bodyStr) as Record<string, unknown>;

          const existing = readConfig(configPath);
          const result = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;

          for (const m of envMapping) {
            const val = getNestedValue(incoming as Record<string, unknown>, m.configPath);
            if (val !== undefined) {
              setNestedValue(result, m.configPath, val);
            }
          }

          writeConfig(configPath, result);

          if (onConfigSaved) {
            try {
              const { merged } = mergeWithEnv(result, envMapping);
              await onConfigSaved(merged);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              return json(res, { ok: true, message: `已保存。重连时出错：${msg}` });
            }
          }
          return json(res, { ok: true, message: "已保存，正在使用新配置重连…" });
        } catch (e: unknown) {
          return json(res, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      res.writeHead(404); res.end("Not Found");
    } catch (e: unknown) {
      if (!res.headersSent) {
        try {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        } catch {}
      }
    }
  });

  server.listen(defaultPort, "0.0.0.0", () => {
    console.log(`[${channelName}] 配置界面: http://127.0.0.1:${defaultPort}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") console.log(`[${channelName}] 端口 ${defaultPort} 已被占用，跳过配置界面`);
    else console.error(`[${channelName}] 配置服务启动失败:`, err.message);
  });
}

// ─── UI HTML Generation ─────────────────────────────────────────────────────

function fieldId(key: string): string {
  return key.replace(/\./g, "_");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildFieldHTML(f: ConfigField): string {
  const id = fieldId(f.key);
  const inputType = f.type === "password" ? "password" : f.type === "number" ? "number" : "text";
  const ph = esc(f.placeholder ?? "");
  const envHint = f.envVar ? ` <span class="env-badge" id="env_${id}" style="display:none">由 ${esc(f.envVar)} 设置</span>` : "";
  return `    <div class="form-group"><label>${esc(f.label)}${f.required ? " *" : ""}${envHint}</label><input id="${id}" type="${inputType}" placeholder="${ph}" autocomplete="off"></div>`;
}

function buildUIHTML(channelName: string, platformFields: ConfigField[]): string {
  const platformFormHTML = platformFields.map(f => buildFieldHTML(f)).join("\n");

  const ailoFields: ConfigField[] = [
    { key: "ailo.wsUrl", label: "AILO_WS_URL", envVar: "AILO_WS_URL", placeholder: "ws://127.0.0.1:19800/ws", required: true },
    { key: "ailo.apiKey", label: "AILO_API_KEY", envVar: "AILO_API_KEY", placeholder: "ailo_ep_xxx", required: true },
    { key: "ailo.endpointId", label: "AILO_ENDPOINT_ID", envVar: "AILO_ENDPOINT_ID", placeholder: channelName.toLowerCase() + "-01", required: true },
    { key: "ailo.displayName", label: "DISPLAY_NAME（可选）", envVar: "DISPLAY_NAME", placeholder: channelName },
  ];
  const ailoFormHTML = ailoFields.map(f => buildFieldHTML(f)).join("\n");

  const allFields = [...platformFields, ...ailoFields];
  const fieldKeys = allFields.map(f => `"${f.key}"`).join(",");
  const fieldIds = allFields.map(f => `"${fieldId(f.key)}"`).join(",");

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ailo ${esc(channelName)}通道 - 配置</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;
  background:#1a1d24;color:#d4d6da;min-height:100vh;font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;
}
.container{max-width:640px;margin:0 auto;padding:24px}
h1{font-size:1.35rem;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:10px;color:#e2e4e8}
.subtitle{font-size:14px;color:#9ca3af;margin-bottom:24px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot.on{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.4)}
.dot.off{background:#f87171}
.card{background:#252830;border:1px solid #333842;border-radius:12px;padding:20px;margin-bottom:20px}
.card h2{font-size:1.05rem;margin-bottom:12px;color:#b4b8be;font-weight:600}
.card p.desc{font-size:14px;color:#9ca3af;margin-bottom:14px;line-height:1.5}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:14px;color:#9ca3af;margin-bottom:6px}
input{background:#1a1d24;border:1px solid #333842;color:#e2e4e8;padding:10px 14px;border-radius:8px;font-size:15px;width:100%;transition:border-color .15s}
input:focus{outline:none;border-color:#4b5563}
input[readonly]{opacity:.6;cursor:not-allowed}
.btn{padding:10px 18px;border-radius:8px;border:none;cursor:pointer;font-size:14px;margin-right:8px;margin-top:4px;transition:opacity .15s}
.btn-primary{background:#3b82f6;color:#fff}
.btn-primary:hover{background:#2563eb}
#saveMsg{margin-left:8px;font-size:14px;color:#9ca3af}
.info-row{display:flex;gap:24px;margin-bottom:8px;font-size:15px}
.info-label{color:#9ca3af;min-width:100px}
.info-value{color:#d4d6da}
.env-badge{font-size:12px;color:#fbbf24;background:#3730501a;padding:2px 8px;border-radius:4px;margin-left:6px}
</style>
</head>
<body>
<div class="container">
  <h1><span class="dot off" id="dot"></span> Ailo ${esc(channelName)}通道 <span id="statusText" style="font-size:14px;color:#9ca3af"></span></h1>
  <p class="subtitle">在下方填写配置信息，保存后会自动使用新配置连接，无需重启进程。</p>

  <div class="card">
    <h2>连接状态</h2>
    <div id="statusInfo">加载中...</div>
  </div>

${platformFields.length > 0 ? `  <div class="card">
    <h2>${esc(channelName)}配置</h2>
${platformFormHTML}
  </div>
` : ""}
  <div class="card">
    <h2>Ailo 连接配置</h2>
    <p class="desc">由 Ailo 端点管理下发的连接信息，或本地开发时填写。</p>
${ailoFormHTML}
  </div>

  <div class="card">
    <button class="btn btn-primary" onclick="saveConfig()">保存配置</button>
    <span id="saveMsg"></span>
  </div>
</div>
<script>
var FIELD_KEYS=[${fieldKeys}];
var FIELD_IDS=[${fieldIds}];
function el(id){return document.getElementById(id)}
function esc(s){var t=String(s==null?'':s);var d=document.createElement('div');d.textContent=t;return d.innerHTML}
function showStatus(data){
  var dot=el('dot'),st=el('statusText'),info=el('statusInfo');
  if(!dot||!st||!info)return;
  if(data&&data.connected){dot.className='dot on';st.textContent='已连接';info.innerHTML='<div class="info-row"><span class="info-label">端点 ID</span><span class="info-value">'+esc(data.endpointId)+'</span></div><div class="info-row"><span class="info-label">显示名</span><span class="info-value">'+esc(data.displayName||'-')+'</span></div>'}
  else{dot.className='dot off';st.textContent='未连接';info.innerHTML='<div class="info-row"><span class="info-value">尚未连接 Ailo。请填写下方配置并保存。</span></div>'}
}
function getVal(path,obj){var p=path.split('.');var c=obj;for(var i=0;i<p.length;i++){if(c==null)return '';c=c[p[i]]}return c==null?'':c}
function fillForm(cfg,envOverrides){
  for(var i=0;i<FIELD_KEYS.length;i++){
    var e=el(FIELD_IDS[i]);if(!e)continue;
    e.value=getVal(FIELD_KEYS[i],cfg)||'';
    var badge=el('env_'+FIELD_IDS[i]);
    if(envOverrides.indexOf(FIELD_KEYS[i])>=0){
      e.readOnly=true;e.title='由环境变量设置，不可在此修改';
      if(badge)badge.style.display='inline';
    }else{
      e.readOnly=false;e.title='';
      if(badge)badge.style.display='none';
    }
  }
}
function collectForm(){
  var obj={};
  for(var i=0;i<FIELD_KEYS.length;i++){
    var e=el(FIELD_IDS[i]);if(!e||e.readOnly)continue;
    var p=FIELD_KEYS[i].split('.');var c=obj;
    for(var j=0;j<p.length-1;j++){if(!c[p[j]])c[p[j]]={};c=c[p[j]]}
    c[p[p.length-1]]=e.value.trim();
  }
  return obj;
}
async function refreshStatus(){try{var r=await fetch('/api/status');if(r.ok)showStatus(await r.json())}catch(e){}}
async function load(){
  try{
    var [sr,cr]=await Promise.all([fetch('/api/status'),fetch('/api/config')]);
    if(!sr.ok||!cr.ok)throw new Error('请求失败');
    showStatus(await sr.json());
    var cd=await cr.json();fillForm(cd.config||{},cd.envOverrides||[]);
  }catch(e){
    var info=el('statusInfo');if(info)info.innerHTML='<div class="info-row"><span class="info-value" style="color:#f87171">加载失败，请刷新页面</span></div>';
  }
}
async function saveConfig(){
  var btn=document.querySelector('.btn-primary'),msg=el('saveMsg');
  if(btn)btn.disabled=true;if(msg)msg.textContent='保存中...';
  try{
    var body=JSON.stringify(collectForm());
    var res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:body});
    var text=await res.text();var data;
    try{data=text?JSON.parse(text):{}}catch(e){data={ok:false,error:'解析失败'}}
    if(data.ok){if(msg){msg.textContent=data.message||'已保存';msg.style.color='#34d399'}setTimeout(load,800)}
    else{if(msg){msg.textContent=data.error||'保存失败';msg.style.color='#f87171'}}
  }catch(e){if(msg){msg.textContent='保存失败（网络或服务器错误）';msg.style.color='#f87171'}}
  finally{if(btn)btn.disabled=false}
}
load();setInterval(refreshStatus,15000);
</script>
</body>
</html>`;
}
