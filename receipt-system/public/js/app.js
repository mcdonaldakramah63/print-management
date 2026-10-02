// Vicamp Print OS -- app.js (redesign build)
let currentUser=null,currentSettings=null,products=[],itemIdCounter=0;
let editingProductId=null,voidTargetId=null,shPage=1,jobsPage=1;
let jobsFilter='pending',logoDataUrl='',prodPage=1;
const SH_PAGE_SIZE=10,PROD_SIZE=15;

(async function init(){
  try{
    const r=await api('GET','/api/auth/me');
    if(!r.user){location.href='login.html';return;}
    currentUser=r.user;
  }catch(_){location.href='login.html';return;}
  const ini=(currentUser.full_name||currentUser.username||'A').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
  document.getElementById('nav-avatar').textContent=ini;
  document.getElementById('nav-username').textContent=currentUser.full_name||currentUser.username;
  document.getElementById('nav-role').textContent=currentUser.role;
  try{const s=await api('GET','/api/settings');currentSettings=s.settings;}catch(_){currentSettings={};}
  await loadProductCatalog();
  setupNav();setupTopbar();setupSaleForm();setupHistory();setupProducts();setupPrintMonitor();setupUsers();setupSettings();setupLogout();
  if(currentUser.role!=='admin')
    ['users','settings','products'].forEach(v=>{
      const e=document.querySelector('[data-view="'+v+'"' + ']');if(e)e.style.display='none';
    });
  navigateTo(location.hash.replace('#','')||'dashboard');
  refreshPendingBadge();setInterval(refreshPendingBadge,30000);
})();

async function loadProductCatalog(){try{const r=await api('GET','/api/products');products=r.products||r;}catch(_){products=[]; }}

// Navigation
function setupNav(){
  document.querySelectorAll('.nav-link[data-view]').forEach(l=>l.addEventListener('click',()=>navigateTo(l.dataset.view)));
}
function setupTopbar(){
  document.getElementById('new-sale-quick').addEventListener('click',()=>navigateTo('new-sale'));
}
const VIEW_META={
  'dashboard':    ['Dashboard','Live system overview of printing operations'],
  'new-sale':     ['New Sale','Create invoice, register print jobs & record transactions'],
  'sales-history':['Sales History','Transaction audit log & settlement records'],
  'products':     ['Products & Services','Configure POS pricing & spool associations'],
  'print-monitor':['Print Monitoring','Live spooler telemetry & auto-billing'],
  'users':        ['Users & Team Access','Manage staff accounts & roles'],
  'settings':     ['Business Settings','Store identity, receipts & security'],
};
function navigateTo(view){
  if(!VIEW_META[view])view='dashboard';
  if(['users','settings','products'].includes(view)&&currentUser.role!=='admin')view='dashboard';
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l=>l.classList.remove('active'));
  const ve=document.getElementById('view-'+view);if(ve)ve.classList.add('active');
  const nl=document.querySelector('[data-view="'+view+'"]');if(nl)nl.classList.add('active');
  const m=VIEW_META[view]||['',''];
  document.getElementById('topbar-heading').textContent=m[0];
  document.getElementById('topbar-sub').textContent=m[1];
  location.hash=view;
  if(view==='dashboard')loadDashboard();
  if(view==='sales-history'){shPage=1;loadHistory();}
  if(view==='users')loadUsers();
  if(view==='settings')fillSettingsForm();
  if(view==='products')loadProducts();
  if(view==='print-monitor'){loadAgents();loadPrintJobs();}
  if(view==='new-sale')resetSaleForm();
}
function setupLogout(){
  document.getElementById('logout-btn').addEventListener('click',async()=>{
    try{await api('POST','/api/auth/logout');}catch(_){}
    location.href='login.html';
  });
}
function openModal(id){document.getElementById(id).style.display='flex';}
function closeModal(id){document.getElementById(id).style.display='none';}
document.addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))e.target.style.display='none';});

