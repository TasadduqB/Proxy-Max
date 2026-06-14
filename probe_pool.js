(async ()=>{
  try{
    const base='http://127.0.0.1:8787';
    const poolRes=await fetch(base+'/api/pool');
    const poolJson=await poolRes.json();
    const pool=poolJson.pool || [];
    for(const e of pool){
      console.log('\n---- Testing:', e.label || e.model, '(', e.provider, '/', e.model,') ----');
      const body = { provider: e.provider, config: { model: e.model } };
      try{
        const r = await fetch(base+'/api/test',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        const j = await r.json();
        console.log('status:', r.status, JSON.stringify(j).slice(0,1000));
      }catch(err){
        console.error('probe error:', String(err));
      }
    }
  }catch(err){ console.error(err); process.exit(1); }
})();
