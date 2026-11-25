'use strict';
/* CollectDex — local-first collection tracker. Data lives in localStorage.
   Live catalogs (browser-direct, CORS-open, no keys): TCGdex, Scryfall, YGOPRODeck.
   AI vision ID: intentionally NOT faked. If a vision provider key is ever added,
   set VISION_ENDPOINT below and identifyByVision() will return candidate names;
   until then identification = photo + name match against live catalogs, with the
   user confirming the exact printing before anything is added. */
const VISION_ENDPOINT = ''; // e.g. 'https://your-vision-proxy/identify' — empty = name matching only
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
const LIVE_CATS = ['pokemon','magic','yugioh'];

let state = load();
let activeCat = 'pokemon';
let pendingItem = null, editingId = null;

function normalizeItem(i){
  return { qty:1, paid:0, value:null, valueSource:'', priceHistory:(i.value!=null?[{t:i.addedAt||Date.now(), v:i.value}]:[]), location:'', gradeCo:'', grade:'', cert:'', condition:'Near Mint', binderId:'', ...i };
}
function load(){
  try{ const s = JSON.parse(localStorage.getItem(LS_KEY)); if(s && Array.isArray(s.items)){ s.items=s.items.map(normalizeItem); s.wishlist=(s.wishlist||[]).map(normalizeItem); return s; } }catch(e){}
  return {items:[], wishlist:[], binders:[]};
}
function save(){ localStorage.setItem(LS_KEY, JSON.stringify(state)); renderTotals(); }
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function money(n){ return (n==null||isNaN(n)) ? '—' : '$'+Number(n).toFixed(2); }
function esc(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function dupCount(item, excludeId){
  return state.items.filter(x=>x.id!==excludeId && ((item.cardId && x.cardId===item.cardId && x.category===item.category) || (!item.cardId && x.name.toLowerCase()===String(item.name||'').toLowerCase() && x.category===item.category))).reduce((s,x)=>s+(x.qty||1),0);
}

/* ---------- tabs ---------- */
function showTab(name){
  document.querySelectorAll('#tabs button').forEach(x=>x.classList.toggle('active', x.dataset.tab===name));
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  if(name==='sets') renderSets();
  if(name==='collection') renderCollection();
  if(name==='binders') renderBinders();
  if(name==='wishlist') renderWishlist();
}
document.querySelectorAll('#tabs button').forEach(b=>b.addEventListener('click', ()=>showTab(b.dataset.tab)));

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
  const msgs={
    pokemon:'Live catalog & prices from TCGdex (TCGplayer market / Cardmarket). Start typing for instant suggestions.',
    magic:'Live catalog & daily prices from Scryfall (TCGplayer / Cardmarket snapshots). Magic card data is always free to browse.',
    yugioh:'Live catalog & prices from YGOPRODeck (TCGplayer / Cardmarket / eBay snapshots).',
    lorcana:'No free live catalog for Lorcana yet — add your cards with the manual form below. Nothing is priced without a source.',
    onepiece:'No free live catalog for One Piece yet — add your cards with the manual form below.',
    sports:'Sports-card pricing needs a licensed source we don’t have yet — track by hand, with grading company, grade and cert number.',
    comics:'Comics catalog/values need a licensed source — track issues, variants and graded slabs by hand. Values stay blank until you enter one.',
    mlp:'My Little Pony CCG (Enterplay): pick a set below to start tracking it. No pricing source exists for MLP cards — values are honestly unavailable.',
  };
  document.getElementById('searchHint').textContent = msgs[activeCat]||'';
}
function renderMlpSets(){
  const box=document.getElementById('mlpSets');
  if(activeCat!=='mlp'){ box.classList.add('hidden'); box.innerHTML=''; return; }
  box.classList.remove('hidden');
  box.innerHTML = MLP_SETS.map(s=>`<button data-set="${esc(s)}">${esc(s)}</button>`).join('');
  box.querySelectorAll('button').forEach(b=>b.addEventListener('click', ()=>{
    openModal({name:'', category:'mlp', set:b.dataset.set, image:''}, false);
    document.getElementById('modalItem').innerHTML = `New My Little Pony card — <em>${esc(b.dataset.set)}</em><br><label style="margin-top:8px">Card name <input id="fName" type="text" placeholder="e.g. Rainbow Dash, Flier Extraordinaire"></label>`;
  }));
}