// Dashboard
async function loadDashboard(){
  refreshPrinterStatus();
  try{
    const data=await api('GET','/api/dashboard/summary');
    const cur=(currentSettings&&currentSettings.currency)||'GHS';
    document.getElementById('kpi-today-rev').textContent=money(data.today.revenue,cur);
    document.getElementById('kpi-today-sales').textContent=data.today.count+' sales';
    document.getElementById('kpi-week-rev').textContent=money(data.last7Days.revenue,cur);
    document.getElementById('kpi-week-sales').textContent=data.last7Days.count+' sales';
    document.getElementById('kpi-month-rev').textContent=money(data.thisMonth.revenue,cur);
    document.getElementById('kpi-month-sales').textContent=data.thisMonth.count+' sales';
    try{const pj=await api('GET','/api/print-jobs?status=pending&limit=1');document.getElementById('kpi-queue').textContent=pj.total||0;}catch(_){}
    drawRevenueChart(data.dailySeries||[]);
    renderTopItems(data.topItems||[]);
    renderDashPrinters();
    renderDashLowStock(data.lowStock||[]);
  }catch(err){console.error('Dashboard:',err);}
}
async function refreshPrinterStatus(){
  try{
    const res=await api('GET','/api/agents');
    const ag=res.agents||res;
    const on=ag.filter(a=>a.status==='online').length;
    document.getElementById('printer-status-text').textContent=ag.length===0?'No agents':(on+'/'+ag.length+' Online');
  }catch(_){document.getElementById('printer-status-text').textContent='Checking...';}
}
async function refreshPendingBadge(){
  try{
    const res=await api('GET','/api/print-jobs?status=pending&limit=1');
    const count=res.total||0;
    const badge=document.getElementById('pending-badge');
    badge.textContent=count;badge.style.display=count>0?'':'none';
  }catch(_){}
}
function drawRevenueChart(series){
  const canvas=document.getElementById('revenue-chart');if(!canvas)return;
  const dpr=window.devicePixelRatio||1;
  const rect=canvas.parentElement.getBoundingClientRect();
  const CW=rect.width||500,CH=200;
  canvas.width=Math.round(CW*dpr);canvas.height=Math.round(CH*dpr);
  canvas.style.width='100%';canvas.style.height=CH+'px';
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const pad={t:10,r:12,b:28,l:12};
  const cW=CW-pad.l-pad.r,cH=CH-pad.t-pad.b;
  if(!series.length)return;
  const maxV=Math.max(1,...series.map(d=>d.revenue));
  const n=series.length,gap=3,barW=Math.max(4,cW/n-gap);
  series.forEach((d,i)=>{
    const bh=(d.revenue/maxV)*cH,x=pad.l+i*(barW+gap),y=pad.t+(cH-bh);
    if(d.revenue>0){
      const g=ctx.createLinearGradient(0,y,0,y+bh);
      g.addColorStop(0,'rgba(78,222,163,.9)');g.addColorStop(1,'rgba(16,185,129,.4)');
      ctx.fillStyle=g;
    }else ctx.fillStyle='rgba(60,74,66,.5)';
    ctx.fillRect(x,y,barW,Math.max(bh,2));
    if(i%2===0&&n<=20){
      ctx.fillStyle='#86948a';ctx.font='9px Inter,sans-serif';ctx.textAlign='center';
      ctx.fillText((d.day||'').slice(5),x+barW/2,CH-8);
    }
  });
}
function renderTopItems(items){
  const el=document.getElementById('top-items-list');
  const cur=(currentSettings&&currentSettings.currency)||'GHS';
  if(!items.length){el.innerHTML='<div class="empty-state"><span class="mat-icon">leaderboard</span><p>No sales in last 30 days</p></div>';return;}
  el.innerHTML=items.slice(0,8).map((item,i)=>
    '<div class="top-item-row">'
    +'<div class="top-item-rank">'+(i+1)+'</div>'
    +'<div class="top-item-name">'+escapeHtml(item.name)+'</div>'
    +'<div class="muted text-xs">'+item.qty+' sold</div>'
    +'<div class="top-item-rev">'+money(item.revenue,cur)+'</div>'
    +'</div>'
  ).join('');
}
async function renderDashPrinters(){
  const el=document.getElementById('dash-printers');
  try{
    const res=await api('GET','/api/agents');const agents=res.agents||res;
    if(!agents.length){el.innerHTML='<p class="muted text-sm">No agents registered.</p>';return;}
    el.innerHTML=agents.map(a=>
      '<div class="agent-card">'
      +'<div class="agent-dot '+(a.status==='online'?'online':'')+'"></div>'
      +'<div style="flex:1;min-width:0">'
      +'<div style="font-weight:600;font-size:13px">'+escapeHtml(a.name)+'</div>'
      +'<div class="text-xs muted">'+escapeHtml(a.host_device||'')+(a.last_seen?' &middot; '+formatDate(a.last_seen):'')+'</div>'
      +'</div>'
      +'<span class="badge '+(a.status==='online'?'badge-green':'badge-gray')+'">'+a.status+'</span>'
      +'</div>'
    ).join('');
  }catch(_){el.innerHTML='<p class="muted text-sm">Could not load agents.</p>';}
}
function renderDashLowStock(list){
  const el=document.getElementById('dash-low-stock');
  if(!list.length){el.innerHTML='<p class="muted text-sm" style="text-align:center;padding:16px 0">All stock healthy</p>';return;}
  el.innerHTML=list.map(p=>'<div class="low-stock-row"><span>'+escapeHtml(p.name)+'</span><span class="badge badge-amber">'+p.stock_qty+' left</span></div>').join('');
}

