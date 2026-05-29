# Agentforce Readiness Assessment

A web application that connects to a Salesforce org via OAuth and automatically scores its readiness to implement Agentforce across 24 architectural dimensions. Designed for Salesforce consultants conducting pre-implementation assessments.

**Live app:** https://agentforce-readiness.onrender.com

**Setup guide:** [docs/setup-guide.md](docs/setup-guide.md) — how to configure a Connected App in a customer org and run an assessment.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sbilgram-lgtm/agentforce-readiness)

---

## What It Does

The app authenticates with your Salesforce org using OAuth 2.0 and runs a series of automated API checks against live org data. Results are displayed on a dashboard with a radar chart, colour-coded category scores (Green / Amber / Red), and specific findings for each failed check. A PDF export is available for sharing with stakeholders.

---

## The 24 Assessment Categories

### 1. Licensing & Product Enablement
Checks that Einstein Generative AI, Agentforce, and Data Cloud are enabled in org settings, that at least one permission set grants the Manage AI Agents permission, that active users are assigned an Agentforce permission set, and that the Einstein/Agentforce AI request quota (DailyEinsteinRequests) is provisioned.

### 2. Security Model & OWD
Reviews Case OWD (should not be Public Read/Write), checks for custom permission sets granting View All Data, verifies that Restriction Rules are in place to scope record visibility for the agent, confirms no objects have Public Read/Write external (guest) access, and checks that login IP ranges are configured.

### 3. Agent User & Least Privilege
Confirms a dedicated integration or automation user exists, verifies no custom permission sets grant Modify All Data, checks that Permission Set Groups are used to manage agent user permissions, confirms an Agentforce Bot User (AutoProc user type) has been provisioned, and verifies a permission set grants Run Flows for agent action execution.

### 4. Einstein Trust Layer
Checks that Einstein Generative AI is enabled (a Trust Layer prerequisite), verifies that Salesforce Data Classification has been applied to fields, confirms PII/PHI/Sensitive fields are tagged so the Trust Layer can mask them in prompts, checks the TrustLayerEnabled org setting, and confirms prompt templates are defined for agent grounding.

### 5. Data Quality & Grounding Readiness
Checks for active duplicate rules, measures custom field description coverage (flags if >30% of custom fields are missing descriptions), confirms Agentforce Data Libraries are configured, checks that active Case record types are defined, and verifies required custom fields are in place to enforce data completeness.

### 6. Knowledge Management
Verifies Knowledge is enabled with articles published, checks the archive-to-published ratio is healthy, flags stale articles (not updated in over 2 years) that would degrade agent grounding quality, and confirms Knowledge data categories are configured for agent topic scoping and article retrieval.

### 7. Omni-Channel & Routing
Confirms service channels, queues, routing configurations, and active presence statuses are in place, checks that a messaging or chat service channel is configured specifically for Agentforce, and verifies skill or availability-based routing is configured.

### 8. Messaging, Chat & Channels
Checks for configured and active messaging channels, verifies embedded service deployments exist for web chat, confirms an Embedded Service configuration exists, and checks that an active Enhanced Messaging or Web Chat channel is in place for Agentforce deployment.

### 9. Console & Agent Workspace
Confirms at least one Lightning Console app exists so human agents have a workspace when Agentforce escalates, checks that utility bar pages are configured for the Omni-Channel widget, verifies a Case-specific record page exists, and confirms a Console app page is configured.

### 10. Lightning Pages & UX
Checks that custom Lightning record pages exist for the objects the agent will touch or hand off to human agents, and verifies the Case record page is customised for the agent workspace.

### 11. Flow, Apex & Agent Actions
Verifies active flows exist as candidate agent actions and that flows have descriptions for agent discoverability, checks all Apex classes are on current API versions (≥v56), confirms active prompt templates are defined, flags any Apex classes with compilation errors, checks that agent actions (GenAiFunction) are configured, and verifies invocable Apex methods exist.

### 12. Agentforce Builder & Topics
Checks that Agentforce agents (Bot Definitions) and topics (GenAiPlugin) are defined, verifies the topics-to-agents ratio indicates proper decomposition, confirms at least one agent is Active (not just Draft), and checks that active GenAiFunction records are attached to topics.

### 13. Experience Cloud & External Access
Confirms active Experience Cloud sites exist if external user access is in scope, checks that Sharing Sets are configured for external user record access, and verifies guest users are active where Experience Cloud is in use.

### 14. Integration & External Systems
Checks that all remote sites use HTTPS, verifies Named Credentials are used for integrations, and confirms External Credentials are configured for OAuth-based external calls.

### 15. Data 360 / Data Cloud
Checks whether Data Cloud is provisioned and enabled, confirms Agentforce Data Libraries are configured for unstructured data grounding, and verifies External Service Registrations are complete for OpenAPI-based data connections.

