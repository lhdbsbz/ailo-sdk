/* ─── Runtime config injected by server ───────────────────────── */
const SHOW_CONNECTION_FORM = window.SHOW_CONNECTION_FORM === true;

/* ─── Toast ───────────────────────────────────────────────────── */
const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function toast(msg, type = 'info', duration = 3500) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${ICONS[type] || ICONS.info}<span>${esc(msg)}</span>`;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

/* ─── Utils ───────────────────────────────────────────────────── */
function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML;
}

function setBtnLoading(btn, loading, text) {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn._origHTML = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span>${text || '处理中...'}`;
  } else {
    btn.disabled = false;
    if (btn._origHTML) { btn.innerHTML = btn._origHTML; btn._origHTML = null; }
  }
}

function renderBadge(running, configured) {
  if (running)    return '<span class="badge on"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>运行中</span>';
  if (configured) return '<span class="badge warning">已配置 · 未运行</span>';
  return '<span class="badge muted">未配置</span>';
}

function updateNavBadge(id, running, configured) {
  const el = document.getElementById(id + 'NavBadge');
  if (!el) return;
  if (running)    { el.style.display=''; el.className='nav-badge on';  el.textContent='运行中'; }
  else if (configured) { el.style.display=''; el.className='nav-badge warning'; el.textContent='已配置'; }
  else { el.style.display='none'; }
}

/* ─── Navigation ──────────────────────────────────────────────── */
function nav(name) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  localStorage.setItem('ailo_nav', name);

  if (name === 'status')   { loadStatus(); if (SHOW_CONNECTION_FORM) loadConnectionForm(); }
  if (name === 'env')      loadEnvCheck();
  if (name === 'skills')   loadSkills();
  if (name === 'mcp')      loadMCP();
  if (name === 'tools')    toolsSub(localStorage.getItem('ailo_tools_sub') || 'reported');
  if (name === 'email')    loadEmailConfig();
  if (name === 'feishu')   loadFeishuConfig();
  if (name === 'dingtalk') loadDingtalkConfig();
  if (name === 'qq')       loadQQConfig();
}

function toolsSub(sub) {
  document.querySelectorAll('.sub-tabs:not(.blueprint-tabs) .sub-tab').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  document.querySelectorAll('#panel-tools .sub-panel').forEach(p => p.classList.toggle('active', p.id === 'sub-' + sub));
  localStorage.setItem('ailo_tools_sub', sub);
  if (sub === 'reported')  loadReportedTools();
  if (sub === 'blueprints') loadAllBlueprints();
}

function hideModal(id) { document.getElementById(id).classList.remove('open'); }
function showModal(id)  { document.getElementById(id).classList.add('open'); }

/* ─── Status ──────────────────────────────────────────────────── */
async function loadStatus() {
  try {
    const s = await fetch('/api/status').then(r => r.json());
    const dot = document.getElementById('globalDot');
    const gs  = document.getElementById('globalStatus');
    const label = document.getElementById('connectionLabel');
    const sublabel = document.getElementById('connectionSublabel');
    const badgeWrap = document.getElementById('connectionBadgeWrap');
    const grid = document.getElementById('statusInfoGrid');

    if (dot) dot.className = 'status-dot ' + (s.connected ? 'on' : 'off');
    if (gs)  gs.textContent = s.connected ? '已连接' : '未连接';
    if (label) label.textContent = s.connected ? '已连接至 Ailo' : '未连接';
    if (sublabel) sublabel.textContent = s.connected ? `端点 ID: ${s.endpointId || '-'}` : '尚未连接至 Ailo 服务';
    if (badgeWrap) badgeWrap.innerHTML = s.connected
      ? '<span class="badge on">在线</span>'
      : '<span class="badge off">离线</span>';
    if (grid) {
      grid.style.display = s.connected ? 'grid' : 'none';
      const epEl = document.getElementById('statusEndpointId');
      const connEl = document.getElementById('statusConnected');
      if (epEl) epEl.textContent = s.endpointId || '-';
      if (connEl) connEl.innerHTML = s.connected ? '<span class="badge on">已连接</span>' : '<span class="badge off">断开</span>';
    }
  } catch (e) {}
}

