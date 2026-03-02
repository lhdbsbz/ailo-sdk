import { createServer, type IncomingMessage, type ServerResponse } from "http";
import {
  readConfig,
  writeConfig,
  mergeWithEnv,
  AILO_ENV_MAPPING,
  getNestedValue,
  setNestedValue,
} from "./connection_util.js";

const SIDECAR_URL = process.env.CLAWWORK_SIDECAR_URL ?? "http://localhost:8020";

interface ConfigServerDeps {
  getConnectionStatus: () => { connected: boolean; endpointId: string; displayName: string };
  port: number;
  configPath: string;
  onConnectionConfigSaved?: (config: {
    ailoWsUrl: string;
    ailoApiKey: string;
    endpointId: string;
    displayName?: string;
  }) => Promise<void>;
}

export function startConfigServer(deps: ConfigServerDeps): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${deps.port}`);
    const path = url.pathname;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      if (path === "/" || path === "/index.html") return serveUI(res, deps);
      if (path === "/api/status") return json(res, deps.getConnectionStatus());
      if (path === "/api/connection" && req.method === "GET") return json(res, getConnectionConfig(deps.configPath));
      if (path === "/api/connection" && req.method === "POST") return json(res, await saveConnectionConfig(deps.configPath, await body(req), deps.onConnectionConfigSaved));
      if (path === "/api/clawwork/health") {
        try {
          const r = await fetch(`${SIDECAR_URL}/health`);
          return json(res, await r.json());
        } catch {
          return json(res, { status: "unreachable", error: "Sidecar not running at " + SIDECAR_URL });
        }
      }
      if (path === "/api/clawwork/status") {
        try {
          const r = await fetch(`${SIDECAR_URL}/status`);
          return json(res, await r.json());
        } catch {
          return json(res, { error: "Sidecar not reachable" });
        }
      }
      if (path === "/api/clawwork/leaderboard") {
        try {
          const r = await fetch(`${SIDECAR_URL}/leaderboard`);
          return json(res, await r.json());
        } catch {
          return json(res, { agents: [] });
        }
      }
      res.writeHead(404); res.end("Not Found");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500); res.end(JSON.stringify({ error: msg }));
    }
  });

  server.listen(deps.port, "127.0.0.1", () => {
    console.log(`[clawwork] 配置界面: http://127.0.0.1:${deps.port}`);
  });
  server.on("error", (err: unknown) => {
    const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "EADDRINUSE") console.log(`[clawwork] 端口 ${deps.port} 已被占用，跳过配置界面`);
    else console.error("[clawwork] 配置服务启动失败:", err instanceof Error ? err.message : err);
  });
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function getConnectionConfig(configPath: string) {
  const cfg = readConfig(configPath);
  const { merged } = mergeWithEnv(cfg, AILO_ENV_MAPPING);
  const url = (getNestedValue(merged as Record<string, unknown>, "ailo.wsUrl") as string) ?? "";
  const key = (getNestedValue(merged as Record<string, unknown>, "ailo.apiKey") as string) ?? "";
  const id = (getNestedValue(merged as Record<string, unknown>, "ailo.endpointId") as string) ?? "";
  return {
    configured: !!(url && key && id),
    ailoWsUrl: url || undefined,
    ailoApiKey: key || undefined,
    endpointId: id || undefined,
    displayName: (getNestedValue(merged as Record<string, unknown>, "ailo.displayName") as string) || undefined,
  };
}

