# Agentforce Readiness Assessment

A web application that connects to a Salesforce org via OAuth and automatically scores its readiness to implement Agentforce across 20 architectural dimensions. Designed for Salesforce consultants conducting pre-implementation assessments.

---

## What It Does

The app authenticates with your Salesforce org using OAuth 2.0 and runs a series of automated API checks against live org data. Results are displayed on a dashboard with a radar chart, colour-coded category scores (Green / Amber / Red), and specific findings for each failed check. A PDF export is available for sharing with stakeholders.

---

## The 20 Assessment Categories

### 1. Licensing & Product Enablement
Checks that Einstein Generative AI, Agentforce, and Data Cloud are enabled in org settings, and that at least one permission set grants the Manage AI Agents permission.

### 2. Security Model & OWD
Reviews Case OWD (should not be Public Read/Write), checks for custom permission sets granting View All Data, and verifies that Restriction Rules are in place to scope record visibility for the agent.

### 3. Agent User & Least Privilege
Confirms a dedicated integration or automation user exists, verifies no custom permission sets grant Modify All Data, and checks that Permission Set Groups are used to manage agent user permissions.

### 4. Einstein Trust Layer
Checks that Einstein Generative AI is enabled (a Trust Layer prerequisite), verifies that Salesforce Data Classification has been applied to fields, and confirms PII/PHI/Sensitive fields are tagged so the Trust Layer can mask them in prompts.

### 5. Data Quality & Grounding Readiness
Checks for active duplicate rules, measures custom field description coverage (flags if >30% of custom fields are missing descriptions), and confirms Agentforce Data Libraries are configured for unstructured data grounding.

### 6. Knowledge Management
Verifies Knowledge is enabled with article types defined, checks that published articles exist, and confirms the archive-to-published ratio is healthy.

### 7. Omni-Channel & Routing
Confirms service channels, queues, routing configurations, and active presence statuses are all in place for Omni-Channel routing to work with Agentforce.

### 8. Messaging, Chat & Channels
Checks for configured and active messaging channels, and verifies embedded service deployments exist for web chat.

### 9. Console & Agent Workspace
Confirms at least one Lightning Console app exists so human agents have a workspace when Agentforce escalates.

### 10. Lightning Pages & UX
Checks that custom Lightning record pages exist for the objects the agent will touch or hand off to human agents.

### 11. Flow, Apex & Agent Actions
Verifies active flows exist as candidate agent actions, checks all Apex classes are on current API versions (≥v50), confirms prompt templates are defined, and flags any Apex classes with compilation errors.

### 12. Agentforce Builder & Topics
Checks that Agentforce agents (Bot Definitions) and topics are defined in the org, and that the topics-to-agents ratio indicates proper decomposition.

### 13. Experience Cloud & External Access
Confirms active Experience Cloud sites exist if external user access is in scope, and checks that Sharing Sets are configured for external user record access.

### 14. Integration & External Systems
Checks that all remote sites use HTTPS, verifies Named Credentials are used for integrations, and confirms External Credentials are configured for OAuth-based external calls.

### 15. Data 360 / Data Cloud
Checks whether Data Cloud data streams are configured for Agentforce grounding.

### 16. Testing & Release Readiness
Checks org-wide Apex test coverage (must be ≥75%), confirms Apex test classes exist, and validates the test-class-to-total-Apex ratio is adequate.

### 17. Observability & Audit
Checks for Agentforce and Einstein event log files and confirms recent logs (last 7 days) are being captured.

### 18. DevOps & ALM
Confirms sandboxes exist (no direct production development), checks that multiple environments are in place for a proper dev/QA/UAT strategy, and verifies recent successful deployments indicate active CI/CD.

### 19. Performance, Scalability & Limits
Reads live org limit consumption from the Salesforce Limits API and flags Daily API Requests, Daily Async Apex, Daily Bulk API Batches, and Daily Streaming Events if any are at or above 50% of their daily limit.

### 20. Compliance, Privacy & Legal
Checks for Data Privacy records (consent tracking), verifies field-level encryption is in use for sensitive data, and confirms event log files are available for an audit trail.

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