async function loadConnectionForm() {
  const card = document.getElementById('connectionFormCard');
  if (!SHOW_CONNECTION_FORM || !card) return;
  card.style.display = '';
  try {
    const c = await fetch('/api/connection').then(r => r.json());
    document.getElementById('connWsUrl').value = c.ailoWsUrl || '';
    document.getElementById('connApiKey').value = c.ailoApiKey || '';
    document.getElementById('connEndpointId').value = c.endpointId || '';
  } catch (e) {}
}

async function saveConnection() {
  const btn = document.getElementById('saveConnBtn');
  const wsUrl = document.getElementById('connWsUrl').value.trim();
  const apiKey = document.getElementById('connApiKey').value.trim();
  const endpointId = document.getElementById('connEndpointId').value.trim();
  if (!wsUrl || !apiKey || !endpointId) { toast('请填写全部三项连接信息', 'error'); return; }
  setBtnLoading(btn, true, '保存中...');
  try {
    const r = await fetch('/api/connection', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ailoWsUrl:wsUrl,ailoApiKey:apiKey,endpointId}) }).then(r=>r.json());
    if (r.ok) {
      toast(r.message || '已保存', 'success');
      let cnt = 0; const iv = setInterval(() => { loadStatus(); if (++cnt >= 5) clearInterval(iv); }, 2000);
    } else toast(r.error || '保存失败', 'error');
  } catch (e) { toast('请求失败', 'error'); }
  setBtnLoading(btn, false);
}

