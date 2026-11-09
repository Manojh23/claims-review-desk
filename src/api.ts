import express, {type RequestHandler} from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import {z} from 'zod';
import type {Database, Row} from './db.js';
import {draftSchema, fallback, reasons, type Provider, type Reason} from './advice.js';

type Role = 'reviewer'|'viewer'|'worker';
type Config = {keys: Record<Role,string>; provider?: Provider; staticDir?: string};
const id = z.string().regex(/^DEMO-[A-Z0-9-]{1,38}$/);
const reason = z.enum(Object.keys(reasons) as [Reason,...Reason[]]);
const statuses = z.enum(['open','approved','dismissed']);
const claim = z.object({
  id, payer:z.enum(['Northstar','Harbor','Pine']),
  billed_cents:z.number().int().min(1).max(10_000_000),
  paid_cents:z.number().int().min(0).max(10_000_000),
  reason,
}).strict().refine(c=>c.paid_cents<c.billed_cents, 'Only open adjustments are accepted');
export const batchSchema = z.object({id,claims:z.array(claim).min(1).max(100)}).strict()
  .refine(b=>new Set(b.claims.map(c=>c.id)).size===b.claims.length,'Claim IDs must be unique per batch');
class Problem extends Error { constructor(public status:number,message:string){super(message);} }
type Claim = z.infer<typeof claim> & Row & {status: z.infer<typeof statuses>};
const hash = (v:string) => createHash('sha256').update(v).digest();

