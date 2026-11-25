'use strict';
/* CollectDex — local-first collection tracker. Data lives in localStorage. */
const LS_KEY = 'collectdex_v1';
const MLP_SETS = ['Premiere','Canterlot Nights','Rock N Rave','Celestial Solstice','The Crystal Games','Absolute Discord','Equestrian Odysseys','High Magic','Marks in Time','Defenders of Equestria','Seaquestria & Beyond','Friends Forever'];
const CATEGORIES = [
  {id:'pokemon', label:'Pokémon', live:true},
  {id:'magic', label:'Magic: The Gathering', live:true},
  {id:'yugioh', label:'Yu-Gi-Oh!', live:true},
  {id:'lorcana', label:'Lorcana', live:false},
  {id:'onepiece', label:'One Piece', live:false},
  {id:'sports', label:'Sports Cards', live:false},
  {id:'comics', label:'Comics', live:false},
  {id:'mlp', label:'My Little Pony', live:false},
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c=>[c.id,c.label]));

let state = load();
let activeCat = 'pokemon';
let pendingItem = null;   // catalog/manual item awaiting confirm in modal
let editingId = null;

function load(){
  try{ const s = JSON.parse(localStorage.getItem(LS_KEY)); if(s && Array.isArray(s.items)) return s; }catch(e){}
  return {items:[], wishlist:[], binders:[]};
}
function save(){ localStorage.setItem(LS_KEY, JSON.stringify(state)); renderTotals(); }
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function money(n){ return (n==null||isNaN(n)) ? '—' : '$'+Number(n).toFixed(2); }
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---------- tabs ---------- */
document.querySelectorAll('#tabs button').forEach(b=>{
  b.addEventListener('click', ()=>{
    document.querySelectorAll('#tabs button').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-'+b.dataset.tab).classList.add('active');
    if(b.dataset.tab==='sets') renderSets();
    if(b.dataset.tab==='collection') renderCollection();
    if(b.dataset.tab==='binders') renderBinders();
    if(b.dataset.tab==='wishlist') renderWishlist();
  });
});

/* ---------- categories ---------- */
const catRow = document.getElementById('catRow');
CATEGORIES.forEach(c=>{
  const b=document.createElement('button');
  b.textContent = c.label + (c.live ? '' : ' · manual');
  b.dataset.cat=c.id;
  if(c.id===activeCat) b.classList.add('active');
  b.addEventListener('click', ()=>{ activeCat=c.id; catRow.querySelectorAll('button').forEach(x=>x.classList.toggle('active', x.dataset.cat===c.id)); updateHint(); renderMlpSets(); });
  catRow.appendChild(b);
});
function updateHint(){
  const h=document.getElementById('searchHint');
  const msgs={
    pokemon:'Live catalog & prices from TCGdex (TCGplayer market / Cardmarket).',
    magic:'Live catalog & daily prices from Scryfall (TCGplayer / Cardmarket snapshots). Magic card data is always free to browse.',
    yugioh:'Live catalog & prices from YGOPRODeck (TCGplayer / Cardmarket / eBay snapshots).',
    lorcana:'No free live catalog for Lorcana yet — add your cards with the manual form below. Nothing is priced without a source.',
    onepiece:'No free live catalog for One Piece yet — add your cards with the manual form below.',
    sports:'Sports-card pricing needs a licensed source we don’t have yet — track by hand, with grading company, grade and cert number.',
    comics:'Comics catalog/values need a licensed source — track issues, variants and graded slabs by hand. Values stay blank until you enter one.',
    mlp:'My Little Pony CCG (Enterplay): pick a set below to start tracking it. No pricing source exists for MLP cards — values are honestly unavailable.',
  };
  h.textContent = msgs[activeCat]||'';
}
function renderMlpSets(){
  const box=document.getElementById('mlpSets');
  if(activeCat!=='mlp'){ box.classList.add('hidden'); box.innerHTML=''; return; }
  box.classList.remove('hidden');
  box.innerHTML = MLP_SETS.map(s=>`<button data-set="${esc(s)}">${esc(s)}</button>`).join('');
  box.querySelectorAll('button').forEach(b=>b.addEventListener('click', ()=>{
    openModal({name:'', category:'mlp', set:b.dataset.set, image:''}, false);
    document.getElementById('modalTitle').textContent='Add a '+b.dataset.set+' card';
    document.getElementById('modalItem').innerHTML = `New My Little Pony card — <em>${esc(b.dataset.set)}</em><br><label style="margin-top:8px">Card name <input id="fName" type="text" placeholder="e.g. Rainbow Dash, Flier Extraordinaire"></label>`;
  }));
}

