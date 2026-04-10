/* ─── Runtime config injected by server ───────────────────────── */
const SHOW_CONNECTION_FORM = window.SHOW_CONNECTION_FORM === true;

/* ─── Toast ───────────────────────────────────────────────────── */
const ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
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
  if (configured) return '<span class="badge warning">已配置</span>';
  return '<span class="badge muted">未配置</span>';
}

function updateNavBadge(id, running, configured) {
  const el = document.getElementById(id + 'NavBadge');
  if (!el) return;
  if (running)    { el.style.display=''; el.className='nav-badge on';  el.textContent='在线'; }
  else if (configured) { el.style.display=''; el.className='nav-badge warning'; el.textContent='已配置'; }
  else { el.style.display='none'; }
}

function updateBadgeCount(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) {
    el.textContent = count;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

/* ─── Navigation ──────────────────────────────────────────────── */
function nav(name) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  localStorage.setItem('ailo_nav', name);

  switch (name) {
    case 'status':
      loadStatus();
      if (SHOW_CONNECTION_FORM) loadConnectionForm();
      break;
    case 'env':
      loadEnvCheck();
      break;
    case 'mcp':      loadMCP(); break;
    case 'tools':    toolsSub(localStorage.getItem('ailo_tools_sub') || 'tools'); break;
  }
}

function toolsSub(sub) {
  document.querySelectorAll('#panel-tools .sub-tab').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  document.querySelectorAll('#panel-tools .sub-panel').forEach(p => p.classList.toggle('active', p.id === 'sub-' + sub));
  localStorage.setItem('ailo_tools_sub', sub);
  if (sub === 'tools') refreshTools();
  else if (sub === 'skills') loadReportedSkills();
}

function hideModal(id) { document.getElementById(id).classList.remove('open'); }
function showModal(id)  { document.getElementById(id).classList.add('open'); }

/* ─── Status ──────────────────────────────────────────────────── */
let lastStatus = { connected: false, endpointId: '' };

async function loadStatus() {
  try {
    const s = await fetch('/api/status').then(r => r.json());
    lastStatus = s;

    // 侧边栏状态
    const dot = document.getElementById('globalDot');
    const gs  = document.getElementById('globalStatus');
    if (dot) dot.className = 'status-dot ' + (s.connected ? 'on' : 'off');
    if (gs)  gs.textContent = s.connected ? '已连接' : '未连接';

    // 状态页
    const title = document.getElementById('statusTitle');
    const subtitle = document.getElementById('statusSubtitle');
    if (title) title.textContent = s.connected ? '已连接' : '未连接';
    if (subtitle) subtitle.textContent = s.connected
      ? `端点 ${s.endpointId || '-'} 已连接到 Ailo`
      : '尚未连接至 Ailo 服务';

    // 状态卡片统计
    const icon = document.getElementById('statusIcon');
    if (icon) {
      icon.className = 'status-icon ' + (s.connected ? 'connected' : 'disconnected');
    }

    // 更新端点 ID
    const epEl = document.getElementById('statEndpointId');
    if (epEl) epEl.textContent = s.endpointId || '-';

    // 工具数量和 MCP 数量需要额外请求
    if (s.connected) {
      refreshToolsCount();
      loadMcpCount();
    } else {
      updateBadgeCount('toolsCount', 0);
      updateBadgeCount('mcpCount', 0);
      const toolCountEl = document.getElementById('statToolCount');
      const mcpCountEl = document.getElementById('statMcpCount');
      if (toolCountEl) toolCountEl.textContent = '-';
      if (mcpCountEl) mcpCountEl.textContent = '-';
    }

    // 运行时间
    const uptimeEl = document.getElementById('statUptime');
    if (uptimeEl) uptimeEl.textContent = s.uptime || '-';

  } catch (e) {
    console.error('Failed to load status:', e);
  }
}

async function refreshToolsCount() {
  try {
    const tools = await fetch('/api/tools').then(r => r.json());
    const count = Array.isArray(tools) ? tools.length : 0;
    updateBadgeCount('toolsCount', count);
    const el = document.getElementById('statToolCount');
    if (el) el.textContent = count;
    return count;
  } catch (e) {
    return 0;
  }
}

async function loadMcpCount() {
  try {
    const d = await fetch('/api/mcp').then(r => r.json());
    const runningCount = (d.servers || []).filter(s => s.running).length;
    updateBadgeCount('mcpCount', runningCount);
    const el = document.getElementById('statMcpCount');
    if (el) el.textContent = runningCount;
    return runningCount;
  } catch (e) {
    return 0;
  }
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
    const r = await fetch('/api/connection', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ailoWsUrl:wsUrl, ailoApiKey:apiKey, endpointId}) }).then(r=>r.json());
    if (r.ok) {
      toast(r.message || '配置已保存，将自动重连', 'success');
      let cnt = 0;
      const iv = setInterval(async () => {
        await loadStatus();
        if (++cnt >= 10) clearInterval(iv);
      }, 2000);
    } else toast(r.error || '保存失败', 'error');
  } catch (e) { toast('请求失败', 'error'); }
  setBtnLoading(btn, false);
}