/* ---------- live catalog fetchers ---------- */
async function fetchPokemonById(id){
  const d=await (await fetch('https://api.tcgdex.net/v2/en/cards/'+encodeURIComponent(id))).json();
  let price=null, src='';
  const tp=d.pricing&&d.pricing.tcgplayer;
  if(tp){ const v=Object.values(tp).find(x=>x&&typeof x==='object'&&x.marketPrice); if(v){ price=v.marketPrice; src='TCGplayer market via TCGdex'; } }
  if(price==null && d.pricing&&d.pricing.cardmarket&&d.pricing.cardmarket.trend!=null){ price=d.pricing.cardmarket.trend; src='Cardmarket trend via TCGdex (EUR)'; }
  return {name:d.name, category:'pokemon', set:d.set?d.set.name:'', setId:d.set?d.set.id:'', cardId:d.id, image:(d.image?d.image+'/low.webp':''), value:price, valueSource:src};
}
async function searchPokemon(q){
  const r=await fetch('https://api.tcgdex.net/v2/en/cards?name='+encodeURIComponent(q));
  if(!r.ok) throw new Error('TCGdex '+r.status);
  const briefs=(await r.json()).slice(0,24);
  const out=[];
  for(const b of briefs){ try{ out.push(await fetchPokemonById(b.id)); }catch(e){} }
  return out;
}
function scryfallToItem(c){
  let price=null, src='';
  if(c.prices&&c.prices.usd){ price=parseFloat(c.prices.usd); src='TCGplayer via Scryfall (daily)'; }
  else if(c.prices&&c.prices.eur){ price=parseFloat(c.prices.eur); src='Cardmarket via Scryfall (EUR, daily)'; }
  return {name:c.name, category:'magic', set:c.set_name||'', setId:c.set||'', cardId:c.id, image:(c.image_uris?c.image_uris.normal:(c.card_faces&&c.card_faces[0].image_uris?c.card_faces[0].image_uris.normal:'')), value:price, valueSource:src};
}
async function searchMagic(q){
  const r=await fetch('https://api.scryfall.com/cards/search?q='+encodeURIComponent('name:'+q)+'&unique=prints');
  if(r.status===404) return [];
  if(!r.ok) throw new Error('Scryfall '+r.status);
  const d=await r.json();
  return (d.data||[]).slice(0,24).map(scryfallToItem);
}
async function fetchYugiohById(id){
  const r=await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?id='+encodeURIComponent(id));
  if(!r.ok) throw new Error('YGOPRODeck '+r.status);
  const d=await r.json(); return yugiohToItem(d.data[0]);
}
function yugiohToItem(c){
  const p=(c.card_prices&&c.card_prices[0])||{};
  let price=null, src='';
  const tcg=parseFloat(p.tcgplayer_price), cm=parseFloat(p.cardmarket_price), eb=parseFloat(p.ebay_price);
  if(tcg>0){ price=tcg; src='TCGplayer via YGOPRODeck'; } else if(cm>0){ price=cm; src='Cardmarket via YGOPRODeck (EUR)'; } else if(eb>0){ price=eb; src='eBay via YGOPRODeck'; }
  return {name:c.name, category:'yugioh', set:(c.card_sets&&c.card_sets[0]?c.card_sets[0].set_name:''), setId:'', cardId:String(c.id), image:(c.card_images&&c.card_images[0]?c.card_images[0].image_url:''), value:price, valueSource:src};
}
async function searchYugioh(q){
  const r=await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?fname='+encodeURIComponent(q));
  if(r.status===400) return [];
  if(!r.ok) throw new Error('YGOPRODeck '+r.status);
  const d=await r.json();
  return (d.data||[]).slice(0,12).map(yugiohToItem);
}
const SEARCHERS={pokemon:searchPokemon, magic:searchMagic, yugioh:searchYugioh};