/* ---------- search ---------- */
document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('searchInput').addEventListener('keydown', e=>{ if(e.key==='Enter') doSearch(); });

let searchSeq=0;
async function doSearch(){
  const mySeq=++searchSeq;
  const q=document.getElementById('searchInput').value.trim();
  const box=document.getElementById('results');
  if(!q){ box.innerHTML=''; return; }
  const cat=CATEGORIES.find(c=>c.id===activeCat);
  if(!cat.live){ box.innerHTML=`<p class="hint">“${esc(CAT_LABEL[activeCat])}” has no live catalog yet — use “+ Manual add” below to track it. No prices will be invented.</p>`; return; }
  box.innerHTML='<p class="hint">Searching…</p>';
  try{
    let results=[];
    if(activeCat==='pokemon') results=await searchPokemon(q);
    else if(activeCat==='magic') results=await searchMagic(q);
    else if(activeCat==='yugioh') results=await searchYugioh(q);
    if(mySeq!==searchSeq) return; // a newer search superseded this one
    renderResults(results);
  }catch(err){ if(mySeq===searchSeq) box.innerHTML=`<p class="hint">Search failed (${esc(err.message)}). Check your connection and try again.</p>`; }
}

async function searchPokemon(q){
  const r=await fetch('https://api.tcgdex.net/v2/en/cards?name='+encodeURIComponent(q));
  if(!r.ok) throw new Error('TCGdex '+r.status);
  const briefs=(await r.json()).slice(0,24);
  const out=[];
  for(const b of briefs){
    try{
      const d=await (await fetch('https://api.tcgdex.net/v2/en/cards/'+encodeURIComponent(b.id))).json();
      let price=null, src='';
      const tp=d.pricing&&d.pricing.tcgplayer;
      if(tp){ const v=Object.values(tp).find(x=>x&&typeof x==='object'&&x.marketPrice); if(v){ price=v.marketPrice; src='TCGplayer market via TCGdex'; } }
      if(price==null && d.pricing&&d.pricing.cardmarket&&d.pricing.cardmarket.trend!=null){ price=d.pricing.cardmarket.trend; src='Cardmarket trend via TCGdex (EUR)'; }
      out.push({name:d.name, category:'pokemon', set:d.set?d.set.name:'', setId:d.set?d.set.id:'', cardId:d.id, image:(d.image?d.image+'/low.webp':''), value:price, valueSource:src});
    }catch(e){ /* skip failed detail */ }
  }
  return out;
}
async function searchMagic(q){
  const r=await fetch('https://api.scryfall.com/cards/search?q='+encodeURIComponent('name:'+q)+'&unique=prints');
  if(r.status===404) return [];
  if(!r.ok) throw new Error('Scryfall '+r.status);
  const d=await r.json();
  return (d.data||[]).slice(0,24).map(c=>{
    let price=null, src='';
    if(c.prices&&c.prices.usd){ price=parseFloat(c.prices.usd); src='TCGplayer via Scryfall (daily)'; }
    else if(c.prices&&c.prices.eur){ price=parseFloat(c.prices.eur); src='Cardmarket via Scryfall (EUR, daily)'; }
    return {name:c.name, category:'magic', set:c.set_name||'', setId:c.set||'', cardId:c.id, image:(c.image_uris?c.image_uris.normal:(c.card_faces&&c.card_faces[0].image_uris?c.card_faces[0].image_uris.normal:'')), value:price, valueSource:src};
  });
}
async function searchYugioh(q){
  const r=await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?fname='+encodeURIComponent(q));
  if(r.status===400) return [];
  if(!r.ok) throw new Error('YGOPRODeck '+r.status);
  const d=await r.json();
  const out=[];
  for(const c of (d.data||[]).slice(0,12)){
    const p=(c.card_prices&&c.card_prices[0])||{};
    let price=null, src='';
    const tcg=parseFloat(p.tcgplayer_price); const cm=parseFloat(p.cardmarket_price); const eb=parseFloat(p.ebay_price);
    if(tcg>0){ price=tcg; src='TCGplayer via YGOPRODeck'; } else if(cm>0){ price=cm; src='Cardmarket via YGOPRODeck (EUR)'; } else if(eb>0){ price=eb; src='eBay via YGOPRODeck'; }
    out.push({name:c.name, category:'yugioh', set:(c.card_sets&&c.card_sets[0]?c.card_sets[0].set_name:''), setId:'', cardId:String(c.id), image:(c.card_images&&c.card_images[0]?c.card_images[0].image_url:''), value:price, valueSource:src});
  }
  return out;
}