/* ─── Tools & Skills ──────────────────────────────────────────── */
async function refreshTools() {
  const el = document.getElementById('reportedToolsList');
  if (!el) return;
  el.innerHTML = '<div class="loading-text">加载中...</div>';

  try {
    const [toolsData, mcpData] = await Promise.all([
      fetch('/api/tools').then(r => r.json()).catch(() => []),
      fetch('/api/mcp').then(r => r.json()).catch(() => ({ servers: [] }))
    ]);

    const tools = Array.isArray(toolsData) ? toolsData : [];
    const mcpServers = mcpData.servers || [];
    const runningMcpServers = mcpServers.filter(s => s.running);

    // 按来源分组
    const builtinTools = tools.filter(t => t.source === 'builtin');
    const mcpTools = tools.filter(t => t.source === 'mcp');

    if (tools.length === 0 && runningMcpServers.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">暂无工具</p>';
      updateBadgeCount('toolsCount', 0);
      return;
    }

    let html = '';

    // 内置工具
    if (builtinTools.length > 0) {
      html += `<div class="tools-section">
        <div class="tools-section-title">内置工具 <span class="count">${builtinTools.length}</span></div>
        <div class="tools-grid">`;
      for (const t of builtinTools) {
        html += `<div class="tool-item">
          <div class="tool-name"><code>${esc(t.name)}</code></div>
          <div class="tool-desc">${esc(t.description)}</div>
        </div>`;
      }
      html += '</div></div>';
    }

    // MCP 工具
    if (mcpTools.length > 0 || runningMcpServers.length > 0) {
      html += `<div class="tools-section">
        <div class="tools-section-title">MCP 工具 <span class="count">${mcpTools.length}</span></div>`;

      if (mcpTools.length > 0) {
        html += '<div class="tools-grid">';
        for (const t of mcpTools) {
          html += `<div class="tool-item">
            <div class="tool-name"><code>${esc(t.name)}</code></div>
            <div class="tool-desc">${esc(t.description)}</div>
          </div>`;
        }
        html += '</div>';
      } else {
        html += '<p class="tools-empty">无运行中的 MCP 服务</p>';
      }
      html += '</div>';
    }

    el.innerHTML = html;

    // 更新 tab 计数
    const toolsTabCount = document.getElementById('toolsTabCount');
    if (toolsTabCount) toolsTabCount.textContent = tools.length;

    // 更新侧边栏计数
    updateBadgeCount('toolsCount', tools.length);

    // 更新状态页
    const toolCountEl = document.getElementById('statToolCount');
    if (toolCountEl) toolCountEl.textContent = tools.length;

  } catch (e) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">加载失败</p>';
  }
}

async function loadReportedTools() {
  await refreshTools();
}

async function loadReportedSkills() {
  const el = document.getElementById('reportedSkillsList');
  if (!el) return;
  el.innerHTML = '<div class="loading-text">加载中...</div>';
  try {
    const d = await fetch('/api/skills').then(r => r.json());
    const skills = Array.isArray(d) ? d : [];
    if (skills.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">暂无技能</p>';
      const tabCount = document.getElementById('skillsTabCount');
      if (tabCount) tabCount.textContent = '0';
      return;
    }
    let html = '<div class="skills-grid">';
    for (const s of skills) {
      html += `<div class="skill-item">
        <div class="skill-name">${esc(s.name)}</div>
        <div class="skill-desc">${esc(s.description)}</div>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;

    const tabCount = document.getElementById('skillsTabCount');
    if (tabCount) tabCount.textContent = skills.length;
  } catch (e) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">加载失败</p>';
  }
}

/* ─── MCP ─────────────────────────────────────────────────────── */
async function loadMCP() {
  const el = document.getElementById('mcpList');
  if (!el) return;
  el.innerHTML = '<div class="loading-text">加载中...</div>';
  try {
    const d = await fetch('/api/mcp').then(r => r.json());
    const servers = d.servers || [];

    if (servers.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">暂无 MCP 服务，点击「新增」添加</p>';
      updateBadgeCount('mcpCount', 0);
      const mcpCountEl = document.getElementById('statMcpCount');
      if (mcpCountEl) mcpCountEl.textContent = '0';
      return;
    }

    let html = '<div class="mcp-servers">';
    for (const s of servers) {
      const transport = s.transport || 'stdio';
      const connInfo = transport === 'sse'
        ? `<code>${esc(s.url||'')}</code>`
        : `<code>${esc((s.command||'')+' '+(s.args||[]).join(' '))}</code>`;
      const statusClass = s.running ? 'running' : 'stopped';
      const statusText = s.running ? '运行中' : '已停止';
      const mcpToolsCount = s.tools?.length || 0;

      html += `<div class="mcp-server-item ${statusClass}">
        <div class="mcp-server-header">
          <div class="mcp-server-name">${esc(s.name)}</div>
          <div class="mcp-server-status">
            <span class="status-dot ${statusClass}"></span>
            ${statusText}
          </div>
        </div>
        <div class="mcp-server-conn">${connInfo}</div>
        <div class="mcp-server-footer">
          <div class="mcp-server-tools">${mcpToolsCount} 个工具</div>
          <div class="mcp-server-actions">
            ${s.running
              ? `<button class="btn btn-secondary btn-sm" onclick="mcpStop('${esc(s.name)}')">停止</button>`
              : `<button class="btn btn-success btn-sm" onclick="mcpStart('${esc(s.name)}')">启动</button>`
            }
            <button class="btn btn-secondary btn-sm" onclick="showMCPEditModal('${esc(s.name)}')">编辑</button>
            <button class="btn btn-danger btn-sm" onclick="mcpDelete('${esc(s.name)}')">删除</button>
          </div>
        </div>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;

    // 更新计数
    const runningCount = servers.filter(s => s.running).length;
    updateBadgeCount('mcpCount', runningCount);
    const mcpCountEl = document.getElementById('statMcpCount');
    if (mcpCountEl) mcpCountEl.textContent = runningCount;

  } catch (e) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">加载失败</p>';
  }
}