/* ─── Tools ───────────────────────────────────────────────────── */
async function loadReportedTools() {
  const el = document.getElementById('reportedToolsList');
  if (!el) return;
  el.innerHTML = '<div class="loading-text">加载中...</div>';
  try {
    const d = await fetch('/api/tools').then(r => r.json());
    if (!d || !d.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">暂无工具</p>'; return; }
    let h = '<div class="table-wrap"><table><thead><tr><th>工具</th><th>来源</th><th>说明</th></tr></thead><tbody>';
    for (const t of d) {
      const src = t.source === 'builtin' ? '<span class="badge info">内置</span>' : '<span class="badge muted">MCP</span>';
      h += `<tr><td><code>${esc(t.name)}</code></td><td>${src}</td><td style="color:var(--text-muted);font-size:13px">${esc(t.description)}</td></tr>`;
    }
    el.innerHTML = h + '</tbody></table></div>';
  } catch (e) { el.textContent = '加载失败'; }
}

/* ─── Multi-blueprint ──────────────────────────────────────────── */
let _bpData = [];
let _bpActive = '';

async function loadAllBlueprints() {
  const tabRow = document.getElementById('blueprintTabRow');
  const panels = document.getElementById('blueprintPanels');
  if (!tabRow || !panels) return;
  panels.innerHTML = '<div class="loading-text">加载中...</div>';
  tabRow.innerHTML = '';
  try {
    _bpData = await fetch('/api/blueprints').then(r => r.json());
    if (!_bpData || !_bpData.length) {
      panels.innerHTML = '<p style="color:var(--text-muted);font-size:14px">暂无蓝图</p>';
      return;
    }
    tabRow.innerHTML = _bpData.map((bp, i) =>
      `<button class="sub-tab${i===0?' active':''}" data-bp="${esc(bp.name)}" onclick="showBlueprintTab('${esc(bp.name)}')">${esc(bp.name)}</button>`
    ).join('');
    panels.innerHTML = _bpData.map((bp, i) =>
      `<div class="sub-panel${i===0?' active':''}" id="bp-panel-${esc(bp.name)}">${bp.content ? `<pre class="blueprint-content">${esc(bp.content)}</pre>` : '<p style="color:var(--text-muted);font-size:14px">无法读取内容</p>'}</div>`
    ).join('');
    _bpActive = _bpData[0]?.name || '';
  } catch (e) { panels.textContent = '加载失败'; }
}

function showBlueprintTab(name) {
  const tabRow = document.getElementById('blueprintTabRow');
  if (!tabRow) return;
  tabRow.querySelectorAll('.sub-tab').forEach(b => b.classList.toggle('active', b.dataset.bp === name));
  document.querySelectorAll('#blueprintPanels .sub-panel').forEach(p => p.classList.toggle('active', p.id === 'bp-panel-' + name));
  _bpActive = name;
}

/* ─── MCP ─────────────────────────────────────────────────────── */
async function loadMCP() {
  const el = document.getElementById('mcpList');
  if (!el) return;
  try {
    const d = await fetch('/api/mcp').then(r => r.json());
    if (!d.servers || !d.servers.length) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">暂无 MCP 服务，点击「新增」添加</p>';
      return;
    }
    let h = '<div class="table-wrap"><table><thead><tr><th>名称</th><th>传输</th><th>连接</th><th>状态</th><th>工具数</th><th>操作</th></tr></thead><tbody>';
    for (const s of d.servers) {
      const transport = s.transport || 'stdio';
      const connInfo = transport === 'sse' ? `<code>${esc(s.url||'')}</code>` : `<code>${esc((s.command||'')+' '+(s.args||[]).join(' '))}</code>`;
      const statusBadge = s.running ? '<span class="badge on">运行中</span>' : '<span class="badge off">停止</span>';
      const transportBadge = transport==='sse' ? '<span class="badge info">SSE</span>' : '<span class="badge muted">stdio</span>';
      let actions = '';
      if (s.running) actions += `<button class="btn btn-secondary btn-sm" onclick="mcpStop('${esc(s.name)}')">停止</button> `;
      else           actions += `<button class="btn btn-success btn-sm" onclick="mcpStart('${esc(s.name)}')">启动</button> `;
      actions += `<button class="btn btn-danger btn-sm" onclick="mcpDelete('${esc(s.name)}')">删除</button>`;
      h += `<tr><td><strong>${esc(s.name)}</strong></td><td>${transportBadge}</td><td style="max-width:180px;overflow:hidden">${connInfo}</td><td>${statusBadge}</td><td>${s.tools?.length||0}</td><td><div style="display:flex;gap:6px">${actions}</div></td></tr>`;
    }
    el.innerHTML = h + '</tbody></table></div>';
  } catch (e) { el.textContent = '加载失败'; }
}

function onMCPTransportChange() {
  const v = document.getElementById('mcpTransport').value;
  document.getElementById('mcpStdioFields').style.display = v==='stdio' ? '' : 'none';
  document.getElementById('mcpSSEFields').style.display   = v==='sse'   ? '' : 'none';
}

function showMCPCreateModal() {
  document.getElementById('mcpCommandArgsList').innerHTML = '';
  document.getElementById('mcpEnvList').innerHTML = '';
  document.getElementById('mcpTransport').value = 'stdio';
  document.getElementById('mcpSSEUrl').value = '';
  onMCPTransportChange();
  addMCPArgvRow('npx'); addMCPArgvRow('-y'); addMCPArgvRow('@modelcontextprotocol/server-filesystem');
  addMCPEnvRow('', '');
  showModal('mcpCreateModal');
}

function addMCPArgvRow(val) {
  const list = document.getElementById('mcpCommandArgsList');
  const n = list.querySelectorAll('.mcp-argv-row').length + 1;
  const row = document.createElement('div');
  row.className = 'mcp-argv-row input-row';
  row.innerHTML = `<input type="text" class="mcp-argv-item" placeholder="${n===1?'命令（如 npx）':'参数'}" style="flex:1"><button type="button" class="remove-btn" onclick="this.closest('.mcp-argv-row').remove()">✕</button>`;
  list.appendChild(row);
  row.querySelector('.mcp-argv-item').value = val || '';
}

