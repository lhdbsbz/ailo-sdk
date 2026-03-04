import { createServer, type IncomingMessage, type ServerResponse } from "http";
import {
  readConfig,
  writeConfig,
  getNestedValue,
  setNestedValue,
} from "./connection_util.js";

interface ConfigServerDeps {
  getConnectionStatus: () => { connected: boolean; endpointId: string };
  port: number;
  configPath: string;
  sidecarUrl: string;
  onConnectionConfigSaved?: (config: {
    ailoWsUrl: string;
    ailoApiKey: string;
    endpointId: string;
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
          const r = await fetch(`${deps.sidecarUrl}/health`);
          return json(res, await r.json());
        } catch {
          return json(res, { status: "unreachable", error: "Sidecar not running at " + deps.sidecarUrl });
        }
      }
      if (path === "/api/clawwork/status") {
        try {
          const r = await fetch(`${deps.sidecarUrl}/status`);
          return json(res, await r.json());
        } catch {
          return json(res, { error: "Sidecar not reachable" });
        }
      }
      if (path === "/api/clawwork/leaderboard") {
        try {
          const r = await fetch(`${deps.sidecarUrl}/leaderboard`);
          return json(res, await r.json());
        } catch {
          return json(res, { agents: [] });
        }
      }
      if (path === "/api/clawwork/evaluations") {
        try {
          const r = await fetch(`${deps.sidecarUrl}/evaluations`);
          return json(res, await r.json());
        } catch {
          return json(res, { evaluations: [], total: 0 });
        }
      }
      if (path === "/api/clawwork/current-task") {
        try {
          const r = await fetch(`${deps.sidecarUrl}/current-task`);
          return json(res, await r.json());
        } catch {
          return json(res, { active: false, task: null });
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
  const url = (getNestedValue(cfg as Record<string, unknown>, "ailo.wsUrl") as string) ?? "";
  const key = (getNestedValue(cfg as Record<string, unknown>, "ailo.apiKey") as string) ?? "";
  const id = (getNestedValue(cfg as Record<string, unknown>, "ailo.endpointId") as string) ?? "";
  return {
    configured: !!(url && key && id),
    ailoWsUrl: url || undefined,
    ailoApiKey: key || undefined,
    endpointId: id || undefined,
  };
}

async function saveConnectionConfig(
  configPath: string,
  bodyStr: string,
  onSaved?: (config: { ailoWsUrl: string; ailoApiKey: string; endpointId: string }) => Promise<void>,
) {
  try {
    const existing = readConfig(configPath) as Record<string, unknown>;
    const b = JSON.parse(bodyStr) as Record<string, string | undefined>;
    if (b.ailoWsUrl !== undefined) setNestedValue(existing, "ailo.wsUrl", b.ailoWsUrl);
    if (b.ailoApiKey !== undefined) setNestedValue(existing, "ailo.apiKey", b.ailoApiKey);
    if (b.endpointId !== undefined) setNestedValue(existing, "ailo.endpointId", b.endpointId);
    writeConfig(configPath, existing);
    const ailoWsUrl = (getNestedValue(existing as Record<string, unknown>, "ailo.wsUrl") as string) ?? "";
    const ailoApiKey = (getNestedValue(existing as Record<string, unknown>, "ailo.apiKey") as string) ?? "";
    const endpointId = (getNestedValue(existing as Record<string, unknown>, "ailo.endpointId") as string) ?? "";
    if (onSaved && ailoWsUrl && ailoApiKey && endpointId) {
      await onSaved({ ailoWsUrl, ailoApiKey, endpointId });
      return { ok: true, message: "已保存，正在使用新配置连接…" };
    }
    return { ok: true, message: "已保存。" };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function serveUI(res: ServerResponse, deps: ConfigServerDeps): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(buildFullHTML());
}

function buildFullHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ailo ClawWork</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;background:#0f1117;color:#d4d6da;min-height:100vh;font-size:14px;line-height:1.55}
a{color:#60a5fa;text-decoration:none}
.shell{max-width:1080px;margin:0 auto;padding:20px 24px}

/* ── header ── */
.hdr{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.hdr h1{font-size:1.25rem;font-weight:700;color:#e2e4e8;letter-spacing:-.02em}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.dot.on{background:#34d399;box-shadow:0 0 6px rgba(52,211,153,.5)}
.dot.off{background:#ef4444}
.hdr-right{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:13px;color:#6b7280}
.hdr-right .badge{font-size:12px}

/* ── tabs ── */
.tabs{display:flex;gap:2px;margin-bottom:20px;background:#1a1d24;border-radius:10px;padding:3px}
.tab{flex:1;text-align:center;padding:9px 0;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;color:#6b7280;transition:all .15s}
.tab.active{background:#252830;color:#e2e4e8;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.tab:hover:not(.active){color:#9ca3af}
.panel{display:none}.panel.active{display:block}

/* ── cards & grid ── */
.card{background:#1a1d24;border:1px solid #282c34;border-radius:12px;padding:18px 20px;margin-bottom:14px}
.card h2{font-size:.95rem;font-weight:600;color:#9ca3af;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.card h2 .cnt{font-size:12px;background:#282c34;padding:2px 8px;border-radius:10px;color:#6b7280}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.metric{background:#252830;border-radius:10px;padding:14px 16px;text-align:center}
.metric .val{font-size:1.4rem;font-weight:700;color:#e2e4e8;line-height:1.2}
.metric .lbl{font-size:12px;color:#6b7280;margin-top:4px}
.metric.accent .val{color:#34d399}
.metric.warn .val{color:#fbbf24}
.metric.danger .val{color:#ef4444}

/* ── progress ── */
.progress-wrap{margin-bottom:14px}
.progress-bar{height:8px;background:#252830;border-radius:4px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,#3b82f6,#8b5cf6);border-radius:4px;transition:width .6s ease}
.progress-info{display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-top:5px}

/* ── current task ── */
.task-active{border-left:3px solid #3b82f6;padding-left:17px}
.task-id{font-family:monospace;font-size:12px;color:#6b7280;word-break:break-all}
.task-meta{display:flex;gap:16px;margin:8px 0;font-size:13px;color:#9ca3af;flex-wrap:wrap}
.task-meta span{display:flex;align-items:center;gap:4px}
.task-prompt{font-size:13px;color:#b4b8be;line-height:1.6;max-height:120px;overflow-y:auto;white-space:pre-wrap;background:#252830;border-radius:8px;padding:12px;margin-top:8px}

/* ── eval history ── */
.eval-item{background:#252830;border-radius:10px;padding:14px 16px;margin-bottom:8px;cursor:pointer;transition:background .15s}
.eval-item:hover{background:#2d3139}
.eval-head{display:flex;align-items:center;gap:12px}
.eval-score{font-size:1.1rem;font-weight:700;min-width:52px}
.eval-score.pass{color:#34d399}
.eval-score.fail{color:#ef4444}
.eval-info{flex:1;min-width:0}
.eval-info .occ{font-size:13px;color:#d4d6da;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.eval-info .time{font-size:12px;color:#6b7280}
.eval-payment{font-size:14px;font-weight:600;color:#e2e4e8}
.eval-feedback{display:none;margin-top:10px;font-size:13px;color:#b4b8be;line-height:1.65;white-space:pre-wrap;max-height:300px;overflow-y:auto;border-top:1px solid #333842;padding-top:10px}
.eval-item.open .eval-feedback{display:block}
.eval-item .arrow{color:#6b7280;transition:transform .2s;font-size:12px}
.eval-item.open .arrow{transform:rotate(90deg)}

/* ── leaderboard ── */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;border-bottom:1px solid #282c34;color:#6b7280;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td{padding:10px 12px;border-bottom:1px solid #1f2229}
tr.me{background:rgba(59,130,246,.08)}
.rank-medal{font-size:16px}

/* ── connection ── */
.conn-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:640px){.conn-grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}}
input{background:#252830;border:1px solid #333842;color:#e2e4e8;padding:9px 12px;border-radius:8px;font-size:14px;width:100%}
input:focus{outline:none;border-color:#4b5563}
.form-group{margin-bottom:12px}
.form-group label{display:block;font-size:12px;color:#6b7280;margin-bottom:5px;text-transform:uppercase;letter-spacing:.03em}
.btn{padding:8px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:all .15s}
.btn-primary{background:#3b82f6;color:#fff}
.btn-primary:hover{background:#2563eb}
.badge{display:inline-block;padding:2px 9px;border-radius:6px;font-size:12px;font-weight:500}
.badge.on{background:rgba(52,211,153,.15);color:#6ee7b7}
.badge.off{background:rgba(248,113,113,.15);color:#fca5a5}
.badge.warn{background:rgba(251,191,36,.15);color:#fcd34d}
.badge.blue{background:rgba(59,130,246,.15);color:#93c5fd}
.info-row{display:flex;gap:12px;margin-bottom:5px;font-size:13px}
.info-label{color:#6b7280;min-width:80px}
.empty{text-align:center;padding:32px 0;color:#4b5563;font-size:14px}
</style>
</head>
<body>
<div class="shell">
  <div class="hdr">
    <span class="dot off" id="dot"></span>
    <h1>Ailo ClawWork</h1>
    <div class="hdr-right">
      <span id="hdrEndpoint"></span>
      <span id="hdrSidecar"></span>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="dashboard">仪表盘</div>
    <div class="tab" data-tab="history">评估记录</div>
    <div class="tab" data-tab="leaderboard">排行榜</div>
    <div class="tab" data-tab="settings">连接设置</div>
  </div>

  <!-- ═══ 仪表盘 ═══ -->
  <div class="panel active" id="panel-dashboard">
    <div class="metrics" id="metricsGrid">
      <div class="metric"><div class="val" id="mBal">--</div><div class="lbl">余额</div></div>
      <div class="metric"><div class="val" id="mIncome">--</div><div class="lbl">累计收入</div></div>
      <div class="metric"><div class="val" id="mTasks">--</div><div class="lbl">已完成</div></div>
      <div class="metric"><div class="val" id="mStatus">--</div><div class="lbl">生存状态</div></div>
    </div>
    <div class="progress-wrap" id="progressWrap">
      <div class="progress-bar"><div class="progress-fill" id="progFill" style="width:0"></div></div>
      <div class="progress-info"><span id="progLabel">0 / 220</span><span id="progPct">0%</span></div>
    </div>
    <div class="card" id="currentTaskCard">
      <h2 id="currentTaskTitle">当前任务</h2>
      <div id="currentTaskBody"><div class="empty">等待领取任务...</div></div>
    </div>
    <div class="card">
      <h2>最近评估 <span class="cnt" id="recentCnt">0</span></h2>
      <div id="recentEvals"><div class="empty">暂无评估记录</div></div>
    </div>
  </div>

  <!-- ═══ 评估记录 ═══ -->
  <div class="panel" id="panel-history">
    <div class="card">
      <h2>全部评估记录 <span class="cnt" id="historyCnt">0</span></h2>
      <div id="historyList"><div class="empty">暂无评估记录</div></div>
    </div>
  </div>

  <!-- ═══ 排行榜 ═══ -->
  <div class="panel" id="panel-leaderboard">
    <div class="card">
      <h2>Agent 排行榜</h2>
      <div id="leaderboardInfo"><div class="empty">加载中...</div></div>
    </div>
  </div>

  <!-- ═══ 连接设置 ═══ -->
  <div class="panel" id="panel-settings">
    <div class="conn-grid">
      <div class="card">
        <h2>Ailo Gateway 连接</h2>
        <div class="form-group"><label>WS URL</label><input id="connWsUrl" placeholder="ws://127.0.0.1:19800/ws"></div>
        <div class="form-group"><label>API Key</label><input id="connApiKey" placeholder="ailo_ep_xxx"></div>
        <div class="form-group"><label>Endpoint ID</label><input id="connEndpointId" placeholder="clawwork-01"></div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:4px">
          <button class="btn btn-primary" onclick="saveConn()">保存并连接</button>
          <span id="saveMsg" style="font-size:13px;color:#6b7280"></span>
        </div>
      </div>
      <div>
        <div class="card">
          <h2>端点状态</h2>
          <div id="connStatusInfo">加载中...</div>
        </div>
        <div class="card">
          <h2>Sidecar 状态</h2>
          <div id="sidecarInfo">加载中...</div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
const A='';
const STATUS_MAP={thriving:'繁荣',stable:'稳定',struggling:'困难',bankrupt:'破产'};

/* ── tabs ── */
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('panel-'+t.dataset.tab).classList.add('active');
  if(t.dataset.tab==='history')loadHistory();
  if(t.dataset.tab==='leaderboard')loadLeaderboard();
  if(t.dataset.tab==='settings'){loadConnForm();loadConnStatus();loadSidecar();}
}));

/* ── dashboard ── */
async function loadDashboard(){
  try{
    const[st,ct,ev]=await Promise.all([
      fetch(A+'/api/clawwork/status').then(r=>r.json()).catch(()=>null),
      fetch(A+'/api/clawwork/current-task').then(r=>r.json()).catch(()=>null),
      fetch(A+'/api/clawwork/evaluations').then(r=>r.json()).catch(()=>({evaluations:[]})),
    ]);
    if(st&&!st.error){
      const bal=st.balance!=null?st.balance:0;
      document.getElementById('mBal').textContent='$'+bal.toFixed(2);
      document.getElementById('mIncome').textContent='$'+(st.total_work_income||0).toFixed(2);
      const done=st.completed_tasks||0,total=st.total_tasks||220;
      document.getElementById('mTasks').textContent=done+' / '+total;
      const status=STATUS_MAP[st.survival_status]||st.survival_status||'-';
      document.getElementById('mStatus').textContent=status;
      const mEl=document.getElementById('mStatus').parentElement;
      mEl.className='metric'+({thriving:' accent',stable:' accent',struggling:' warn',bankrupt:' danger'}[st.survival_status]||'');
      const pct=total>0?Math.round(done/total*100):0;
      document.getElementById('progFill').style.width=pct+'%';
      document.getElementById('progLabel').textContent=done+' / '+total+' 任务已完成';
      document.getElementById('progPct').textContent=pct+'%';
    }
    const titleEl=document.getElementById('currentTaskTitle');
    const bodyEl=document.getElementById('currentTaskBody');
    if(ct&&ct.task){
      const t=ct.task;
      const isWorking=ct.status==='working';
      const isDone=ct.status==='completed';
      titleEl.innerHTML=isWorking?'当前任务 <span class="badge blue">进行中</span>':isDone?'最近完成 <span class="badge on">已提交</span>':'任务';
      let html='<div class="task-active" style="border-left-color:'+(isWorking?'#3b82f6':'#34d399')+'">'+
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'+
        '<span style="font-size:15px;font-weight:600;color:#e2e4e8">'+esc(t.occupation)+'</span>';
      if(isDone&&ct.last_score!=null){
        const sc=(ct.last_score*100).toFixed(0);
        html+='<span style="font-weight:600;color:'+(ct.last_score>=0.6?'#34d399':'#ef4444')+'">'+sc+'% &middot; $'+Number(ct.last_payment||0).toFixed(2)+'</span>';
      }else{
        html+='<span style="font-weight:600;color:#fbbf24">$'+Number(t.max_payment).toFixed(2)+'</span>';
      }
      html+='</div><div class="task-meta"><span>'+esc(t.sector)+'</span></div>'+
        '<div class="task-id">'+esc(t.task_id)+'</div>';
      if(t.prompt)html+='<div class="task-prompt">'+esc(t.prompt)+'</div>';
      html+='</div>';
      bodyEl.innerHTML=html;
    }else{
      titleEl.textContent='当前任务';
      bodyEl.innerHTML='<div class="empty">等待领取任务...</div>';
    }
    renderEvalList('recentEvals',ev.evaluations||[],5);
    document.getElementById('recentCnt').textContent=String((ev.evaluations||[]).length);
  }catch(e){console.error(e);}
}

/* ── eval rendering ── */
function renderEvalList(elId,evals,limit){
  const el=document.getElementById(elId);
  const items=limit?evals.slice(0,limit):evals;
  if(!items.length){el.innerHTML='<div class="empty">暂无评估记录</div>';return;}
  el.innerHTML=items.map((e,i)=>{
    const score=e.evaluation_score!=null?(e.evaluation_score*100).toFixed(0)+'%':'?';
    const pass=e.evaluation_score>=0.6;
    const ts=e.timestamp?new Date(e.timestamp).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';
    const tid=(e.task_id||'').substring(0,8);
    return '<div class="eval-item" onclick="this.classList.toggle(\\'open\\')">'+
      '<div class="eval-head">'+
      '<div class="eval-score '+(pass?'pass':'fail')+'">'+score+'</div>'+
      '<div class="eval-info"><div class="occ">'+esc(tid)+'</div><div class="time">'+ts+'</div></div>'+
      '<div class="eval-payment">'+(e.payment>0?'+$'+Number(e.payment).toFixed(2):'$0.00')+'</div>'+
      '<span class="arrow">&#9654;</span></div>'+
      '<div class="eval-feedback">'+esc(e.feedback||'无评语')+'</div></div>';
  }).join('');
}

/* ── history ── */
async function loadHistory(){
  try{
    const ev=await fetch(A+'/api/clawwork/evaluations').then(r=>r.json());
    const evals=ev.evaluations||[];
    document.getElementById('historyCnt').textContent=String(evals.length);
    renderEvalList('historyList',evals,0);
  }catch(e){document.getElementById('historyList').innerHTML='<div class="empty">加载失败</div>';}
}

/* ── leaderboard ── */
async function loadLeaderboard(){
  const el=document.getElementById('leaderboardInfo');
  try{
    const d=await fetch(A+'/api/clawwork/leaderboard').then(r=>r.json());
    const agents=d.agents||[];
    if(!agents.length){el.innerHTML='<div class="empty">暂无数据</div>';return;}
    const medals=['','\\u{1F947}','\\u{1F948}','\\u{1F949}'];
    let h='<table><thead><tr><th>#</th><th>Agent</th><th>余额</th><th>收入</th><th>任务</th><th>质量</th><th>状态</th></tr></thead><tbody>';
    for(const a of agents){
      const r=a.rank<=3?'<span class="rank-medal">'+medals[a.rank]+'</span>':a.rank;
      const q=a.avg_quality!=null?(a.avg_quality*100).toFixed(0)+'%':'--';
      const me=a.signature==='Ailo';
      h+='<tr class="'+(me?'me':'')+'"><td>'+r+'</td><td>'+(me?'<strong>'+a.signature+'</strong>':a.signature)+'</td><td>$'+a.balance.toFixed(2)+'</td><td>$'+a.total_work_income.toFixed(2)+'</td><td>'+a.num_tasks+'</td><td>'+q+'</td><td><span class="badge '+(a.survival_status==='thriving'||a.survival_status==='stable'?'on':a.survival_status==='struggling'?'warn':'off')+'">'+(STATUS_MAP[a.survival_status]||a.survival_status)+'</span></td></tr>';
    }
    el.innerHTML=h+'</tbody></table>';
  }catch(e){el.innerHTML='<div class="empty">加载失败</div>';}
}

/* ── settings ── */
async function loadConnForm(){
  try{
    const c=await fetch(A+'/api/connection').then(r=>r.json());
    document.getElementById('connWsUrl').value=c.ailoWsUrl||'';
    document.getElementById('connApiKey').value=c.ailoApiKey||'';
    document.getElementById('connEndpointId').value=c.endpointId||'';
  }catch(e){}
}
async function loadConnStatus(){
  try{
    const s=await fetch(A+'/api/status').then(r=>r.json());
    document.getElementById('dot').className='dot '+(s.connected?'on':'off');
    document.getElementById('hdrEndpoint').innerHTML=s.connected?'<span class="badge on">Endpoint</span>':'<span class="badge off">Endpoint</span>';
    document.getElementById('connStatusInfo').innerHTML=
      '<div class="info-row"><span class="info-label">状态</span><span>'+(s.connected?'<span class="badge on">已连接</span>':'<span class="badge off">未连接</span>')+'</span></div>'+
      '<div class="info-row"><span class="info-label">端点 ID</span><span>'+(s.endpointId||'-')+'</span></div>';
  }catch(e){document.getElementById('connStatusInfo').textContent='加载失败';}
}
async function loadSidecar(){
  try{
    const h=await fetch(A+'/api/clawwork/health').then(r=>r.json());
    if(h.error){
      document.getElementById('hdrSidecar').innerHTML='<span class="badge off">Sidecar</span>';
      document.getElementById('sidecarInfo').innerHTML='<span class="badge off">未连接</span><p style="font-size:13px;color:#6b7280;margin-top:6px">请先启动 sidecar</p>';
      return;
    }
    document.getElementById('hdrSidecar').innerHTML='<span class="badge on">Sidecar</span>';
    document.getElementById('sidecarInfo').innerHTML=
      '<div class="info-row"><span class="info-label">Agent</span><span>'+(h.signature||'-')+'</span></div>'+
      '<div class="info-row"><span class="info-label">任务池</span><span>'+(h.tasks_loaded||0)+' 个</span></div>'+
      '<div class="info-row"><span class="info-label">评估器</span><span>'+(h.evaluator_ready?'<span class="badge on">就绪</span>':'<span class="badge warn">未配置</span>')+'</span></div>';
  }catch(e){
    document.getElementById('hdrSidecar').innerHTML='<span class="badge off">Sidecar</span>';
    document.getElementById('sidecarInfo').innerHTML='<span class="badge off">无法连接</span>';
  }
}
async function saveConn(){
  const msg=document.getElementById('saveMsg');
  const d={ailoWsUrl:document.getElementById('connWsUrl').value.trim(),ailoApiKey:document.getElementById('connApiKey').value.trim(),endpointId:document.getElementById('connEndpointId').value.trim()};
  if(!d.ailoWsUrl||!d.ailoApiKey||!d.endpointId){msg.textContent='请填写所有字段';msg.style.color='#f87171';return;}
  try{
    const r=await fetch(A+'/api/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(r=>r.json());
    if(r.ok){msg.textContent=r.message||'已保存';msg.style.color='#4ade80';setTimeout(()=>{loadConnStatus();loadSidecar();loadDashboard();},2000);}
    else{msg.textContent=r.error||'保存失败';msg.style.color='#f87171';}
  }catch(e){msg.textContent='请求失败';msg.style.color='#f87171';}
}

function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

/* ── init & polling ── */
loadDashboard();loadConnStatus();loadSidecar();
setInterval(()=>{
  const active=document.querySelector('.tab.active');
  if(active&&active.dataset.tab==='dashboard')loadDashboard();
  loadConnStatus();loadSidecar();
},10000);
</script>
</body>
</html>`;
}