function onMCPTransportChange() {
  const v = document.getElementById('mcpTransport').value;
  document.getElementById('mcpStdioFields').style.display = v === 'stdio' ? '' : 'none';
  document.getElementById('mcpSSEFields').style.display   = v === 'sse'   ? '' : 'none';
}

function showMCPCreateModal() {
  document.getElementById('mcpName').value = '';
  document.getElementById('mcpName').readOnly = false;
  document.getElementById('mcpCommandArgsList').innerHTML = '';
  document.getElementById('mcpEnvList').innerHTML = '';
  document.getElementById('mcpTransport').value = 'stdio';
  document.getElementById('mcpSSEUrl').value = '';
  onMCPTransportChange();
  addMCPArgvRow('npx'); addMCPArgvRow('-y'); addMCPArgvRow('@modelcontextprotocol/server-filesystem');
  addMCPEnvRow('', '');
  document.querySelector('#mcpCreateModal .modal-title').textContent = '新增 MCP 服务';
  document.querySelector('#mcpCreateModal .modal-footer .btn-primary').textContent = '添加';
  document.querySelector('#mcpCreateModal .modal-footer .btn-primary').onclick = doCreateMCP;
  showModal('mcpCreateModal');
}

async function showMCPEditModal(name) {
  try {
    const d = await fetch('/api/mcp').then(r => r.json());
    const server = (d.servers || []).find(s => s.name === name);
    if (!server) {
      toast('未找到该 MCP 服务', 'error');
      return;
    }

    document.getElementById('mcpName').value = server.name;
    document.getElementById('mcpName').readOnly = true;
    document.getElementById('mcpTransport').value = server.transport || 'stdio';
    document.getElementById('mcpCommandArgsList').innerHTML = '';
    document.getElementById('mcpEnvList').innerHTML = '';

    if (server.transport === 'sse') {
      document.getElementById('mcpSSEUrl').value = server.url || '';
    } else {
      const command = server.command || '';
      const args = server.args || [];
      if (command) {
        addMCPArgvRow(command);
        for (const arg of args) {
          addMCPArgvRow(arg);
        }
      }
    }

    if (server.env) {
      for (const [k, v] of Object.entries(server.env)) {
        addMCPEnvRow(k, v);
      }
    }

    onMCPTransportChange();
    document.querySelector('#mcpCreateModal .modal-title').textContent = '编辑 MCP 服务';
    document.querySelector('#mcpCreateModal .modal-footer .btn-primary').textContent = '保存';
    document.querySelector('#mcpCreateModal .modal-footer .btn-primary').onclick = doUpdateMCP;
    showModal('mcpCreateModal');
  } catch (e) {
    toast('加载失败', 'error');
  }
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
    if (r.text) {
      hideModal('mcpCreateModal');
      toast('MCP 服务已添加', 'success');
      await loadMCP();
      await refreshTools();
    } else {
      toast(r.error || '添加失败', 'error');
    }
  } catch (e) { toast('请求失败', 'error'); }
}