/* ---------- search tab ---------- */
let searchSeq=0;
async function doSearch(){
  const mySeq=++searchSeq;
  const q=document.getElementById('searchInput').value.trim();
  const box=document.getElementById('results');
  hideAc();
  if(!q){ box.innerHTML=''; return; }
  const cat=CATEGORIES.find(c=>c.id===activeCat);
  if(!cat.live){ box.innerHTML=`<p class="hint">“${esc(CAT_LABEL[activeCat])}” has no live catalog yet — use “+ Manual add” below to track it. No prices will be invented.</p>`; return; }
  box.innerHTML='<p class="hint">Searching the live catalog…</p>';
  try{
    const results=await SEARCHERS[activeCat](q);
    if(mySeq!==searchSeq) return;
    renderResults(results, box);
  }catch(err){ if(mySeq===searchSeq) box.innerHTML=`<p class="hint">Search failed (${esc(err.message)}). Check your connection and try again.</p>`; }
}
document.getElementById('searchBtn').addEventListener('click', doSearch);
document.getElementById('searchInput').addEventListener('keydown', e=>{ if(e.key==='Enter') doSearch(); });

function renderResults(results, box){
  if(!results.length){ box.innerHTML='<p class="hint">No matches in the live catalog. Try a different spelling, or add it by hand.</p>'; return; }
  box.innerHTML='';
  results.forEach(it=>{
    const el=document.createElement('div'); el.className='card';
    const imgHtml = it.image ? '<img loading="lazy" src="'+esc(it.image)+'" alt="'+esc(it.name)+'">' : '<div class="noimg">🃏</div>';
    el.innerHTML=`
      ${imgHtml}
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
    el.querySelector('.want').addEventListener('click', ()=>{ state.wishlist.push(normalizeItem({...it, id:uid(), targetPrice:null, note:''})); save(); alert('Added to your wishlist.'); });
    box.appendChild(el);
  });
}

/* ---------- autocomplete (real catalog suggestions) ---------- */
const acBox=document.getElementById('acBox');
let acTimer=null;
function hideAc(){ acBox.classList.add('hidden'); acBox.innerHTML=''; }
document.getElementById('searchInput').addEventListener('input', e=>{
  const q=e.target.value.trim();
  clearTimeout(acTimer);
  if(q.length<2 || !CATEGORIES.find(c=>c.id===activeCat).live){ hideAc(); return; }
  acTimer=setTimeout(async ()=>{
    try{
      let sugg=[];
      if(activeCat==='magic'){
        const r=await fetch('https://api.scryfall.com/cards/autocomplete?q='+encodeURIComponent(q));
        const d=await r.json(); sugg=(d.data||[]).slice(0,8).map(n=>({name:n, sub:'Magic'}));
      }else if(activeCat==='pokemon'){
        const r=await fetch('https://api.tcgdex.net/v2/en/cards?name='+encodeURIComponent(q));
        const d=await r.json(); sugg=d.slice(0,8).map(c=>({name:c.name, sub:'Pokémon'}));
      }else if(activeCat==='yugioh'){
        const r=await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?fname='+encodeURIComponent(q));
        if(r.ok){ const d=await r.json(); sugg=(d.data||[]).slice(0,8).map(c=>({name:c.name, sub:'Yu-Gi-Oh!'})); }
      }
      if(!sugg.length){ hideAc(); return; }
      acBox.innerHTML='';
      sugg.forEach(s=>{
        const b=document.createElement('button');
        b.innerHTML=esc(s.name)+'<span>'+esc(s.sub)+'</span>';
        b.addEventListener('click', ()=>{ document.getElementById('searchInput').value=s.name; doSearch(); });
        acBox.appendChild(b);
      });
      acBox.classList.remove('hidden');
    }catch(err){ hideAc(); }
  }, 300);
});
document.addEventListener('click', e=>{ if(!e.target.closest('.ac-wrap')) hideAc(); });

/* ---------- SCAN flow ---------- */
let camStream=null;
document.getElementById('camStart').addEventListener('click', async ()=>{
  try{
    camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
    const v=document.getElementById('camVideo');
    v.srcObject=camStream; v.classList.remove('hidden');
    document.getElementById('camActions').classList.remove('hidden');
  }catch(e){ alert('Camera not available here — use “Upload / take photo” instead.'); }
});
document.getElementById('camStop').addEventListener('click', stopCam);
function stopCam(){ if(camStream){ camStream.getTracks().forEach(t=>t.stop()); camStream=null; } document.getElementById('camVideo').classList.add('hidden'); document.getElementById('camActions').classList.add('hidden'); }
document.getElementById('camSnap').addEventListener('click', ()=>{
  const v=document.getElementById('camVideo'), c=document.getElementById('camCanvas');
  c.width=v.videoWidth; c.height=v.videoHeight;
  c.getContext('2d').drawImage(v,0,0);
  const img=document.getElementById('scanImg');
  img.src=c.toDataURL('image/jpeg',0.85); img.classList.remove('hidden');
  stopCam();
  document.getElementById('scanName').focus();
});
document.getElementById('scanPhoto').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f) return;
  const img=document.getElementById('scanImg');
  img.src=URL.createObjectURL(f); img.classList.remove('hidden');
  document.getElementById('scanName').focus();
});
async function identifyByVision(/* photoDataUrl */){
  if(!VISION_ENDPOINT) return null; // no key configured — honest name-matching path
  return null; // plug a vision provider here; must return candidate names only
}
let scanSeq=0;
async function doScanFind(){
  const mySeq=++scanSeq;
  const q=document.getElementById('scanName').value.trim();
  const box=document.getElementById('scanResults');
  if(!q){ box.innerHTML=''; return; }
  box.innerHTML='<p class="hint">Matching against the live catalogs…</p>';
  try{
    const all=[];
    for(const cat of LIVE_CATS){ try{ (await SEARCHERS[cat](q)).forEach(r=>all.push(r)); }catch(e){} }
    if(mySeq!==scanSeq) return;
    // rank: exact name first, then starts-with, then contains
    const ql=q.toLowerCase();
    all.sort((a,b)=>{
      const rank=x=>x.name.toLowerCase()===ql?0:(x.name.toLowerCase().startsWith(ql)?1:2);
      return rank(a)-rank(b);
    });
    if(!all.length){ box.innerHTML='<p class="hint">No catalog matches for that name. Check the spelling on the card and try again — or add it by hand from the Search tab.</p>'; return; }
    renderResults(all.slice(0,18), box);
  }catch(err){ if(mySeq===scanSeq) box.innerHTML=`<p class="hint">Match failed (${esc(err.message)}).</p>`; }
}
document.getElementById('scanFind').addEventListener('click', doScanFind);
document.getElementById('scanName').addEventListener('keydown', e=>{ if(e.key==='Enter') doScanFind(); });

/* ---------- modal (confirm-before-add) ---------- */
const modal=document.getElementById('modal');
function binderOptions(sel){
  return '<option value="">No binder</option>'+state.binders.map(b=>`<option value="${b.id}" ${b.id===sel?'selected':''}>${esc(b.name)}</option>`).join('');
}
function openModal(item, isEdit){
  pendingItem=item; editingId=isEdit?item.id:null;
  document.getElementById('modalTitle').textContent=isEdit?'Edit item':'Confirm — add this exact item?';
  document.getElementById('modalItem').textContent=(item.name||'New item')+(item.set?' · '+item.set:'');
  const dw=document.getElementById('dupWarn');
  const dups=isEdit?0:dupCount(item,null);
  if(dups>0){ dw.textContent=`⚠ Duplicate check: you already own ${dups} cop${dups===1?'y':'ies'} of this card. Saving will add another — or cancel and edit the existing one to bump its quantity.`; dw.classList.remove('hidden'); }
  else dw.classList.add('hidden');
  document.getElementById('fCondition').value=item.condition||'Near Mint';
  document.getElementById('fBinder').innerHTML=binderOptions(item.binderId||'');
  document.getElementById('fLocation').value=item.location||'';
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
  const newValue=document.getElementById('fValue').value===''?null:parseFloat(document.getElementById('fValue').value);
  const history=Array.isArray(pendingItem.priceHistory)?[...pendingItem.priceHistory]:[];
  if(newValue!=null && (history.length===0 || history[history.length-1].v!==newValue)) history.push({t:Date.now(), v:newValue});
  const rec=normalizeItem({
    ...pendingItem, name,
    id: editingId||uid(),
    condition:document.getElementById('fCondition').value,
    binderId:document.getElementById('fBinder').value||'',
    location:document.getElementById('fLocation').value.trim(),
    paid:parseFloat(document.getElementById('fPaid').value)||0,
    value:newValue,
    valueSource:document.getElementById('fValueSource').value.trim(),
    gradeCo:document.getElementById('fGradeCo').value.trim(),
    grade:document.getElementById('fGrade').value.trim(),
    cert:document.getElementById('fCert').value.trim(),
    qty:Math.max(1,parseInt(document.getElementById('fQty').value)||1),
    priceHistory:history,
    addedAt:pendingItem.addedAt||Date.now(),
  });
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

/* ---------- collection ---------- */
function renderTotals(){
  const total=state.items.reduce((s,i)=>s+((i.value||0)*(i.qty||1)),0);
  document.getElementById('totalsBar').innerHTML=`${state.items.length} items · Collection value: <strong>${money(total)}</strong>`;
}
function itemCard(i, mode){
  const el=document.createElement('div'); el.className='card';
  const gain=(i.value!=null)?(i.value-i.paid):null;
  const dups=mode==='collection'?dupCount(i,i.id):0;
  const imgHtml = i.image ? '<img loading="lazy" src="'+esc(i.image)+'" alt="'+esc(i.name)+'">' : '<div class="noimg">'+(i.category==='comics'?'📚':'🃏')+'</div>';
  let extra='';
  if(mode==='wishlist'){
    if(i.targetPrice!=null) extra+=`<div class="set">Target: ${money(i.targetPrice)}</div>`;
    if(i.targetPrice!=null && i.value!=null && i.value<=i.targetPrice) extra+='<span class="target-badge">At / below target 🎯</span>';
    if(i.note) extra+=`<div class="set">📝 ${esc(i.note)}</div>`;
  }
  el.innerHTML=`
    ${imgHtml}
    <div class="card-body">
      <h4>${esc(i.name)}${i.qty>1?' ×'+i.qty:''}</h4>
      <div class="set">${esc(CAT_LABEL[i.category]||i.category)}${i.set?' · '+esc(i.set):''}</div>
      <div class="set">${esc(i.condition||'')}${i.gradeCo?' · '+esc(i.gradeCo)+' '+esc(i.grade):''}${i.cert?' · Cert '+esc(i.cert):''}</div>
      ${i.location?`<div class="set">📍 ${esc(i.location)}</div>`:''}
      ${dups>0?`<span class="dup-badge">Duplicate — ${dups} more owned</span>`:''}
      ${i.value!=null?`<div class="price">${money(i.value)}</div><div class="price-src">${esc(i.valueSource||'Manual value')}</div>`:'<div class="price-src">Value unavailable — no pricing source</div>'}
      ${mode==='collection'?`<div class="set">Paid ${money(i.paid)}${gain!=null?` · <span class="${gain>=0?'gain':'loss'}">${gain>=0?'+':''}${money(gain)}</span>`:''}</div>`:''}
      ${extra}
      <div class="card-actions">
        ${mode==='collection'?'<button class="edit">Edit</button><button class="del">Delete</button>':''}
        ${mode==='wishlist'?'<button class="got">Got it ✓</button><button class="tgt">Target / note</button><button class="del">Remove</button>':''}
      </div>
    </div>`;
  if(mode==='collection'){
    el.querySelector('.edit').addEventListener('click', ()=>openModal(i,true));
    el.querySelector('.del').addEventListener('click', ()=>{ if(confirm('Remove “'+i.name+'” from your collection?')){ state.items=state.items.filter(x=>x.id!==i.id); save(); renderCollection(); renderBinders(); } });
  }else if(mode==='wishlist'){
    el.querySelector('.got').addEventListener('click', ()=>{ state.wishlist=state.wishlist.filter(x=>x.id!==i.id); save(); openModal({...i},false); renderWishlist(); });
    el.querySelector('.tgt').addEventListener('click', ()=>{ const t=prompt('Target price in $ (blank = none):', i.targetPrice??''); if(t!==null){ i.targetPrice=t===''?null:parseFloat(t); const n=prompt('Note (optional):', i.note||''); if(n!==null) i.note=n; save(); renderWishlist(); } });
    el.querySelector('.del').addEventListener('click', ()=>{ state.wishlist=state.wishlist.filter(x=>x.id!==i.id); save(); renderWishlist(); });
  }
  return el;
}
function renderInsights(){
  const box=document.getElementById('insights');
  const movers=state.items.filter(i=>i.priceHistory&&i.priceHistory.length>=2&&i.value!=null)
    .map(i=>({name:i.name, first:i.priceHistory[0].v, now:i.value, chg:i.value-i.priceHistory[0].v}))
    .filter(m=>m.chg!==0)
    .sort((a,b)=>Math.abs(b.chg)-Math.abs(a.chg)).slice(0,5);
  const dupItems=state.items.filter(i=>dupCount(i,i.id)>0).length;
  if(!movers.length && !dupItems){ box.innerHTML='<h4>Insights</h4><p class="hint" style="margin:0">Price movers appear here after you refresh prices (snapshots are stored per item). Duplicate detection is always on.</p>'; return; }
  box.innerHTML='<h4>Insights</h4>'+
    movers.map(m=>`<div class="mover"><span>${esc(m.name)} <span style="color:var(--muted)">(${money(m.first)} → ${money(m.now)})</span></span><span class="${m.chg>=0?'gain':'loss'}">${m.chg>=0?'+':''}${money(m.chg)}</span></div>`).join('')+
    (dupItems?`<div class="mover"><span>Duplicates in collection</span><span>${dupItems} item${dupItems===1?'':'s'} — tick “Duplicates only” to review</span></div>`:'');
}
function renderCollection(){
  const catF=document.getElementById('colCatFilter');
  if(catF.options.length<=1) CATEGORIES.forEach(c=>{ const o=document.createElement('option'); o.value=c.id; o.textContent=c.label; catF.appendChild(o); });
  const bf=document.getElementById('colBinderFilter');
  const prevB=bf.value;
  bf.innerHTML='<option value="">All binders</option>'+state.binders.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('');
  bf.value=prevB;
  const tf=document.getElementById('colTextFilter').value.trim().toLowerCase();
  const sort=document.getElementById('colSort').value;
  const dupOnly=document.getElementById('colDupOnly').checked;
  let items=state.items.filter(i=>(!catF.value||i.category===catF.value)&&(!bf.value||i.binderId===bf.value)&&(!tf||i.name.toLowerCase().includes(tf))&&(!dupOnly||dupCount(i,i.id)>0));
  const by={ 'added':(a,b)=>b.addedAt-a.addedAt, 'value-desc':(a,b)=>(b.value||0)-(a.value||0), 'value-asc':(a,b)=>(a.value||0)-(b.value||0), 'gain-desc':(a,b)=>((b.value||0)-b.paid)-((a.value||0)-a.paid), 'paid-desc':(a,b)=>b.paid-a.paid, 'name':(a,b)=>a.name.localeCompare(b.name) };
  items=items.slice().sort(by[sort]||by.added);
  const list=document.getElementById('collectionList'); list.innerHTML='';
  items.forEach(i=>list.appendChild(itemCard(i,'collection')));
  document.getElementById('collectionEmpty').classList.toggle('hidden', state.items.length>0);
  const totalV=state.items.reduce((s,i)=>s+((i.value||0)*(i.qty||1)),0);
  const totalP=state.items.reduce((s,i)=>s+(i.paid*(i.qty||1)),0);
  document.getElementById('collectionSummary').innerHTML=`
    <div><span>Items</span><strong>${state.items.length}</strong></div>
    <div><span>Total value</span><strong>${money(totalV)}</strong></div>
    <div><span>Total paid</span><strong>${money(totalP)}</strong></div>
    <div><span>Gain / loss</span><strong class="${totalV-totalP>=0?'gain':'loss'}">${money(totalV-totalP)}</strong></div>`;
  renderInsights(); renderTotals();
}
['colCatFilter','colBinderFilter','colSort','colDupOnly'].forEach(id=>document.getElementById(id).addEventListener('change', renderCollection));
document.getElementById('colTextFilter').addEventListener('input', renderCollection);

/* ---------- price refresh (snapshots → movers) ---------- */
async function refreshOne(i){
  if(!i.cardId) return false;
  try{
    let fresh=null;
    if(i.category==='pokemon') fresh=await fetchPokemonById(i.cardId);
    else if(i.category==='magic'){ const r=await fetch('https://api.scryfall.com/cards/'+i.cardId); if(r.ok) fresh=scryfallToItem(await r.json()); }
    else if(i.category==='yugioh') fresh=await fetchYugiohById(i.cardId);
    if(fresh&&fresh.value!=null){
      if(i.value!==fresh.value){ i.priceHistory.push({t:Date.now(), v:fresh.value}); i.value=fresh.value; i.valueSource=fresh.valueSource; }
      return true;
    }
  }catch(e){}
  return false;
}
document.getElementById('refreshPrices').addEventListener('click', async ()=>{
  const msg=document.getElementById('ioMsg');
  const targets=state.items.filter(i=>LIVE_CATS.includes(i.category)&&i.cardId);
  if(!targets.length){ msg.textContent='No live-catalog items to refresh yet.'; return; }
  msg.textContent='Refreshing '+targets.length+' prices from their sources…';
  let ok=0; for(const i of targets){ if(await refreshOne(i)) ok++; }
  save(); renderCollection();
  msg.textContent=`Refreshed ${ok}/${targets.length} prices. Snapshots saved — see Insights for movers.`;
});

/* ---------- import / export ---------- */
function download(name, text, type){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
}
document.getElementById('exportJson').addEventListener('click', ()=>download('collectdex-export.json', JSON.stringify(state,null,2), 'application/json'));
document.getElementById('exportCsv').addEventListener('click', ()=>{
  const head=['name','category','set','condition','qty','paid','value','valueSource','gradeCo','grade','cert','location','binder'];
  const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const rows=state.items.map(i=>{ const b=state.binders.find(x=>x.id===i.binderId); return [i.name,CAT_LABEL[i.category]||i.category,i.set,i.condition,i.qty,i.paid,i.value??'',i.valueSource,i.gradeCo,i.grade,i.cert,i.location,b?b.name:''].map(q).join(','); });
  download('collectdex-export.csv', head.join(',')+'\n'+rows.join('\n'), 'text/csv');
});
document.getElementById('importFile').addEventListener('change', async e=>{
  const f=e.target.files[0]; if(!f) return;
  const msg=document.getElementById('ioMsg');
  try{
    const text=await f.text();
    let added=0;
    if(f.name.endsWith('.json')){
      const d=JSON.parse(text);
      (d.items||[]).forEach(i=>{ state.items.push(normalizeItem({...i, id:uid()})); added++; });
      (d.binders||[]).forEach(b=>{ if(!state.binders.some(x=>x.name===b.name)) state.binders.push({id:b.id||uid(), name:b.name}); });
      (d.wishlist||[]).forEach(i=>{ state.wishlist.push(normalizeItem({...i, id:uid()})); });
    }else{
      const lines=text.trim().split('\n').slice(1);
      lines.forEach(line=>{
        const cells=[]; let cur='', inQ=false;
        for(let k=0;k<line.length;k++){ const ch=line[k]; if(ch==='"'){ if(inQ&&line[k+1]==='"'){ cur+='"'; k++; } else inQ=!inQ; } else if(ch===','&&!inQ){ cells.push(cur); cur=''; } else cur+=ch; }
        cells.push(cur);
        if(cells.length<2||!cells[0]) return;
        const catId=(Object.entries(CAT_LABEL).find(([,l])=>l===cells[1])||['pokemon'])[0];
        state.items.push(normalizeItem({id:uid(), name:cells[0], category:catId, set:cells[2]||'', condition:cells[3]||'Near Mint', qty:parseInt(cells[4])||1, paid:parseFloat(cells[5])||0, value:cells[6]===''?null:parseFloat(cells[6]), valueSource:cells[7]||'', gradeCo:cells[8]||'', grade:cells[9]||'', cert:cells[10]||'', location:cells[11]||'', addedAt:Date.now()}));
        added++;
      });
    }
    save(); renderCollection(); renderBinders();
    msg.textContent='Imported '+added+' items.';
  }catch(err){ msg.textContent='Import failed: '+err.message; }
  e.target.value='';
});

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
      <div class="card-actions" style="max-width:280px"><button class="ren">Rename</button><button class="delb">Delete binder</button></div>
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

/* ---------- sets & missing cards ---------- */
let pokeSetsCache=null;
async function renderSets(){
  const box=document.getElementById('pokeSets');
  try{
    if(!pokeSetsCache){ const r=await fetch('https://api.tcgdex.net/v2/en/sets'); pokeSetsCache=await r.json(); }
    const owned={};
    state.items.filter(i=>i.category==='pokemon'&&i.setId).forEach(i=>{ (owned[i.setId]=owned[i.setId]||new Set()).add(i.cardId||i.name); });
    box.innerHTML='';
    const sf=(document.getElementById('setFilter').value||'').trim().toLowerCase();
    pokeSetsCache.slice().reverse().filter(s=>!sf||s.name.toLowerCase().includes(sf)).forEach(s=>{
      const total=(s.cardCount&&s.cardCount.total)||0;
      const have=owned[s.id]?owned[s.id].size:0;
      const pct=total?Math.min(100,Math.round(have/total*100)):0;
      const d=document.createElement('div'); d.className='set-row';
      d.innerHTML=`<div class="meta"><strong>${esc(s.name)}</strong><span>${have}/${total} · ${pct}% — tap for missing cards</span></div><div class="bar"><i style="width:${pct}%"></i></div>`;
      d.addEventListener('click', ()=>showSetDetail(s));
      box.appendChild(d);
    });
  }catch(e){ box.innerHTML='<p class="hint">Couldn’t load the Pokémon set list from TCGdex right now.</p>'; }
  const mlpBox=document.getElementById('mlpProgress'); mlpBox.innerHTML='';
  MLP_SETS.forEach(s=>{
    const n=state.items.filter(i=>i.category==='mlp'&&i.set===s).reduce((a,i)=>a+(i.qty||1),0);
    const d=document.createElement('div'); d.className='set-row';
    d.innerHTML=`<div class="meta"><strong>${esc(s)}</strong><span>${n} cards tracked · value unavailable (no pricing source)</span></div>`;
    mlpBox.appendChild(d);
  });
  const other=document.getElementById('otherSets'); other.innerHTML='';
  const groups={};
  state.items.filter(i=>i.category!=='pokemon'&&i.category!=='mlp'&&i.set).forEach(i=>{ const k=(CAT_LABEL[i.category]||i.category)+' — '+i.set; groups[k]=(groups[k]||0)+(i.qty||1); });
  const keys=Object.keys(groups);
  if(!keys.length) other.innerHTML='<p class="hint">Sets from your other categories will appear here as you add items with a set name.</p>';
  keys.forEach(k=>{ const d=document.createElement('div'); d.className='set-row'; d.innerHTML=`<div class="meta"><strong>${esc(k)}</strong><span>${groups[k]} cards</span></div>`; other.appendChild(d); });
}
async function showSetDetail(set){
  const box=document.getElementById('setDetail');
  box.classList.remove('hidden');
  box.innerHTML=`<h4 style="margin:0 0 6px">${esc(set.name)} — what you're missing</h4><p class="hint">Loading the full set list from TCGdex…</p>`;
  box.scrollIntoView({behavior:'smooth'});
  try{
    const d=await (await fetch('https://api.tcgdex.net/v2/en/sets/'+encodeURIComponent(set.id))).json();
    const ownedIds=new Set(state.items.filter(i=>i.category==='pokemon').map(i=>i.cardId));
    const cards=d.cards||[];
    const missing=cards.filter(c=>!ownedIds.has(c.id));
    box.innerHTML=`<h4 style="margin:0 0 6px">${esc(set.name)} — ${cards.length-missing.length}/${cards.length} owned · ${missing.length} missing</h4>
      <p class="hint">Greyed cards are the ones you're missing. Tap a missing card to search & add it.</p>
      <div class="grid">${cards.map(c=>{
        const own=ownedIds.has(c.id);
        return `<div class="mini ${own?'owned':'missing'}" data-id="${esc(c.id)}" data-name="${esc(c.name)}">${c.image?`<img loading="lazy" src="${esc(c.image)}/low.webp" alt="${esc(c.name)}">`:''}<div>${esc(c.name)}${own?' ✓':''}</div></div>`;
      }).join('')}</div>`;
    box.querySelectorAll('.mini.missing').forEach(el=>el.addEventListener('click', async ()=>{
      const it=await fetchPokemonById(el.dataset.id);
      openModal(it,false);
    }));
  }catch(e){ box.innerHTML='<p class="hint">Couldn’t load that set’s card list right now.</p>'; }
}

document.getElementById('setFilter').addEventListener('input', ()=>{ if(pokeSetsCache) renderSets(); });

/* ---------- init ---------- */
updateHint(); renderMlpSets(); renderTotals(); renderCollection(); renderWishlist();
