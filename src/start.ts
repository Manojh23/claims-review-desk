import { connect } from './db.js';
import { makeApp } from './api.js';
import { azureProvider } from './advice.js';

const e=process.env;
const keys={reviewer:e.REVIEWER_KEY??'',viewer:e.VIEWER_KEY??'',worker:e.WORKER_KEY??''};
const provider=e.AZURE_OPENAI_ENDPOINT && e.AZURE_OPENAI_API_KEY && e.AZURE_OPENAI_DEPLOYMENT
  ?azureProvider(e.AZURE_OPENAI_ENDPOINT,e.AZURE_OPENAI_API_KEY,e.AZURE_OPENAI_DEPLOYMENT):undefined;
const db=await connect(e.DATABASE_URL,e.EMBEDDED_DB_PATH??'.data');
const app=makeApp(db,{keys,provider,staticDir:'dist'});
const s=app.listen(Number(e.PORT??4173),e.HOST??'127.0.0.1',()=>console.log('Claims Review Desk ready'));
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>s.close(()=>void db.close()));