function renderResults(results){
  const box=document.getElementById('results');
  if(!results.length){ box.innerHTML='<p class="hint">No matches found in the live catalog. Try a different spelling, or add it by hand below.</p>'; return; }
  box.innerHTML='';
  results.forEach(it=>{
    const el=document.createElement('div'); el.className='card';
    el.innerHTML=`
      ${it.image?`<img loading="lazy" src="${esc(it.image)}" alt="${esc(it.name)}">`:'<div class="noimg">🃏</div>'}
      <div class="card-body">
        <h4>${esc(it.name)}</h4>
        <div class="set">${esc(it.set||'')}</div>
        ${it.value!=null?`<div class="price">${money(it.value)}</div><div class="price-src">${esc(it.valueSource)}</div>`:'<div class="price-src">No price from source</div>'}
        <div class="card-actions">
          <button class="add">+ Add</button>
          <button class="want">☆ Want</button>
        </div>
      </div>`;
    el.querySelector('.add').addEventListener('click', ()=>openModal(it,false));
    el.querySelector('.want').addEventListener('click', ()=>{ state.wishlist.push({...it, id:uid()}); save(); alert('Added to your wishlist.'); });
    box.appendChild(el);
  });
}

/* ---------- modal (confirm-before-add) ---------- */
const modal=document.getElementById('modal');
function binderOptions(sel){
  return '<option value="">No binder</option>'+state.binders.map(b=>`<option value="${b.id}" ${b.id===sel?'selected':''}>${esc(b.name)}</option>`).join('');
}
function openModal(item, isEdit){
  pendingItem=item; editingId=isEdit?item.id:null;
  document.getElementById('modalTitle').textContent=isEdit?'Edit item':'Confirm — add this exact item?';
  document.getElementById('modalItem').textContent=(item.name||'New item')+(item.set?' · '+item.set:'');
  document.getElementById('fCondition').value=item.condition||'Near Mint';
  document.getElementById('fBinder').innerHTML=binderOptions(item.binderId||'');
  document.getElementById('fPaid').value=item.paid??'';
  document.getElementById('fValue').value=item.value??'';
  document.getElementById('fValueSource').value=item.valueSource||'';
  document.getElementById('fGradeCo').value=item.gradeCo||'';
  document.getElementById('fGrade').value=item.grade||'';
  document.getElementById('fCert').value=item.cert||'';
  document.getElementById('fQty').value=item.qty||1;
  modal.classList.remove('hidden');
}
document.getElementById('modalCancel').addEventListener('click', ()=>modal.classList.add('hidden'));
document.getElementById('modalSave').addEventListener('click', ()=>{
  if(!pendingItem) return;
  const nameEl=document.getElementById('fName');
  const name=nameEl?nameEl.value.trim():pendingItem.name;
  if(!name){ alert('Give the item a name first.'); return; }
  const rec={
    ...pendingItem, name,
    id: editingId||uid(),
    condition:document.getElementById('fCondition').value,
    binderId:document.getElementById('fBinder').value||'',
    paid:parseFloat(document.getElementById('fPaid').value)||0,
    value:document.getElementById('fValue').value===''?null:parseFloat(document.getElementById('fValue').value),
    valueSource:document.getElementById('fValueSource').value.trim(),
    gradeCo:document.getElementById('fGradeCo').value.trim(),
    grade:document.getElementById('fGrade').value.trim(),
    cert:document.getElementById('fCert').value.trim(),
    qty:Math.max(1,parseInt(document.getElementById('fQty').value)||1),
    addedAt:pendingItem.addedAt||Date.now(),
  };
  if(editingId){ const i=state.items.findIndex(x=>x.id===editingId); if(i>=0) state.items[i]=rec; }
  else state.items.push(rec);
  save(); modal.classList.add('hidden');
  renderCollection(); renderBinders();
});
document.getElementById('manualBtn').addEventListener('click', ()=>{
  openModal({name:'', category:activeCat, set:'', image:''}, false);
  document.getElementById('modalItem').innerHTML=`New ${esc(CAT_LABEL[activeCat])} item<br><label style="margin-top:8px">Name <input id="fName" type="text" placeholder="Item name"></label><label>Set / series <input id="fSetName" type="text" placeholder="Optional"></label>`;
  const sn=document.getElementById('fSetName');
  sn.addEventListener('input', ()=>{ if(pendingItem) pendingItem.set=sn.value; });
});