function addMCPEnvRow(k, v) {
  const list = document.getElementById('mcpEnvList');
  const row = document.createElement('div');
  row.className = 'mcp-env-row input-row';
  row.innerHTML = `<input type="text" class="mcp-env-key" placeholder="KEY" style="width:120px"><input type="text" class="mcp-env-val" placeholder="值" style="flex:1"><button type="button" class="remove-btn" onclick="this.closest('.mcp-env-row').remove()">✕</button>`;
  list.appendChild(row);
  row.querySelector('.mcp-env-key').value = k || '';
  row.querySelector('.mcp-env-val').value = v || '';
}

async function doCreateMCP() {
  const name = document.getElementById('mcpName').value.trim();
  const transport = document.getElementById('mcpTransport').value;
  const env = {};
  document.querySelectorAll('.mcp-env-row').forEach(row => {
    const k = (row.querySelector('.mcp-env-key').value||'').trim();
    if (k) env[k] = (row.querySelector('.mcp-env-val').value||'').trim();
  });
  if (!name) { toast('请填写名称', 'error'); return; }
  let payload;
  if (transport === 'sse') {
    const url = document.getElementById('mcpSSEUrl').value.trim();
    if (!url) { toast('请填写服务器 URL', 'error'); return; }
    payload = { action:'create', name, transport:'sse', url, env };
  } else {
    const argvItems = Array.from(document.querySelectorAll('.mcp-argv-item')).map(e=>e.value.trim()).filter(Boolean);
    const command = argvItems[0]||'';
    if (!command) { toast('请填写命令', 'error'); return; }
    payload = { action:'create', name, transport:'stdio', command, args:argvItems.slice(1), env };
  }
  try {
    const r = await fetch('/api/mcp', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) }).then(r=>r.json());
    if (r.text) { hideModal('mcpCreateModal'); document.getElementById('mcpName').value=''; loadMCP(); toast(r.text, 'success'); }
    else toast(r.error || '添加失败', 'error');
  } catch (e) { toast('请求失败', 'error'); }
}

async function mcpStart(name)  { try { const r=await fetch('/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start',name})}).then(r=>r.json()); loadMCP(); if(r.text)toast(r.text,'success'); }catch(e){toast('请求失败','error');} }
async function mcpStop(name)   { try { await fetch('/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'stop',name})}); loadMCP(); }catch(e){toast('请求失败','error');} }
async function mcpDelete(name) { if(!confirm('确定删除 MCP 服务「'+name+'」？'))return; try{await fetch('/api/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',name})});loadMCP();}catch(e){toast('请求失败','error');} }