async function saveConnectionConfig(
  configPath: string,
  bodyStr: string,
  onSaved?: (config: { ailoWsUrl: string; ailoApiKey: string; endpointId: string; displayName?: string }) => Promise<void>,
) {
  try {
    const existing = readConfig(configPath) as Record<string, unknown>;
    const b = JSON.parse(bodyStr) as Record<string, string | undefined>;
    if (b.ailoWsUrl !== undefined) setNestedValue(existing, "ailo.wsUrl", b.ailoWsUrl);
    if (b.ailoApiKey !== undefined) setNestedValue(existing, "ailo.apiKey", b.ailoApiKey);
    if (b.endpointId !== undefined) setNestedValue(existing, "ailo.endpointId", b.endpointId);
    if (b.displayName !== undefined) setNestedValue(existing, "ailo.displayName", b.displayName);
    writeConfig(configPath, existing);
    const { merged } = mergeWithEnv(existing, AILO_ENV_MAPPING);
    const ailoWsUrl = (getNestedValue(merged as Record<string, unknown>, "ailo.wsUrl") as string) ?? "";
    const ailoApiKey = (getNestedValue(merged as Record<string, unknown>, "ailo.apiKey") as string) ?? "";
    const endpointId = (getNestedValue(merged as Record<string, unknown>, "ailo.endpointId") as string) ?? "";
    const displayName = (getNestedValue(merged as Record<string, unknown>, "ailo.displayName") as string) ?? undefined;
    if (onSaved && ailoWsUrl && ailoApiKey && endpointId) {
      await onSaved({ ailoWsUrl, ailoApiKey, endpointId, displayName });
      return { ok: true, message: "已保存，正在使用新配置连接…" };
    }
    return { ok: true, message: "已保存。" };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function serveUI(res: ServerResponse, deps: ConfigServerDeps): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ailo ClawWork</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;background:#1a1d24;color:#d4d6da;min-height:100vh;font-size:15px;line-height:1.55}
.container{max-width:720px;margin:0 auto;padding:24px}
h1{font-size:1.3rem;font-weight:600;margin-bottom:20px;display:flex;align-items:center;gap:10px;color:#e2e4e8}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot.on{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.4)}
.dot.off{background:#f87171}
.card{background:#252830;border:1px solid #333842;border-radius:12px;padding:20px;margin-bottom:16px}
.card h2{font-size:1.05rem;margin-bottom:12px;color:#b4b8be;font-weight:600}
.badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:13px;font-weight:500}
.badge.on{background:rgba(52,211,153,.18);color:#6ee7b7}
.badge.off{background:rgba(248,113,113,.18);color:#fca5a5}
.badge.warn{background:rgba(251,191,36,.18);color:#fcd34d}
input{background:#1a1d24;border:1px solid #333842;color:#e2e4e8;padding:10px 14px;border-radius:8px;font-size:15px;width:100%}
input:focus{outline:none;border-color:#4b5563}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:14px;color:#9ca3af;margin-bottom:6px}
.btn{padding:8px 18px;border-radius:8px;border:none;cursor:pointer;font-size:14px;transition:opacity .15s}
.btn-primary{background:#3b82f6;color:#fff}
.btn-primary:hover{background:#2563eb}
.info-row{display:flex;gap:16px;margin-bottom:6px;font-size:14px}
.info-label{color:#9ca3af;min-width:100px}
.info-value{color:#d4d6da}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;padding:8px 12px;border-bottom:1px solid #333842;color:#9ca3af;font-weight:500}
td{padding:8px 12px;border-bottom:1px solid #2d3139}
.tabs{display:flex;gap:6px;margin-bottom:20px;border-bottom:1px solid #333842;padding-bottom:10px}
.tab{padding:8px 18px;border-radius:8px 8px 0 0;cursor:pointer;font-size:15px;color:#9ca3af;border:1px solid transparent;transition:color .15s,background .15s}
.tab.active{color:#e2e4e8;background:#252830;border-color:#333842;border-bottom-color:#252830}
.tab:hover{color:#d1d5db}
.panel{display:none}.panel.active{display:block}
</style>
</head>
<body>
<div class="container">
  <h1><span class="dot off" id="dot"></span> Ailo ClawWork <span id="statusText" style="font-size:14px;color:#9ca3af"></span></h1>

  <div class="tabs">
    <div class="tab active" onclick="showTab('connection')">连接配置</div>
    <div class="tab" onclick="showTab('clawwork')">打工状态</div>
    <div class="tab" onclick="showTab('leaderboard')">排行榜</div>
  </div>

  <!-- 连接配置 -->
  <div class="panel active" id="panel-connection">
    <div class="card">
      <h2>Ailo 连接配置</h2>
      <p style="font-size:14px;color:#9ca3af;margin-bottom:14px">填写 Ailo Gateway 的连接信息，保存后自动连接。</p>
      <div class="form-group"><label>AILO_WS_URL</label><input id="connWsUrl" placeholder="ws://127.0.0.1:19800/ws"></div>
      <div class="form-group"><label>AILO_API_KEY</label><input id="connApiKey" placeholder="ailo_ep_xxx"></div>
      <div class="form-group"><label>AILO_ENDPOINT_ID</label><input id="connEndpointId" placeholder="clawwork-01"></div>
      <div class="form-group"><label>显示名（可选）</label><input id="connDisplayName" placeholder="ClawWork打工"></div>
      <button class="btn btn-primary" onclick="saveConnection()">保存并连接</button>
      <span id="saveMsg" style="margin-left:10px;font-size:14px;color:#9ca3af"></span>
    </div>
    <div class="card">
      <h2>连接状态</h2>
      <div id="statusInfo">加载中...</div>
    </div>
    <div class="card">
      <h2>Sidecar 状态</h2>
      <div id="sidecarInfo">加载中...</div>
    </div>
  </div>

  <!-- 打工状态 -->
  <div class="panel" id="panel-clawwork">
    <div class="card">
      <h2>经济状态</h2>
      <div id="economicInfo">加载中...</div>
    </div>
  </div>

  <!-- 排行榜 -->
  <div class="panel" id="panel-leaderboard">
    <div class="card">
      <h2>排行榜</h2>
      <div id="leaderboardInfo">加载中...</div>
    </div>
  </div>
</div>

<script>
const API='';
function showTab(name){
  document.querySelectorAll('.tab').forEach(t=>{
    const map={connection:'连接配置',clawwork:'打工状态',leaderboard:'排行榜'};
    t.classList.toggle('active',t.textContent.trim()===map[name]);
  });
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
  if(name==='clawwork')loadEconomic();
  if(name==='leaderboard')loadLeaderboard();
}

async function loadStatus(){
  try{
    const s=await fetch(API+'/api/status').then(r=>r.json());
    document.getElementById('dot').className='dot '+(s.connected?'on':'off');
    document.getElementById('statusText').textContent=s.connected?'已连接':'未连接';
    document.getElementById('statusInfo').innerHTML=
      '<div class="info-row"><span class="info-label">状态</span><span class="info-value">'+(s.connected?'<span class="badge on">已连接</span>':'<span class="badge off">未连接</span>')+'</span></div>'+
      '<div class="info-row"><span class="info-label">端点 ID</span><span class="info-value">'+(s.endpointId||'-')+'</span></div>'+
      '<div class="info-row"><span class="info-label">显示名</span><span class="info-value">'+(s.displayName||'-')+'</span></div>';
  }catch(e){document.getElementById('statusInfo').textContent='加载失败';}
}

async function loadSidecar(){
  try{
    const h=await fetch(API+'/api/clawwork/health').then(r=>r.json());
    if(h.error){
      document.getElementById('sidecarInfo').innerHTML='<span class="badge off">未连接</span><p style="font-size:14px;color:#9ca3af;margin-top:8px">请先启动 sidecar: <code>.venv\\\\Scripts\\\\python server.py</code></p>';
      return;
    }
    document.getElementById('sidecarInfo').innerHTML=
      '<div class="info-row"><span class="info-label">状态</span><span class="info-value"><span class="badge on">运行中</span></span></div>'+
      '<div class="info-row"><span class="info-label">Agent</span><span class="info-value">'+(h.signature||'-')+'</span></div>'+
      '<div class="info-row"><span class="info-label">任务数</span><span class="info-value">'+(h.tasks_loaded||0)+' 个 GDPVal 任务</span></div>'+
      '<div class="info-row"><span class="info-label">余额</span><span class="info-value">$'+(h.balance!=null?h.balance.toFixed(2):'-')+'</span></div>'+
      '<div class="info-row"><span class="info-label">生存状态</span><span class="info-value">'+(h.survival_status||'-')+'</span></div>'+
      '<div class="info-row"><span class="info-label">评估器</span><span class="info-value">'+(h.evaluator_ready?'<span class="badge on">就绪</span>':'<span class="badge warn">未配置 API Key</span>')+'</span></div>';
  }catch(e){document.getElementById('sidecarInfo').innerHTML='<span class="badge off">无法连接</span>';}
}

async function loadConnectionForm(){
  try{
    const c=await fetch(API+'/api/connection').then(r=>r.json());
    document.getElementById('connWsUrl').value=c.ailoWsUrl||'';
    document.getElementById('connApiKey').value=c.ailoApiKey||'';
    document.getElementById('connEndpointId').value=c.endpointId||'';
    document.getElementById('connDisplayName').value=c.displayName||'';
  }catch(e){}
}

async function saveConnection(){
  const msg=document.getElementById('saveMsg');
  const d={
    ailoWsUrl:document.getElementById('connWsUrl').value.trim(),
    ailoApiKey:document.getElementById('connApiKey').value.trim(),
    endpointId:document.getElementById('connEndpointId').value.trim(),
    displayName:document.getElementById('connDisplayName').value.trim()
  };
  if(!d.ailoWsUrl||!d.ailoApiKey||!d.endpointId){msg.textContent='请填写前三项';msg.style.color='#f87171';return;}
  try{
    const r=await fetch(API+'/api/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(r=>r.json());
    if(r.ok){msg.textContent=r.message||'已保存';msg.style.color='#4ade80';setTimeout(()=>{loadStatus();loadSidecar();},2000);}
    else{msg.textContent=r.error||'保存失败';msg.style.color='#f87171';}
  }catch(e){msg.textContent='请求失败';msg.style.color='#f87171';}
}

async function loadEconomic(){
  const el=document.getElementById('economicInfo');
  try{
    const s=await fetch(API+'/api/clawwork/status').then(r=>r.json());
    if(s.error){el.innerHTML='<span class="badge off">Sidecar 未连接</span>';return;}
    el.innerHTML=
      '<div class="info-row"><span class="info-label">余额</span><span class="info-value" style="font-size:1.2em;font-weight:600">$'+(s.balance!=null?s.balance.toFixed(2):'-')+'</span></div>'+
      '<div class="info-row"><span class="info-label">生存状态</span><span class="info-value">'+({thriving:'繁荣',stable:'稳定',struggling:'困难',bankrupt:'破产'}[s.survival_status]||s.survival_status||'-')+'</span></div>'+
      '<div class="info-row"><span class="info-label">累计收入</span><span class="info-value">$'+(s.total_work_income!=null?s.total_work_income.toFixed(2):'-')+'</span></div>'+
      '<div class="info-row"><span class="info-label">累计成本</span><span class="info-value">$'+(s.total_token_cost!=null?s.total_token_cost.toFixed(4):'-')+'</span></div>'+
      '<div class="info-row"><span class="info-label">当前任务</span><span class="info-value">'+(s.current_task||'无')+'</span></div>';
  }catch(e){el.textContent='加载失败';}
}

async function loadLeaderboard(){
  const el=document.getElementById('leaderboardInfo');
  try{
    const d=await fetch(API+'/api/clawwork/leaderboard').then(r=>r.json());
    const agents=d.agents||[];
    if(!agents.length){el.innerHTML='<p style="color:#9ca3af">暂无数据</p>';return;}
    let h='<table><thead><tr><th>#</th><th>Agent</th><th>余额</th><th>收入</th><th>任务数</th><th>平均质量</th><th>状态</th></tr></thead><tbody>';
    for(const a of agents){
      const medal=a.rank===1?'\\u{1F947}':a.rank===2?'\\u{1F948}':a.rank===3?'\\u{1F949}':a.rank;
      const quality=a.avg_quality!=null?(a.avg_quality*100).toFixed(1)+'%':'N/A';
      const isAilo=a.signature==='Ailo';
      h+='<tr style="'+(isAilo?'background:rgba(59,130,246,.1)':'')+'"><td>'+medal+'</td><td>'+(isAilo?'<strong>'+a.signature+'</strong>':a.signature)+'</td><td>$'+a.balance.toFixed(2)+'</td><td>$'+a.total_work_income.toFixed(2)+'</td><td>'+a.num_tasks+'</td><td>'+quality+'</td><td>'+a.survival_status+'</td></tr>';
    }
    el.innerHTML=h+'</tbody></table>';
  }catch(e){el.textContent='加载失败';}
}

loadConnectionForm();loadStatus();loadSidecar();
setInterval(()=>{loadStatus();loadSidecar();},15000);
</script>
</body>
</html>`);
}
