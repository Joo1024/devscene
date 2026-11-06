// Renderer deliberately has no Node access: every action goes through the application API.
interface Window { workscene: { call(action:string,payload?:unknown):Promise<any> } }
type Snapshot = import('../core/application').Application extends {snapshot():infer S} ? S : never;
type LocationView = import('../core/domain').Location;
type EnvView = import('../core/domain').Environment;
const $ = (id:string) => document.getElementById(id)!;
const escapeHTML = (value:unknown) => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const call = (action:string,payload?:unknown) => window.workscene.call(action,payload);
let data:Snapshot; let view='locations'; let worksetId=''; let selected=''; let refreshing=false;
let submitEditor: (()=>Promise<void>) | undefined;
const time=(n?:number)=>n?new Date(n).toLocaleString():'尚未成功扫描';
function notice(message:string,error=false) { $('notice').hidden=false; $('notice').textContent=message; $('notice').className=`notice${error?' error':''}`; }
async function run(action:()=>Promise<void>) { try { await action(); await refresh(); } catch(err) { notice(String(err).replace(/^Error: Error invoking remote method 'workscene': Error: /,''),true); } }
function envName(id:string) { return data.environments.find(e=>e.id===id)?.name ?? '未知环境'; }
function sessions(id:string) { return data.sessions.filter(s=>s.locationIds.includes(id)); }
function badge(text:string,kind='') { return `<span class="badge ${kind}">${escapeHTML(text)}</span>`; }
function navigate(next:string,ws='') { view=next;worksetId=ws;render(); }
function options() {
  const filter=$('environment-filter') as HTMLSelectElement;const previous=filter.value;
  filter.innerHTML='<option value="">全部环境</option>'+data.environments.map(e=>`<option value="${escapeHTML(e.id)}">${escapeHTML(e.name)}</option>`).join('');filter.value=previous;
}
function render() {
  if(!data)return;
  $('location-count').textContent=String(data.locations.length);$('window-count').textContent=String(data.sessions.length);$('workset-count').textContent=String(data.worksets.length);
  $('nav-count').textContent=String(data.locations.length);$('nav-sessions').textContent=String(data.sessions.length);
  $('connection-note').textContent=data.sessions.length?'仅包括已接入扩展的窗口':'尚未检测到有效会话';
  document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',(el as HTMLElement).dataset.view===view&&!worksetId));
  $('worksets').innerHTML=data.worksets.length?data.worksets.map(w=>`<button class="workset-button ${worksetId===w.id?'active':''}" data-ws="${escapeHTML(w.id)}">◈ <span>${escapeHTML(w.name)}</span><i>${w.locationIds.length}</i></button>`).join(''):'<p class="hint">还没有工作集。<br>先浏览位置，随时开始组织。</p>';
  const titles:Record<string,string>={locations:worksetId?(data.worksets.find(w=>w.id===worksetId)?.name??'工作集'):'回到你的工作现场',sessions:'已连接的 VS Code 窗口',environments:'环境与扫描',setup:'让工作现场连接起来'};
  $('title').textContent=titles[view];$('breadcrumb').textContent=worksetId?titles[view]:view==='locations'?'全部位置':titles[view];
  $('subtitle').textContent=view==='sessions'?'每个有效扩展实例对应一个窗口，多根工作区只计一次。':view==='environments'?'明确扫描范围，显式关联 SSH 别名。离线时保留最后成功发现。':view==='setup'?'几步完成接入。目录发现与窗口上报相互独立。':'发现散落的代码目录，把正在做的事放在一起。';
  $('toolbar').hidden=view!=='locations';
  if(view==='locations')renderLocations();else if(view==='sessions')renderSessions();else if(view==='environments')renderEnvironments();else renderSetup();
  const latest=data.operations.at(-1);
  if(latest){const labels:Record<string,string>={pending:'等待接收',accepted:'已接收',executed:'已执行，未确认激活',activated:'已确认激活',unsupported:'不支持',failed:'失败',timeout:'超时'};$('footer-status').textContent=`${labels[latest.state]} · ${latest.message}`;}
}
function renderLocations() {
  const query=($('search') as HTMLInputElement).value.toLocaleLowerCase();const env=($('environment-filter') as HTMLSelectElement).value;const state=($('session-filter') as HTMLSelectElement).value;
  const ws=data.worksets.find(w=>w.id===worksetId);
  const list=data.locations.filter(l=>(!env||l.environmentId===env)&&(!ws||ws.locationIds.includes(l.id))&&(!state||(state==='connected'?sessions(l.id).length>0:sessions(l.id).length===0))&&[l.name,l.path,l.checkout?.branch,envName(l.environmentId),...data.worksets.filter(w=>w.locationIds.includes(l.id)).map(w=>w.name)].join(' ').toLocaleLowerCase().includes(query)).sort((a,b)=>sessions(b.id).length-sessions(a.id).length||a.name.localeCompare(b.name));
  if(!list.some(l=>l.id===selected))selected=list[0]?.id??'';
  const heading=`<div class="list-heading"><span>${list.length} 个位置${ws?' · '+escapeHTML(ws.name):''}</span>${ws?`<button data-edit-ws="${escapeHTML(ws.id)}">编辑工作集</button>`:'<span>按连接状态排序</span>'}</div>`;
  if(!list.length){$('content').innerHTML=heading+`<div class="empty"><div class="empty-symbol">▧</div><h2>${data.locations.length?'没有匹配的位置':'从一个代码目录开始'}</h2><p>${data.locations.length?'试试不同的搜索词或筛选条件。':'添加普通目录，或设置扫描根目录来发现 Git checkout 与关联 worktree。扩展上报的扫描范围外目录也会出现在这里。'}</p><button class="primary" data-action="add">＋ 添加目录</button><button data-view="environments">配置扫描范围</button></div>`;return;}
  $('content').innerHTML=heading+`<div class="layout"><div class="location-list">${list.map(l=>{
    const s=sessions(l.id);const cache=data.cache[l.environmentId];
    return `<article class="location-card ${selected===l.id?'selected':''}" tabindex="0" role="button" data-location="${l.id}" aria-label="查看 ${escapeHTML(l.name)}"><div class="folder-icon">${l.checkout?'⑂':'▱'}</div><div class="location-main"><div class="card-title"><b>${escapeHTML(l.name)}</b>${s.length?badge(`${s.length} 个已连接窗口`,'green'):''}</div><div class="path">${escapeHTML(l.path)}</div><div class="tags">${badge(envName(l.environmentId))}${l.checkout?badge(l.checkout.kind==='worktree'?'worktree':'checkout')+badge(l.checkout.branch):badge('目录')}${l.source==='session'?badge('扩展发现 · 扫描范围外'):''}${l.exists===false?badge('路径缺失','amber'):''}${cache?.status==='offline'?badge('离线缓存','amber'):cache?.status==='error'?badge('扫描存在错误','amber'):''}${data.worksets.filter(w=>w.locationIds.includes(l.id)).map(w=>badge(w.name)).join('')}</div></div></article>`;
  }).join('')}</div>${detail(list.find(l=>l.id===selected)!)}</div>`;
}
function detail(l:LocationView) {
  const s=sessions(l.id);const e=data.environments.find(e=>e.id===l.environmentId)!;
  return `<aside class="detail"><span class="eyebrow">位置详情</span><h2>${escapeHTML(l.name)}</h2><div class="path">${escapeHTML(l.path)}</div><div class="meta"><span>环境</span><span>${escapeHTML(e.name)} · ${e.kind==='local'?'本机':'SSH'}</span></div><div class="meta"><span>发现来源</span><span>${l.source==='scan'?'目录扫描':l.source==='session'?'扩展上报':'用户保留'}</span></div>${l.checkout?`<div class="meta"><span>分支</span><span>${escapeHTML(l.checkout.branch)}</span></div><div class="path">${escapeHTML(l.checkout.head.slice(0,12))}</div>`:''}<button class="primary" data-open="${l.id}">在新窗口打开 ↗</button><h3>关联的已连接窗口 · ${s.length}</h3>${s.length?s.map(x=>`<div class="session-item"><strong>${escapeHTML(x.workspaceName)}</strong><p>${x.focused?'● 已知焦点':'○ 后台或焦点未知'} · ${x.folders.length} 个工作区目录</p><div class="path">实例 ${escapeHTML(x.instanceId.slice(0,8))}</div><button data-activate="${escapeHTML(x.instanceId)}" data-target-location="${l.id}">${x.capabilities.includes('activateSession')?'切换到此窗口':'检查激活能力'}</button></div>`).join(''):'<p class="hint">尚未检测到有效会话。此状态不代表确认没有打开窗口，请检查扩展接入。</p>'}<h3>组织</h3><button data-organize="${l.id}">＋ 加入 / 创建工作集</button>${s.length>1?'<p class="hint">此位置关联多个窗口，请明确选择要返回的实例。</p>':''}</aside>`;
}
function renderSessions() {
  $('content').innerHTML=(data.sessions.length?data.sessions.map(s=>`<section class="panel wide-session"><div><h3>${escapeHTML(s.workspaceName)} ${s.focused?badge('已知焦点','green'):''}</h3><p>${s.folders.length} 个工作区目录 · 实例 ${escapeHTML(s.instanceId.slice(0,8))} · VS Code ${escapeHTML(s.toolVersion)}</p>${s.folders.map(f=>`<div class="path">${escapeHTML(f.uri)}</div>`).join('')}${!s.folders.length?'<p class="hint">空窗口 · 无目录关联</p>':''}${s.unresolved.length?`<p class="error">${s.unresolved.length} 个 URI 尚未关联环境，请配置 SSH 别名；未识别的远端类型不会自动合并。</p>`:''}</div><button data-activate="${escapeHTML(s.instanceId)}">切换到此窗口 ↗</button></section>`).join(''):`<div class="empty"><div class="empty-symbol">▣</div><h2>尚未检测到有效会话</h2><p>安装并加载 WorkScene 扩展后，已连接的 VS Code 稳定版窗口会出现在这里。缺少上报不代表没有打开的窗口。</p><button class="primary" data-view="setup">检查扩展接入</button></div>`)+(data.expiredSessions.length?`<section class="panel"><h3>已过期的会话 · ${data.expiredSessions.length}</h3><p class="hint">这些实例已超过 35 秒未确认，不计入窗口总数，不支持跳转。窗口关闭或扩展重载后旧实例会自动淘汰，工作集保持不变。</p></section>`:'');
}
function renderEnvironments() {
  $('content').innerHTML=`<div class="list-heading"><span>环境身份与连接别名分开保存</span><button class="primary" data-new-env>＋ 添加 SSH 环境</button></div>`+data.environments.map(e=>{
    const c=data.cache[e.id];const states:Record<string,string>={online:'扫描成功',offline:'离线 · 已保留缓存',error:'扫描错误 · 已保留缓存',unknown:'尚未扫描'};
    return `<section class="panel"><h2>${escapeHTML(e.name)} ${badge(e.kind==='local'?'本机':'SSH')} ${badge(states[c?.status??'unknown'],c?.status==='online'?'green':'amber')}</h2>${e.kind==='ssh'?`<p>连接目标：${escapeHTML(e.target)} · 显式别名：${escapeHTML(e.aliases.join(', '))}</p>`:''}<p class="hint">扫描深度 ${e.depth} · ${e.caseSensitive?'区分':'不区分'}路径大小写 · 最后成功：${time(c?.lastSuccess)}</p>${e.roots.length?e.roots.map(r=>`<div class="path">${escapeHTML(r)}</div>`).join(''):'<p class="hint">尚未配置扫描根目录。普通目录请使用“添加目录”。</p>'}${c?.errors.length?`<pre class="error">${escapeHTML(c.errors.join('\n'))}</pre>`:''}<div class="panel-actions"><button data-edit-env="${escapeHTML(e.id)}">编辑范围与别名</button><button data-scan="${escapeHTML(e.id)}" ${data.scanning.includes(e.id)?'disabled':''}>${data.scanning.includes(e.id)?'正在扫描…':'扫描此环境'}</button></div></section>`;
  }).join('');
}
function renderSetup() {
  $('content').innerHTML=`<div class="grid"><section class="panel steps"><h2>第一次使用</h2><div class="step"><div><h3>选择你工作的地方</h3><p>添加本机目录或 SSH 环境，设置根目录与最大扫描深度。扫描不会修改 Git 仓库。</p><button data-view="environments">配置环境</button></div></div><div class="step"><div><h3>连接真实的 VS Code 窗口</h3><p>将附带扩展安装到本机 VS Code 稳定版。Remote SSH 窗口同样使用本机 UI 扩展。安装后重新加载已有窗口。</p><div class="panel-actions"><button class="primary" data-install>安装扩展</button><button data-show-vsix>定位 VSIX 文件</button></div></div></div><div class="step"><div><h3>组织并返回</h3><p>检查扩展状态栏，搜索目录并加入工作集。多窗口时选择具体实例；也可以明确在新窗口打开。</p><button data-view="sessions">查看已连接窗口</button></div></div></section><section class="panel"><h2>接入状态与诊断</h2><p>${data.sessions.length?`${data.sessions.length} 个已连接的 VS Code 窗口`:'尚未检测到有效会话'}</p><p class="hint">只有已加载扩展并持续上报的稳定版窗口会计入统计。SSH 使用系统配置、密钥与 known_hosts，应用不保存密码；远端需有 Git 和 Python 3。</p><div class="panel-actions"><button data-diagnostics>运行诊断</button></div><div id="diagnostics-result"></div><h3>配置与数据</h3><p class="hint">导出环境、手动保留位置与工作集，临时会话和接入令牌不导出。导入前自动备份。卸载应用默认保留用户数据，具体路径见诊断结果。</p></section></div>`;
}
function editor(title:string,body:string,submit:()=>Promise<void>) { $('editor-title').textContent=title;$('editor-body').innerHTML=body;$('form-error').textContent='';submitEditor=submit;($('editor') as HTMLDialogElement).showModal(); }
function field(id:string,label:string,value='',hint='',type='text') { return `<label class="field">${label}<input id="${id}" type="${type}" value="${escapeHTML(value)}" required>${hint?`<small>${hint}</small>`:''}</label>`; }
function val(id:string) { return ($(id) as HTMLInputElement).value; }
function environmentEditor(id?:string) {
  const existing=data.environments.find(e=>e.id===id);const e:EnvView=existing??{id:'',name:'',kind:'ssh',target:'',roots:[],aliases:[],depth:3,caseSensitive:true};
  editor(existing?'编辑环境':'添加 SSH 环境',field('env-name','显示名称',e.name)+(e.kind==='ssh'?field('env-target','系统 SSH 目标',e.target,'使用已有 ~/.ssh/config 别名或 user@host；不同账号请建立不同环境。')+field('env-aliases','VS Code Remote SSH 别名',e.aliases.join(', '),'多个别名用逗号分隔。仅在确认同一账号与文件系统后映射到此环境。'):'')+`<label class="field">扫描根目录（每行一个绝对路径）<textarea id="env-roots">${escapeHTML(e.roots.join('\n'))}</textarea><small>只在指定深度内发现 Git；登记的关联 worktree 可超出根目录。</small></label>${e.kind==='local'?'<button type="button" id="pick-root">选择本机根目录</button>':''}`+field('env-depth','最大扫描深度（0–8）',String(e.depth),'默认 3，每次最多访问 15000 个目录。','number')+`<label class="field">路径规则<select id="env-case" ${existing?'disabled':''}><option value="true" ${e.caseSensitive?'selected':''}>区分大小写（保守默认）</option><option value="false" ${!e.caseSensitive?'selected':''}>不区分大小写（仅明确确认后）</option></select><small>现有环境的账号、目标与身份规则不可直接修改；连接别名可增补。</small></label>`,async()=>{
    await call('saveEnvironment',{...e,name:val('env-name'),target:e.kind==='ssh'?val('env-target'):undefined,aliases:e.kind==='ssh'?val('env-aliases').split(',').map(x=>x.trim()).filter(Boolean):[],roots:val('env-roots').split('\n').map(x=>x.trim()).filter(Boolean),depth:Number(val('env-depth')),caseSensitive:val('env-case')==='true'});
  });
  if(existing&&e.kind==='ssh')($('env-target') as HTMLInputElement).disabled=true;
  if(e.kind==='local')$('pick-root').onclick=()=>void run(async()=>{const p=await call('chooseDirectory');if(p)($('env-roots') as HTMLTextAreaElement).value=[val('env-roots'),p].filter(Boolean).join('\n');});
}
function addLocation() {
  editor('添加目录',`<label class="field">所在环境<select id="loc-env">${data.environments.map(e=>`<option value="${escapeHTML(e.id)}">${escapeHTML(e.name)}</option>`).join('')}</select></label>`+field('loc-path','目录绝对路径','','普通目录也可以加入；远端存在性在连接后确认。')+'<button type="button" id="pick-location">选择本机目录</button>',async()=>{await call('addLocation',{environmentId:val('loc-env'),path:val('loc-path')});});
  $('pick-location').onclick=()=>void run(async()=>{const p=await call('chooseDirectory');if(p){($('loc-env') as HTMLSelectElement).value=data.environments.find(e=>e.kind==='local')!.id;($('loc-path') as HTMLInputElement).value=p;}});
}
function worksetEditor(id?:string,include?:string) {
  const ws=data.worksets.find(w=>w.id===id);const ids=new Set([...(ws?.locationIds??[]),...(include?[include]:[])]);
  editor(ws?'编辑工作集':'创建 / 加入工作集',(!ws&&data.worksets.length?`<label class="field">加入已有工作集，或新建<select id="ws-existing"><option value="">创建新工作集</option>${data.worksets.map(w=>`<option value="${escapeHTML(w.id)}">${escapeHTML(w.name)}</option>`).join('')}</select></label>`:'')+field('ws-name','工作集名称',ws?.name??'')+`<div class="field">关联位置（同一位置可属于多个工作集）</div><div class="checklist">${data.locations.map(l=>`<label><input type="checkbox" name="ws-location" value="${l.id}" ${ids.has(l.id)?'checked':''}><span>${escapeHTML(l.name)} · ${escapeHTML(envName(l.environmentId))}<span class="path">${escapeHTML(l.path)}</span></span></label>`).join('')||'<p class="hint">当前没有位置，可以先保存空工作集。</p>'}</div>${ws?'<button class="danger" type="button" id="delete-workset">删除此工作集（保留目录）</button>':''}`,async()=>{await call('saveWorkset',{id:ws?.id??(valOptional('ws-existing')||undefined),name:val('ws-name'),locationIds:[...document.querySelectorAll<HTMLInputElement>('input[name="ws-location"]:checked')].map(el=>el.value)});});
  if($('ws-existing'))$('ws-existing').onchange=()=>{const target=data.worksets.find(w=>w.id===val('ws-existing'));($('ws-name') as HTMLInputElement).value=target?.name??'';document.querySelectorAll<HTMLInputElement>('input[name="ws-location"]').forEach(el=>{el.checked=target?.locationIds.includes(el.value)||el.value===include;});};
  if(ws)$('delete-workset').onclick=()=>void run(async()=>{await call('deleteWorkset',ws.id);worksetId='';($('editor') as HTMLDialogElement).close();});
}
function valOptional(id:string){return $(id)?val(id):'';}
async function refresh(){if(refreshing)return;refreshing=true;try{data=await call('snapshot');options();render();}finally{refreshing=false;}}
document.addEventListener('click',event=>{
  const b=(event.target as HTMLElement).closest<HTMLElement>('button,[data-location]');if(!b)return;const d=b.dataset;
  if(d.view)navigate(d.view);else if(d.ws)navigate('locations',d.ws);else if(d.location){selected=d.location;renderLocations();}
  else if(d.action==='add')addLocation();else if('newEnv'in d)environmentEditor();else if(d.editEnv)environmentEditor(d.editEnv);else if(d.editWs)worksetEditor(d.editWs);else if(d.organize)worksetEditor(undefined,d.organize);
  else if(d.scan)void run(async()=>{notice('正在执行只读扫描…');await call('scan',d.scan);notice('扫描已结束；结果与错误见环境状态。');});
  else if(d.open)void run(async()=>notice((await call('open',d.open)).message));
  else if(d.activate)void run(async()=>{const result=await call('activate',{sessionId:d.activate,locationId:d.targetLocation,requestId:crypto.randomUUID()});notice(result.message);});
  else if('install'in d)void run(async()=>{notice('正在安装 VS Code 扩展…');notice((await call('installExtension')).message);});
  else if('showVsix'in d)void run(async()=>{await call('showExtension');});
  else if('diagnostics'in d)void run(async()=>{const result=await call('diagnostics');editor('诊断结果',`<pre>${escapeHTML(JSON.stringify(result,null,2))}</pre>`,async()=>{});});
});
document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&(event.target as HTMLElement).dataset.location){event.preventDefault();selected=(event.target as HTMLElement).dataset.location!;renderLocations();}if((event.metaKey||event.ctrlKey)&&event.key==='k'){event.preventDefault();navigate('locations');$('search').focus();}});
$('add-location').onclick=addLocation;$('new-workset').onclick=()=>worksetEditor();
$('search').oninput=renderLocations;$('environment-filter').onchange=renderLocations;$('session-filter').onchange=renderLocations;
$('close-dialog').onclick=$('cancel-dialog').onclick=()=>($('editor') as HTMLDialogElement).close();
$('editor-form').onsubmit=event=>{event.preventDefault();const button=document.querySelector<HTMLButtonElement>('#editor-form button[type="submit"]')!;button.disabled=true;void(async()=>{try{await submitEditor?.();($('editor') as HTMLDialogElement).close();await refresh();}catch(err){$('form-error').textContent=String(err);}finally{button.disabled=false;}})();};
$('rescan').onclick=()=>void run(async()=>{const id=val('environment-filter');notice('正在执行只读扫描…');for(const e of data.environments.filter(e=>!id||e.id===id))await call('scan',e.id);notice('扫描已结束；错误与离线缓存状态可在“环境与扫描”中查看。');});
$('export').onclick=()=>void run(async()=>{const p=await call('export');if(p)notice(`已导出配置与组织数据：${p}`);});
$('import').onclick=()=>void run(async()=>{if(await call('import'))notice('已导入并备份旧配置。请检查此设备的路径与 SSH 别名。');});
setInterval(()=>{if(!($('editor') as HTMLDialogElement).open)void refresh().catch(err=>notice(String(err),true));},2500);
void refresh().catch(err=>notice(String(err),true));