/* ---------- photo assist ---------- */
document.getElementById('photoInput').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f) return;
  const img=document.getElementById('photoImg');
  img.src=URL.createObjectURL(f);
  document.getElementById('photoPreview').classList.remove('hidden');
  document.getElementById('searchInput').focus();
});

/* ---------- collection ---------- */
function renderTotals(){
  const total=state.items.reduce((s,i)=>s+((i.value||0)*(i.qty||1)),0);
  document.getElementById('totalsBar').innerHTML=`${state.items.length} items · Collection value: <strong>${money(total)}</strong>`;
}
function itemCard(i, mode){
  const el=document.createElement('div'); el.className='card';
  const gain=(i.value!=null)?(i.value-i.paid):null;
  const imgHtml = i.image ? '<img loading="lazy" src="'+esc(i.image)+'" alt="'+esc(i.name)+'">' : '<div class="noimg">'+(i.category==='comics'?'📚':'🃏')+'</div>';
  el.innerHTML=`
    ${imgHtml}
    <div class="card-body">
      <h4>${esc(i.name)}${i.qty>1?' ×'+i.qty:''}</h4>
      <div class="set">${esc(CAT_LABEL[i.category]||i.category)}${i.set?' · '+esc(i.set):''}</div>
      <div class="set">${esc(i.condition||'')}${i.gradeCo?' · '+esc(i.gradeCo)+' '+esc(i.grade):''}${i.cert?' · Cert '+esc(i.cert):''}</div>
      ${i.value!=null?`<div class="price">${money(i.value)}</div><div class="price-src">${esc(i.valueSource||'Manual value')}</div>`:'<div class="price-src">Value unavailable — no pricing source</div>'}
      <div class="set">Paid ${money(i.paid)}${gain!=null?` · <span class="${gain>=0?'gain':'loss'}">${gain>=0?'+':''}${money(gain)}</span>`:''}</div>
      <div class="card-actions">
        ${mode==='collection'?'<button class="edit">Edit</button><button class="del">Delete</button>':''}
        ${mode==='wishlist'?'<button class="got">Got it ✓</button><button class="del">Remove</button>':''}
      </div>
    </div>`;
  if(mode==='collection'){
    el.querySelector('.edit').addEventListener('click', ()=>openModal(i,true));
    el.querySelector('.del').addEventListener('click', ()=>{ if(confirm('Remove “'+i.name+'” from your collection?')){ state.items=state.items.filter(x=>x.id!==i.id); save(); renderCollection(); renderBinders(); } });
  }else if(mode==='wishlist'){
    el.querySelector('.got').addEventListener('click', ()=>{ state.wishlist=state.wishlist.filter(x=>x.id!==i.id); openModal({...i},false); renderWishlist(); });
    el.querySelector('.del').addEventListener('click', ()=>{ state.wishlist=state.wishlist.filter(x=>x.id!==i.id); save(); renderWishlist(); });
  }
  return el;
}
function renderCollection(){
  const catF=document.getElementById('colCatFilter');
  if(catF.options.length<=1) CATEGORIES.forEach(c=>{ const o=document.createElement('option'); o.value=c.id; o.textContent=c.label; catF.appendChild(o); });
  const bf=document.getElementById('colBinderFilter');
  bf.innerHTML='<option value="">All binders</option>'+state.binders.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('');
  const list=document.getElementById('collectionList'); list.innerHTML='';
  const items=state.items.filter(i=>(!catF.value||i.category===catF.value)&&(!bf.value||i.binderId===bf.value));
  items.forEach(i=>list.appendChild(itemCard(i,'collection')));
  document.getElementById('collectionEmpty').classList.toggle('hidden', state.items.length>0);
  const totalV=state.items.reduce((s,i)=>s+((i.value||0)*(i.qty||1)),0);
  const totalP=state.items.reduce((s,i)=>s+(i.paid*(i.qty||1)),0);
  document.getElementById('collectionSummary').innerHTML=`
    <div><span>Items</span><strong>${state.items.length}</strong></div>
    <div><span>Total value</span><strong>${money(totalV)}</strong></div>
    <div><span>Total paid</span><strong>${money(totalP)}</strong></div>
    <div><span>Gain / loss</span><strong class="${totalV-totalP>=0?'gain':'loss'}">${money(totalV-totalP)}</strong></div>`;
  renderTotals();
}
document.getElementById('colCatFilter').addEventListener('change', renderCollection);
document.getElementById('colBinderFilter').addEventListener('change', renderCollection);