// Sale Form
function setupSaleForm(){
  document.getElementById('add-catalog-item').addEventListener('click',openCatalogModal);
  document.getElementById('add-custom-item').addEventListener('click',()=>addItemRow());
  document.getElementById('clear-form-btn').addEventListener('click',resetSaleForm);
  ['s-discount-amt','s-discount-pct','s-tax'].forEach(id=>document.getElementById(id).addEventListener('input',recalcTotals));
  document.querySelectorAll('[data-pay]').forEach(chip=>chip.addEventListener('click',()=>{
    document.querySelectorAll('[data-pay]').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    document.getElementById('tendered-wrap').style.display=chip.dataset.pay==='Cash'?'':'none';
  }));
  document.getElementById('s-tendered').addEventListener('input',function(){
    const grand=parseFloat(document.getElementById('t-grand').textContent.replace(/[^0-9.]/g,''))||0;
    const t=parseFloat(this.value)||0;
    const cur=(currentSettings&&currentSettings.currency)||'GHS';
    document.getElementById('t-change').textContent=money(Math.max(0,t-grand),cur);
  });
  setupQuickTender();
  document.getElementById('complete-sale-btn').addEventListener('click',submitSale);
  document.getElementById('hold-order-btn').addEventListener('click',()=>alert('Draft saving coming soon.'));
  buildPresetChips();
  document.getElementById('catalog-search').addEventListener('input',renderCatalogList);
}
function buildPresetChips(){
  const c=document.getElementById('preset-chips');
  ['Walk-in','Secretariat','Regular Student','Corporate','VIP'].forEach(p=>{
    const chip=document.createElement('span');
    chip.className='chip';chip.textContent=p;
    chip.addEventListener('click',()=>{
      document.getElementById('s-customer').value=p;
      c.querySelectorAll('.chip').forEach(ch=>ch.classList.remove('active'));
      chip.classList.add('active');
    });
    c.appendChild(chip);
  });
}
function setupQuickTender(){
  const el=document.getElementById('quick-tender');
  [0,20,50,100,200].forEach(amt=>{
    const chip=document.createElement('span');
    chip.className='chip';chip.textContent=amt===0?'Exact':amt;
    chip.addEventListener('click',()=>{
      if(amt===0){
        const grand=parseFloat(document.getElementById('t-grand').textContent.replace(/[^0-9.]/g,''))||0;
        document.getElementById('s-tendered').value=grand.toFixed(2);
      }else document.getElementById('s-tendered').value=amt;
      document.getElementById('s-tendered').dispatchEvent(new Event('input'));
    });
    el.appendChild(chip);
  });
}
function resetSaleForm(){
  ['s-customer','s-phone','s-tendered'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  document.getElementById('s-discount-amt').value='0';
  document.getElementById('s-discount-pct').value='0';
  document.getElementById('s-tax').value='0';
  document.getElementById('sale-error').style.display='none';
  document.getElementById('sale-success').style.display='none';
  document.querySelectorAll('[data-pay]').forEach((c,i)=>c.classList.toggle('active',i===0));
  document.getElementById('preset-chips').querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
  document.getElementById('sale-items').innerHTML='';
  addItemRow();recalcTotals();
}
function addItemRow(name,price,qty){
  const id=++itemIdCounter;
  const row=document.createElement('div');
  row.className='item-row';row.dataset.rowId=id;
  row.innerHTML=
    '<div class="field"><input class="item-name" placeholder="Item / service name" value="'+escapeHtml(name||'')+'">'
    +'<div class="stock-hint" style="display:none"></div></div>'
    +'<div class="field"><input class="item-price" type="number" min="0" step="0.01" placeholder="0.00" value="'+(price||'')+'"></div>'
    +'<div class="field"><input class="item-qty" type="number" min="1" step="1" placeholder="1" value="'+(qty||1)+'"></div>'
    +'<div class="field"><input class="item-total" type="text" readonly placeholder="0.00" tabindex="-1" style="color:var(--primary);font-family:var(--font-mono)"></div>'
    +'<button class="remove-item" title="Remove">&times;</button>';
  document.getElementById('sale-items').appendChild(row);
  const ni=row.querySelector('.item-name'),pi=row.querySelector('.item-price'),qi=row.querySelector('.item-qty');
  ni.addEventListener('input',()=>{
    const m=products.find(p=>p.name.toLowerCase()===ni.value.trim().toLowerCase());
    if(m){row.dataset.productId=m.id;if(!pi.value)pi.value=m.price;}else delete row.dataset.productId;
    updateStockHint(row);recalcTotals();
  });
  pi.addEventListener('input',recalcTotals);
  qi.addEventListener('input',()=>{updateStockHint(row);recalcTotals();});
  row.querySelector('.remove-item').addEventListener('click',()=>{row.remove();recalcTotals();});
  if(name)recalcTotals();
}
function updateStockHint(row){
  const hint=row.querySelector('.stock-hint'),pid=row.dataset.productId;
  if(!pid){hint.style.display='none';return;}
  const p=products.find(p=>String(p.id)===String(pid));
  if(!p||!p.track_stock){hint.style.display='none';return;}
  const qty=parseFloat(row.querySelector('.item-qty').value)||0,short=qty>p.stock_qty;
  hint.style.display='';hint.className='stock-hint'+(short?' warn':'');
  hint.textContent=short?('Only '+p.stock_qty+' in stock!'):(p.stock_qty+' in stock');
}
function recalcTotals(){
  let sub=0;
  document.querySelectorAll('#sale-items .item-row').forEach(row=>{
    const p=parseFloat(row.querySelector('.item-price').value)||0;
    const q=parseFloat(row.querySelector('.item-qty').value)||0;
    const l=p*q;row.querySelector('.item-total').value=l.toFixed(2);sub+=l;
  });
  const da=parseFloat(document.getElementById('s-discount-amt').value)||0;
  const dp=parseFloat(document.getElementById('s-discount-pct').value)||0;
  const disc=Math.min(sub,Math.max(0,da+sub*dp/100));
  const tr=parseFloat(document.getElementById('s-tax').value)||0;
  const tax=(sub-disc)*tr/100,grand=(sub-disc)+tax;
  const cur=(currentSettings&&currentSettings.currency)||'GHS';
  document.getElementById('t-subtotal').textContent=money(sub,cur);
  document.getElementById('t-discount').textContent='- '+money(disc,cur);
  document.getElementById('t-tax').textContent=money(tax,cur);
  document.getElementById('t-grand').textContent=money(grand,cur);
  const ten=parseFloat(document.getElementById('s-tendered').value)||0;
  document.getElementById('t-change').textContent=money(Math.max(0,ten-grand),cur);
}
async function submitSale(){
  const errEl=document.getElementById('sale-error'),sucEl=document.getElementById('sale-success');
  errEl.style.display='none';sucEl.style.display='none';
  const items=Array.from(document.querySelectorAll('#sale-items .item-row')).map(row=>({
    name:row.querySelector('.item-name').value.trim(),
    qty:parseFloat(row.querySelector('.item-qty').value)||0,
    unit_price:parseFloat(row.querySelector('.item-price').value)||0,
    product_id:row.dataset.productId||null,
  }));
  if(!items.length||items.some(i=>!i.name||!i.qty||!i.unit_price)){
    errEl.textContent='Add at least one complete item (name, qty, price).';
    errEl.style.display='';return;
  }
  const payChip=document.querySelector('[data-pay].active');
  const da=parseFloat(document.getElementById('s-discount-amt').value)||0;
  const dp=parseFloat(document.getElementById('s-discount-pct').value)||0;
  const payload={
    customer_name:document.getElementById('s-customer').value.trim()||'Walk-in',
    customer_phone:document.getElementById('s-phone').value.trim(),
    items,discount_type:dp>0?'percent':'amount',discount_value:dp>0?dp:da,
    tax_rate:parseFloat(document.getElementById('s-tax').value)||0,
    payment_method:payChip?payChip.dataset.pay:'Cash',
  };
  const btn=document.getElementById('complete-sale-btn');
  btn.disabled=true;btn.textContent='Processing...';
  try{
    const result=await api('POST','/api/sales',payload);
    await loadProductCatalog();
    window.open('receipt.html?id='+result.id,'_blank');
    resetSaleForm();
    sucEl.textContent='Sale recorded! Receipt opened in new tab.';
    sucEl.style.display='';
    setTimeout(()=>{sucEl.style.display='none';},4000);
  }catch(err){errEl.textContent=err.message;errEl.style.display='';}
  finally{btn.disabled=false;btn.innerHTML='<span class="mat-icon" style="font-size:16px">print</span> Complete Sale & Print Receipt';}
}
function openCatalogModal(){
  document.getElementById('catalog-search').value='';renderCatalogList();openModal('catalog-modal');
}
function renderCatalogList(){
  const q=document.getElementById('catalog-search').value.toLowerCase();
  const cur=(currentSettings&&currentSettings.currency)||'GHS';
  const f=products.filter(p=>p.name.toLowerCase().includes(q)&&p.active!==0);
  document.getElementById('catalog-list').innerHTML=f.length
    ?f.map(p=>
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 4px;border-bottom:1px solid var(--outline-variant)">'
      +'<div><div style="font-size:13px;font-weight:500">'+escapeHtml(p.name)+'</div>'
      +'<div class="text-xs muted">'+escapeHtml(p.category||'')+'</div></div>'
      +'<div style="display:flex;align-items:center;gap:10px">'
      +'<span style="font-family:var(--font-mono);color:var(--primary);font-size:13px">'+money(p.price,cur)+'</span>'
      +'<button class="btn btn-outline btn-xs" onclick="addItemFromCatalog('+p.id+')">Add</button>'
      +'</div></div>'
    ).join('')
    :'<p class="muted text-sm" style="padding:20px;text-align:center">No products found</p>';
}
function addItemFromCatalog(productId){
  const p=products.find(pr=>pr.id===productId);
  if(!p)return;
  addItemRow(p.name,p.price,1);closeModal('catalog-modal');recalcTotals();
}

// Sales History
function setupHistory(){
  document.getElementById('sh-to').value=new Date().toISOString().slice(0,10);
  document.getElementById('sh-filter-btn').addEventListener('click',()=>{shPage=1;loadHistory();});
  document.getElementById('sh-search').addEventListener('keydown',e=>{if(e.key==='Enter'){shPage=1;loadHistory();}});
  document.getElementById('sh-tbody').addEventListener('click',e=>{
    const vb=e.target.closest('.void-btn');
    if(vb)promptVoid(vb.dataset.id,vb.dataset.rno);
  });
}
async function loadHistory(){
  const params=new URLSearchParams();
  const from=document.getElementById('sh-from').value;
  const to=document.getElementById('sh-to').value;
  const q=document.getElementById('sh-search').value.trim();
  const cashier=document.getElementById('sh-cashier').value;
  const status=document.getElementById('sh-status').value;
  if(from)params.set('from',from);if(to)params.set('to',to);
  if(q)params.set('q',q);if(cashier)params.set('cashier',cashier);
  if(status)params.set('status',status);
  params.set('page',shPage);params.set('limit',SH_PAGE_SIZE);
  try{
    const res=await api('GET','/api/sales?'+params.toString());
    const sales=res.sales||[];const total=res.total||sales.length;
    const cur=(currentSettings&&currentSettings.currency)||'GHS';
    document.getElementById('sh-today-count').textContent=res.todayCount!==undefined?res.todayCount:'--';
    document.getElementById('sh-today-rev').textContent=money(res.todayRevenue||0,cur);
    document.getElementById('sh-voided').textContent=res.voidedCount!==undefined?res.voidedCount:'--';
    const sel=document.getElementById('sh-cashier');
    if(res.cashiers&&sel.options.length<=1)
      res.cashiers.forEach(c=>sel.appendChild(new Option(c.full_name||c.username,c.username)));
    if(!sales.length){
      document.getElementById('sh-tbody').innerHTML='<tr><td colspan="7"><div class="empty-state"><span class="mat-icon">receipt_long</span><p>No transactions found</p></div></td></tr>';
      document.getElementById('sh-pagination').innerHTML='';return;
    }
    document.getElementById('sh-tbody').innerHTML=sales.map(s=>{
      const v=s.status==='voided'||s.voided;
      return '<tr class="'+(v?'voided':'')+'">'
        +'<td class="mono">'+escapeHtml(s.receipt_no)+'</td>'
        +'<td class="muted text-sm">'+formatDate(s.created_at)+'</td>'
        +'<td>'+escapeHtml(s.customer_name||'Walk-in')+'</td>'
        +'<td class="muted">'+escapeHtml(s.cashier_name||s.operator_name||'--')+'</td>'
        +'<td class="num">'+money(s.total,cur)+'</td>'
        +'<td><span class="badge '+(v?'badge-red':'badge-green')+'">'+(v?'Voided':'Completed')+'</span></td>'
        +'<td><a href="receipt.html?id='+s.id+'" target="_blank" class="btn btn-ghost btn-xs"><span class="mat-icon" style="font-size:14px">print</span></a>'
        +(currentUser.role==='admin'&&!v?' <button class="btn btn-danger btn-xs void-btn" data-id="'+s.id+'" data-rno="'+escapeHtml(s.receipt_no)+'">Void</button>':'')
        +'</td></tr>';
    }).join('');
    renderPagination('sh-pagination',shPage,Math.ceil(total/SH_PAGE_SIZE),p=>{shPage=p;loadHistory();});
  }catch(err){
    document.getElementById('sh-tbody').innerHTML='<tr><td colspan="7" class="muted">'+escapeHtml(err.message)+'</td></tr>';
  }
}
function promptVoid(id,receiptNo){
  voidTargetId=id;
  document.getElementById('void-receipt-id').textContent=receiptNo;
  openModal('void-modal');
  document.getElementById('void-confirm-btn').onclick=async()=>{
    try{await api('PATCH','/api/sales/'+voidTargetId+'/void');closeModal('void-modal');loadHistory();}
    catch(err){alert(err.message);}
  };
}

// Products
function setupProducts(){
  document.getElementById('add-product-btn').addEventListener('click',()=>openProductModal());
  document.getElementById('pm-save-btn').addEventListener('click',saveProduct);
}
async function loadProducts(){
  try{
    const res=await api('GET','/api/products?page='+prodPage+'&limit='+PROD_SIZE);
    const list=res.products||res;const total=res.total||list.length;
    const cur=(currentSettings&&currentSettings.currency)||'GHS';
    if(!list.length){document.getElementById('prod-tbody').innerHTML='<tr><td colspan="7"><div class="empty-state"><span class="mat-icon">inventory_2</span><p>No products yet.</p></div></td></tr>';return;}
    document.getElementById('prod-tbody').innerHTML=list.map(p=>{
      const active=p.active!==0;
      return '<tr>'
        +'<td><div style="font-weight:600">'+escapeHtml(p.name)+'</div><div class="text-xs muted">'+escapeHtml(p.sku||'')+'</div></td>'
        +'<td class="muted text-sm">'+escapeHtml(p.category||'--')+'</td>'
        +'<td class="num">'+money(p.price,cur)+'</td>'
        +'<td>'+(p.track_stock?'<span class="badge '+(p.stock_qty<=(p.reorder_level||0)?'badge-amber':'badge-green')+'">'+p.stock_qty+' in stock</span>':'<span class="muted text-xs">Service</span>')+'</td>'
        +'<td>'+(p.billing_mode&&p.billing_mode!=='none'?'<span class="badge badge-blue">'+p.billing_mode+'</span>':'<span class="muted">--</span>')+'</td>'
        +'<td><span class="badge '+(active?'badge-green':'badge-gray')+'">'+(active?'Active':'Inactive')+'</span></td>'
        +'<td>'
        +'<button class="btn btn-ghost btn-xs" onclick="openProductModal('+p.id+')"><span class="mat-icon" style="font-size:14px">edit</span></button> '
        +(active?'<button class="btn btn-danger btn-xs" onclick="toggleProduct('+p.id+',false)">Deactivate</button>':'<button class="btn btn-outline btn-xs" onclick="toggleProduct('+p.id+',true)">Activate</button>')
        +'</td></tr>';
    }).join('');
    renderPagination('prod-pagination',prodPage,Math.ceil(total/PROD_SIZE),p=>{prodPage=p;loadProducts();});
    await loadProductCatalog();
  }catch(err){document.getElementById('prod-tbody').innerHTML='<tr><td colspan="7" class="muted">'+escapeHtml(err.message)+'</td></tr>';}
}
function openProductModal(id){
  editingProductId=id||null;
  document.getElementById('prod-modal-title').textContent=id?'Edit Product':'Add Product';
  document.getElementById('pm-error').style.display='none';
  if(id){
    const p=products.find(pr=>pr.id===id);if(!p)return;
    document.getElementById('pm-name').value=p.name||'';
    document.getElementById('pm-sku').value=p.sku||'';
    document.getElementById('pm-category').value=p.category||'Document Printing';
    document.getElementById('pm-price').value=p.price||'';
    document.getElementById('pm-stock').value=p.track_stock?p.stock_qty:'';
    document.getElementById('pm-low-stock').value=p.reorder_level!=null?p.reorder_level:'';
    document.getElementById('pm-billing-mode').value=p.billing_mode||'none';
  }else{
    ['pm-name','pm-sku','pm-price','pm-stock','pm-low-stock'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('pm-category').value='Document Printing';
    document.getElementById('pm-billing-mode').value='none';
  }
  openModal('product-modal');
}
async function saveProduct(){
  const errEl=document.getElementById('pm-error');errEl.style.display='none';
  const name=document.getElementById('pm-name').value.trim();
  const price=parseFloat(document.getElementById('pm-price').value);
  if(!name||isNaN(price)){errEl.textContent='Name and price required.';errEl.style.display='';return;}
  const sv=document.getElementById('pm-stock').value;
  const payload={name,sku:document.getElementById('pm-sku').value.trim(),
    category:document.getElementById('pm-category').value,price,
    track_stock:sv!=='',stock_qty:sv!==''?parseInt(sv)||0:null,
    reorder_level:parseInt(document.getElementById('pm-low-stock').value)||0,
    billing_mode:document.getElementById('pm-billing-mode').value};
  try{
    if(editingProductId)await api('PUT','/api/products/'+editingProductId,payload);
    else await api('POST','/api/products',payload);
    closeModal('product-modal');loadProducts();
  }catch(err){errEl.textContent=err.message;errEl.style.display='';}
}
async function toggleProduct(id,active){
  try{await api('PUT','/api/products/'+id,{active:active?1:0});loadProducts();}catch(err){alert(err.message);}
}

// Print Monitor
function setupPrintMonitor(){
  document.getElementById('refresh-spooler-btn').addEventListener('click',()=>{loadAgents();loadPrintJobs();});
  document.getElementById('register-agent-btn').addEventListener('click',()=>openModal('agent-modal'));
  document.getElementById('ag-save-btn').addEventListener('click',registerAgent);
  document.getElementById('job-filter-tabs').addEventListener('click',e=>{
    const chip=e.target.closest('[data-filter]');if(!chip)return;
    document.querySelectorAll('#job-filter-tabs .chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');jobsFilter=chip.dataset.filter;jobsPage=1;loadPrintJobs();
  });
}
async function loadAgents(){
  const el=document.getElementById('agents-list');
  try{
    const res=await api('GET','/api/agents');const agents=res.agents||res;
    if(!agents.length){el.innerHTML='<p class="muted text-sm">No agents registered.</p>';return;}
    el.innerHTML=agents.map(a=>
      '<div class="agent-card">'
      +'<div class="agent-dot '+(a.status==='online'?'online':'')+'"></div>'
      +'<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">'+escapeHtml(a.name)+'</div>'
      +'<div class="text-xs muted">'+escapeHtml(a.host_device||'')+(a.last_seen?' &middot; '+formatDate(a.last_seen):'')+'</div></div>'
      +'<span class="badge '+(a.status==='online'?'badge-green':'badge-gray')+'">'+a.status+'</span>'
      +(currentUser.role==='admin'?' <button class="btn btn-danger btn-xs" onclick="disableAgent('+a.id+')">Disable</button>':'')
      +'</div>'
    ).join('');
    document.getElementById('stat-jobs-today').textContent=agents.reduce((s,a)=>s+(a.jobs_today||0),0);
    document.getElementById('stat-capture-rate').textContent='--';
    document.getElementById('stat-billed').textContent='--';
  }catch(err){el.innerHTML='<p class="muted text-sm">'+escapeHtml(err.message)+'</p>';}
}
async function registerAgent(){
  const errEl=document.getElementById('ag-error');errEl.style.display='none';
  const name=document.getElementById('ag-name').value.trim();
  const host=document.getElementById('ag-host').value.trim();
  if(!name||!host){errEl.textContent='Name and host required.';errEl.style.display='';return;}
  try{await api('POST','/api/agents',{name,host_device:host});closeModal('agent-modal');loadAgents();}catch(err){errEl.textContent=err.message;errEl.style.display='';}
}
async function disableAgent(id){
  if(!confirm('Disable this agent?'))return;
  try{await api('DELETE','/api/agents/'+id);loadAgents();}catch(err){alert(err.message);}
}
async function loadPrintJobs(){
  const el=document.getElementById('print-jobs-list');
  const params=new URLSearchParams({page:jobsPage,limit:10});
  if(jobsFilter!=='all')params.set('status',jobsFilter);
  try{
    const res=await api('GET','/api/print-jobs?'+params.toString());
    const jobs=res.jobs||res;const total=res.total||jobs.length;
    const cur=(currentSettings&&currentSettings.currency)||'GHS';
    const pc=res.pendingCount!==undefined?res.pendingCount:(jobsFilter==='pending'?jobs.length:'--');
    document.getElementById('pending-count-label').textContent=pc+' Pending';
    if(!jobs.length){
      el.innerHTML='<div class="empty-state"><span class="mat-icon">pending_actions</span><p>No jobs in this queue</p></div>';
      document.getElementById('jobs-pagination').innerHTML='';refreshPendingBadge();return;
    }
    el.innerHTML=jobs.map(job=>{
      const bc=job.status==='pending'?'badge-amber':job.status==='approved'?'badge-green':job.status==='rejected'?'badge-red':'badge-gray';
      const jj=JSON.stringify(job).replace(/"/g,'&quot;');
      return '<div class="card" style="margin-bottom:10px;padding:14px 16px">'
        +'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">'
        +'<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escapeHtml(job.document_title||job.filename||'Print Job')+'</div>'
        +'<div class="text-xs muted mt4">'+escapeHtml(job.printer_name||'--')+' &middot; '+(job.pages||'?')+' pgs &middot; '+escapeHtml(job.submitted_by||job.agent_name||'--')+(job.created_at?' &middot; '+formatDate(job.created_at):'')+'</div></div>'
        +'<span class="badge '+bc+'">'+job.status+'</span>'
        +'</div>'
        +(job.status==='pending'
          ?'<div style="display:flex;gap:8px;margin-top:10px">'
            +'<button class="btn btn-primary btn-sm" onclick="openBillModal(JSON.parse(this.dataset.job))" data-job="'+jj+'"><span class="mat-icon" style="font-size:14px">receipt_long</span> Bill</button>'
            +'<button class="btn btn-danger btn-sm" onclick="rejectJob('+job.id+')"><span class="mat-icon" style="font-size:14px">close</span> Reject</button>'
            +'</div>'
          :'')
        +(job.status==='approved'&&job.total?'<div class="mt8 text-sm text-primary mono">'+money(job.total,cur)+'</div>':'')
        +'</div>';
    }).join('');
    renderPagination('jobs-pagination',jobsPage,Math.ceil(total/10),p=>{jobsPage=p;loadPrintJobs();});
    refreshPendingBadge();
  }catch(err){el.innerHTML='<p class="muted text-sm">'+escapeHtml(err.message)+'</p>';}
}
function openBillModal(job){
  document.getElementById('bill-error').style.display='none';
  document.getElementById('bill-job-info').innerHTML=
    '<strong>'+escapeHtml(job.document_title||job.filename||'Print Job')+'</strong><br>'
    +'<span class="muted text-sm">'+(job.pages||'?')+' pages &middot; '+escapeHtml(job.printer_name||'--')+'</span>';
  const sel=document.getElementById('bill-product');
  sel.innerHTML=products.filter(p=>p.active!==0).map(p=>
    '<option value="'+p.id+'" data-price="'+p.price+'">'+escapeHtml(p.name)+' @ '+money(p.price,'')+'/unit</option>'
  ).join('');
  function updT(){
    const opt=sel.options[sel.selectedIndex];
    const pr=opt?parseFloat(opt.dataset.price)||0:0;
    document.getElementById('bill-total').textContent=money(pr*(parseInt(job.pages)||1),(currentSettings&&currentSettings.currency)||'GHS');
  }
  sel.onchange=updT;updT();
  document.getElementById('bill-confirm-btn').onclick=()=>approveAndBill(job.id);
  openModal('bill-modal');
}
async function approveAndBill(jobId){
  const errEl=document.getElementById('bill-error');errEl.style.display='none';
  const pid=document.getElementById('bill-product').value;
  if(!pid){errEl.textContent='Select a product.';errEl.style.display='';return;}
  try{await api('POST','/api/print-jobs/'+jobId+'/approve',{product_id:pid});closeModal('bill-modal');loadPrintJobs();}catch(err){errEl.textContent=err.message;errEl.style.display='';}
}
async function rejectJob(id){
  if(!confirm('Reject this print job?'))return;
  try{await api('POST','/api/print-jobs/'+id+'/reject');loadPrintJobs();}catch(err){alert(err.message);}
}

// Users
function setupUsers(){
  document.getElementById('create-user-btn').addEventListener('click',createUser);
  document.getElementById('clear-user-btn').addEventListener('click',()=>{
    ['u-fullname','u-username','u-password'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('u-role').value='cashier';
    ['user-error','user-success'].forEach(id=>document.getElementById(id).style.display='none');
  });
  document.getElementById('eu-save-btn').addEventListener('click',saveEditUser);
  document.getElementById('users-tbody').addEventListener('click',e=>{
    const eb=e.target.closest('[data-edit-user]');
    if(eb){try{openEditUser(JSON.parse(eb.dataset.editUser));}catch(_){}}
    const db=e.target.closest('.del-btn');
    if(db)deleteUser(db.dataset.id,db.dataset.name);
  });
}
async function loadUsers(){
  try{
    const res=await api('GET','/api/users');const users=res.users||res;
    document.getElementById('user-count-label').textContent=users.length+' user'+(users.length===1?'':'s');
    document.getElementById('users-tbody').innerHTML=users.map(u=>{
      const ini=(u.full_name||u.username||'?')[0].toUpperCase();
      return '<tr>'
        +'<td><div style="display:flex;align-items:center;gap:8px">'
        +'<div class="nav-user-avatar" style="width:28px;height:28px;font-size:11px">'+ini+'</div>'
        +'<div><div style="font-weight:600;font-size:13px">'+escapeHtml(u.full_name||u.username)+'</div>'
        +'<div class="text-xs muted">@'+escapeHtml(u.username)+'</div></div></div></td>'
        +'<td><span class="badge '+(u.role==='admin'?'badge-blue':'badge-gray')+'">'+u.role+'</span></td>'
        +'<td><span class="badge badge-green">Active</span></td>'
        +'<td>'+(u.id!==currentUser.id
          ?'<button class="btn btn-ghost btn-xs" data-edit-user="'+JSON.stringify(u).replace(/"/g,'&quot;')+'">Edit</button> '
            +'<button class="btn btn-danger btn-xs del-btn" data-id="'+u.id+'" data-name="'+escapeHtml(u.username)+'">Disable</button>'
          :'<span class="text-xs muted">You</span>')
        +'</td></tr>';
    }).join('');
  }catch(err){document.getElementById('users-tbody').innerHTML='<tr><td colspan="4" class="muted">'+escapeHtml(err.message)+'</td></tr>';}
}
async function createUser(){
  const errEl=document.getElementById('user-error'),sucEl=document.getElementById('user-success');
  errEl.style.display='none';sucEl.style.display='none';
  const un=document.getElementById('u-username').value.trim();
  const pw=document.getElementById('u-password').value;
  if(!un||!pw){errEl.textContent='Username and password required.';errEl.style.display='';return;}
  try{
    await api('POST','/api/users',{full_name:document.getElementById('u-fullname').value.trim(),username:un,password:pw,role:document.getElementById('u-role').value});
    sucEl.textContent='User created.';sucEl.style.display='';
    ['u-fullname','u-username','u-password'].forEach(id=>document.getElementById(id).value='');
    loadUsers();setTimeout(()=>{sucEl.style.display='none';},3000);
  }catch(err){errEl.textContent=err.message;errEl.style.display='';}
}
function openEditUser(user){
  document.getElementById('eu-id').value=user.id;
  document.getElementById('eu-fullname').value=user.full_name||'';
  document.getElementById('eu-role').value=user.role||'cashier';
  document.getElementById('eu-password').value='';
  document.getElementById('eu-error').style.display='none';
  openModal('edit-user-modal');
}
async function saveEditUser(){
  const errEl=document.getElementById('eu-error');errEl.style.display='none';
  const id=document.getElementById('eu-id').value;
  const payload={full_name:document.getElementById('eu-fullname').value.trim(),role:document.getElementById('eu-role').value};
  const pw=document.getElementById('eu-password').value;
  if(pw)payload.password=pw;
  try{await api('PUT','/api/users/'+id,payload);closeModal('edit-user-modal');loadUsers();}catch(err){errEl.textContent=err.message;errEl.style.display='';}
}
async function deleteUser(id,username){
  if(!confirm('Disable @'+username+'?'))return;
  try{await api('DELETE','/api/users/'+id);loadUsers();}catch(err){alert(err.message);}
}

// Settings
function setupSettings(){
  document.getElementById('s-logo').addEventListener('change',e=>{
    const file=e.target.files[0];if(!file)return;
    if(file.size>2097152){alert('Logo must be under 2 MB.');e.target.value='';return;}
    const r=new FileReader();
    r.onload=()=>{logoDataUrl=r.result;const p=document.getElementById('s-logo-preview');p.src=logoDataUrl;p.style.display='block';};
    r.readAsDataURL(file);
  });
  document.getElementById('save-settings-btn').addEventListener('click',saveSettings);
  document.getElementById('change-pw-btn').addEventListener('click',changePassword);
  document.getElementById('test-print-btn').addEventListener('click',()=>window.open('receipt.html?id=1','_blank'));
}
function fillSettingsForm(){
  const s=currentSettings||{};
  const map={'s-bname':s.business_name||'','s-header':s.receipt_header||s.business_name||'',
    's-address':s.address||'','s-phone-s':s.phone||'','s-email':s.email||'',
    's-tax-rate':s.tax_rate!=null?s.tax_rate:'0','s-currency':s.currency||'GHS',
    's-prefix':s.receipt_prefix||'RCT-','s-next-num':s.next_invoice_number||'1',
    's-footer':s.receipt_footer||s.footer_note||''};
  Object.keys(map).forEach(id=>{const el=document.getElementById(id);if(el)el.value=map[id];});
  const mr=document.getElementById('s-manual-review');
  if(mr)mr.checked=!!s.require_manual_print_review;
  const prev=document.getElementById('s-logo-preview');
  if(s.logo_data_url){prev.src=s.logo_data_url;prev.style.display='block';}else prev.style.display='none';
  updateReceiptPreview();
}
function updateReceiptPreview(){
  const s=currentSettings||{};
  const g=id=>{const el=document.getElementById(id);return el?el.value:null;};
  const name=g('s-bname')||s.business_name||'Your Business';
  const addr=g('s-address')||s.address||'';
  const phone=g('s-phone-s')||s.phone||'';
  const prefix=g('s-prefix')||'RCT-';
  const footer=g('s-footer')||'Thank you!';
  const cur=g('s-currency')||s.currency||'GHS';
  const el=document.getElementById('receipt-preview-box');if(!el)return;
  const L=String.fromCharCode(9473).repeat(44),D=String.fromCharCode(9472).repeat(44);
  el.textContent=[L,name.toUpperCase(),addr,phone,L,
    'RECEIPT: '+prefix+new Date().getFullYear()+'-0001',
    'DATE:    '+new Date().toLocaleDateString('en-GB'),D,
    'B&W Print A4 1pg    1x @ '+cur+' 1.50',
    'Spiral Binding      1x @ '+cur+' 6.00',D,
    'TOTAL:              '+cur+' 7.50',L,footer,
    'Powered by Vicamp Print OS',L,
  ].filter(Boolean).join('\n');
}
async function saveSettings(){
  const sucEl=document.getElementById('settings-success');sucEl.style.display='none';
  const payload={
    business_name:document.getElementById('s-bname').value.trim(),
    receipt_header:document.getElementById('s-header').value.trim(),
    address:document.getElementById('s-address').value.trim(),
    phone:document.getElementById('s-phone-s').value.trim(),
    email:document.getElementById('s-email').value.trim(),
    tax_rate:parseFloat(document.getElementById('s-tax-rate').value)||0,
    currency:document.getElementById('s-currency').value.trim()||'GHS',
    receipt_prefix:document.getElementById('s-prefix').value.trim(),
    footer_note:document.getElementById('s-footer').value.trim(),
    require_manual_print_review:document.getElementById('s-manual-review').checked,
  };
  if(logoDataUrl)payload.logo_data_url=logoDataUrl;
  const nn=parseInt(document.getElementById('s-next-num').value);
  if(nn>0)payload.next_invoice_number=nn;
  try{
    await api('PUT','/api/settings',payload);
    const res=await api('GET','/api/settings');currentSettings=res.settings;
    sucEl.textContent='Settings saved.';sucEl.style.display='';
    updateReceiptPreview();setTimeout(()=>{sucEl.style.display='none';},3000);
  }catch(err){alert('Save failed: '+err.message);}
}
async function changePassword(){
  const errEl=document.getElementById('pw-error'),sucEl=document.getElementById('pw-success');
  errEl.style.display='none';sucEl.style.display='none';
  const cur=document.getElementById('pw-current').value;
  const nw=document.getElementById('pw-new').value;
  const conf=document.getElementById('pw-confirm').value;
  if(!cur||!nw){errEl.textContent='Fill current and new password.';errEl.style.display='';return;}
  if(nw!==conf){errEl.textContent='Passwords do not match.';errEl.style.display='';return;}
  if(nw.length<6){errEl.textContent='Min 6 characters.';errEl.style.display='';return;}
  try{
    await api('POST','/api/auth/change-password',{currentPassword:cur,newPassword:nw});
    ['pw-current','pw-new','pw-confirm'].forEach(id=>document.getElementById(id).value='');
    sucEl.textContent='Password updated.';sucEl.style.display='';
    setTimeout(()=>{sucEl.style.display='none';},3000);
  }catch(err){errEl.textContent=err.message;errEl.style.display='';}
}

// Pagination
function renderPagination(containerId,cur,total,onPage){
  const el=document.getElementById(containerId);
  if(!el||total<=1){if(el)el.innerHTML='';return;}
  let html='<button class="page-btn"'+(cur===1?' disabled':' onclick="('+ onPage.toString()+')'+(cur-1)+'"')+'>&lsaquo;</button>';
  for(let p=1;p<=total;p++){
    if(p===1||p===total||Math.abs(p-cur)<=1)
      html+='<button class="page-btn '+(p===cur?'active':'')+' onclick="('+onPage.toString()+')('+p+')">'+p+'</button>';
    else if(Math.abs(p-cur)===2)
      html+='<span style="padding:0 4px;color:var(--outline)">&hellip;</span>';
  }
  html+='<button class="page-btn"'+(cur===total?' disabled':' onclick="('+onPage.toString()+')'+(cur+1)+'"')+'>&rsaquo;</button>';
  el.innerHTML=html;
}