async function doUpdateMCP() {
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
    payload = { action:'update', name, transport:'sse', url, env };
  } else {
    const argvItems = Array.from(document.querySelectorAll('.mcp-argv-item')).map(e=>e.value.trim()).filter(Boolean);
    const command = argvItems[0]||'';
    if (!command) { toast('请填写命令', 'error'); return; }
    payload = { action:'update', name, transport:'stdio', command, args:argvItems.slice(1), env };
  }

  try {
    const r = await fetch('/api/mcp', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) }).then(r=>r.json());
    if (r.text) {
      hideModal('mcpCreateModal');
      toast('MCP 服务已更新', 'success');
      await loadMCP();
      await refreshTools();
    } else {
      toast(r.error || '更新失败', 'error');
    }
  } catch (e) { toast('请求失败', 'error'); }
}

async function mcpStart(name) {
  try {
    const r = await fetch('/api/mcp', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'start', name})}).then(r=>r.json());
    if (r.text) toast(r.text, 'success');
    await loadMCP();
    await refreshTools(); // 刷新工具列表
  } catch (e) { toast('请求失败', 'error'); }
}

async function mcpStop(name) {
  try {
    await fetch('/api/mcp', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'stop', name})});
    toast('MCP 服务已停止', 'info');
    await loadMCP();
    await refreshTools(); // 刷新工具列表
  } catch (e) { toast('请求失败', 'error'); }
}

async function mcpDelete(name) {
  if (!confirm(`确定删除 MCP 服务「${name}」？`)) return;
  try {
    await fetch('/api/mcp', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'delete', name})});
    toast('MCP 服务已删除', 'success');
    await loadMCP();
    await refreshTools(); // 刷新工具列表
  } catch (e) { toast('请求失败', 'error'); }
}

/* ─── Env Check ────────────────────────────────────────────────── */
const ENV_ICONS = { node:'⬡', python:'🐍' };

async function loadEnvCheck() {
  const el = document.getElementById('envCheckList');
  const row = document.getElementById('envInstallRow');
  if (!el) return;
  if (!el.closest('.panel')?.classList.contains('active')) return;
  el.innerHTML = '<div class="loading-text">加载中...</div>';
  try {
    const d = await fetch('/api/env/check').then(r=>r.json());
    const runtimes = d.runtimes || [];
    let hasAutoMissing = false;
    let h = '<div class="env-grid">';
    for (const r of runtimes) {
      if (r.canAutoInstall && !r.ok) hasAutoMissing = true;
      const icon = ENV_ICONS[r.id] || '📦';
      const statusClass = r.ok ? 'ok' : 'fail';
      h += `<div class="env-item ${statusClass}">
        <div class="env-icon">${icon}</div>
        <div class="env-info">
          <div class="env-name">${esc(r.name)}</div>
          <div class="env-desc">${esc(r.description)}</div>
          ${r.ok && r.detail ? `<div class="env-detail">${esc(r.detail)}</div>` : ''}
        </div>
        <div class="env-action">
          ${r.ok ? `<span class="badge on">已安装</span>` : ''}
          ${!r.ok && r.hint ? `<button class="btn btn-secondary btn-sm env-hint-btn" data-name="${esc(r.name)}" data-hint="${esc(r.hint||'')}">安装教程</button>` : ''}
        </div>
      </div>`;
    }
    h += '</div>';
    el.innerHTML = h || '<p style="color:var(--text-muted);font-size:14px">暂无检测项</p>';
    if (row) row.style.display = hasAutoMissing ? '' : 'none';

    el.querySelectorAll('.env-hint-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-name') || '';
        const hint = btn.getAttribute('data-hint') || '';
        document.getElementById('envHintModalTitle').textContent = name + ' 安装说明';
        document.getElementById('envHintModalContent').textContent = hint;
        showModal('envHintModal');
      });
    });
  } catch (e) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:14px">加载失败</p>';
    if (row) row.style.display='none';
  }
}

async function doEnvInstall() {
  const btn = document.getElementById('envInstallBtn');
  setBtnLoading(btn, true, '安装中...');
  try {
    const r = await fetch('/api/env/install', { method:'POST'}).then(x=>x.json());
    if (r.installed?.length) toast('已安装: ' + r.installed.join(', '), 'success');
    if (r.errors?.length)   toast('安装失败: ' + r.errors.join('; '), 'error');
    loadEnvCheck();
  } catch (e) { toast('请求失败', 'error'); }
  setBtnLoading(btn, false);
}

/* ─── Init ─────────────────────────────────────────────────────── */
async function init() {
  await loadStatus();
}

init();
setInterval(loadStatus, 10000); // 状态轮询

/* ─── Restore last nav on page load ────────────────────────── */
(function restoreNav() {
  const saved = localStorage.getItem('ailo_nav');
  if (saved && document.getElementById('panel-' + saved)) nav(saved);
})();