export function makeApp(db:Database, config:Config) {
  if (Object.values(config.keys).some(k=>k.length<12) || new Set(Object.values(config.keys)).size!==3)
    throw new Error('Configure three distinct access keys of at least 12 characters.');
  const app=express();
  app.disable('x-powered-by');
  app.use(express.json({limit:'96kb'}));
  app.use((_req,res,next)=>{res.setHeader('X-Request-Id',randomUUID());next();});
  app.use('/api',(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  const allow = (...roles:Role[]):RequestHandler => (req,res,next)=>{
    const m=req.get('authorization')?.match(/^Bearer (\S+)$/i);
    if(!m) return next(new Problem(401,'Access key required'));
    const found=(Object.keys(config.keys) as Role[]).find(k=>timingSafeEqual(hash(m[1]),hash(config.keys[k])));
    if(!found) return next(new Problem(401,'Invalid access key'));
    if(!roles.includes(found)) return next(new Problem(403,'This role cannot perform that action'));
    res.locals.role=found;next();
  };
  const readers=allow('reviewer','viewer');
  app.get('/api/health',async (_req,res)=>{await db.rows('SELECT 1');res.json({ok:true});});
  app.get('/api/session',readers,(_req,res)=>res.json({role:res.locals.role}));
  app.post('/api/batches',allow('reviewer'),async(req,res)=>{
    const b=batchSchema.parse(req.body);
    const digest=hash(JSON.stringify({...b,claims:b.claims.slice().sort((a,b)=>a.id.localeCompare(b.id))})).toString('hex');
    const result=await db.transaction(async q=>{
      const fresh=await q.rows('INSERT INTO batches(id,digest) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',[b.id,digest]);
      if(!fresh.length) {
        const [old]=await q.rows('SELECT digest FROM batches WHERE id=$1',[b.id]);
        if(old?.digest!==digest) throw new Problem(409,'Batch ID already used with a different payload');
        return {inserted:0,replay:true};
      }
      for(const c of b.claims) {
        const made=await q.rows('INSERT INTO claims(id,batch_id,payer,billed_cents,paid_cents,reason) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',
          [c.id,b.id,c.payer,c.billed_cents,c.paid_cents,c.reason]);
        if(!made.length) throw new Problem(409,'Claim ID already exists');
        await q.rows('INSERT INTO audit(claim_id,actor,action) VALUES($1,$2,$3)',[c.id,'reviewer','imported']);
      }
      return {inserted:b.claims.length,replay:false};
    });
    res.status(result.replay?200:201).json(result);
  });
  app.get('/api/claims',readers,async(req,res)=>{
    const filter=z.object({status:statuses.optional(),limit:z.coerce.number().int().min(1).max(100).default(50),
      offset:z.coerce.number().int().min(0).max(10000).default(0)}).parse(req.query);
    res.json(await db.rows(
      'SELECT id,payer,billed_cents,paid_cents,reason,status,created_at FROM claims WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
      [filter.status??null,filter.limit,filter.offset]));
  });
  app.get('/api/summary',readers,async(_req,res)=>{
    const [summary]=await db.rows(`SELECT count(*)::int total,count(*) FILTER(WHERE status='open')::int open,
      count(*) FILTER(WHERE status='approved')::int approved, count(*) FILTER(WHERE status='dismissed')::int dismissed,
      COALESCE(sum(billed_cents-paid_cents) FILTER(WHERE status='open'),0)::text open_cents FROM claims`);
    res.json(summary);
  });
  app.get('/api/claims/:id/audit',readers,async(req,res)=>{
    res.json(await db.rows('SELECT seq::text,actor,action,recorded_at FROM audit WHERE claim_id=$1 ORDER BY seq',[id.parse(req.params.id)]));
  });
  app.post('/api/claims/:id/draft',allow('reviewer'),async(req,res)=>{
    const [row]=await db.rows<Claim>('SELECT reason,paid_cents,billed_cents FROM claims WHERE id=$1 AND status=$2',[id.parse(req.params.id),'open']);
    if(!row) throw new Problem(404,'Open claim not found');
    const input={reason:row.reason,paid_cents:row.paid_cents,billed_cents:row.billed_cents};
    if(config.provider) {
      try {return res.json({...draftSchema.parse(await config.provider(input)),source:'azure'});}
      catch {return res.json({...fallback(input),source:'fallback'});}
    }
    res.json({...fallback(input),source:'template'});
  });
  app.post('/api/claims/:id/decision',allow('reviewer'),async(req,res)=>{
    const claimId=id.parse(req.params.id);
    const decision=z.object({decision:z.enum(['approved','dismissed'])}).strict().parse(req.body).decision;
    await db.transaction(async q=>{
      const changed=await q.rows("UPDATE claims SET status=$2 WHERE id=$1 AND status='open' RETURNING id",[claimId,decision]);
      if(!changed.length) throw new Problem(409,'Claim is not open for review');
      await q.rows('INSERT INTO audit(claim_id,actor,action) VALUES($1,$2,$3)',[claimId,'reviewer',decision]);
      if(decision==='approved') await q.rows('INSERT INTO outbox(claim_id) VALUES($1)',[claimId]);
    });
    res.json({status:decision});
  });
  app.get('/api/automation/jobs',allow('worker'),async(_req,res)=>{
    res.json(await db.rows("SELECT id::text,claim_id,'review_approved' AS event,created_at FROM outbox WHERE acknowledged_at IS NULL ORDER BY id LIMIT 100"));
  });
  app.post('/api/automation/jobs/:id/ack',allow('worker'),async(req,res)=>{
    const job=z.string().regex(/^[1-9][0-9]{0,17}$/).parse(req.params.id);
    const seen=await db.rows('UPDATE outbox SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1 RETURNING id',[job]);
    if(!seen.length) throw new Problem(404,'Job not found');
    res.json({acknowledged:true});
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'Unknown API route'}));
  if(config.staticDir) app.use(express.static(resolve(config.staticDir)));
  app.use(((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(err instanceof Problem) return res.status(err.status).json({error:err.message});
    if(err instanceof z.ZodError) return res.status(422).json({error:'Invalid request',issues:err.issues.map(i=>i.path.join('.')+': '+i.message)});
    if(err instanceof SyntaxError || (err && typeof err==='object' && 'status' in err && err.status===413))
      return res.status(err instanceof SyntaxError?400:413).json({error:'Invalid request body'});
    console.error(JSON.stringify({event:'request_failed',requestId:res.getHeader('X-Request-Id')}));
    res.status(500).json({error:'Unexpected server error'});
  }) as express.ErrorRequestHandler);
  return app;
}
