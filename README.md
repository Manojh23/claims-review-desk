# Claims Review Desk

A full-stack portfolio demo for a revenue cycle review queue. A reviewer imports a normalized synthetic remittance batch, reviews open adjustments, requests a suggested note, and makes a human decision. An approved item becomes an automation job. The app contains only fictional sample data.

## Run it

Use Node.js 22.12+ and npm. The default stores data in embedded PostgreSQL (PGlite); no cloud account is required.

```bash
npm ci
npm run build
npm test
export REVIEWER_KEY="$(openssl rand -hex 18)"
export VIEWER_KEY="$(openssl rand -hex 18)"
export WORKER_KEY="$(openssl rand -hex 18)"
npm start
```

Open http://127.0.0.1:4173 and paste your reviewer key. Choose **Import sample batch**, open a claim, then choose **Draft review note** or **Approve for automation**. Importing the same sample again does not duplicate it. Log in with the viewer key to see read-only access. Keep keys in your local shell; do not commit them.

For a PostgreSQL server instead, set `DATABASE_URL` to a dedicated local demo database. Docker Compose defines the web service and a PostgreSQL 16 container. With the keys above still exported, set `POSTGRES_PASSWORD` to an alphanumeric random string and run `docker compose up --build`. The published port binds to loopback. Docker Compose configuration is provided as an alternate run path.

## Design

- **React and TypeScript:** status-filtered queue, summary cards, draft note and audit history.
- **Express and PostgreSQL:** validated REST routes, parameterized SQL, indexed queue and audit tables, and integer-cent accounting.
- **Transactional intake:** the batch ID and normalized payload hash detect retries and changed replays. Claim creation and audit records succeed or roll back together.
- **Human review and automation:** reviewer, viewer and worker keys enforce separate API permissions. The approval, audit entry and outbox write are committed together. A worker polls jobs and acknowledges by job ID; it should deduplicate processing by that ID because an unacknowledged job may appear again. The queue is a mock robot handoff, with no UiPath calls.
- **Suggested notes:** template mode works offline. Set `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and `AZURE_OPENAI_DEPLOYMENT` to enable the optional Azure adapter with a deployment that supports JSON mode. The request contains only a synthetic reason category and amounts; output is schema validated and a template is used on errors. A note never changes a decision. The adapter is tested with mocked responses; no live Azure deployment was used.
- **Checks:** GitHub Actions builds and runs the integration tests. The application exposes database readiness and request IDs.

## API reference

Use `Authorization: Bearer <role key>` for protected routes. Request bodies are JSON.

| Method and path | Access | Behavior |
|---|---|---|
| GET /api/health | Public | Check database readiness |
| GET /api/session | Reviewer, viewer | Identify active role |
| POST /api/batches | Reviewer | Import a normalized synthetic batch; see fixtures/sample.json |
| GET /api/claims | Reviewer, viewer | Filter by status; paginate with limit and offset |
| GET /api/summary | Reviewer, viewer | Queue counts and open adjustment total |
| GET /api/claims/:id/audit | Reviewer, viewer | Show the claim event history |
| POST /api/claims/:id/draft | Reviewer | Suggest a note for an open claim |
| POST /api/claims/:id/decision | Reviewer | Set decision to approved or dismissed |
| GET /api/automation/jobs | Worker | Read the next pending automation jobs |
| POST /api/automation/jobs/:id/ack | Worker | Acknowledge a job; retry safe |

## Scope

The JSON fixture is inspired by the [remittance workflow described by CMS](https://www.cms.gov/medicare/coding-billing/electronic-billing/health-care-payment-remittance-advice). This demo does not parse X12 835 files, connect to an EHR or clearinghouse, or use production health data. It is not a HIPAA or SOC 2 implementation. The Azure adapter follows the [Microsoft chat API reference](https://learn.microsoft.com/en-us/azure/foundry/openai/latest).
