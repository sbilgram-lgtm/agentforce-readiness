# Agentforce Readiness Assessment — Setup Guide

This guide walks you through connecting the Agentforce Readiness Assessment app to a customer's Salesforce sandbox org. The app is already deployed and ready to use — you just need to create a Connected App in the customer org.

---

## What You Need

- Access to the customer's **sandbox org** with System Administrator profile
- The app URL: **https://agentforce-readiness.onrender.com**

---

## Step 1 — Create a Connected App in the Customer Org

1. Log in to the customer sandbox as a System Administrator
2. Go to **Setup** → search for **App Manager** → click **New Connected App**
3. Fill in the following:

   **Basic Information**
   | Field | Value |
   |-------|-------|
   | Connected App Name | `Agentforce Readiness Assessment` |
   | API Name | `Agentforce_Readiness_Assessment` |
   | Contact Email | your email address |

   **API (Enable OAuth Settings)**
   - Check **Enable OAuth Settings**
   - **Callback URL:** `https://agentforce-readiness.onrender.com/auth/callback`
   - **Selected OAuth Scopes:** Add both:
     - `Access and manage your data (api)`
     - `Perform requests on your behalf at any time (refresh_token, offline_access)`
   - Uncheck **Require Proof Key for Code Exchange (PKCE)** if checked
   - Leave all other settings as default

4. Click **Save** → Click **Continue**

> **Note:** Allow 2–10 minutes for the Connected App to activate after saving.

---

## Step 2 — Get the Consumer Key and Secret

1. In App Manager, find your new Connected App and click **View**
2. Click **Manage Consumer Details** (may require re-authentication)
3. Copy the **Consumer Key** (Client ID) and **Consumer Secret** — you will need both to log in

---

## Step 3 — Set OAuth Policies

1. In App Manager, find your Connected App and click **Manage**
2. Click **Edit Policies**
3. Set **Permitted Users** to `All users may self-authorize` (or `Admin approved users` if you want to restrict access)
4. Set **IP Relaxation** to `Relax IP restrictions`
5. Click **Save**

---

## Step 4 — Run the Assessment

1. Open **https://agentforce-readiness.onrender.com** in your browser
2. Enter the following:

   | Field | Value |
   |-------|-------|
   | Org / Sandbox URL | The customer's My Domain URL, e.g. `https://customername--sandboxname.sandbox.my.salesforce.com` |
   | Client ID (Consumer Key) | Copied from Step 2 |
   | Client Secret (Consumer Secret) | Copied from Step 2 |

3. Click **Connect to Salesforce**
4. Log in with your Salesforce credentials on the Salesforce login page
5. Click **Allow** when prompted to grant access
6. The assessment dashboard will load automatically and run all 20 checks

---

## Step 5 — Review Results and Export

- The **radar chart** gives an at-a-glance view of readiness across all 20 categories
- Each category card shows the auto-check findings and score (Green ≥80%, Amber 50–79%, Red <50%)
- The **Remediation Backlog** at the bottom lists all failing checks in priority order
- Click **Export PDF** to generate a report to share with the customer

---

## Org URL Format Reference

| Environment | URL Format |
|-------------|-----------|
| Sandbox | `https://companyname--sandboxname.sandbox.my.salesforce.com` |
| Developer Edition | `https://companyname.develop.my.salesforce.com` |
| Production | `https://companyname.my.salesforce.com` |

> **Tip:** The correct URL is found in the browser address bar when logged into the org — use the domain that ends in `.salesforce.com`, not `.salesforce-setup.com`.

---

## Required Permissions

The user logging in must have sufficient permissions to query the objects the app checks. A **System Administrator** profile will work for all checks. If using a non-admin user, they need at minimum:

- API Enabled
- View Setup and Configuration
- View All Data (for full results across all categories)

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Redirected back to login with no error | Wait 5–10 minutes for the Connected App to fully activate, then try again |
| `error=invalid_client` | Double-check the Consumer Key and Secret — copy them fresh from Manage Consumer Details |
| `error=redirect_uri_mismatch` | Verify the Callback URL in the Connected App is exactly `https://agentforce-readiness.onrender.com/auth/callback` |
| `error=missing required code challenge` | PKCE is enabled — uncheck it in the Connected App OAuth settings |
| Dashboard loads but all categories show errors | The logged-in user lacks API access or View Setup and Configuration permission |
| App takes 30+ seconds to load | Render free tier spins down after inactivity — first load may be slow, subsequent loads are fast |

---

## Security Notes

- The app never stores your Consumer Key, Secret, or access tokens permanently — they are held only in a server-side session that expires after 1 hour
- The app is read-only — it queries org data but makes no changes
- Each session is isolated — credentials entered by one user are not accessible to others

---

*App built by Steven Bilgram — sbilgram-lgtm/agentforce-readiness*