/* ─── Skills ───────────────────────────────────────────────────── */
async function loadSkills() {
  const el = document.getElementById('skillsList');
  if (!el) return;
  try {
    const d = await fetch('/api/skills').then(r => r.json());
    if (!d.skills || !d.skills.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">暂无 Skills</p>'; return; }
    let h = '';
    for (const s of d.skills) {
      const srcBadge = s.source === 'builtin' ? '<span class="badge info">内置</span>' : '<span class="badge muted">自定义</span>';
      const delBtn   = s.source === 'customized' ? `<button class="btn btn-danger btn-sm" onclick="deleteSkill('${esc(s.name).replace(/'/g,"\\'")}')">删除</button>` : '';
      h += `<div class="skill-item">
        <div class="skill-info">
          <div class="skill-name">${esc(s.name)} ${srcBadge}</div>
          <div class="skill-desc">${esc(s.description)}</div>
        </div>
        <div class="skill-actions">
          <button class="btn btn-secondary btn-sm" onclick="showSkillDetail('${esc(s.name).replace(/'/g,"\\'")}')">详情</button>
          ${delBtn}
          <label class="toggle"><input type="checkbox" ${s.enabled?'checked':''} onchange="toggleSkill('${esc(s.name).replace(/'/g,"\\'")}',this.checked)"><span class="slider"></span></label>
        </div>
      </div>`;
    }
    el.innerHTML = h;
  } catch (e) { el.textContent = '加载失败'; }
}

async function showSkillDetail(name) {
  document.getElementById('skillDetailTitle').textContent = name + ' — 详情';
  document.getElementById('skillDetailContent').textContent = '加载中...';
  showModal('skillDetailModal');
  try {
    const r = await fetch('/api/skills/' + encodeURIComponent(name) + '/content').then(r=>r.json());
    document.getElementById('skillDetailContent').textContent = r.content != null && r.content !== '' ? r.content : '无内容';
  } catch (e) { document.getElementById('skillDetailContent').textContent = '加载失败'; }
}

async function toggleSkill(name, enabled) {
  await fetch('/api/skills/' + encodeURIComponent(name) + '/' + (enabled?'enable':'disable'), {method:'POST'});
  loadSkills();
}
async function deleteSkill(name) {
  if (!confirm('确定删除 ' + name + '？')) return;
  await fetch('/api/skills/' + encodeURIComponent(name), {method:'DELETE'});
  loadSkills();
}
async function doInstall() {
  const url = document.getElementById('installUrl').value;
  if (!url) return;
  try {
    const r = await fetch('/api/skills/hub/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}).then(r=>r.json());
    toast('安装成功: ' + r.name, 'success');
    hideModal('installModal');
    loadSkills();
  } catch (e) { toast('安装失败: ' + e.message, 'error'); }
}
async function doCreate() {
  const name = document.getElementById('createName').value;
  const content = document.getElementById('createContent').value;
  if (!name || !content) return;
  await fetch('/api/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,content})});
  hideModal('createModal');
  loadSkills();
}
async function doSkillsReconnect() {
  const btn = document.getElementById('skillsReconnectBtn');
  setBtnLoading(btn, true, '重连中...');
  try {
    const r = await fetch('/api/skills/reconnect',{method:'POST'}).then(x=>x.json());
    if (r.ok) toast(r.message||'已重连', 'success');
    else toast(r.error||'重连失败', 'error');
  } catch (e) { toast('请求失败', 'error'); }
  setBtnLoading(btn, false);
}
function showInstallModal() { document.getElementById('installUrl').value=''; showModal('installModal'); }
function showCreateModal()  { document.getElementById('createName').value=''; document.getElementById('createContent').value=''; showModal('createModal'); }

/* ─── Platform configs ────────────────────────────────────────── */
async function loadEmailConfig() {
  try {
    const c = await fetch('/api/email/config').then(r=>r.json());
    document.getElementById('emailImapHost').value = c.imapHost||'';
    document.getElementById('emailImapUser').value = c.imapUser||'';
    document.getElementById('emailImapPassword').value = c.imapPassword||'';
    document.getElementById('emailImapPort').value = c.imapPort||993;
    document.getElementById('emailSmtpHost').value = c.smtpHost||'';
    document.getElementById('emailSmtpPort').value = c.smtpPort||465;
    document.getElementById('emailSmtpUser').value = c.smtpUser||'';
    document.getElementById('emailSmtpPassword').value = c.smtpPassword||'';
    document.getElementById('emailStatusBadge').innerHTML = renderBadge(c.running, c.configured);
    updateNavBadge('email', c.running, c.configured);
  } catch (e) {}
}
async function saveEmailConfig() {
  const btn = document.getElementById('saveEmailBtn');
  const data = {
    imapHost: document.getElementById('emailImapHost').value.trim(),
    imapUser: document.getElementById('emailImapUser').value.trim(),
    imapPassword: document.getElementById('emailImapPassword').value,
    imapPort: parseInt(document.getElementById('emailImapPort').value)||993,
    smtpHost: document.getElementById('emailSmtpHost').value.trim()||undefined,
    smtpPort: parseInt(document.getElementById('emailSmtpPort').value)||undefined,
    smtpUser: document.getElementById('emailSmtpUser').value.trim()||undefined,
    smtpPassword: document.getElementById('emailSmtpPassword').value||undefined,
  };
  if (!data.imapHost || !data.imapUser) { toast('请至少填写 IMAP 主机和用户名', 'error'); return; }
  setBtnLoading(btn, true, '保存中...');
  try {
    const r = await fetch('/api/email/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(r=>r.json());
    if (r.ok) { toast(r.message||'已保存', 'success'); setTimeout(loadEmailConfig, 2000); }
    else toast(r.error||'保存失败', 'error');
  } catch (e) { toast('请求失败', 'error'); }
  setBtnLoading(btn, false);
}

async function loadFeishuConfig() {
  try {
    const c = await fetch('/api/feishu/config').then(r=>r.json());
    document.getElementById('feishuAppId').value = c.appId||'';
    document.getElementById('feishuAppSecret').value = c.appSecret||'';
    document.getElementById('feishuStatusBadge').innerHTML = renderBadge(c.running, c.configured);
    updateNavBadge('feishu', c.running, c.configured);
  } catch (e) {}
}
async function saveFeishuConfig() {
  const btn = document.getElementById('saveFeishuBtn');
  const data = { appId: document.getElementById('feishuAppId').value.trim(), appSecret: document.getElementById('feishuAppSecret').value };
  if (!data.appId) { toast('请填写 App ID', 'error'); return; }
  setBtnLoading(btn, true, '保存中...');
  try {
    const r = await fetch('/api/feishu/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(r=>r.json());
    if (r.ok) { toast(r.message||'已保存', 'success'); setTimeout(loadFeishuConfig, 2000); }
    else toast(r.error||'保存失败', 'error');
  } catch (e) { toast('请求失败', 'error'); }
  setBtnLoading(btn, false);
}

async function loadDingtalkConfig() {
  try {
    const c = await fetch('/api/dingtalk/config').then(r=>r.json());
    document.getElementById('dingtalkClientId').value = c.clientId||'';
    document.getElementById('dingtalkClientSecret').value = c.clientSecret||'';
    document.getElementById('dingtalkStatusBadge').innerHTML = renderBadge(c.running, c.configured);
    updateNavBadge('dingtalk', c.running, c.configured);
  } catch (e) {}
}
async function saveDingtalkConfig() {
  const btn = document.getElementById('saveDingtalkBtn');
  const data = { clientId: document.getElementById('dingtalkClientId').value.trim(), clientSecret: document.getElementById('dingtalkClientSecret').value };
  if (!data.clientId) { toast('请填写 Client ID', 'error'); return; }
  setBtnLoading(btn, true, '保存中...');
  try {
    const r = await fetch('/api/dingtalk/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(r=>r.json());
    if (r.ok) { toast(r.message||'已保存', 'success'); setTimeout(loadDingtalkConfig, 2000); }
    else toast(r.error||'保存失败', 'error');
  } catch (e) { toast('请求失败', 'error'); }
  setBtnLoading(btn, false);
}

async function loadQQConfig() {
  try {
    const c = await fetch('/api/qq/config').then(r=>r.json());
    document.getElementById('qqAppId').value = c.appId||'';
    document.getElementById('qqAppSecret').value = c.appSecret||'';
    document.getElementById('qqApiBase').value = c.apiBase||'';
    document.getElementById('qqStatusBadge').innerHTML = renderBadge(c.running, c.configured);
    updateNavBadge('qq', c.running, c.configured);
  } catch (e) {}
}
async function saveQQConfig() {
  const btn = document.getElementById('saveQQBtn');
  const data = { appId: document.getElementById('qqAppId').value.trim(), appSecret: document.getElementById('qqAppSecret').value, apiBase: document.getElementById('qqApiBase').value.trim()||undefined };
  if (!data.appId) { toast('请填写 App ID', 'error'); return; }
  setBtnLoading(btn, true, '保存中...');
  try {
    const r = await fetch('/api/qq/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(r=>r.json());
    if (r.ok) { toast(r.message||'已保存', 'success'); setTimeout(loadQQConfig, 2000); }
    else toast(r.error||'保存失败', 'error');
  } catch (e) { toast('请求失败', 'error'); }
  setBtnLoading(btn, false);
}

/* ─── Env Check ────────────────────────────────────────────────── */
const ENV_ICONS = { node:'⬡', python:'🐍', playwright:'🎭' };

async function loadEnvCheck() {
  const el = document.getElementById('envCheckList');
  const row = document.getElementById('envInstallRow');
  if (!el) return;
  try {
    const d = await fetch('/api/env/check').then(r=>r.json());
    const runtimes = d.runtimes || [];
    let hasAutoMissing = false;
    let h = '';
    for (const r of runtimes) {
      if (r.canAutoInstall && !r.ok) hasAutoMissing = true;
      const icon = ENV_ICONS[r.id] || '📦';
      h += `<div class="env-item">
        <div class="env-icon ${r.ok?'ok':'fail'}">${icon}</div>
        <div class="env-body">
          <div class="env-name">${esc(r.name)} ${r.ok ? '<span class="badge on">已安装</span>' : '<span class="badge off">未安装</span>'}</div>
          <div class="env-desc">${esc(r.description)}</div>
          ${r.ok && r.detail ? `<div class="env-detail">${esc(r.detail)}</div>` : ''}
        </div>
        <div>
      ${!r.ok && r.hint ? `<button class="btn btn-secondary btn-sm env-hint-btn" data-name="${esc(r.name)}" data-hint="${esc(r.hint||'')}">安装教程</button>` : ''}
        </div>
      </div>`;
    }
    el.innerHTML = h || '<p style="color:var(--text-muted);font-size:14px">暂无检测项</p>';
    if (row) row.style.display = hasAutoMissing ? '' : 'none';

    // 用事件委托处理「安装教程」按钮，避免在 onclick 属性里拼接含特殊字符的字符串
    el.querySelectorAll('.env-hint-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-name') || '';
        const hint = btn.getAttribute('data-hint') || '';
        document.getElementById('envHintModalTitle').textContent = name + ' 安装说明';
        document.getElementById('envHintModalContent').textContent = hint;
        showModal('envHintModal');
      });
    });
  } catch (e) { el.textContent = '加载失败'; if (row) row.style.display='none'; }
}

async function doEnvInstall() {
  const btn = document.getElementById('envInstallBtn');
  setBtnLoading(btn, true, '安装中...');
  try {
    const r = await fetch('/api/env/install',{method:'POST'}).then(x=>x.json());
    if (r.installed?.length) toast('已安装: ' + r.installed.join(', '), 'success');
    if (r.errors?.length)   toast('安装失败: ' + r.errors.join('; '), 'error');
    loadEnvCheck();
  } catch (e) { toast('请求失败', 'error'); }
  setBtnLoading(btn, false);
}

/* ─── Init ─────────────────────────────────────────────────────── */
async function init() {
  await loadStatus();
  // 预加载通道状态用于侧边栏 badge
  try {
    const [emailCfg, feishuCfg, dingtalkCfg, qqCfg] = await Promise.allSettled([
      fetch('/api/email/config').then(r=>r.json()),
      fetch('/api/feishu/config').then(r=>r.json()),
      fetch('/api/dingtalk/config').then(r=>r.json()),
      fetch('/api/qq/config').then(r=>r.json()),
    ]);
    if (emailCfg.status==='fulfilled')    updateNavBadge('email',    emailCfg.value.running,    emailCfg.value.configured);
    if (feishuCfg.status==='fulfilled')   updateNavBadge('feishu',   feishuCfg.value.running,   feishuCfg.value.configured);
    if (dingtalkCfg.status==='fulfilled') updateNavBadge('dingtalk', dingtalkCfg.value.running, dingtalkCfg.value.configured);
    if (qqCfg.status==='fulfilled')       updateNavBadge('qq',       qqCfg.value.running,       qqCfg.value.configured);
  } catch (e) {}
}

init();
setInterval(loadStatus, 15000);

/* ─── Restore last nav on page load ────────────────────────── */
(function restoreNav() {
  const saved = localStorage.getItem('ailo_nav');
  if (saved && document.getElementById('panel-' + saved)) nav(saved);
})();