/* ---------- binders ---------- */
document.getElementById('binderAdd').addEventListener('click', ()=>{
  const inp=document.getElementById('binderName'); const name=inp.value.trim(); if(!name) return;
  state.binders.push({id:uid(), name}); inp.value=''; save(); renderBinders(); renderCollection();
});
function renderBinders(){
  const box=document.getElementById('binderList'); box.innerHTML='';
  if(!state.binders.length){ box.innerHTML='<p class="empty">No binders yet. Create one above, then assign items to it when you add or edit them.</p>'; return; }
  state.binders.forEach(b=>{
    const items=state.items.filter(i=>i.binderId===b.id);
    const val=items.reduce((s,i)=>s+((i.value||0)*(i.qty||1)),0);
    const d=document.createElement('div'); d.className='binder-block';
    d.innerHTML=`<h4>${esc(b.name)}</h4><div class="set">${items.length} items · ${money(val)}</div>
      <div class="card-actions" style="max-width:260px"><button class="ren">Rename</button><button class="delb">Delete binder</button></div>
      <p class="hint">Deleting a binder keeps its items in your collection, unassigned.</p>`;
    d.querySelector('.ren').addEventListener('click', ()=>{ const n=prompt('New name:', b.name); if(n){ b.name=n; save(); renderBinders(); } });
    d.querySelector('.delb').addEventListener('click', ()=>{ if(confirm('Delete binder “'+b.name+'”? Items stay in your collection.')){ state.items.forEach(i=>{ if(i.binderId===b.id) i.binderId=''; }); state.binders=state.binders.filter(x=>x.id!==b.id); save(); renderBinders(); renderCollection(); } });
    box.appendChild(d);
  });
}

/* ---------- wishlist ---------- */
function renderWishlist(){
  const list=document.getElementById('wishlistList'); list.innerHTML='';
  state.wishlist.forEach(i=>list.appendChild(itemCard(i,'wishlist')));
  document.getElementById('wishlistEmpty').classList.toggle('hidden', state.wishlist.length>0);
}

/* ---------- sets ---------- */
let pokeSetsCache=null;
async function renderSets(){
  // Pokémon
  const box=document.getElementById('pokeSets');
  try{
    if(!pokeSetsCache){ const r=await fetch('https://api.tcgdex.net/v2/en/sets'); pokeSetsCache=await r.json(); }
    const owned={};
    state.items.filter(i=>i.category==='pokemon'&&i.setId).forEach(i=>{ (owned[i.setId]=owned[i.setId]||new Set()).add(i.cardId||i.name); });
    box.innerHTML='';
    pokeSetsCache.slice().reverse().slice(0,60).forEach(s=>{
      const total=(s.cardCount&&s.cardCount.total)||0;
      const have=owned[s.id]?owned[s.id].size:0;
      const pct=total?Math.min(100,Math.round(have/total*100)):0;
      const d=document.createElement('div'); d.className='set-row';
      d.innerHTML=`<div class="meta"><strong>${esc(s.name)}</strong><span>${have}/${total} · ${pct}%</span></div><div class="bar"><i style="width:${pct}%"></i></div>`;
      box.appendChild(d);
    });
  }catch(e){ box.innerHTML='<p class="hint">Couldn’t load the Pokémon set list from TCGdex right now.</p>'; }
  // MLP
  const mlpBox=document.getElementById('mlpProgress'); mlpBox.innerHTML='';
  MLP_SETS.forEach(s=>{
    const n=state.items.filter(i=>i.category==='mlp'&&i.set===s).reduce((a,i)=>a+(i.qty||1),0);
    const d=document.createElement('div'); d.className='set-row';
    d.innerHTML=`<div class="meta"><strong>${esc(s)}</strong><span>${n} cards tracked · value unavailable (no pricing source)</span></div>`;
    mlpBox.appendChild(d);
  });
  // other sets from collection
  const other=document.getElementById('otherSets'); other.innerHTML='';
  const groups={};
  state.items.filter(i=>i.category!=='pokemon'&&i.category!=='mlp'&&i.set).forEach(i=>{ const k=(CAT_LABEL[i.category]||i.category)+' — '+i.set; groups[k]=(groups[k]||0)+(i.qty||1); });
  const keys=Object.keys(groups);
  if(!keys.length) other.innerHTML='<p class="hint">Sets from your other categories will appear here as you add items with a set name.</p>';
  keys.forEach(k=>{ const d=document.createElement('div'); d.className='set-row'; d.innerHTML=`<div class="meta"><strong>${esc(k)}</strong><span>${groups[k]} cards</span></div>`; other.appendChild(d); });
}

/* ---------- init ---------- */
updateHint(); renderMlpSets(); renderTotals(); renderCollection(); renderWishlist();
