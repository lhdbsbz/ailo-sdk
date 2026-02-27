/**
 * 飞书 Channel 自带配置界面：打开网页填写飞书应用 + Ailo 连接信息，保存后生效。
 * 仿照 ailo-desktop 的 config_server，仅保留配置表单与状态。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";

export interface FeishuConfigFromEnv {
  appId: string;
  appSecret: string;
}

export interface AiloConfigFromEnv {
  ailoWsUrl: string;
  ailoApiKey: string;
  endpointId: string;
  displayName?: string;
}

export interface FullConfig {
  feishu: FeishuConfigFromEnv;
  ailo: AiloConfigFromEnv & { configured: boolean };
}

export interface ConfigServerDeps {
  port: number;
  envFilePath: string;
  getConnectionStatus: () => { connected: boolean; endpointId: string; displayName: string };
  /** 保存配置后调用，传入 Ailo 连接字段；飞书应用配置修改后需重启生效 */
  onConfigSaved?: (config: AiloConfigFromEnv) => Promise<void>;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "r" ? "\r" : c === '"' ? '"' : c === "\\" ? "\\" : "\\" + c));
    } else if (val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

function getConfig(envFilePath: string): FullConfig {
  const env = parseEnvFile(envFilePath);
  const ailoWsUrl = env.AILO_WS_URL ?? "";
  const ailoApiKey = env.AILO_API_KEY ?? "";
  const endpointId = env.AILO_ENDPOINT_ID ?? "";
  const configured = !!(ailoWsUrl && ailoApiKey && endpointId);
  return {
    feishu: {
      appId: env.FEISHU_APP_ID ?? "",
      appSecret: env.FEISHU_APP_SECRET ?? "",
    },
    ailo: {
      ailoWsUrl,
      ailoApiKey,
      endpointId,
      displayName: env.DISPLAY_NAME || undefined,
      configured,
    },
  };
}

async function saveConfig(
  envFilePath: string,
  bodyStr: string,
  onSaved?: (config: AiloConfigFromEnv) => Promise<void>
): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const env = parseEnvFile(envFilePath);
    let b: { feishu?: { appId?: string; appSecret?: string }; ailo?: { ailoWsUrl?: string; ailoApiKey?: string; endpointId?: string; displayName?: string } };
    try {
      b = JSON.parse(bodyStr) as typeof b;
    } catch {
      return { ok: false, error: "请求体不是合法 JSON" };
    }
    if (b && typeof b === "object" && b.feishu) {
      if (b.feishu.appId !== undefined) env.FEISHU_APP_ID = b.feishu.appId;
      if (b.feishu.appSecret !== undefined) env.FEISHU_APP_SECRET = b.feishu.appSecret;
    }
    if (b && typeof b === "object" && b.ailo) {
      if (b.ailo.ailoWsUrl !== undefined) env.AILO_WS_URL = b.ailo.ailoWsUrl;
      if (b.ailo.ailoApiKey !== undefined) env.AILO_API_KEY = b.ailo.ailoApiKey;
      if (b.ailo.endpointId !== undefined) env.AILO_ENDPOINT_ID = b.ailo.endpointId;
      if (b.ailo.displayName !== undefined) env.DISPLAY_NAME = b.ailo.displayName;
    }
    const lines = Object.entries(env).map(([k, v]) => {
      const val = String(v ?? "");
      if (/[\r\n#"\\]/.test(val)) return `${k}="${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
      return `${k}=${val}`;
    });
    writeFileSync(envFilePath, lines.join("\n") + "\n", "utf-8");

    const ailoWsUrl = env.AILO_WS_URL ?? "";
    const ailoApiKey = env.AILO_API_KEY ?? "";
    const endpointId = env.AILO_ENDPOINT_ID ?? "";
    const displayName = env.DISPLAY_NAME;
    if (onSaved && ailoWsUrl && ailoApiKey && endpointId) {
      try {
        await onSaved({ ailoWsUrl, ailoApiKey, endpointId, displayName });
      } catch (reconnectErr: unknown) {
        const msg = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
        return { ok: true, message: `已保存。重连时出错：${msg}` };
      }
      return { ok: true, message: "已保存。Ailo 连接将使用新配置重连；飞书应用配置修改后请重启进程生效。" };
    }
    return { ok: true, message: "已保存。请填写完整 Ailo 连接信息后自动连接；飞书应用配置修改后请重启进程生效。" };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function getUIHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ailo 飞书通道 - 配置</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;
  background:#1a1d24;
  color:#d4d6da;
  min-height:100vh;
  font-size:15px;
  line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
.container{max-width:640px;margin:0 auto;padding:24px}
h1{font-size:1.35rem;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:10px;color:#e2e4e8}
.subtitle{font-size:14px;color:#9ca3af;margin-bottom:24px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot.on{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.4)}
.dot.off{background:#f87171}
.card{
  background:#252830;
  border:1px solid #333842;
  border-radius:12px;
  padding:20px;
  margin-bottom:20px;
}
.card h2{font-size:1.05rem;margin-bottom:12px;color:#b4b8be;font-weight:600}
.card p.desc{font-size:14px;color:#9ca3af;margin-bottom:14px;line-height:1.5}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:14px;color:#9ca3af;margin-bottom:6px}
input{
  background:#1a1d24;
  border:1px solid #333842;
  color:#e2e4e8;
  padding:10px 14px;
  border-radius:8px;
  font-size:15px;
  width:100%;
  transition:border-color .15s;
}
input:focus{outline:none;border-color:#4b5563}
.btn{padding:10px 18px;border-radius:8px;border:none;cursor:pointer;font-size:14px;margin-right:8px;margin-top:4px;transition:opacity .15s}
.btn-primary{background:#3b82f6;color:#fff}
.btn-primary:hover{background:#2563eb}
#saveMsg{margin-left:8px;font-size:14px;color:#9ca3af}
.info-row{display:flex;gap:24px;margin-bottom:8px;font-size:15px}
.info-label{color:#9ca3af;min-width:100px}
.info-value{color:#d4d6da}
</style>
</head>
<body>
<div class="container">
  <h1><span class="dot off" id="dot"></span> Ailo 飞书通道 <span id="statusText" style="font-size:14px;color:#9ca3af"></span></h1>
  <p class="subtitle">在下方填写飞书应用与 Ailo 连接信息，保存后会自动断开并用新配置重连，无需重启进程。</p>

  <div class="card">
    <h2>连接状态</h2>
    <div id="statusInfo">加载中...</div>
  </div>

  <div class="card">
    <h2>飞书应用配置</h2>
    <p class="desc">在飞书开放平台创建自建应用，获取 App ID 与 App Secret。修改后保存即可生效。</p>
    <div class="form-group"><label>FEISHU_APP_ID</label><input id="feishuAppId" placeholder="cli_xxx" autocomplete="off"></div>
    <div class="form-group"><label>FEISHU_APP_SECRET</label><input id="feishuAppSecret" type="password" placeholder="应用密钥" autocomplete="off"></div>
  </div>

  <div class="card">
    <h2>Ailo 连接配置</h2>
    <p class="desc">由 Ailo 端点管理下发的连接信息，或本地开发时填写。保存后会自动断开并用新配置重连。</p>
    <div class="form-group"><label>AILO_WS_URL</label><input id="ailoWsUrl" placeholder="ws://127.0.0.1:19800/ws"></div>
    <div class="form-group"><label>AILO_API_KEY</label><input id="ailoApiKey" type="text" placeholder="ailo_ep_xxx" autocomplete="off"></div>
    <div class="form-group"><label>AILO_ENDPOINT_ID</label><input id="ailoEndpointId" placeholder="feishu-01"></div>
    <div class="form-group"><label>DISPLAY_NAME（可选）</label><input id="ailoDisplayName" placeholder="飞书"></div>
  </div>

  <div class="card">
    <button class="btn btn-primary" onclick="saveConfig()">保存配置</button>
    <span id="saveMsg"></span>
  </div>
</div>
<script>
function el(id){return document.getElementById(id)}
function esc(s){const t=String(s==null?'':s);const d=document.createElement('div');d.textContent=t;return d.innerHTML;}
function showStatus(data){
  const dot=el('dot');const st=el('statusText');const info=el('statusInfo');
  if(!dot||!st||!info)return;
  if(data&&data.connected){dot.className='dot on';st.textContent='已连接';info.innerHTML='<div class="info-row"><span class="info-label">端点 ID</span><span class="info-value">'+esc(data.endpointId)+'</span></div><div class="info-row"><span class="info-label">显示名</span><span class="info-value">'+esc(data.displayName||'-')+'</span></div>'}
  else{dot.className='dot off';st.textContent='未连接';info.innerHTML='<div class="info-row"><span class="info-value">尚未连接 Ailo。请填写下方配置并保存。</span></div>'}
}
function fillForm(data){
  const feishu=data?.feishu||{};const ailo=data?.ailo||{};
  const set=(id,v)=>{const e=el(id);if(e)e.value=v||'';};
  set('feishuAppId',feishu.appId);set('feishuAppSecret',feishu.appSecret);
  set('ailoWsUrl',ailo.ailoWsUrl);set('ailoApiKey',ailo.ailoApiKey);
  set('ailoEndpointId',ailo.endpointId);set('ailoDisplayName',ailo.displayName);
}
async function refreshStatus(){
  try{
    const statusRes=await fetch('/api/status');
    if(!statusRes.ok)return;
    const status=await statusRes.json();
    showStatus(status);
  }catch(_){}
}
async function load(){
  try{
    const [statusRes,configRes]=await Promise.all([fetch('/api/status'),fetch('/api/config')]);
    if(!statusRes.ok||!configRes.ok)throw new Error('请求失败');
    const status=await statusRes.json();const config=await configRes.json();
    showStatus(status);fillForm(config);
  }catch(e){
    const info=el('statusInfo');if(info)info.innerHTML='<div class="info-row"><span class="info-value" style="color:#f87171">加载失败，请刷新页面</span></div>';
  }
}
function val(id){const e=el(id);return (e&&e.value?e.value:'').trim();}
async function saveConfig(){
  const btn=document.querySelector('.btn-primary');const msg=el('saveMsg');
  if(btn)btn.disabled=true;if(msg)msg.textContent='保存中...';
  try{
    const body=JSON.stringify({
      feishu:{appId:val('feishuAppId'),appSecret:val('feishuAppSecret')},
      ailo:{ailoWsUrl:val('ailoWsUrl'),ailoApiKey:val('ailoApiKey'),endpointId:val('ailoEndpointId'),displayName:val('ailoDisplayName')||undefined}
    });
    const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body});
    const text=await res.text();
    let data;try{data=text?JSON.parse(text):{};}catch(_){data={ok:false,error:res.ok?'解析失败':'保存失败'};}
    if(data.ok){if(msg)msg.textContent=data.message||'已保存';if(msg)msg.style.color='#34d399';setTimeout(load,800);}
    else{if(msg)msg.textContent=data.error||'保存失败';if(msg)msg.style.color='#f87171';}
  }catch(err){if(msg)msg.textContent='保存失败（网络或服务器错误）';if(msg)msg.style.color='#f87171';}
  finally{if(btn)btn.disabled=false;}
}
load();
setInterval(refreshStatus,15000);
</script>
</body>
</html>`;
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

const MAX_BODY_SIZE = 64 * 1024; // 64KB

async function body(req: IncomingMessage): Promise<string> {
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

export function startConfigServer(deps: ConfigServerDeps): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${deps.port}`);
    const path = (url.pathname || "/").replace(/\/+$/, "") || "/";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getUIHTML());
        return;
      }
      if (path === "/api/status" && req.method === "GET") {
        let status: { connected: boolean; endpointId: string; displayName: string };
        try {
          status = deps.getConnectionStatus();
        } catch {
          status = { connected: false, endpointId: "", displayName: "飞书" };
        }
        return json(res, status);
      }
      if (path === "/api/config" && req.method === "GET") {
        let config: FullConfig;
        try {
          config = getConfig(deps.envFilePath);
        } catch {
          config = {
            feishu: { appId: "", appSecret: "" },
            ailo: { ailoWsUrl: "", ailoApiKey: "", endpointId: "", displayName: undefined, configured: false },
          };
        }
        return json(res, config);
      }
      if (path === "/api/config" && req.method === "POST") {
        return json(res, await saveConfig(deps.envFilePath, await body(req), deps.onConfigSaved));
      }
      res.writeHead(404);
      res.end("Not Found");
      return;
    } catch (e: unknown) {
      if (!res.headersSent) {
        try {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        } catch (_) {
          // 客户端已断开时 res.end 可能抛错，忽略
        }
      }
    }
  });

  server.listen(deps.port, "127.0.0.1", () => {
    console.log(`[feishu] 配置界面: http://127.0.0.1:${deps.port}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") console.log(`[feishu] 端口 ${deps.port} 已被占用，跳过配置界面`);
    else console.error("[feishu] 配置服务启动失败:", err.message);
  });
}
