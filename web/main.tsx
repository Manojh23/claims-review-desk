import {useEffect,useState, type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import fixture from '../fixtures/sample.json' with {type:'json'};
import './style.css';

type Claim={id:string;payer:string;billed_cents:number;paid_cents:number;reason:string;status:string};
type Summary={total:number;open:number;approved:number;dismissed:number;open_cents:string};
type Draft={summary:string;nextStep:string;source:string};
type Audit={seq:string;action:string;actor:string;recorded_at:string};
const usd=(c:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100);
async function api<T>(key:string,path:string,body?:unknown):Promise<T>{
  const r=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',
    headers:{Authorization:'Bearer '+key,...(body!==undefined?{'Content-Type':'application/json'}:{})},
    body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();
  if(!r.ok) throw new Error(data.error??'Request failed');
  return data;
}

function App(){
  const [input,setInput]=useState('');
  const [session,setSession]=useState<{key:string;role:string}|null>(null);
  const [summary,setSummary]=useState<Summary>();
  const [claims,setClaims]=useState<Claim[]>([]);
  const [filter,setFilter]=useState('open');
  const [offset,setOffset]=useState(0);
  const [selected,select]=useState<Claim>();
  const [draft,setDraft]=useState<Draft>();
  const [audit,setAudit]=useState<Audit[]>([]);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const report=(e:unknown)=>setError(e instanceof Error?e.message:'Request failed');
  useEffect(()=>{
    if(!session) return;
    let active=true;
    const f=filter==='all'?'':'&status='+filter;
    Promise.all([api<Claim[]>(session.key,'claims?limit=20&offset='+offset+f),api<Summary>(session.key,'summary')])
      .then(([rows,s])=>{if(active){setClaims(rows);setSummary(s);}})
      .catch(e=>{if(active)report(e);});
    return ()=>{active=false;};
  },[session,filter,offset,refresh]);
  useEffect(()=>{
    setAudit([]);setDraft(undefined);
    if(!session||!selected)return;
    let active=true;
    api<Audit[]>(session.key,'claims/'+selected.id+'/audit')
      .then(a=>{if(active)setAudit(a);}).catch(e=>{if(active)report(e);});
    return ()=>{active=false;};
  },[session,selected,refresh]);
  const perform=async (fn:()=>Promise<void>)=>{
    setBusy(true);setError('');setMessage('');
    try{await fn();}catch(e){report(e);}finally{setBusy(false);}
  };
  const login=(e:FormEvent)=>{
    e.preventDefault();
    void perform(async()=>{
      const key=input.trim();
      const x=await api<{role:string}>(key,'session');
      setSession({key,role:x.role});setInput('');
    });
  };
  const reviewer=session?.role==='reviewer';
  const importBatch=()=>void perform(async()=>{
    const result=await api<{inserted:number;replay:boolean}>(session!.key,'batches',fixture);
    setMessage(result.replay?'This sample batch was already imported.':result.inserted+' sample claims imported.');
    setOffset(0);setRefresh(v=>v+1);
  });
  const makeDraft=()=>void perform(async()=>setDraft(await api<Draft>(session!.key,'claims/'+selected!.id+'/draft',{})));
  const decide=(decision:string)=>void perform(async()=>{
    await api(session!.key,'claims/'+selected!.id+'/decision',{decision});
    setMessage(selected!.id+' '+decision+'.');select(undefined);setRefresh(v=>v+1);
  });
  return <>
    <header><div><span className="eyebrow">REVENUE OPERATIONS DEMO</span><h1>Claims Review Desk</h1></div>
      {session&&<button className="secondary" disabled={busy} onClick={()=>{setSession(null);select(undefined);setClaims([]);setSummary(undefined);setAudit([]);setDraft(undefined);setMessage('');setError('');setOffset(0);}}>Sign out</button>}</header>
    <main>
      <p className="banner">Sandbox · Synthetic claims only</p>
      {error&&<p className="alert" role="alert">{error}</p>}
      {message&&<p className="notice" role="status">{message}</p>}
      {!session?<section className="sign"><h2>Open the review desk</h2><p>Enter your reviewer or viewer key.</p>
        <form onSubmit={login}><label htmlFor="access">Access key</label><input id="access" type="password" value={input} onChange={e=>setInput(e.target.value)} required/>
        <button disabled={busy}>Open desk</button></form></section>:<>
        <div className="stats">
          {[['Open claims',summary?.open],['Open adjustments',summary?usd(Number(summary.open_cents)):undefined],['Approved',summary?.approved],['Dismissed',summary?.dismissed]].map(([label,value])=>
            <div className="stat" key={label}><span>{label}</span><strong>{value??'—'}</strong></div>)}
        </div>
        <section>
          <div className="bar"><h2>Review queue</h2><div className="actions">
            <label htmlFor="status">Status</label><select id="status" value={filter} onChange={e=>{setFilter(e.target.value);setOffset(0);select(undefined);}}>
              <option value="open">Open</option><option value="approved">Approved</option><option value="dismissed">Dismissed</option><option value="all">All</option>
            </select>{reviewer&&<button disabled={busy} onClick={importBatch}>Import sample batch</button>}</div></div>
          <div className="table"><table><thead><tr><th>Claim</th><th>Payer</th><th>Reason</th><th>Adjustment</th><th>Status</th></tr></thead>
          <tbody>{claims.map(c=><tr key={c.id}><td><button className="link" disabled={busy} onClick={()=>select(c)}>{c.id}</button></td><td>{c.payer}</td><td>{c.reason.replaceAll('_',' ').toLowerCase()}</td><td>{usd(c.billed_cents-c.paid_cents)}</td><td><span className="pill">{c.status}</span></td></tr>)}</tbody></table></div>
          {!claims.length&&<p>No claims match this view.</p>}
          {(offset>0||claims.length===20)&&<div className="actions pages"><button className="secondary" disabled={!offset} onClick={()=>{setOffset(v=>v-20);select(undefined);}}>Previous</button><button className="secondary" disabled={claims.length<20} onClick={()=>{setOffset(v=>v+20);select(undefined);}}>Next</button></div>}
        </section>
        {selected&&<section aria-label="Claim details">
          <div className="bar"><h2>{selected.id}</h2><button className="secondary" disabled={busy} onClick={()=>select(undefined)}>Close detail</button></div>
          <p>{selected.payer} · Billed {usd(selected.billed_cents)} · Paid {usd(selected.paid_cents)}</p>
          {reviewer&&selected.status==='open'&&<div className="actions">
            <button className="secondary" disabled={busy} onClick={makeDraft}>Draft review note</button>
            <button disabled={busy} onClick={()=>decide('approved')}>Approve for automation</button>
            <button className="secondary" disabled={busy} onClick={()=>decide('dismissed')}>Dismiss</button>
          </div>}
          {draft&&<div className="draft"><strong>Suggested note · {draft.source}</strong><p>{draft.summary}</p><p>{draft.nextStep}</p></div>}
          <h3>Audit history</h3>
          <ul>{audit.map(a=><li key={a.seq}>{a.action} · {a.actor} · {new Date(a.recorded_at).toLocaleString()}</li>)}</ul>
        </section>}
      </>}
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<App/>);
