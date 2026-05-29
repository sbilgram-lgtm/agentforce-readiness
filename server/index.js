require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const jsforce = require('jsforce');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

if (!isProduction) {
  app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
}
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'agentforce-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: isProduction, maxAge: 3600000, sameSite: 'lax' },
  proxy: isProduction
}));

if (isProduction) app.set('trust proxy', 1);

function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (isProduction) return `${req.protocol}://${req.get('host')}`;
  return 'http://localhost:3000';
}

function getCallbackUrl(req) {
  if (process.env.SF_CALLBACK_URL) return process.env.SF_CALLBACK_URL;
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/auth/callback`;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

app.post('/auth/login', (req, res) => {
  const loginUrl = (req.body.loginUrl || 'https://login.salesforce.com').replace(/\/$/, '');
  const clientId = req.body.clientId || process.env.SF_CLIENT_ID;
  const clientSecret = req.body.clientSecret || process.env.SF_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'missing_credentials' });
  }

  req.session.loginUrl = loginUrl;
  req.session.clientId = clientId;
  req.session.clientSecret = clientSecret;

  const oauth2 = new jsforce.OAuth2({
    loginUrl,
    clientId,
    clientSecret,
    redirectUri: getCallbackUrl(req)
  });

  res.json({ redirectUrl: oauth2.getAuthorizationUrl({ scope: 'api refresh_token' }) });
});

app.get('/auth/callback', async (req, res) => {
  const loginUrl = req.session.loginUrl || 'https://login.salesforce.com';
  const clientId = req.session.clientId || process.env.SF_CLIENT_ID;
  const clientSecret = req.session.clientSecret || process.env.SF_CLIENT_SECRET;

  const oauth2 = new jsforce.OAuth2({
    loginUrl,
    clientId,
    clientSecret,
    redirectUri: getCallbackUrl(req)
  });

  const conn = new jsforce.Connection({ oauth2 });
  try {
    await conn.authorize(req.query.code);
    req.session.accessToken = conn.accessToken;
    req.session.instanceUrl = conn.instanceUrl;
    req.session.refreshToken = conn.refreshToken;
    req.session.save(err => {
      if (err) return res.redirect(`${getBaseUrl(req)}/?error=session_error`);
      res.redirect(getBaseUrl(req));
    });
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${getBaseUrl(req)}/?error=auth_failed`);
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/auth/status', (req, res) => {
  res.json({
    loggedIn: !!(req.session.accessToken && req.session.instanceUrl),
    instanceUrl: req.session.instanceUrl || null
  });
});

// ─── Connection helper ────────────────────────────────────────────────────────

function getConn(req) {
  const { instanceUrl, accessToken } = req.session;
  if (!instanceUrl || !accessToken) throw new Error('Not authenticated');
  return new jsforce.Connection({ instanceUrl, accessToken });
}