### 16. Testing & Release Readiness
Checks org-wide Apex test coverage (must be ≥75%), confirms Apex test classes exist, validates the test-class-to-total-Apex ratio, verifies the Agentforce Testing Center has been used (GenAiPlannerFeedback records), and checks that a Full or Partial Copy sandbox exists for UAT and load testing.

### 17. Observability & Audit
Checks for Agentforce and Einstein event log files, confirms recent logs (last 7 days) are being captured, verifies prompt interaction data is being recorded (GenAiPromptInteraction), confirms dashboards exist for operational monitoring, and checks that MessagingSession data is being captured.

### 18. DevOps & ALM
Confirms sandboxes exist (no direct production development), verifies at least 3 sandboxes are in place for a Dev/QA/UAT environment strategy, checks that recent successful deployments indicate active CI/CD, and confirms Agentforce-related assets are source-controlled.

### 19. Performance, Scalability & Limits
Reads live org limit consumption from the Salesforce Limits API and flags Daily API Requests, Daily Async Apex, Daily Bulk API Batches, Daily Streaming Events, and Daily Einstein/Agentforce AI Requests if any are at or above 50% of their daily limit.

### 20. Compliance, Privacy & Legal
Checks for Data Privacy records (consent tracking), verifies field-level encryption is in use for sensitive data, and confirms event log files are available for an audit trail of AI-generated actions.

### 21. Agent Design & Use Case Readiness *(new)*
Checks that agents are defined and at least one is Active, verifies agents and topics have descriptions documenting the job-to-be-done, confirms agent actions are defined and documented, and verifies active prompt templates are in place. Also assesses whether success metrics, escalation models, intent documentation, and phased rollout plans have been defined.

### 22. Prompt Engineering & Grounding Strategy *(new)*
Checks that prompt templates are defined, verifies active (not just Draft) templates exist, confirms Flex-type templates are configured for maximum flexibility, checks that templates have descriptions for versioning and review, and verifies grounding data sources (Agentforce Data Libraries) are linked. Assesses whether prompts are scoped to the job-to-be-done, grounding sources are explicitly referenced, and a prompt review and versioning process is in place.

### 23. Escalation & Handoff Architecture *(new)*
Checks that active transfer/escalation flows are defined, verifies queues exist for escalated work routing, confirms active service channels are in place for handoff, checks that Omni-Channel flows are configured for routing logic, and verifies tiered queues and multi-channel support are in place. Assesses whether conversation context is passed on handoff, escalation triggers are defined, SLA handling is confirmed, and a fallback path exists for all failure modes.

### 24. MuleSoft, Middleware & External API Readiness *(new)*
Checks that Named Credentials are used for external integrations, verifies External Credentials are configured for OAuth-based auth, confirms External Service Registrations exist for OpenAPI-based connections, checks that all active remote sites use HTTPS, verifies External Services are documented, and confirms OAuth-based credentials are preferred over basic auth. Assesses whether API contracts, rate limits, retry strategies, and idempotency are defined for all external systems the agent calls.

---

## Scoring

| Score | Status |
|-------|--------|
| ≥ 80% | Green — Ready |
| 50–79% | Amber — Needs Attention |
| < 50% | Red — Not Ready |

Categories with three or more automated checks are scored entirely from API data. Mixed categories prepend automated findings and score from manual Yes/No questions answered by the consultant.

---

## Setup

### Prerequisites
- A Salesforce Connected App with OAuth enabled
- Callback URL set to `http://localhost:3000/auth/callback` (local) or your deployed app URL
- PKCE must be **disabled** on the Connected App
- The Connected App user must have API access and sufficient permissions to query the checked objects

### Local Development

1. Clone the repo and install dependencies:
   ```
   npm install
   ```

2. Create a `.env` file in the project root:
   ```
   SESSION_SECRET=your-secret-here
   PORT=3001
   SF_CALLBACK_URL=http://localhost:3000/auth/callback
   ```

3. Start both servers:
   ```
   npm run dev
   ```
   React runs on port 3000, Express on port 3001.

4. Open `http://localhost:3000`, enter your org URL, Consumer Key, and Consumer Secret, then click **Connect to Salesforce**.

### Deployment (Render)

- Build Command: `npm install --production=false && npm run build`
- Start Command: `node server/index.js`
- Environment variables: `SESSION_SECRET`, `BASE_URL` (your Render app URL), `NODE_ENV=production`

---

## Tech Stack

- **Frontend:** React 18 + TypeScript, Recharts (radar chart), jsPDF (export)
- **Backend:** Express, jsforce (Salesforce API), express-session
- **Auth:** OAuth 2.0 Authorization Code flow (Web Server)