function requireAuth(req, res, next) {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function safeQuery(conn, soql) {
  return new Promise((resolve) => {
    conn.query(soql, (err, result) => {
      if (err) resolve({ records: [], error: err.message });
      else resolve(result);
    });
  });
}

function safeDescribe(conn, obj) {
  return new Promise((resolve) => {
    conn.describe(obj, (err, result) => {
      if (err) resolve(null);
      else resolve(result);
    });
  });
}

async function safeRest(conn, path) {
  try {
    return await conn.request(path);
  } catch (e) {
    return { error: e.message };
  }
}

function ac(id, label, passed, finding) {
  return { id, label, passed: !!passed, finding: passed ? null : finding };
}

// ─── Category 1: Licensing & Product Enablement ───────────────────────────────
app.get('/api/assess/licensing', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [limits, orgInfo, einsteingSetting] = await Promise.all([
      safeRest(conn, '/services/data/v62.0/limits/'),
      safeRest(conn, '/services/data/v62.0/sobjects/Organization/describe/').catch(() => null),
      safeQuery(conn, "SELECT Id, SettingName, SettingValue FROM OrganizationSetting WHERE SettingName IN ('EinsteinGptEnabled','AgentforceEnabled','DataCloudEnabled') LIMIT 10").catch(() => ({ records: [] }))
    ]);

    const featureFlags = await safeRest(conn, '/services/data/v62.0/tooling/query/?q=SELECT+QualifiedApiName,IsEnabled+FROM+FeatureParameterBoolean+WHERE+QualifiedApiName+IN+(\'AgentforceEnabled\',\'EinsteinGenAI\',\'DataCloud\')').catch(() => ({ records: [] }));

    const [orgSettingsRes, manageAIAgentsPS] = await Promise.all([
      safeQuery(conn, "SELECT SettingName, SettingValue FROM OrganizationSetting WHERE SettingName IN ('EinsteinGptEnabled','AgentforceEnabled','DataCloudEnabled') LIMIT 10"),
      safeQuery(conn, "SELECT Id FROM PermissionSet WHERE PermissionsManageAIAgents = true LIMIT 1").catch(() => ({ records: [] }))
    ]);
    const settings = {};
    (orgSettingsRes.records || []).forEach(r => { settings[r.SettingName] = r.SettingValue; });
    const einsteinEnabled = settings['EinsteinGptEnabled'] === 'true' || settings['EinsteinGenerativeAIEnabled'] === 'true';
    const [licPSA, licEinsteinQuota, pricingRes] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM PermissionSetAssignment WHERE PermissionSet.Name LIKE '%Agentforce%' AND Assignee.IsActive = true").catch(() => ({ totalSize: 0 })),
      safeRest(conn, '/services/data/v62.0/limits/').catch(() => ({})),
      safeQuery(conn, "SELECT SettingName, SettingValue FROM OrganizationSetting WHERE SettingName IN ('FlexCreditsEnabled','ConversationPricingEnabled','AgentforcePricingModel') LIMIT 5").catch(() => ({ records: [] }))
    ]);
    const agentforcePSACount = licPSA.totalSize || 0;
    const einsteinQuotaLimit = (licEinsteinQuota && licEinsteinQuota.DailyEinsteinRequests) ? licEinsteinQuota.DailyEinsteinRequests : null;

    const pricingSettings = {};
    (pricingRes.records || []).forEach(r => { pricingSettings[r.SettingName] = r.SettingValue; });
    const hasPricingModel = Object.keys(pricingSettings).length > 0 || (licEinsteinQuota && licEinsteinQuota.DailyEinsteinRequests && licEinsteinQuota.DailyEinsteinRequests.Max > 0);

    const autoChecks = [
      ac('lic_ac_1', 'Einstein Generative AI is enabled', einsteinEnabled, 'Einstein Generative AI is not enabled in org settings'),
      ac('lic_ac_2', 'Agentforce is enabled', settings['AgentforceEnabled'] === 'true', 'Agentforce is not enabled in org settings'),
      ac('lic_ac_3', 'Data Cloud is enabled', settings['DataCloudEnabled'] === 'true', 'Data Cloud is not enabled in org settings'),
      ac('lic_ac_4', 'A permission set with Manage AI Agents exists', (manageAIAgentsPS.records || []).length > 0, 'No permission set found with Manage AI Agents — admin cannot manage agents'),
      ac('lic_ac_5', 'Active users have Agentforce permission set assigned', agentforcePSACount > 0, 'No active users assigned an Agentforce permission set — licensing may not be activated for any user'),
      ac('lic_ac_6', 'Einstein/Agentforce AI request quota is provisioned', !!(einsteinQuotaLimit && einsteinQuotaLimit.Max > 0), 'DailyEinsteinRequests limit not found — Agentforce AI quota may not be provisioned for this org'),
      ac('lic_ac_7', 'Agentforce pricing model is confirmed (Flex Credits or Conversations)', hasPricingModel, 'No Agentforce pricing model setting detected — confirm Flex Credits vs. Conversations pricing model selection before go-live (they cannot coexist in the same org)')
    ];

    res.json({
      category: 'Licensing, Product Enablement, and Org Prerequisites',
      limits: limits.error ? null : { dailyApiRequests: limits.DailyApiRequests },
      orgSettings: einsteingSetting.records || [],
      featureFlags: featureFlags.records || [],
      autoChecks,
      questions: [
        { id: 'lic_1', text: 'Does the customer have the correct Agentforce/Einstein/Data 360 entitlements?', type: 'boolean' },
        { id: 'lic_2', text: 'Is Einstein Generative AI enabled?', type: 'boolean' },
        { id: 'lic_3', text: 'Is Agentforce enabled in the org?', type: 'boolean' },
        { id: 'lic_4', text: 'Is Data 360 / Data Cloud configured?', type: 'boolean' },
        { id: 'lic_5', text: 'Is the Einstein Trust Layer enabled?', type: 'boolean' },
        { id: 'lic_6', text: 'Do admins have Manage AI Agents permission?', type: 'boolean' },
        { id: 'lic_7', text: 'Are sandbox/Developer Edition enablement differences identified?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 3: Security Model, OWD, Sharing ────────────────────────────────
app.get('/api/assess/security-model', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [owdRules, sharingRules, restrictionRules] = await Promise.all([
      safeQuery(conn, 'SELECT SobjectType, DefaultInternalAccess, DefaultExternalAccess FROM ObjectPermissions LIMIT 5').catch(() => ({ records: [] })),
      safeRest(conn, '/services/data/v62.0/tooling/query/?q=SELECT+Id,SobjectType,SharingModel+FROM+SharingRules+LIMIT+100').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, Description FROM RestrictionRule LIMIT 20').catch(() => ({ records: [] }))
    ]);

    const [caseOwdRes, viewAllDataPS, restrictionRulesRes] = await Promise.all([
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+QualifiedApiName,DefaultInternalAccess,DefaultExternalAccess+FROM+EntityDefinition+WHERE+QualifiedApiName+IN+('Case','Account','Contact')").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, Name FROM PermissionSet WHERE PermissionsViewAllData = true AND IsCustom = true LIMIT 10").catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id FROM RestrictionRule LIMIT 1').catch(() => ({ records: [] }))
    ]);
    const caseOwd = (caseOwdRes.records || []).find(r => r.QualifiedApiName === 'Case');
    const caseNotPublicRW = !caseOwd || caseOwd.DefaultInternalAccess !== 'ReadWrite';
    const noViewAllData = (viewAllDataPS.records || []).length === 0;
    const hasRestrictionRules = (restrictionRulesRes.records || []).length > 0;
    const [publicRWExternalObjects, loginIpRanges] = await Promise.all([
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+QualifiedApiName,DefaultExternalAccess+FROM+EntityDefinition+WHERE+DefaultExternalAccess='ReadWrite'+LIMIT+5").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT COUNT() FROM LoginIpRange LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const noPublicRWExternal = (publicRWExternalObjects.records || []).length === 0;
    const hasLoginIpRanges = (loginIpRanges.totalSize || 0) > 0;

    const autoChecks = [
      ac('sec_ac_1', 'Case OWD is not Public Read/Write', caseNotPublicRW, 'Case OWD is Public Read/Write — agent may over-expose case data to all users'),
      ac('sec_ac_2', 'No custom permission sets grant View All Data', noViewAllData, `${(viewAllDataPS.records||[]).length} custom permission set(s) grant View All Data — verify agent user is not assigned these`),
      ac('sec_ac_3', 'Restriction rules are configured', hasRestrictionRules, 'No restriction rules found — consider scoping rules to limit agent record visibility'),
      ac('sec_ac_4', 'No objects have Public Read/Write external (guest) access', noPublicRWExternal, 'Objects have Public Read/Write external access — guest users and agent external deployments may over-expose data'),
      ac('sec_ac_5', 'Login IP ranges are configured', hasLoginIpRanges, 'No login IP ranges configured — consider restricting agent user login to known IP ranges')
    ];

    res.json({
      category: 'Security Model, OWD, Sharing, and Record Visibility',
      sharingRulesCount: (sharingRules.records || []).length,
      restrictionRulesCount: (restrictionRules.records || []).length,
      autoChecks,
      questions: [
        { id: 'sec_1', text: 'Have OWD settings been reviewed for all objects the agent will access?', type: 'boolean' },
        { id: 'sec_2', text: 'Are internal and external OWD settings assessed separately (Experience Cloud in scope)?', type: 'boolean' },
        { id: 'sec_3', text: 'Has the role hierarchy, sharing rules, and teams been validated?', type: 'boolean' },
        { id: 'sec_4', text: 'Is View All Data / Modify All Data use justified and minimized?', type: 'boolean' },
        { id: 'sec_5', text: 'Is a security matrix defined by persona and agent role?', type: 'boolean' },
        { id: 'sec_6', text: 'Is the agent execution model (running user vs. system/integration user) defined?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 4: Agent User, Permission Sets, Least Privilege ─────────────────
app.get('/api/assess/agent-user', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [integrationUsers, permSetGroups] = await Promise.all([
      safeQuery(conn, "SELECT Id, Name, UserType, IsActive FROM User WHERE UserType IN ('AutoProc','CsnOnly','Guest','Standard') AND IsActive = true LIMIT 50"),
      safeQuery(conn, 'SELECT Id, DeveloperName, Description FROM PermissionSetGroup LIMIT 30')
    ]);

    const intUsers = (integrationUsers.records || []).filter(u => u.UserType !== 'Standard');

    const [modifyAllPS, autoProcUsers, runFlowPS, apexToolPS, viewTracesPS, deployAgentsPS] = await Promise.all([
      safeQuery(conn, "SELECT Id, Name FROM PermissionSet WHERE PermissionsModifyAllData = true AND IsCustom = true LIMIT 10").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT COUNT() FROM User WHERE UserType = 'AutoProc' AND IsActive = true").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM PermissionSet WHERE PermissionsRunFlow = true AND IsCustom = true LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM PermissionSet WHERE PermissionsUseApexAsAgentTool = true LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM PermissionSet WHERE PermissionsViewAgentTraces = true LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM PermissionSet WHERE PermissionsDeployAgents = true LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const noModifyAll = (modifyAllPS.records || []).length === 0;
    const hasAutoProcUser = (autoProcUsers.totalSize || 0) > 0;
    const hasRunFlowPS = (runFlowPS.totalSize || 0) > 0;

    const autoChecks = [
      ac('au_ac_1', 'Integration or automation users exist', intUsers.length > 0, 'No integration/automation users found — define a dedicated agent user with scoped permissions'),
      ac('au_ac_2', 'No custom permission sets grant Modify All Data', noModifyAll, `${(modifyAllPS.records||[]).length} custom permission set(s) grant Modify All Data — verify the agent user does not inherit these`),
      ac('au_ac_3', 'Permission Set Groups are defined', (permSetGroups.records||[]).length > 0, 'No Permission Set Groups found — use PSGs to manage least-privilege permission bundles for agent users'),
      ac('au_ac_4', 'Agentforce Bot User (AutoProc) exists', hasAutoProcUser, 'No AutoProc user type found — a dedicated Agentforce bot user has not been provisioned'),
      ac('au_ac_5', 'A permission set grants Run Flows (required for agent actions)', hasRunFlowPS, 'No custom permission set grants Run Flows — agent actions using flows will fail without this permission'),
      ac('au_ac_6', 'UseApexAsAgentTool permission set exists (MCP/Apex-as-tool)', apexToolPS.totalSize > 0, 'No permission set grants UseApexAsAgentTool — required for exposing Apex methods as MCP tools for agents (Spring \'26)'),
      ac('au_ac_7', 'ViewAgentTraces permission set exists (platform tracing)', viewTracesPS.totalSize > 0, 'No permission set grants ViewAgentTraces — required for Agent Platform Tracing observability (Spring \'26)'),
      ac('au_ac_8', 'DeployAgents permission set exists (production deployment)', deployAgentsPS.totalSize > 0, 'No permission set grants DeployAgents — required for deploying agents to production (Spring \'26)')
    ];

    res.json({
      category: 'Agent User, Permission Sets, CRUD/FLS, and Least Privilege',
      integrationUsersFound: intUsers.length,
      integrationUsers: intUsers.slice(0, 10),
      permissionSetGroupsCount: (permSetGroups.records || []).length,
      autoChecks,
      questions: [
        { id: 'au_1', text: 'Is a dedicated agent/integration user defined for each agent?', type: 'boolean' },
        { id: 'au_2', text: 'Are CRUD, FLS, and object permissions validated for the agent user?', type: 'boolean' },
        { id: 'au_3', text: 'Is Apex class access, Flow access, and prompt template access granted?', type: 'boolean' },
        { id: 'au_4', text: 'Is Knowledge, file, and external credential access scoped correctly?', type: 'boolean' },
        { id: 'au_5', text: 'Are admin-style permissions avoided for the agent user?', type: 'boolean' },
        { id: 'au_6', text: 'Are session settings, login IP ranges, MFA, and Connected App access reviewed?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 5: Einstein Trust Layer & AI Security ───────────────────────────
app.get('/api/assess/trust-layer', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const sensitiveFields = await safeQuery(conn, "SELECT Id, QualifiedApiName, DataClassification FROM FieldDefinition WHERE DataClassification IN ('RestrictedSensitivePersonalInformation','SensitivePersonalInformation','PersonalInformation','PII','PHI') LIMIT 50").catch(() => ({ records: [] }));

    const [einsteinSettingRes, classifiedFieldCheck] = await Promise.all([
      safeQuery(conn, "SELECT SettingName, SettingValue FROM OrganizationSetting WHERE SettingName = 'EinsteinGptEnabled' LIMIT 1").catch(() => ({ records: [] })),
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+Id+FROM+FieldDefinition+WHERE+DataClassification+%21%3D+'NonSensitive'+AND+DataClassification+%21%3D+null+LIMIT+1").catch(() => ({ records: [] }))
    ]);
    const einsteinEnabled = (einsteinSettingRes.records || [])[0]?.SettingValue === 'true';
    const hasClassifiedFields = (classifiedFieldCheck.records || []).length > 0;
    const hasSensitiveFieldsClassified = (sensitiveFields.records || []).length > 0;
    const [trustLayerSetting, promptTemplatesForETL] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM OrganizationSetting WHERE SettingName = 'TrustLayerEnabled' LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM PromptTemplate LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const hasTrustLayerSetting = (trustLayerSetting.totalSize || 0) > 0;
    const hasPromptTemplates = (promptTemplatesForETL.totalSize || 0) > 0;

    const autoChecks = [
      ac('etl_ac_1', 'Einstein Generative AI is enabled (Trust Layer prerequisite)', einsteinEnabled, 'Einstein Generative AI is not enabled — the Einstein Trust Layer requires this to be active'),
      ac('etl_ac_2', 'Salesforce Data Classification is applied to fields', hasClassifiedFields, 'No fields have data classification applied — field-level AI masking in prompts cannot function without classification'),
      ac('etl_ac_3', 'PII/PHI/Sensitive fields are tagged with data classification', hasSensitiveFieldsClassified, 'No PII/PHI/sensitive-classified fields found — ensure all regulated fields are classified so Trust Layer can mask them'),
      ac('etl_ac_4', 'Trust Layer org setting is present', hasTrustLayerSetting, 'TrustLayerEnabled setting not found — verify Einstein Trust Layer is fully activated'),
      ac('etl_ac_5', 'Prompt templates exist (grounding prompts configured)', hasPromptTemplates, 'No prompt templates found — agent grounding and action prompts are not yet defined')
    ];

    res.json({
      category: 'Einstein Trust Layer, AI Security, and Responsible AI Controls',
      sensitiveFieldsFound: (sensitiveFields.records || []).length,
      sensitiveFields: (sensitiveFields.records || []).slice(0, 10),
      autoChecks,
      questions: [
        { id: 'etl_1', text: 'Is the Einstein Trust Layer enabled with grounding, masking, and toxicity detection?', type: 'boolean' },
        { id: 'etl_2', text: 'Are Salesforce Data Classification values set for sensitive fields?', type: 'boolean' },
        { id: 'etl_3', text: 'Is PII/PHI/PCI/financial data assessed for prompt/response/action exposure?', type: 'boolean' },
        { id: 'etl_4', text: 'Is an AI governance policy defined (approved/prohibited use cases, human-in-the-loop)?', type: 'boolean' },
        { id: 'etl_5', text: 'Is escalation and hallucination handling defined?', type: 'boolean' },
        { id: 'etl_6', text: 'Is the LLM model strategy confirmed (Salesforce-managed vs. BYOLLM)?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 6: Data Quality & Grounding Readiness ──────────────────────────
app.get('/api/assess/data-quality', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [dupRules, missingDescCount, totalCustomCount, dataLibraries] = await Promise.all([
      safeQuery(conn, 'SELECT Id, DeveloperName, IsActive FROM DuplicateRule LIMIT 20'),
      safeQuery(conn, "SELECT COUNT() FROM FieldDefinition WHERE Description = null AND QualifiedApiName LIKE '%__c'").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM FieldDefinition WHERE QualifiedApiName LIKE '%__c'").catch(() => ({ totalSize: 1 })),
      safeQuery(conn, 'SELECT Id, DeveloperName, Type FROM AgentforceDataLibrary LIMIT 20').catch(() => ({ records: [] }))
    ]);

    const duplicateRulesActive = (dupRules.records || []).filter(r => r.IsActive).length;
    const missingCount = missingDescCount.totalSize || 0;
    const totalCount = totalCustomCount.totalSize || 1;
    const missingRatio = missingCount / totalCount;
    const [caseRecordTypes, requiredCustomFields] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM RecordType WHERE SobjectType = 'Case' AND IsActive = true LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM FieldDefinition WHERE QualifiedApiName LIKE '%__c' AND IsRequired = true LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const hasCaseRecordTypes = (caseRecordTypes.totalSize || 0) > 0;
    const hasRequiredCustomFields = (requiredCustomFields.totalSize || 0) > 0;

    const autoChecks = [
      ac('dq_ac_1', 'Active duplicate rules exist', duplicateRulesActive > 0, 'No active duplicate rules — duplicate records will degrade agent reasoning and grounding accuracy'),
      ac('dq_ac_2', 'Custom field description coverage is adequate (>70%)', missingRatio < 0.30, `${Math.round(missingRatio * 100)}% of custom fields are missing descriptions — agents cannot understand field purpose without metadata`),
      ac('dq_ac_3', 'Agentforce Data Libraries are configured', (dataLibraries.records||[]).length > 0, 'No Agentforce Data Libraries found — unstructured data and knowledge grounding is not yet configured'),
      ac('dq_ac_4', 'Case record types are configured', hasCaseRecordTypes, 'No active Case record types found — agents need record type context to correctly classify and route cases'),
      ac('dq_ac_5', 'Required custom fields are defined on key objects', hasRequiredCustomFields, 'No required custom fields found — data completeness for agent grounding cannot be enforced')
    ];

    res.json({
      category: 'Data Quality, Data Model, and Grounding Readiness',
      duplicateRulesActive,
      customFieldsMissingDescriptions: missingCount,
      dataLibrariesFound: (dataLibraries.records || []).length,
      dataLibraries: dataLibraries.records || [],
      autoChecks,
      questions: [
        { id: 'dq_1', text: 'Is CRM data complete, trusted, normalized, and governed enough for agent reasoning?', type: 'boolean' },
        { id: 'dq_2', text: 'Have duplicate Accounts/Contacts/Leads, orphaned Cases, and missing fields been remediated?', type: 'boolean' },
        { id: 'dq_3', text: 'Is the authoritative data source confirmed (Salesforce, Data 360, Knowledge, files, web)?', type: 'boolean' },
        { id: 'dq_4', text: 'Are Agentforce Data Libraries configured for unstructured/semi-structured grounding?', type: 'boolean' },
        { id: 'dq_5', text: 'Are data freshness requirements defined (real-time, batch, knowledge-only)?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 7: Knowledge Management ────────────────────────────────────────
app.get('/api/assess/knowledge', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [articles, archivedArticles, knowledgeEnabled] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM Knowledge__kav WHERE PublishStatus = 'Online' AND Language = 'en_US'").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM Knowledge__kav WHERE PublishStatus = 'Archived'").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM Knowledge__kav LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);

    const publishedArticles = articles.totalSize || 0;
    const archivedArticles2 = archivedArticles.totalSize || 0;
    const articleTypesCount = knowledgeEnabled.totalSize !== undefined ? 1 : 0;
    const [staleArticles, dataCategories, groundingRes] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM KnowledgeArticleVersion WHERE PublishStatus = 'Online' AND LastModifiedDate < LAST_N_YEARS:2 LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM DataCategory LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+Id,DeveloperName+FROM+KnowledgeArticleGrounding+LIMIT+5").catch(() => ({ records: [] }))
    ]);
    const noStaleArticles = (staleArticles.totalSize || 0) === 0;
    const hasDataCategories = (dataCategories.totalSize || 0) > 0;

    const autoChecks = [
      ac('km_ac_1', 'Knowledge (Lightning) is enabled', publishedArticles > 0 || knowledgeEnabled.totalSize !== undefined, 'Knowledge is not enabled — agents cannot ground on Knowledge articles'),
      ac('km_ac_2', 'Published Knowledge articles exist', publishedArticles > 0, 'No published Knowledge articles — agent has no content to ground on'),
      ac('km_ac_3', 'Archive ratio is healthy (published >= archived)', publishedArticles >= archivedArticles2, `Archived articles (${archivedArticles2}) exceed published (${publishedArticles}) — article lifecycle governance may be needed`),
      ac('km_ac_4', 'Knowledge articles are current (no articles >2 years old)', noStaleArticles, 'Published Knowledge articles are more than 2 years old — stale content degrades agent grounding quality'),
      ac('km_ac_5', 'Knowledge data categories are configured', hasDataCategories, 'No Knowledge data categories found — agents use data categories for topic scoping and article retrieval'),
      ac('km_ac_6', 'Knowledge Article Grounding is configured (Spring \'26)', (groundingRes.records || []).length > 0, 'No KnowledgeArticleGrounding records found — Knowledge grounding for Agentforce requires explicit grounding configuration in Spring \'26+')
    ];

    res.json({
      category: 'Knowledge Management Readiness',
      publishedArticles,
      archivedArticles: archivedArticles2,
      articleTypes: articleTypesCount,
      autoChecks,
      questions: [
        { id: 'km_1', text: 'Is Knowledge enabled with article types, data categories, and publication channels configured?', type: 'boolean' },
        { id: 'km_2', text: 'Are articles written for agent use (clear titles, concise, current, no conflicting versions)?', type: 'boolean' },
        { id: 'km_3', text: 'Is Knowledge sufficient or do Data Libraries/web sources/Data 360 also need to be used?', type: 'boolean' },
        { id: 'km_4', text: 'Are article visibility differences between internal, external, and AI agents confirmed?', type: 'boolean' },
        { id: 'km_5', text: 'Is there an article lifecycle, review cadence, and ownership model defined?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 8: Omni-Channel, Routing, Queues ───────────────────────────────
app.get('/api/assess/omni-channel', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [queues, serviceChannels, presenceStatuses, routingConfigs] = await Promise.all([
      safeQuery(conn, 'SELECT Id, Name, Type FROM Group WHERE Type = \'Queue\' LIMIT 50'),
      safeQuery(conn, 'SELECT Id, DeveloperName, Label, IsActive FROM ServiceChannel LIMIT 30').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, IsActive FROM ServicePresenceStatus LIMIT 30').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, CapacityWeight, IsActive FROM RoutingConfig LIMIT 30').catch(() => ({ records: [] }))
    ]);

    const activePresenceStatuses = (presenceStatuses.records || []).filter(p => p.IsActive).length;
    const [messagingServiceChannel, availabilityRouting] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM ServiceChannel WHERE RelatedEntityType = 'LiveChatTranscript' OR RelatedEntityType = 'MessagingSession' LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM RoutingConfig WHERE RoutingModel = 'MostAvailable' OR RoutingModel = 'LeastActive' LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const hasMessagingServiceChannel = (messagingServiceChannel.totalSize || 0) > 0;
    const hasAvailabilityRouting = (availabilityRouting.totalSize || 0) > 0;

    const autoChecks = [
      ac('oc_ac_1', 'Service channels are configured', (serviceChannels.records||[]).length > 0, 'No Omni-Channel service channels found — Omni-Channel routing is not set up'),
      ac('oc_ac_2', 'Queues are configured for work routing', (queues.records||[]).length > 0, 'No queues found — work items cannot be routed to Agentforce or human agents'),
      ac('oc_ac_3', 'Routing configurations exist', (routingConfigs.records||[]).length > 0, 'No routing configurations found — Omni-Channel routing rules are incomplete'),
      ac('oc_ac_4', 'Active presence statuses are defined', activePresenceStatuses > 0, 'No active presence statuses — agent availability for Omni-Channel is not configured'),
      ac('oc_ac_5', 'A messaging or chat service channel is configured for Agentforce', hasMessagingServiceChannel, 'No messaging/chat service channel found — Agentforce Service Agent requires a messaging or chat channel'),
      ac('oc_ac_6', 'Skill or availability-based routing is configured', hasAvailabilityRouting, 'No availability-based routing configurations found — consider skills-based routing for optimal agent/human capacity')
    ];

    res.json({
      category: 'Omni-Channel, Routing, Queues, Skills, and Capacity',
      queuesCount: (queues.records || []).length,
      serviceChannelsCount: (serviceChannels.records || []).length,
      activePresenceStatuses,
      routingConfigsCount: (routingConfigs.records || []).length,
      queues: (queues.records || []).slice(0, 10),
      serviceChannels: serviceChannels.records || [],
      autoChecks,
      questions: [
        { id: 'oc_1', text: 'Is Omni-Channel enabled and correctly configured for target channels?', type: 'boolean' },
        { id: 'oc_2', text: 'Are routing configurations, queues, skills, presence statuses, and capacity model validated?', type: 'boolean' },
        { id: 'oc_3', text: 'Are inbound Omni-Channel flows routing conversations to Agentforce configured?', type: 'boolean' },
        { id: 'oc_4', text: 'Are escalation/handoff flows to human reps or queues configured?', type: 'boolean' },
        { id: 'oc_5', text: 'Is fallback logic defined (agent cannot answer, action fails, no humans available)?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 9: Messaging, Chat, Email, Voice, Channels ─────────────────────
app.get('/api/assess/channels', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [messagingChannels, embeddedServiceDeployments] = await Promise.all([
      safeQuery(conn, 'SELECT Id, DeveloperName, Type, IsActive FROM MessagingChannel LIMIT 30').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, SiteName, IsActive FROM EmbeddedServiceDeployment LIMIT 20').catch(() => ({ records: [] }))
    ]);

    const embeddedDeploymentsCount = (embeddedServiceDeployments.records || []).length;
    const activeMessagingCount = (messagingChannels.records || []).filter(c => c.IsActive).length;
    const [embeddedServiceConfigs, activeChatMessagingChannels, voiceChannelRes, whatsAppRes] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM EmbeddedServiceConfig LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM MessagingChannel WHERE IsActive = true AND (Type = 'EmbeddedMessaging' OR Type = 'WebChat') LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM ServiceChannel WHERE RelatedEntityType = 'VoiceCall' LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM MessagingChannel WHERE Type = 'WhatsApp' AND IsActive = true LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const hasEmbeddedServiceConfig = (embeddedServiceConfigs.totalSize || 0) > 0;
    const hasActiveChatChannel = (activeChatMessagingChannels.totalSize || 0) > 0;

    const autoChecks = [
      ac('ch_ac_1', 'Messaging channels are configured', (messagingChannels.records||[]).length > 0, 'No messaging channels configured — Agentforce Service Agent cannot be deployed to messaging channels'),
      ac('ch_ac_2', 'Active messaging channels exist', activeMessagingCount > 0, `${(messagingChannels.records||[]).length} messaging channel(s) found but none are active`),
      ac('ch_ac_3', 'Embedded service deployments exist', embeddedDeploymentsCount > 0, 'No embedded service deployments — web chat/Enhanced Chat channel deployment is not configured'),
      ac('ch_ac_4', 'Embedded Service configuration exists', hasEmbeddedServiceConfig, 'No Embedded Service configuration found — web chat deployment for Agentforce requires an Embedded Service config'),
      ac('ch_ac_5', 'Enhanced Messaging or Web Chat channel is active', hasActiveChatChannel, 'No active Enhanced Messaging or Web Chat channel — Agentforce Service Agent requires one of these channel types'),
      ac('ch_ac_6', 'Voice service channel is configured (Agentforce Voice)', voiceChannelRes.totalSize > 0, 'No Voice service channel found — Agentforce Voice (GA Spring \'26) requires a voice-type service channel (note: voice actions cost 30 Flex Credits vs 20 for standard)'),
      ac('ch_ac_7', 'WhatsApp channel is configured', whatsAppRes.totalSize > 0, 'No active WhatsApp messaging channel — WhatsApp Voice support added in Spring \'26 for contact center deployments')
    ];

    res.json({
      category: 'Messaging, Enhanced Chat, Email, Voice, and Channel Readiness',
      messagingChannelsCount: (messagingChannels.records || []).length,
      messagingChannels: messagingChannels.records || [],
      embeddedDeploymentsCount,
      autoChecks,
      questions: [
        { id: 'ch_1', text: 'Are all channels in scope identified (Enhanced Chat, Messaging, WhatsApp, SMS, email, voice, Slack)?', type: 'boolean' },
        { id: 'ch_2', text: 'Does each channel have correct routing, identity, authentication, escalation, and consent model?', type: 'boolean' },
        { id: 'ch_3', text: 'Is Enhanced Chat v2 or Messaging connection configured where Service Agent is deployed?', type: 'boolean' },
        { id: 'ch_4', text: 'Are BYOC/external contact-center constraints documented?', type: 'boolean' },
        { id: 'ch_5', text: 'Has email-specific routing and unused routing address cleanup been completed?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 10: Console App & Agent Workspace ───────────────────────────────
app.get('/api/assess/console', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [apps, omniWidget, knowledgeComponent] = await Promise.all([
      safeQuery(conn, "SELECT Id, Name, DeveloperName, NavType FROM AppDefinition WHERE NavType = 'Console' LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName FROM FlexiPage WHERE Type = 'UtilityBar' LIMIT 10").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName FROM FlexiPage WHERE Type IN ('RecordPage','AppPage') AND MasterLabel LIKE '%Service%' LIMIT 10").catch(() => ({ records: [] }))
    ]);

    const consoleAppsFound = (apps.records||[]).length;
    const hasUtilityBar = (omniWidget.records||[]).length > 0;
    const hasServicePage = (knowledgeComponent.records||[]).length > 0;
    const [caseRecordPage, consoleAppPage] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM FlexiPage WHERE Type = 'RecordPage' AND MasterLabel LIKE '%Case%' LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM FlexiPage WHERE Type = 'AppPage' AND MasterLabel LIKE '%Console%' LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const hasCaseRecordPage = (caseRecordPage.totalSize || 0) > 0;
    const hasConsoleAppPage = (consoleAppPage.totalSize || 0) > 0;

    const autoChecks = [
      ac('ca_ac_1', 'At least one Lightning Console app exists', consoleAppsFound > 0, 'No Lightning Console apps found — agents will not have a console workspace for escalated case handling'),
      ac('ca_ac_2', 'Utility bar pages exist (Omni-Channel widget support)', hasUtilityBar, 'No utility bar FlexiPages found — Omni-Channel widget cannot be surfaced for human agents handling escalations'),
      ac('ca_ac_3', 'Service-related Lightning pages are configured', hasServicePage, 'No Service-related Lightning pages found — human agents may lack the correct page layout after Agentforce escalation'),
      ac('ca_ac_4', 'Case record page exists for agent workspace', hasCaseRecordPage, 'No Case-specific record page — human agents handling escalated cases lack an optimised workspace'),
      ac('ca_ac_5', 'Console app page is configured', hasConsoleAppPage, 'No Console app page found — the Service Console workspace may not be fully configured')
    ];

    res.json({
      category: 'Console App and Agent Workspace Readiness',
      consoleAppsFound,
      hasUtilityBar,
      hasServicePage,
      consoleApps: apps.records || [],
      autoChecks,
      questions: [
        { id: 'ca_1', text: 'Are users working in a supported Lightning Console or standard Lightning app?', type: 'boolean' },
        { id: 'ca_2', text: 'Is the Service Console configured with utility bar, Omni-Channel widget, and Knowledge components?', type: 'boolean' },
        { id: 'ca_3', text: 'Can human agents see full conversation context when Agentforce escalates?', type: 'boolean' },
        { id: 'ca_4', text: 'Does console configuration support the target operating model (tier 1, queues, supervisors)?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 11: Lightning Record Pages, Dynamic Forms ──────────────────────
app.get('/api/assess/lightning-pages', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [flexiPages, caseRecordPages, dynamicActions] = await Promise.all([
      safeQuery(conn, "SELECT Id, DeveloperName, EntityDefinitionId, Type FROM FlexiPage WHERE Type IN ('RecordPage','AppPage') LIMIT 50").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName FROM FlexiPage WHERE Type = 'RecordPage' AND MasterLabel LIKE '%Case%' LIMIT 10").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName FROM FlexiPage WHERE Type = 'RecordPage' LIMIT 1").catch(() => ({ records: [] }))
    ]);

    const recordPagesCount = (flexiPages.records||[]).length;
    const hasCasePage = (caseRecordPages.records||[]).length > 0;
    const hasRecordPages = (dynamicActions.records||[]).length > 0;
    const autoChecks = [
      ac('lp_ac_1', 'Lightning record pages exist', recordPagesCount > 0, 'No custom Lightning record pages found — agents and human users may rely on default layouts without proper field/action configuration'),
      ac('lp_ac_2', 'Case record page is customised for agent workspace', hasCasePage, 'No Case-specific Lightning record page found — human agents handling escalated cases may lack optimised field and action layout'),
      ac('lp_ac_3', 'Multiple record pages configured across objects', recordPagesCount >= 3, `Only ${recordPagesCount} record page(s) found — ensure all objects the agent touches have reviewed Lightning pages`)
    ];

    res.json({
      category: 'Lightning Record Pages, Dynamic Forms, Dynamic Actions, and UX',
      recordPagesCount,
      hasCasePage,
      autoChecks,
      questions: [
        { id: 'lp_1', text: 'Are Lightning record pages reviewed for all objects the agent touches or hands off to users?', type: 'boolean' },
        { id: 'lp_2', text: 'Are Dynamic Forms and Dynamic Actions assessed for visibility, required fields, and conditional sections?', type: 'boolean' },
        { id: 'lp_3', text: 'Do page designs expose all fields and actions human agents need after escalation?', type: 'boolean' },
        { id: 'lp_4', text: 'Have Lightning page errors and component performance issues been reviewed?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 12: Flow, Apex, Prompt Templates, Agent Actions ─────────────────
app.get('/api/assess/automation', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [flows, apexClasses, promptTemplates, agentFunctions] = await Promise.all([
      safeQuery(conn, "SELECT Id, DeveloperName, ProcessType, Status FROM Flow WHERE ProcessType = 'AutoLaunchedFlow' AND Status = 'Active' LIMIT 100"),
      safeQuery(conn, "SELECT Id, Name, IsValid, ApiVersion FROM ApexClass WHERE Status = 'Active' LIMIT 200"),
      safeQuery(conn, "SELECT Id, DeveloperName, Type FROM PromptTemplate WHERE Status = 'Active' LIMIT 30").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName FROM GenAiFunction WHERE IsActive = true LIMIT 30").catch(() => ({ records: [] }))
    ]);

    const outdatedApex = (apexClasses.records || []).filter(c => parseFloat(c.ApiVersion) < 56);
    const outdatedApexCount = outdatedApex.length;
    const activeFlowsCount = (flows.records || []).length;
    const promptTemplatesCount = (promptTemplates.records || []).length;
    const invalidApexCount = (apexClasses.records || []).filter(c => !c.IsValid).length;
    const agentFunctionsCount = (agentFunctions.records || []).length;
    const [flowsWithDescriptions, invocableApexClasses, agentScriptRes, mcpToolsRes] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM Flow WHERE ProcessType = 'AutoLaunchedFlow' AND Status = 'Active' AND Description != null LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM ApexClass WHERE Status = 'Active' AND Name LIKE '%Invocable%' LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+Id,DeveloperName+FROM+AgentScript+LIMIT+10").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT COUNT() FROM ExternalServiceRegistration WHERE Status = 'Complete' AND DeveloperName LIKE '%MCP%' LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const hasFlowsWithDescriptions = (flowsWithDescriptions.totalSize || 0) > 0;
    const hasInvocableApex = (invocableApexClasses.totalSize || 0) > 0;

    const autoChecks = [
      ac('auto_ac_1', 'Active AutoLaunchedFlows exist (candidate agent actions)', activeFlowsCount > 0, 'No active AutoLaunchedFlows found — no existing automation available to use as Agentforce actions'),
      ac('auto_ac_2', 'Apex classes use Spring \'23+ API versions (>=v56)', outdatedApexCount === 0, `${outdatedApexCount} Apex class(es) use API versions below v56 — upgrade before using as Agentforce invocable actions`),
      ac('auto_ac_3', 'Active prompt templates are configured', promptTemplatesCount > 0, 'No active prompt templates found — agent grounding prompts and action prompts are not yet defined'),
      ac('auto_ac_4', 'No invalid Apex classes', invalidApexCount === 0, `${invalidApexCount} Apex class(es) have compilation errors — fix before using as agent actions`),
      ac('auto_ac_5', 'Agent actions (GenAiFunction) are configured', agentFunctionsCount > 0, 'No active GenAiFunction records found — no actions have been configured in Agentforce Builder yet'),
      ac('auto_ac_6', 'Active flows have descriptions (agent action discoverability)', hasFlowsWithDescriptions, 'Active AutoLaunchedFlows lack descriptions — agents cannot discover undocumented flows as candidate actions'),
      ac('auto_ac_7', 'Invocable Apex methods exist for agent actions', hasInvocableApex, 'No Apex classes with \'Invocable\' in the name found — confirm @InvocableMethod annotations exist for agent action candidates'),
      ac('auto_ac_8', 'Agent Scripts are defined (Spring \'26 DSL)', (agentScriptRes.records || []).length > 0, 'No AgentScript records found — Agent Script is the new Spring \'26 DSL that combines natural language with deterministic logic for more reliable agents'),
      ac('auto_ac_9', 'MCP Tool registrations exist (Spring \'26)', mcpToolsRes.totalSize > 0, 'No MCP Tool registrations found — Model Context Protocol tools (Spring \'26 GA) enable agents to interact with external AI systems and expose Apex as tools')
    ];

    res.json({
      category: 'Flow, Apex, Prompt Templates, and Agent Actions',
      activeFlowsCount,
      apexClassesCount: (apexClasses.records || []).length,
      outdatedApexCount,
      promptTemplatesCount,
      promptTemplates: promptTemplates.records || [],
      agentFunctionsCount,
      autoChecks,
      questions: [
        { id: 'auto_1', text: 'Have existing flows, Apex, and APIs been inventoried as potential agent actions?', type: 'boolean' },
        { id: 'auto_2', text: 'Does each candidate action have clear inputs, outputs, error handling, and permission model?', type: 'boolean' },
        { id: 'auto_3', text: 'Is the user-context vs. system-context decision made for each action?', type: 'boolean' },
        { id: 'auto_4', text: 'Are deterministic vs. natural-language reasoning actions identified?', type: 'boolean' },
        { id: 'auto_5', text: 'Are prompt templates created and reviewed?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 13: Agentforce Builder, Topics, Instructions ───────────────────
app.get('/api/assess/agentforce-builder', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [agents, topics] = await Promise.all([
      safeQuery(conn, 'SELECT Id, DeveloperName, Status FROM BotDefinition LIMIT 30').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, MasterLabel FROM GenAiPlugin WHERE IsActive = true LIMIT 50').catch(() => ({ records: [] }))
    ]);

    const agentsFound = (agents.records || []).length;
    const topicsFound = (topics.records || []).length;
    const activeAgentsInBuilder = (agents.records || []).filter(a => a.Status === 'Active').length;

    const activeGenAiFunctions = await safeQuery(conn, "SELECT COUNT() FROM GenAiFunction WHERE IsActive = true LIMIT 1").catch(() => ({ totalSize: 0 }));
    const hasActiveGenAiFunctions = (activeGenAiFunctions.totalSize || 0) > 0;

    const agentScriptCountRes = await safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+COUNT()+FROM+AgentScript+LIMIT+1").catch(() => ({ records: [] }));
    const agentScriptCount = (agentScriptCountRes.records || [])[0]?.expr0 || 0;

    const autoChecks = [
      ac('ab_ac_1', 'Agentforce agents (Bot Definitions) are defined', agentsFound > 0, 'No Agentforce agents found — agent build has not started'),
      ac('ab_ac_2', 'Agent subagents (GenAiPlugin) are defined — Topics renamed to Subagents in Spring \'26', topicsFound > 0, 'No active GenAiPlugin records found — agents have no defined Subagents (formerly Topics)'),
      ac('ab_ac_3', 'Topics-to-agents ratio suggests decomposition (>=1 topic per agent)', agentsFound > 0 && topicsFound >= agentsFound, agentsFound === 0 ? 'No agents found' : `${agentsFound} agent(s) but ${topicsFound} subagent(s) — ensure each agent has at least one Subagent scoped to a job-to-be-done`),
      ac('ab_ac_4', 'At least one agent is Active (not just Draft)', activeAgentsInBuilder > 0, 'No agents are in Active status — all defined agents are in Draft and cannot be deployed'),
      ac('ab_ac_5', 'Active agent actions (GenAiFunction) are attached to topics', hasActiveGenAiFunctions, 'No active GenAiFunction records — Subagents have no actions configured and cannot execute tasks'),
      ac('ab_ac_6', 'Agent Scripts are used in at least one agent (Spring \'26)', (agentScriptCount || 0) > 0, 'No Agent Scripts found — Spring \'26 Agent Script DSL provides deterministic + LLM hybrid reasoning; plain text instructions are less reliable')
    ];

    res.json({
      category: 'Agentforce Builder, Topics/Subagents, Instructions, and Asset Library',
      agentsFound,
      agents: agents.records || [],
      topicsFound,
      topics: (topics.records || []).slice(0, 10),
      autoChecks,
      questions: [
        { id: 'ab_1', text: 'Are agent topics/subagents defined around discrete jobs to be done?', type: 'boolean' },
        { id: 'ab_2', text: 'Are instructions reviewed for specificity, tone, escalation triggers, and compliance constraints?', type: 'boolean' },
        { id: 'ab_3', text: 'Are standard and custom actions validated and reusable across agents?', type: 'boolean' },
        { id: 'ab_4', text: 'Are naming standards, versioning, and deployment process established?', type: 'boolean' },
        { id: 'ab_5', text: 'Is a design authority review process in place for topics, actions, prompts, and grounding sources?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 14: Experience Cloud & External Access ─────────────────────────
app.get('/api/assess/experience-cloud', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [sites, networks, guestUserSharing, guestUsers] = await Promise.all([
      safeQuery(conn, "SELECT Id, Name, Status, UrlPathPrefix FROM Site WHERE Status IN ('Active','InMaintenance') LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, Name, Status FROM Network LIMIT 20').catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, Name FROM SharingSet LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, Name, IsActive FROM User WHERE UserType = 'Guest' AND IsActive = true LIMIT 10").catch(() => ({ records: [] }))
    ]);

    const sitesExist = (sites.records||[]).length > 0;
    const sharingSetsExist = (guestUserSharing.records||[]).length > 0;
    const guestUsersCount = (guestUsers.records||[]).length;
    const autoChecks = [
      ac('ec_ac_1', 'Experience Cloud sites exist', sitesExist, 'No active Experience Cloud sites found — if external user access is in scope, site configuration is required'),
      ac('ec_ac_2', 'Sharing Sets are configured', sharingSetsExist, 'No Sharing Sets found — external user record access for Experience Cloud portals is not configured'),
      ac('ec_ac_3', 'Guest users are active (Experience Cloud in use)', guestUsersCount > 0, 'No active guest users found — Experience Cloud external access may not be configured or in use')
    ];

    res.json({
      category: 'Experience Cloud, Embedded Service, and Public/External Access',
      activeSitesCount: (sites.records || []).length,
      networksCount: (networks.records || []).length,
      sharingSetsCount: (guestUserSharing.records || []).length,
      guestUsersCount,
      sites: sites.records || [],
      autoChecks,
      questions: [
        { id: 'ec_1', text: 'Is Experience Cloud architecture reviewed if the agent is exposed to external users?', type: 'boolean' },
        { id: 'ec_2', text: 'Are guest user access, sharing sets, CSP, CORS, and SSO reviewed?', type: 'boolean' },
        { id: 'ec_3', text: 'Is grounding, actions, and data access segmented if the same agent serves internal and external users?', type: 'boolean' },
        { id: 'ec_4', text: 'Are escalation paths from external channels into internal queues confirmed?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 15: Integration & External Systems ──────────────────────────────
app.get('/api/assess/integrations', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [namedCredentials, externalCredentials, remoteSites] = await Promise.all([
      safeQuery(conn, 'SELECT Id, DeveloperName, Endpoint FROM NamedCredential LIMIT 30').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName FROM ExternalCredential LIMIT 30').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, EndpointUrl, IsActive, MutualAuthEnabled FROM RemoteProxy LIMIT 50').catch(() => ({ records: [] }))
    ]);

    const insecureRemoteSites = (remoteSites.records || []).filter(r => r.EndpointUrl && !r.EndpointUrl.startsWith('https'));
    const insecureRemoteSitesCount = insecureRemoteSites.length;
    const namedCredentialsCount = (namedCredentials.records || []).length;
    const externalCredentialsCount = (externalCredentials.records || []).length;
    const autoChecks = [
      ac('int_ac_1', 'All remote sites use HTTPS', insecureRemoteSitesCount === 0, `${insecureRemoteSitesCount} remote site(s) use HTTP — insecure endpoints must be secured before agent actions can safely call them`),
      ac('int_ac_2', 'Named Credentials are used for integrations', namedCredentialsCount > 0, 'No Named Credentials found — integrations may be using hardcoded credentials or endpoints instead of the recommended pattern'),
      ac('int_ac_3', 'External Credentials are configured', externalCredentialsCount > 0, 'No External Credentials found — modern OAuth-based auth for agent external actions is not configured')
    ];

    res.json({
      category: 'Integration and External System Readiness',
      namedCredentialsCount,
      externalCredentialsCount,
      remoteSitesCount: (remoteSites.records || []).length,
      insecureRemoteSitesCount,
      namedCredentials: namedCredentials.records || [],
      autoChecks,
      questions: [
        { id: 'int_1', text: 'Are all external systems the agent must query/update identified?', type: 'boolean' },
        { id: 'int_2', text: 'Are API limits, authentication, Named Credentials, and retry handling reviewed?', type: 'boolean' },
        { id: 'int_3', text: 'Is the integration pattern confirmed (direct action, Flow, MuleSoft, middleware)?', type: 'boolean' },
        { id: 'int_4', text: 'Is idempotency, timeout behavior, and auditability defined for external calls?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 16: Data 360 / Data Cloud ──────────────────────────────────────
app.get('/api/assess/data-cloud', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [dataCloudSetting, dataLibraries, externalServices] = await Promise.all([
      safeQuery(conn, "SELECT SettingName, SettingValue FROM OrganizationSetting WHERE SettingName = 'DataCloudEnabled' LIMIT 1").catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, Type FROM AgentforceDataLibrary LIMIT 20').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, Status FROM ExternalServiceRegistration WHERE Status = \'Complete\' LIMIT 10').catch(() => ({ records: [] }))
    ]);

    const dataCloudEnabled = (dataCloudSetting.records || [])[0]?.SettingValue === 'true';
    const dataLibrariesCount = (dataLibraries.records || []).length;
    const externalServicesCount = (externalServices.records || []).length;
    const autoChecks = [
      ac('dc_ac_1', 'Data Cloud is provisioned and enabled', dataCloudEnabled, 'Data Cloud is not enabled in org settings — Data 360 grounding for Agentforce requires Data Cloud'),
      ac('dc_ac_2', 'Agentforce Data Libraries are configured', dataLibrariesCount > 0, 'No Agentforce Data Libraries found — unstructured data grounding for agents is not configured'),
      ac('dc_ac_3', 'External Service Registrations are complete', externalServicesCount > 0, 'No completed External Service Registrations found — OpenAPI-based external data connections for agent grounding are not set up')
    ];

    res.json({
      category: 'Data 360 / Data Cloud Architecture',
      dataCloudEnabled,
      dataLibrariesCount,
      dataLibraries: dataLibraries.records || [],
      autoChecks,
      questions: [
        { id: 'dc_1', text: 'Is Data 360 set up with data streams, identity resolution, and calculated insights?', type: 'boolean' },
        { id: 'dc_2', text: 'Are data spaces, permissions, governance, residency, and retention configured?', type: 'boolean' },
        { id: 'dc_3', text: 'Is it confirmed whether the agent needs CRM data, external lakehouse data, unified profiles, or all?', type: 'boolean' },
        { id: 'dc_4', text: 'Is the data freshness requirement for Data 360 grounding defined?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 17: Testing, Simulation, Release Readiness ─────────────────────
app.get('/api/assess/testing', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [apexTestClasses, overallCoverage] = await Promise.all([
      safeQuery(conn, "SELECT Id, Name FROM ApexClass WHERE Name LIKE '%Test%' AND Status = 'Active' LIMIT 100"),
      safeRest(conn, '/services/data/v62.0/tooling/query/?q=SELECT+PercentCovered+FROM+ApexOrgWideCoverage').catch(() => ({ records: [] }))
    ]);

    const orgCoverage = (overallCoverage.records || [])[0]?.PercentCovered || 0;
    const apexTestClassesCount = (apexTestClasses.records || []).length;

    const totalApexRes = await safeQuery(conn, "SELECT COUNT() FROM ApexClass WHERE Status = 'Active'").catch(() => ({ totalSize: 0 }));
    const totalApexCount = totalApexRes.totalSize || 0;
    const testRatio = totalApexCount > 0 ? apexTestClassesCount / totalApexCount : 0;

    const [testingCenterFeedback, fullSandboxForTesting] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM GenAiPlannerFeedback LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM SandboxInfo WHERE LicenseType IN ('FULL','PARTIAL') LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const hasTestingCenterFeedback = (testingCenterFeedback.totalSize || 0) > 0;
    const hasFullOrPartialSandbox = (fullSandboxForTesting.totalSize || 0) > 0;

    const autoChecks = [
      ac('test_ac_1', 'Org-wide Apex coverage meets 75% threshold', orgCoverage >= 75, `Org-wide Apex coverage is ${orgCoverage}% — below the 75% required for production deployment`),
      ac('test_ac_2', 'Apex test classes exist', apexTestClassesCount > 0, 'No Apex test classes found — automated testing is not established'),
      ac('test_ac_3', 'Test class ratio is adequate (>=15% of classes)', testRatio >= 0.15, `Test class ratio is ${Math.round(testRatio * 100)}% — increase test coverage before Agentforce go-live`),
      ac('test_ac_4', 'Agentforce Testing Center has been used (GenAiPlannerFeedback exists)', hasTestingCenterFeedback, 'No Testing Center feedback records found — Agentforce Testing Center has not been used to evaluate agent accuracy'),
      ac('test_ac_5', 'Full or Partial Copy sandbox exists for UAT/load testing', hasFullOrPartialSandbox, 'No Full or Partial Copy sandbox found — load and UAT testing for Agentforce requires production-scale data')
    ];

    res.json({
      category: 'Testing, Simulation, and Release Readiness',
      apexTestClassesCount,
      orgWideApexCoverage: orgCoverage,
      autoChecks,
      questions: [
        { id: 'test_1', text: 'Is an Agentforce test strategy defined (utterance, grounding, action, permissions, escalation testing)?', type: 'boolean' },
        { id: 'test_2', text: 'Is the Agentforce Testing Center used for Q&A test generation and accuracy evaluation?', type: 'boolean' },
        { id: 'test_3', text: 'Is test data coverage validated across personas, record types, channels, and failure modes?', type: 'boolean' },
        { id: 'test_4', text: 'Are go/no-go criteria defined (accuracy rate, escalation rate, action success rate, containment rate)?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 18: Observability, Analytics, Audit ────────────────────────────
app.get('/api/assess/observability', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [eventLogFiles, promptInteractions, reportCount] = await Promise.all([
      safeQuery(conn, "SELECT Id, EventType, CreatedDate FROM EventLogFile WHERE EventType IN ('AgentforceSession','EinsteinGPTGeneration','AgentforceAction','EinsteinGenerativeAI') ORDER BY CreatedDate DESC LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT COUNT() FROM GenAiPromptInteraction LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM Report LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);

    const eventLogFilesFound = (eventLogFiles.records || []).length;
    const hasPromptInteractions = (promptInteractions.totalSize || 0) > 0;
    const hasReports = (reportCount.totalSize || 0) > 0;

    const [dashboardCount, messagingSessionCount, agentTraceRes, viewTracesPermRes] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM Dashboard LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM MessagingSession LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+Id,CreatedDate+FROM+AgentTrace+ORDER+BY+CreatedDate+DESC+LIMIT+5").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT COUNT() FROM PermissionSet WHERE PermissionsViewAgentTraces = true LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);
    const hasDashboards = (dashboardCount.totalSize || 0) > 0;
    const hasMessagingSessions = (messagingSessionCount.totalSize || 0) > 0;

    const autoChecks = [
      ac('obs_ac_1', 'Agentforce or Einstein event log files exist', eventLogFilesFound > 0, 'No Agentforce/Einstein event log files found — AI session observability data is not being captured'),
      ac('obs_ac_2', 'Event log files are recent (last 7 days)', (eventLogFiles.records||[]).some(e => new Date(e.CreatedDate) > new Date(Date.now() - 7*24*60*60*1000)), 'No recent (last 7 days) Agentforce/Einstein event logs — verify monitoring is active'),
      ac('obs_ac_3', 'Prompt interaction data is being captured (GenAiPromptInteraction)', hasPromptInteractions, 'No GenAiPromptInteraction records found — prompt-level observability is not yet active (requires live agent usage)'),
      ac('obs_ac_4', 'Reports exist for operational monitoring', hasReports, 'No reports found — operational dashboards for agent performance monitoring have not been built'),
      ac('obs_ac_5', 'Dashboards exist for operational monitoring', hasDashboards, 'No dashboards found — build operational dashboards for agent containment, handoff rate, and action success metrics'),
      ac('obs_ac_6', 'Messaging session data is being captured', hasMessagingSessions, 'No MessagingSession records found — live conversation capture is not yet active (may require live agent usage)'),
      ac('obs_ac_7', 'Agent Platform Traces exist (Spring \'26 tracing)', (agentTraceRes.records || []).length > 0, 'No AgentTrace records found — Agent Platform Tracing (Spring \'26 GA) captures LLM calls, Flow execution, and Apex traces for root cause analysis'),
      ac('obs_ac_8', 'ViewAgentTraces permission is assigned to operations team', viewTracesPermRes.totalSize > 0, 'No permission set grants ViewAgentTraces — operations team cannot access Agent Platform Traces without this permission')
    ];

    res.json({
      category: 'Observability, Analytics, Audit, and Feedback',
      eventLogFilesFound,
      recentEventLogs: (eventLogFiles.records || []).slice(0, 5),
      autoChecks,
      questions: [
        { id: 'obs_1', text: 'Are Einstein audit, analytics, monitoring, and feedback enabled?', type: 'boolean' },
        { id: 'obs_2', text: 'Are operational dashboards defined (containment, handoff, action failure, CSAT)?', type: 'boolean' },
        { id: 'obs_3', text: 'Is the Agentforce Session Trace OTel API evaluated for advanced observability?', type: 'boolean' },
        { id: 'obs_4', text: 'Is a production review process for failed conversations and continuous tuning established?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 19: DevOps, Metadata, Environments, ALM ────────────────────────
app.get('/api/assess/devops', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [sandboxes, deployments] = await Promise.all([
      safeQuery(conn, 'SELECT Id, SandboxName, LicenseType FROM SandboxInfo LIMIT 20').catch(() => ({ records: [] })),
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+Id,Status,StartDate+FROM+DeployRequest+WHERE+Status+IN+('Succeeded','Failed')+ORDER+BY+StartDate+DESC+LIMIT+10").catch(() => ({ records: [] }))
    ]);

    const sandboxesFound = (sandboxes.records || []).length;
    const successfulDeploys = (deployments.records||[]).filter(d => d.Status === 'Succeeded');

    const agentforceStaticResources = await safeQuery(conn, "SELECT COUNT() FROM StaticResource WHERE Name LIKE '%agentforce%' OR Name LIKE '%Agentforce%' OR Name LIKE '%agent%' LIMIT 1").catch(() => ({ totalSize: 0 }));
    const hasAgentforceStaticResources = (agentforceStaticResources.totalSize || 0) > 0;

    const apiVersionsRes = await safeRest(conn, "/services/data/").catch(() => []);
    const versions = Array.isArray(apiVersionsRes) ? apiVersionsRes : [];
    const hasV66 = versions.some(v => v.version === '66.0');

    const autoChecks = [
      ac('do_ac_1', 'Sandboxes exist (work is not all done in production)', sandboxesFound > 0, 'No sandboxes found — Agentforce development directly in production is extremely high risk'),
      ac('do_ac_2', 'Multiple sandboxes support a proper environment strategy', sandboxesFound >= 2, `Only ${sandboxesFound} sandbox found — consider dev, QA, and UAT environments for Agentforce`),
      ac('do_ac_3', 'Recent successful deployments indicate active CI/CD', successfulDeploys.length > 0, 'No recent successful deployments found — CI/CD and deployment processes may not be established'),
      ac('do_ac_4', 'At least 3 sandboxes exist (Dev, QA, UAT environment strategy)', sandboxesFound >= 3, `Only ${sandboxesFound} sandbox(es) found — a proper Agentforce environment strategy requires at minimum Dev, QA, and UAT sandboxes`),
      ac('do_ac_5', 'Agentforce-related static resources or assets are present', hasAgentforceStaticResources, 'No Agentforce-related static resources found — confirm deployment assets and metadata are source-controlled'),
      ac('do_ac_6', 'API v66.0 is available (Spring \'26 agent metadata bundles)', hasV66, 'API v66.0 not available — Spring \'26 versioned agent metadata bundles and Agent Script require Metadata API v66+')
    ];

    res.json({
      category: 'DevOps, Metadata, Environments, and ALM',
      sandboxesFound,
      sandboxes: sandboxes.records || [],
      recentDeployments: (deployments.records || []).slice(0, 5),
      autoChecks,
      questions: [
        { id: 'do_1', text: 'Is there a source-control strategy for Agentforce metadata, prompts, flows, and Apex?', type: 'boolean' },
        { id: 'do_2', text: 'Is deployment tooling, packaging constraints, and sandbox strategy confirmed?', type: 'boolean' },
        { id: 'do_3', text: 'Are scratch orgs vs. sandbox requirements assessed for Data 360/Data Library dependencies?', type: 'boolean' },
        { id: 'do_4', text: 'Are agent assets included in the Design Authority/release checklist?', type: 'boolean' },
        { id: 'do_5', text: 'Is a rollback plan defined for Agentforce production deployments?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 20: Performance, Scalability, Limits ───────────────────────────
app.get('/api/assess/performance', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const limits = await safeRest(conn, '/services/data/v62.0/limits/');

    const flags = [];
    if (limits && !limits.error) {
      const pct = (used, max) => max ? Math.round((used / max) * 100) : 0;
      const checks = [
        { name: 'DailyApiRequests', label: 'Daily API Requests', ...limits.DailyApiRequests },
        { name: 'DailyAsyncApexExecutions', label: 'Daily Async Apex', ...limits.DailyAsyncApexExecutions },
        { name: 'DailyBulkApiBatches', label: 'Daily Bulk API Batches', ...limits.DailyBulkApiBatches },
        { name: 'DailyStreamingApiEvents', label: 'Daily Streaming Events', ...limits.DailyStreamingApiEvents },
        { name: 'DailyEinsteinRequests', label: 'Daily Einstein/Agentforce AI Requests', ...(limits.DailyEinsteinRequests || {}) }
      ].filter(c => c.Max);
      checks.forEach(c => {
        const pctUsed = pct(c.Remaining ? (c.Max - c.Remaining) : 0, c.Max);
        flags.push({ ...c, percentUsed: pctUsed, flagged: pctUsed >= 50 });
      });
    }

    const autoChecks = flags.map((f, i) => ac(`perf_ac_${i+1}`, `${f.label} within safe limits (<50%)`, !f.flagged, `${f.label} is at ${f.percentUsed}% of daily limit`));

    res.json({
      category: 'Performance, Scalability, and Limits',
      limitsFlags: flags,
      autoChecks,
      questions: [
        { id: 'perf_1', text: 'Are transaction volume, concurrent conversations, and API call volumes assessed?', type: 'boolean' },
        { id: 'perf_2', text: 'Is target latency for agent response and action completion defined?', type: 'boolean' },
        { id: 'perf_3', text: 'Are slow Lightning pages, heavy flows, large data volumes, and sharing recalculation risks reviewed?', type: 'boolean' },
        { id: 'perf_4', text: 'Are integration bottlenecks and callout limits assessed?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 21: Compliance, Privacy, Legal ─────────────────────────────────
app.get('/api/assess/compliance', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [dataPrivacyRecords, fieldEncryption] = await Promise.all([
      safeQuery(conn, 'SELECT Id, Name FROM DataPrivacyRecord LIMIT 10').catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, QualifiedApiName FROM FieldDefinition WHERE IsEncrypted = true LIMIT 50").catch(() => ({ records: [] }))
    ]);

    const dataPrivacyRecordsFound = (dataPrivacyRecords.records || []).length;
    const encryptedFieldsCount = (fieldEncryption.records || []).length;

    const auditLogsRes = await safeQuery(conn, "SELECT Id FROM EventLogFile LIMIT 1").catch(() => ({ records: [] }));
    const hasAuditLogs = (auditLogsRes.records || []).length > 0;
    const autoChecks = [
      ac('comp_ac_1', 'Data Privacy records exist (privacy/consent tracking)', dataPrivacyRecordsFound > 0, 'No Data Privacy records found — individual privacy tracking and consent management is not configured'),
      ac('comp_ac_2', 'Field-level encryption is in use', encryptedFieldsCount > 0, 'No encrypted fields found — consider Salesforce Shield Encryption for sensitive fields accessed by Agentforce'),
      ac('comp_ac_3', 'Event log files are available for audit trail', hasAuditLogs, 'No event log files found — audit trail for AI-generated actions may not be available (requires Event Monitoring license)')
    ];

    res.json({
      category: 'Compliance, Privacy, Legal, and Records Retention',
      dataPrivacyRecordsFound,
      encryptedFieldsCount,
      autoChecks,
      questions: [
        { id: 'comp_1', text: 'Are regulated data and policies identified (PHI, PII, PCI, HIPAA, GDPR, CCPA)?', type: 'boolean' },
        { id: 'comp_2', text: 'Are prompts, responses, actions, and transcripts auditable?', type: 'boolean' },
        { id: 'comp_3', text: 'Are retention and deletion requirements defined for Messaging Sessions, transcripts, and AI outputs?', type: 'boolean' },
        { id: 'comp_4', text: 'Is data access restricted to authorized individuals for intended purposes?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 21: Agent Design and Use Case Readiness ────────────────────────
app.get('/api/assess/agent-design', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [agents, topics, agentFunctions, promptTemplates] = await Promise.all([
      safeQuery(conn, 'SELECT Id, DeveloperName, Status, Description FROM BotDefinition LIMIT 30').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, MasterLabel, Description FROM GenAiPlugin WHERE IsActive = true LIMIT 50').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, Description FROM GenAiFunction WHERE IsActive = true LIMIT 50').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, Type, Status FROM PromptTemplate LIMIT 30').catch(() => ({ records: [] }))
    ]);

    const agentsWithDescription = (agents.records || []).filter(a => a.Description && a.Description.length > 10).length;
    const topicsWithDescription = (topics.records || []).filter(t => t.Description && t.Description.length > 10).length;
    const actionsWithDescription = (agentFunctions.records || []).filter(f => f.Description && f.Description.length > 10).length;
    const activeAgents = (agents.records || []).filter(a => a.Status === 'Active').length;
    const totalAgents = (agents.records || []).length;
    const totalTopics = (topics.records || []).length;
    const totalActions = (agentFunctions.records || []).length;
    const activePromptTemplates = (promptTemplates.records || []).filter(p => p.Status === 'Active').length;

    const autoChecks = [
      ac('ad_ac_1', 'Agents are defined in Agentforce Builder', totalAgents > 0, 'No agents defined — agent build has not started'),
      ac('ad_ac_2', 'At least one agent is Active', activeAgents > 0, 'No agents are Active — all agents are in Draft and cannot serve users'),
      ac('ad_ac_3', 'Agents have descriptions (use case is documented)', agentsWithDescription > 0, 'No agents have descriptions — document the job-to-be-done for each agent'),
      ac('ad_ac_4', 'Topics/subagents are defined and have descriptions', topicsWithDescription > 0, totalTopics === 0 ? 'No topics defined — agent scope has not been decomposed into jobs-to-be-done' : 'Topics exist but lack descriptions — document the intent scope of each topic'),
      ac('ad_ac_5', 'Agent actions are defined and documented', actionsWithDescription > 0, totalActions === 0 ? 'No agent actions defined — agents have no capability to execute tasks' : 'Actions exist but lack descriptions — document each action for agent discoverability'),
      ac('ad_ac_6', 'Active prompt templates are configured for agent grounding', activePromptTemplates > 0, 'No active prompt templates — agent instructions and grounding prompts are not yet defined')
    ];

    res.json({
      category: 'Agent Design and Use Case Readiness',
      totalAgents,
      activeAgents,
      totalTopics,
      totalActions,
      activePromptTemplates,
      agentsWithDescription,
      topicsWithDescription,
      actionsWithDescription,
      autoChecks,
      questions: [
        { id: 'ad_1', text: 'Is the agent persona, job-to-be-done, and success metrics (containment rate, CSAT, handle time) defined?', type: 'boolean' },
        { id: 'ad_2', text: 'Are the top 10–20 intents/utterances documented and validated with business stakeholders?', type: 'boolean' },
        { id: 'ad_3', text: 'Is the human-in-the-loop escalation model and override process confirmed?', type: 'boolean' },
        { id: 'ad_4', text: 'Is a phased rollout plan defined (pilot group → GA) with go/no-go criteria?', type: 'boolean' },
        { id: 'ad_5', text: 'Has a design authority or review process been established for agent topics, actions, and prompts?', type: 'boolean' },
        { id: 'ad_6', text: 'Are out-of-scope topics and explicit agent guardrails documented?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 22: Prompt Engineering and Grounding Strategy ──────────────────
app.get('/api/assess/prompt-engineering', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [promptTemplates, dataLibraries, agents] = await Promise.all([
      safeQuery(conn, 'SELECT Id, DeveloperName, Type, Status, Description FROM PromptTemplate LIMIT 50').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, Type FROM AgentforceDataLibrary LIMIT 20').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, Status FROM BotDefinition LIMIT 20').catch(() => ({ records: [] }))
    ]);

    const totalTemplates = (promptTemplates.records || []).length;
    const activeTemplates = (promptTemplates.records || []).filter(p => p.Status === 'Active').length;
    const draftTemplates = (promptTemplates.records || []).filter(p => p.Status === 'Draft').length;
    const templatesWithDescription = (promptTemplates.records || []).filter(p => p.Description && p.Description.length > 10).length;
    const templateTypes = [...new Set((promptTemplates.records || []).map(p => p.Type))];
    const hasFlexTemplate = (promptTemplates.records || []).some(p => p.Type === 'Flex');
    const dataLibrariesCount = (dataLibraries.records || []).length;
    const agentsCount = (agents.records || []).length;

    const autoChecks = [
      ac('pe_ac_1', 'Prompt templates are defined', totalTemplates > 0, 'No prompt templates found — agent instructions, grounding prompts, and action prompts are not configured'),
      ac('pe_ac_2', 'Active prompt templates exist (not all in Draft)', activeTemplates > 0, draftTemplates > 0 ? `${draftTemplates} prompt template(s) are in Draft — activate reviewed templates before go-live` : 'No active prompt templates — publish reviewed templates'),
      ac('pe_ac_3', 'Flex-type prompt templates are configured', hasFlexTemplate, 'No Flex prompt templates found — Flex templates provide the most flexible agent instruction patterns for Agentforce'),
      ac('pe_ac_4', 'Prompt templates have descriptions (versioning and purpose documented)', templatesWithDescription > 0, 'No prompt templates have descriptions — document the purpose, version, and grounding source of each template'),
      ac('pe_ac_5', 'Grounding data sources (Data Libraries) are linked', dataLibrariesCount > 0, 'No Agentforce Data Libraries configured — prompts cannot ground on unstructured data sources'),
      ac('pe_ac_6', 'Prompt templates exist relative to agents defined', agentsCount === 0 || activeTemplates >= agentsCount, agentsCount > activeTemplates ? `${agentsCount} agent(s) defined but only ${activeTemplates} active prompt template(s) — each agent should have at least one active template` : 'No agents defined yet')
    ];

    res.json({
      category: 'Prompt Engineering and Grounding Strategy',
      totalTemplates,
      activeTemplates,
      draftTemplates,
      templatesWithDescription,
      templateTypes,
      dataLibrariesCount,
      autoChecks,
      questions: [
        { id: 'pe_1', text: 'Are system prompts scoped to the specific job-to-be-done (not generic instructions)?', type: 'boolean' },
        { id: 'pe_2', text: 'Are grounding sources (Knowledge, Data Library, Flow output, CRM data) explicitly referenced in each prompt?', type: 'boolean' },
        { id: 'pe_3', text: 'Is a prompt versioning and peer review process defined before templates go active?', type: 'boolean' },
        { id: 'pe_4', text: 'Are prompts tested for hallucination, tone, compliance, and escalation trigger accuracy?', type: 'boolean' },
        { id: 'pe_5', text: 'Is the LLM model selection confirmed (Salesforce-managed vs. BYOLLM via Model Builder)?', type: 'boolean' },
        { id: 'pe_6', text: 'Are prohibitions and guardrails explicitly stated in system prompts (topics the agent must not handle)?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 23: Escalation and Handoff Architecture ────────────────────────
app.get('/api/assess/escalation', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [transferFlows, queues, serviceChannels, omniFlows] = await Promise.all([
      safeQuery(conn, "SELECT Id, DeveloperName, ProcessType, Status FROM Flow WHERE Status = 'Active' AND (DeveloperName LIKE '%Transfer%' OR DeveloperName LIKE '%Escalat%' OR DeveloperName LIKE '%Handoff%' OR DeveloperName LIKE '%Handover%') LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, Name FROM Group WHERE Type = 'Queue' LIMIT 50").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName, IsActive FROM ServiceChannel LIMIT 30").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName, ProcessType, Status FROM Flow WHERE Status = 'Active' AND ProcessType = 'OmniChannelFlow' LIMIT 20").catch(() => ({ records: [] }))
    ]);

    const transferFlowsCount = (transferFlows.records || []).length;
    const queuesCount = (queues.records || []).length;
    const activeServiceChannels = (serviceChannels.records || []).filter(s => s.IsActive).length;
    const omniFlowsCount = (omniFlows.records || []).length;

    const autoChecks = [
      ac('esc_ac_1', 'Escalation/transfer flows are defined', transferFlowsCount > 0, 'No active flows with transfer/escalation/handoff naming found — agent-to-human escalation paths are not configured'),
      ac('esc_ac_2', 'Queues exist for escalated work routing', queuesCount > 0, 'No queues found — escalated conversations have nowhere to route when the agent cannot handle a request'),
      ac('esc_ac_3', 'Active service channels are configured for handoff', activeServiceChannels > 0, 'No active service channels — Omni-Channel handoff from Agentforce to human agents is not possible'),
      ac('esc_ac_4', 'Omni-Channel flows are configured for routing logic', omniFlowsCount > 0, 'No OmniChannelFlow type flows found — Omni-Channel routing flows are required for Agentforce handoff to human queues'),
      ac('esc_ac_5', 'Multiple queues support tiered escalation', queuesCount >= 2, `Only ${queuesCount} queue(s) found — consider tiered queues (Tier 1, Tier 2, Supervisor) for escalation routing`),
      ac('esc_ac_6', 'Service channels cover messaging and/or chat', activeServiceChannels >= 2, `Only ${activeServiceChannels} active service channel(s) — ensure channels cover all deployment targets for escalation`)
    ];

    res.json({
      category: 'Escalation and Handoff Architecture',
      transferFlowsCount,
      transferFlows: transferFlows.records || [],
      queuesCount,
      activeServiceChannels,
      omniFlowsCount,
      autoChecks,
      questions: [
        { id: 'esc_1', text: 'Is full conversation context (transcript, intent, customer identity, case data) passed to the human agent on escalation?', type: 'boolean' },
        { id: 'esc_2', text: 'Are escalation triggers defined (sentiment, keywords, topic out of scope, action failure, customer request)?', type: 'boolean' },
        { id: 'esc_3', text: 'Are SLA timers handled correctly on escalation (reset, carried over, or new SLA applied)?', type: 'boolean' },
        { id: 'esc_4', text: 'Is a supervisor override/intervention path defined for live agent monitoring?', type: 'boolean' },
        { id: 'esc_5', text: 'Is a fallback path defined for all failure modes (no humans available, action error, channel outage)?', type: 'boolean' },
        { id: 'esc_6', text: 'Is post-escalation feedback loop established to improve agent accuracy over time?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 24: MuleSoft, Middleware, and External API Readiness ────────────
app.get('/api/assess/middleware', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [namedCredentials, externalCredentials, externalServices, remoteSites, apexCallouts] = await Promise.all([
      safeQuery(conn, 'SELECT Id, DeveloperName, Endpoint FROM NamedCredential LIMIT 50').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, AuthenticationProtocol FROM ExternalCredential LIMIT 30').catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName, Status, Description FROM ExternalServiceRegistration WHERE Status = 'Complete' LIMIT 30").catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, EndpointUrl, IsActive, MutualAuthEnabled FROM RemoteProxy WHERE IsActive = true LIMIT 50').catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, Name FROM ApexClass WHERE Status = 'Active' AND Name LIKE '%Callout%' LIMIT 20").catch(() => ({ records: [] }))
    ]);

    const namedCredentialsCount = (namedCredentials.records || []).length;
    const externalCredentialsCount = (externalCredentials.records || []).length;
    const externalServicesCount = (externalServices.records || []).length;
    const activeRemoteSitesCount = (remoteSites.records || []).length;
    const insecureRemoteSites = (remoteSites.records || []).filter(r => r.EndpointUrl && !r.EndpointUrl.startsWith('https')).length;
    const externalServicesWithDescription = (externalServices.records || []).filter(s => s.Description && s.Description.length > 5).length;
    const oauthExternalCredentials = (externalCredentials.records || []).filter(c => c.AuthenticationProtocol && c.AuthenticationProtocol.includes('OAuth')).length;

    const autoChecks = [
      ac('mw_ac_1', 'Named Credentials are used for external integrations', namedCredentialsCount > 0, 'No Named Credentials found — agent external actions may be using hardcoded endpoints or credentials, which is a security risk'),
      ac('mw_ac_2', 'External Credentials are configured for OAuth-based auth', externalCredentialsCount > 0, 'No External Credentials found — modern per-user OAuth authentication for agent external actions is not configured'),
      ac('mw_ac_3', 'External Service Registrations exist for OpenAPI-based connections', externalServicesCount > 0, 'No completed External Service Registrations found — OpenAPI/REST-based external system connections for agent actions are not set up'),
      ac('mw_ac_4', 'All active remote sites use HTTPS', insecureRemoteSites === 0, `${insecureRemoteSites} active remote site(s) use HTTP — all agent external callout endpoints must use HTTPS`),
      ac('mw_ac_5', 'External Services are documented (have descriptions)', externalServicesCount === 0 || externalServicesWithDescription > 0, 'External Service Registrations exist but lack descriptions — document the purpose, owner, and rate limits of each external connection'),
      ac('mw_ac_6', 'OAuth-based External Credentials are configured', oauthExternalCredentials > 0, externalCredentialsCount === 0 ? 'No External Credentials found' : 'No OAuth-based External Credentials found — prefer OAuth over basic auth for agent action external calls')
    ];

    res.json({
      category: 'MuleSoft, Middleware, and External API Readiness',
      namedCredentialsCount,
      externalCredentialsCount,
      externalServicesCount,
      activeRemoteSitesCount,
      insecureRemoteSites,
      oauthExternalCredentials,
      namedCredentials: (namedCredentials.records || []).slice(0, 10),
      externalServices: externalServices.records || [],
      autoChecks,
      questions: [
        { id: 'mw_1', text: 'Are all external systems the agent must query or update identified with confirmed API contracts?', type: 'boolean' },
        { id: 'mw_2', text: 'Are API rate limits, retry strategies, and timeout handling defined for each external system?', type: 'boolean' },
        { id: 'mw_3', text: 'Is the integration pattern confirmed (direct Named Credential callout, External Service, Flow, MuleSoft, or middleware)?', type: 'boolean' },
        { id: 'mw_4', text: 'Is idempotency and auditability defined for all agent-triggered external write operations?', type: 'boolean' },
        { id: 'mw_5', text: 'Are API version locks in place to prevent breaking changes from impacting live agents?', type: 'boolean' },
        { id: 'mw_6', text: 'Is MuleSoft Anypoint (if applicable) connected, authenticated, and API catalog aligned with agent action requirements?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 25: Agentforce Voice Readiness ─────────────────────────────────
app.get('/api/assess/voice', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [voiceChannels, voiceAgents, voicePresenceStatuses, whatsAppChannels, routingConfigs] = await Promise.all([
      safeQuery(conn, "SELECT Id, DeveloperName, IsActive FROM ServiceChannel WHERE RelatedEntityType = 'VoiceCall' LIMIT 10").catch(() => ({ records: [] })),
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+Id,DeveloperName+FROM+BotDefinition+WHERE+Type='Voice'+LIMIT+10").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName, IsActive FROM ServicePresenceStatus WHERE DeveloperName LIKE '%Voice%' OR DeveloperName LIKE '%Phone%' LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName, IsActive, Type FROM MessagingChannel WHERE Type = 'WhatsApp' LIMIT 10").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName, IsActive FROM RoutingConfig WHERE DeveloperName LIKE '%Voice%' OR DeveloperName LIKE '%Phone%' LIMIT 10").catch(() => ({ records: [] }))
    ]);

    const voiceChannelCount = (voiceChannels.records || []).length;
    const activeVoiceChannels = (voiceChannels.records || []).filter(c => c.IsActive).length;
    const voiceAgentCount = (voiceAgents.records || []).length;
    const voicePresenceCount = (voicePresenceStatuses.records || []).filter(p => p.IsActive).length;
    const whatsAppCount = (whatsAppChannels.records || []).filter(c => c.IsActive).length;
    const voiceRoutingCount = (routingConfigs.records || []).length;

    const autoChecks = [
      ac('voice_ac_1', 'Voice service channel is configured', voiceChannelCount > 0, 'No voice service channel found — Agentforce Voice (GA Spring \'26) requires a VoiceCall-type service channel configured in Omni-Channel'),
      ac('voice_ac_2', 'Voice service channel is active', activeVoiceChannels > 0, voiceChannelCount === 0 ? 'No voice channels found' : 'Voice service channel exists but is not active — activate it to enable Agentforce Voice routing'),
      ac('voice_ac_3', 'Voice-type agent is defined', voiceAgentCount > 0, 'No Voice-type Bot Definition found — a dedicated Voice agent must be configured in Agentforce Builder for voice deployments'),
      ac('voice_ac_4', 'Voice presence statuses are configured', voicePresenceCount > 0, 'No voice-related presence statuses found — agents and human reps need voice-specific presence statuses for Omni-Channel routing'),
      ac('voice_ac_5', 'Voice routing configuration exists', voiceRoutingCount > 0, 'No voice routing configurations found — Omni-Channel routing rules for voice calls are not configured'),
      ac('voice_ac_6', 'WhatsApp Voice channel is configured (if in scope)', whatsAppCount > 0, 'No active WhatsApp channel found — WhatsApp Voice support was added in Spring \'26 for contact center deployments (configure if WhatsApp is a target channel)')
    ];

    res.json({
      category: 'Agentforce Voice Readiness',
      voiceChannelCount,
      activeVoiceChannels,
      voiceAgentCount,
      voicePresenceCount,
      whatsAppCount,
      voiceRoutingCount,
      voiceChannels: voiceChannels.records || [],
      whatsAppChannels: whatsAppChannels.records || [],
      autoChecks,
      questions: [
        { id: 'voice_1', text: 'Is voice identified as a target channel for Agentforce deployment?', type: 'boolean' },
        { id: 'voice_2', text: 'Is the brand voice/tone and persona defined for the voice agent?', type: 'boolean' },
        { id: 'voice_3', text: 'Are voice-specific Flex Credit costs budgeted (30 credits per voice action vs. 20 for standard)?', type: 'boolean' },
        { id: 'voice_4', text: 'Is the escalation path from voice agent to human agent (warm transfer) designed and tested?', type: 'boolean' },
        { id: 'voice_5', text: 'Are language and regional requirements confirmed for voice deployment?', type: 'boolean' },
        { id: 'voice_6', text: 'Are call recording, transcript retention, and compliance requirements defined for voice interactions?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 26: MCP & External Tool Integration ────────────────────────────
app.get('/api/assess/mcp', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);
    const [namedCredentials, externalCredentials, externalServices, apexWithInvocable] = await Promise.all([
      safeQuery(conn, "SELECT Id, DeveloperName, Endpoint FROM NamedCredential WHERE DeveloperName LIKE '%MCP%' OR DeveloperName LIKE '%mcp%' LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName, AuthenticationProtocol FROM ExternalCredential LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName, Status, Description FROM ExternalServiceRegistration WHERE Status = 'Complete' LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT COUNT() FROM ApexClass WHERE Status = 'Active' AND Name LIKE '%Tool%' LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);

    const mcpNamedCredCount = (namedCredentials.records || []).length;
    const externalCredCount = (externalCredentials.records || []).length;
    const externalServicesCount = (externalServices.records || []).length;
    const apexToolCount = apexWithInvocable.totalSize || 0;

    // Check for UseApexAsAgentTool permission
    const apexToolPermRes = await safeQuery(conn, "SELECT COUNT() FROM PermissionSet WHERE PermissionsUseApexAsAgentTool = true LIMIT 1").catch(() => ({ totalSize: 0 }));
    const hasApexToolPerm = (apexToolPermRes.totalSize || 0) > 0;

    // Check for MCP-related tooling metadata
    const mcpToolRes = await safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+Id,DeveloperName+FROM+ExternalServiceRegistration+WHERE+Status='Complete'+LIMIT+20").catch(() => ({ records: [] }));
    const mcpToolCount = (mcpToolRes.records || []).length;

    const autoChecks = [
      ac('mcp_ac_1', 'External Service Registrations exist for MCP/API tool connections', externalServicesCount > 0, 'No completed External Service Registrations — MCP tool connections require OpenAPI/REST service registrations to expose external systems to agents (Spring \'26)'),
      ac('mcp_ac_2', 'UseApexAsAgentTool permission set exists', hasApexToolPerm, 'No permission set grants UseApexAsAgentTool — this Spring \'26 permission is required to expose Apex methods as MCP tools for agent actions'),
      ac('mcp_ac_3', 'External Credentials are configured for OAuth-based MCP auth', externalCredCount > 0, 'No External Credentials found — MCP tool integrations should use OAuth-based External Credentials, not basic auth or hardcoded credentials'),
      ac('mcp_ac_4', 'Apex tool classes exist (candidate MCP tools)', apexToolCount > 0, 'No Apex classes with "Tool" naming found — confirm @InvocableMethod Apex classes are defined and annotated for MCP tool exposure'),
      ac('mcp_ac_5', 'Named Credentials back external MCP connections', (namedCredentials.records || []).length > 0 || mcpNamedCredCount === 0, (namedCredentials.records || []).length === 0 ? 'No MCP-named credentials found — ensure Named Credentials are used for all MCP external system connections' : null),
      ac('mcp_ac_6', 'Service registrations are documented', externalServicesCount === 0 || (externalServices.records || []).filter(s => s.Description && s.Description.length > 5).length > 0, 'External Service Registrations exist but lack descriptions — document the purpose, owner, and rate limits of each MCP tool connection')
    ];

    res.json({
      category: 'MCP & External Tool Integration',
      mcpNamedCredCount,
      externalCredCount,
      externalServicesCount,
      apexToolCount,
      hasApexToolPerm,
      mcpToolCount,
      externalServices: externalServices.records || [],
      autoChecks,
      questions: [
        { id: 'mcp_1', text: 'Have external AI tools or systems requiring MCP integration been identified (Claude, Google, etc.)?', type: 'boolean' },
        { id: 'mcp_2', text: 'Are Apex methods intended as MCP tools annotated with @InvocableMethod and have Apex test coverage?', type: 'boolean' },
        { id: 'mcp_3', text: 'Are MCP tool connections secured with Named Credentials and OAuth External Credentials?', type: 'boolean' },
        { id: 'mcp_4', text: 'Are rate limits, retry handling, and timeout behavior defined for each MCP tool connection?', type: 'boolean' },
        { id: 'mcp_5', text: 'Is the Salesforce MCP Server registry configured for external AI assistant access (if applicable)?', type: 'boolean' },
        { id: 'mcp_6', text: 'Are MCP tool security policies reviewed — which tools can access what data and perform what actions?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 27: Agent Script & Metadata Readiness ──────────────────────────
app.get('/api/assess/agent-script', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);

    const [agentScripts, agents, deployRequests, apiVersions] = await Promise.all([
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+Id,DeveloperName,MasterLabel+FROM+AgentScript+LIMIT+30").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName, Status FROM BotDefinition LIMIT 20").catch(() => ({ records: [] })),
      safeRest(conn, "/services/data/v62.0/tooling/query/?q=SELECT+Id,Status,StartDate+FROM+DeployRequest+WHERE+Status='Succeeded'+ORDER+BY+StartDate+DESC+LIMIT+10").catch(() => ({ records: [] })),
      safeRest(conn, "/services/data/").catch(() => ([]))
    ]);

    const agentScriptCount = (agentScripts.records || []).length;
    const agentsCount = (agents.records || []).length;
    const activeAgentsCount = (agents.records || []).filter(a => a.Status === 'Active').length;

    const versions = Array.isArray(apiVersions) ? apiVersions : [];
    const hasV66 = versions.some(v => v.version === '66.0' || parseFloat(v.version) >= 66);
    const latestVersion = versions.length > 0 ? Math.max(...versions.map(v => parseFloat(v.version))) : 0;

    const recentDeploys = (deployRequests.records || []).length;
    const agentScriptRatio = agentsCount > 0 ? agentScriptCount / agentsCount : 0;

    const autoChecks = [
      ac('as_ac_1', 'Agent Scripts are defined (Spring \'26 DSL)', agentScriptCount > 0, 'No AgentScript records found — Agent Script is the Spring \'26 DSL that combines natural language with deterministic programmatic logic for more reliable, testable agents'),
      ac('as_ac_2', 'Agent Script coverage relative to agents (>=1 script per agent)', agentsCount === 0 || agentScriptRatio >= 1, agentsCount === 0 ? 'No agents defined yet' : `${agentsCount} agent(s) but only ${agentScriptCount} Agent Script(s) — each agent should use Agent Script instead of plain text instructions`),
      ac('as_ac_3', 'API v66.0+ is available (Spring \'26 metadata bundles)', hasV66, `Highest available API version is v${latestVersion} — Spring \'26 versioned agent metadata bundles and Agent Script deployment require Metadata API v66+`),
      ac('as_ac_4', 'Active agents are deployed (not just Draft)', activeAgentsCount > 0, agentsCount === 0 ? 'No agents defined' : 'No agents are in Active status — agents must be activated before they can serve users'),
      ac('as_ac_5', 'Recent successful deployments indicate active CI/CD for agent assets', recentDeploys > 0, 'No recent successful deployments — ensure agent metadata (AgentScript, BotDefinition, GenAiPlugin) is deployed via CI/CD, not built directly in production'),
      ac('as_ac_6', 'Agents are defined with descriptions for governance', (agents.records || []).filter(a => a.Description && a.Description.length > 5).length > 0 || agentsCount === 0, agentsCount === 0 ? 'No agents defined' : 'Agents are defined but lack descriptions — document the job-to-be-done for each agent for governance and peer review')
    ];

    res.json({
      category: 'Agent Script & Metadata Readiness',
      agentScriptCount,
      agentsCount,
      activeAgentsCount,
      hasV66,
      latestApiVersion: latestVersion,
      recentDeploys,
      agentScripts: agentScripts.records || [],
      autoChecks,
      questions: [
        { id: 'as_1', text: 'Are agent builders trained on Agent Script DSL (the Spring \'26 hybrid natural language + programmatic language)?', type: 'boolean' },
        { id: 'as_2', text: 'Is a peer review process established for Agent Script before promotion to Active?', type: 'boolean' },
        { id: 'as_3', text: 'Are agent assets (AgentScript, BotDefinition, GenAiPlugin, PromptTemplate) included in source control?', type: 'boolean' },
        { id: 'as_4', text: 'Is the CI/CD pipeline updated to handle the new versioned agent metadata bundle format (Metadata API v66+)?', type: 'boolean' },
        { id: 'as_5', text: 'Is batch testing in Agentforce Testing Center being used to validate Agent Script accuracy before go-live?', type: 'boolean' },
        { id: 'as_6', text: 'Is a rollback plan defined if an Agent Script update causes regressions in production?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Category 28: Licensing Model & FinOps ───────────────────────────────────
app.get('/api/assess/finops', requireAuth, async (req, res) => {
  try {
    const conn = getConn(req);

    const [limits, pricingSettings, agentforceUserLicenses, permSetAssignments] = await Promise.all([
      safeRest(conn, '/services/data/v62.0/limits/').catch(() => ({})),
      safeQuery(conn, "SELECT SettingName, SettingValue FROM OrganizationSetting WHERE SettingName IN ('FlexCreditsEnabled','ConversationPricingEnabled','AgentforcePricingModel','EinsteinGptEnabled','AgentforceEnabled') LIMIT 10").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT COUNT() FROM PermissionSetLicenseAssign WHERE PermissionSetLicense.DeveloperName LIKE '%Agentforce%' LIMIT 1").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM PermissionSetAssignment WHERE PermissionSet.Name LIKE '%Agentforce%' AND Assignee.IsActive = true LIMIT 1").catch(() => ({ totalSize: 0 }))
    ]);

    const settings = {};
    (pricingSettings.records || []).forEach(r => { settings[r.SettingName] = r.SettingValue; });

    const einsteinQuota = limits.DailyEinsteinRequests;
    const hasEinsteinQuota = einsteinQuota && einsteinQuota.Max > 0;
    const quotaUsedPct = hasEinsteinQuota ? Math.round(((einsteinQuota.Max - einsteinQuota.Remaining) / einsteinQuota.Max) * 100) : 0;
    const quotaHealthy = hasEinsteinQuota ? quotaUsedPct < 80 : false;

    const agentforceEnabled = settings['AgentforceEnabled'] === 'true';
    const einsteinEnabled = settings['EinsteinGptEnabled'] === 'true';
    const hasUserLicenses = (agentforceUserLicenses.totalSize || 0) > 0 || (permSetAssignments.totalSize || 0) > 0;
    const hasPricingModel = agentforceEnabled || Object.keys(settings).length > 0;

    const autoChecks = [
      ac('fo_ac_1', 'Agentforce is enabled (licensing prerequisite)', agentforceEnabled, 'Agentforce is not enabled in org settings — confirm licensing is active before any deployment'),
      ac('fo_ac_2', 'Einstein Generative AI quota (DailyEinsteinRequests) is provisioned', hasEinsteinQuota, 'No DailyEinsteinRequests quota found — Agentforce AI request quota is not provisioned; contact your AE to confirm Flex Credits or Conversations pricing is active'),
      ac('fo_ac_3', 'Einstein AI quota consumption is below 80%', hasEinsteinQuota && quotaHealthy, hasEinsteinQuota ? `Einstein AI quota is at ${quotaUsedPct}% — monitor consumption to avoid hitting daily limits which would disable agent responses` : 'Quota not provisioned — cannot assess consumption'),
      ac('fo_ac_4', 'Agentforce user license assignments exist', hasUserLicenses, 'No Agentforce permission set license assignments found — users cannot interact with or manage agents without an Agentforce User license ($5/user/month with base license required)'),
      ac('fo_ac_5', 'Pricing model is confirmed (Flex Credits vs. Conversations)', hasPricingModel, 'Agentforce pricing model is not confirmed — Flex Credits and Conversations pricing cannot coexist; select before go-live to avoid billing complications'),
      ac('fo_ac_6', 'AI quota is not critically near limit (<80% consumed)', !hasEinsteinQuota || quotaUsedPct < 80, `Einstein AI quota is at ${quotaUsedPct}% of daily limit — at this rate the org may hit limits during peak hours, halting agent responses`)
    ];

    res.json({
      category: 'Licensing Model & FinOps',
      agentforceEnabled,
      einsteinEnabled,
      hasEinsteinQuota,
      quotaUsedPct: hasEinsteinQuota ? quotaUsedPct : null,
      hasUserLicenses,
      hasPricingModel,
      dailyEinsteinMax: einsteinQuota?.Max || 0,
      dailyEinsteinRemaining: einsteinQuota?.Remaining || 0,
      autoChecks,
      questions: [
        { id: 'fo_1', text: 'Has the pricing model been confirmed with your Salesforce AE — Flex Credits, Conversations, or Salesforce Foundations (200k free credits)?', type: 'boolean' },
        { id: 'fo_2', text: 'Is the Digital Wallet configured for Flex Credits usage tracking and cost attribution by team/channel?', type: 'boolean' },
        { id: 'fo_3', text: 'Are voice action costs budgeted separately (30 Flex Credits per voice action vs. 20 for standard actions)?', type: 'boolean' },
        { id: 'fo_4', text: 'Is a quota alert or monitoring process defined to notify when DailyEinsteinRequests approaches the daily limit?', type: 'boolean' },
        { id: 'fo_5', text: 'Are Agentforce User Licenses ($5/user/month) assigned to all users who will interact with or manage agents?', type: 'boolean' },
        { id: 'fo_6', text: 'Is a FinOps review cadence established to track Flex Credit consumption, optimize agent actions, and forecast costs?', type: 'boolean' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve React app in production ───────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../build')));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/auth') || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, '../build', 'index.html'));
  });
}

app.listen(PORT, () => console.log(`Agentforce Readiness server running on port ${PORT}`));
