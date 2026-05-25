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
    res.redirect(getBaseUrl(req));
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
      safeRest(conn, '/services/data/v59.0/limits/'),
      safeRest(conn, '/services/data/v59.0/sobjects/Organization/describe/').catch(() => null),
      safeQuery(conn, "SELECT Id, SettingName, SettingValue FROM OrganizationSetting WHERE SettingName IN ('EinsteinGptEnabled','AgentforceEnabled','DataCloudEnabled') LIMIT 10").catch(() => ({ records: [] }))
    ]);

    const featureFlags = await safeRest(conn, '/services/data/v59.0/tooling/query/?q=SELECT+QualifiedApiName,IsEnabled+FROM+FeatureParameterBoolean+WHERE+QualifiedApiName+IN+(\'AgentforceEnabled\',\'EinsteinGenAI\',\'DataCloud\')').catch(() => ({ records: [] }));

    const [orgSettingsRes, manageAIAgentsPS] = await Promise.all([
      safeQuery(conn, "SELECT SettingName, SettingValue FROM OrganizationSetting WHERE SettingName IN ('EinsteinGptEnabled','AgentforceEnabled','DataCloudEnabled') LIMIT 10"),
      safeQuery(conn, "SELECT Id FROM PermissionSet WHERE PermissionsManageAIAgents = true LIMIT 1").catch(() => ({ records: [] }))
    ]);
    const settings = {};
    (orgSettingsRes.records || []).forEach(r => { settings[r.SettingName] = r.SettingValue; });
    const autoChecks = [
      ac('lic_ac_1', 'Einstein Generative AI is enabled', settings['EinsteinGptEnabled'] === 'true', 'Einstein Generative AI is not enabled in org settings'),
      ac('lic_ac_2', 'Agentforce is enabled', settings['AgentforceEnabled'] === 'true', 'Agentforce is not enabled in org settings'),
      ac('lic_ac_3', 'Data Cloud is enabled', settings['DataCloudEnabled'] === 'true', 'Data Cloud is not enabled in org settings'),
      ac('lic_ac_4', 'A permission set with Manage AI Agents exists', (manageAIAgentsPS.records || []).length > 0, 'No permission set found with Manage AI Agents — admin cannot manage agents')
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
      safeRest(conn, '/services/data/v59.0/tooling/query/?q=SELECT+Id,SobjectType,SharingModel+FROM+SharingRules+LIMIT+100').catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, DeveloperName, Description FROM RestrictionRule LIMIT 20').catch(() => ({ records: [] }))
    ]);

    const [caseOwdRes, viewAllDataPS, restrictionRulesRes] = await Promise.all([
      safeRest(conn, "/services/data/v59.0/tooling/query/?q=SELECT+QualifiedApiName,DefaultInternalAccess,DefaultExternalAccess+FROM+EntityDefinition+WHERE+QualifiedApiName+IN+('Case','Account','Contact')").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, Name FROM PermissionSet WHERE PermissionsViewAllData = true AND IsCustom = true LIMIT 10").catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id FROM RestrictionRule LIMIT 1').catch(() => ({ records: [] }))
    ]);
    const caseOwd = (caseOwdRes.records || []).find(r => r.QualifiedApiName === 'Case');
    const caseNotPublicRW = !caseOwd || caseOwd.DefaultInternalAccess !== 'ReadWrite';
    const noViewAllData = (viewAllDataPS.records || []).length === 0;
    const hasRestrictionRules = (restrictionRulesRes.records || []).length > 0;
    const autoChecks = [
      ac('sec_ac_1', 'Case OWD is not Public Read/Write', caseNotPublicRW, 'Case OWD is Public Read/Write — agent may over-expose case data to all users'),
      ac('sec_ac_2', 'No custom permission sets grant View All Data', noViewAllData, `${(viewAllDataPS.records||[]).length} custom permission set(s) grant View All Data — verify agent user is not assigned these`),
      ac('sec_ac_3', 'Restriction rules are configured', hasRestrictionRules, 'No restriction rules found — consider scoping rules to limit agent record visibility')
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

    const modifyAllPS = await safeQuery(conn, "SELECT Id, Name FROM PermissionSet WHERE PermissionsModifyAllData = true AND IsCustom = true LIMIT 10").catch(() => ({ records: [] }));
    const noModifyAll = (modifyAllPS.records || []).length === 0;
    const autoChecks = [
      ac('au_ac_1', 'Integration or automation users exist', intUsers.length > 0, 'No integration/automation users found — define a dedicated agent user with scoped permissions'),
      ac('au_ac_2', 'No custom permission sets grant Modify All Data', noModifyAll, `${(modifyAllPS.records||[]).length} custom permission set(s) grant Modify All Data — verify the agent user does not inherit these`),
      ac('au_ac_3', 'Permission Set Groups are defined', (permSetGroups.records||[]).length > 0, 'No Permission Set Groups found — use PSGs to manage least-privilege permission bundles for agent users')
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
      safeRest(conn, "/services/data/v59.0/tooling/query/?q=SELECT+Id+FROM+FieldDefinition+WHERE+DataClassification+%21%3D+'NonSensitive'+AND+DataClassification+%21%3D+null+LIMIT+1").catch(() => ({ records: [] }))
    ]);
    const einsteinEnabled = (einsteinSettingRes.records || [])[0]?.SettingValue === 'true';
    const hasClassifiedFields = (classifiedFieldCheck.records || []).length > 0;
    const hasSensitiveFieldsClassified = (sensitiveFields.records || []).length > 0;
    const autoChecks = [
      ac('etl_ac_1', 'Einstein Generative AI is enabled (Trust Layer prerequisite)', einsteinEnabled, 'Einstein Generative AI is not enabled — the Einstein Trust Layer requires this to be active'),
      ac('etl_ac_2', 'Salesforce Data Classification is applied to fields', hasClassifiedFields, 'No fields have data classification applied — field-level AI masking in prompts cannot function without classification'),
      ac('etl_ac_3', 'PII/PHI/Sensitive fields are tagged with data classification', hasSensitiveFieldsClassified, 'No PII/PHI/sensitive-classified fields found — ensure all regulated fields are classified so Trust Layer can mask them')
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
    const autoChecks = [
      ac('dq_ac_1', 'Active duplicate rules exist', duplicateRulesActive > 0, 'No active duplicate rules — duplicate records will degrade agent reasoning and grounding accuracy'),
      ac('dq_ac_2', 'Custom field description coverage is adequate (>70%)', missingRatio < 0.30, `${Math.round(missingRatio * 100)}% of custom fields are missing descriptions — agents cannot understand field purpose without metadata`),
      ac('dq_ac_3', 'Agentforce Data Libraries are configured', (dataLibraries.records||[]).length > 0, 'No Agentforce Data Libraries found — unstructured data and knowledge grounding is not yet configured')
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
    const [articles, archivedArticles, articleTypes] = await Promise.all([
      safeQuery(conn, "SELECT COUNT() FROM Knowledge__kav WHERE PublishStatus = 'Online' AND Language = 'en_US'").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, "SELECT COUNT() FROM Knowledge__kav WHERE PublishStatus = 'Archived'").catch(() => ({ totalSize: 0 })),
      safeQuery(conn, 'SELECT Id, DeveloperName FROM KnowledgeArticleType LIMIT 20').catch(() => ({ records: [] }))
    ]);

    const publishedArticles = articles.totalSize || 0;
    const archivedArticles2 = archivedArticles.totalSize || 0;
    const articleTypesCount = (articleTypes.records || []).length;
    const autoChecks = [
      ac('km_ac_1', 'Knowledge is enabled (article types defined)', articleTypesCount > 0, 'Knowledge is not enabled — no article types found, agents cannot ground on Knowledge articles'),
      ac('km_ac_2', 'Published Knowledge articles exist', publishedArticles > 0, 'No published Knowledge articles — agent has no content to ground on'),
      ac('km_ac_3', 'Archive ratio is healthy (published >= archived)', publishedArticles >= archivedArticles2, `Archived articles (${archivedArticles2}) exceed published (${publishedArticles}) — article lifecycle governance may be needed`)
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
    const autoChecks = [
      ac('oc_ac_1', 'Service channels are configured', (serviceChannels.records||[]).length > 0, 'No Omni-Channel service channels found — Omni-Channel routing is not set up'),
      ac('oc_ac_2', 'Queues are configured for work routing', (queues.records||[]).length > 0, 'No queues found — work items cannot be routed to Agentforce or human agents'),
      ac('oc_ac_3', 'Routing configurations exist', (routingConfigs.records||[]).length > 0, 'No routing configurations found — Omni-Channel routing rules are incomplete'),
      ac('oc_ac_4', 'Active presence statuses are defined', activePresenceStatuses > 0, 'No active presence statuses — agent availability for Omni-Channel is not configured')
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
    const autoChecks = [
      ac('ch_ac_1', 'Messaging channels are configured', (messagingChannels.records||[]).length > 0, 'No messaging channels configured — Agentforce Service Agent cannot be deployed to messaging channels'),
      ac('ch_ac_2', 'Active messaging channels exist', activeMessagingCount > 0, `${(messagingChannels.records||[]).length} messaging channel(s) found but none are active`),
      ac('ch_ac_3', 'Embedded service deployments exist', embeddedDeploymentsCount > 0, 'No embedded service deployments — web chat/Enhanced Chat channel deployment is not configured')
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
    const apps = await safeQuery(conn, "SELECT Id, Name, DeveloperName, NavType FROM AppDefinition WHERE NavType = 'Console' LIMIT 20").catch(() => ({ records: [] }));

    const autoChecks = [
      ac('ca_ac_1', 'At least one Lightning Console app exists', (apps.records||[]).length > 0, 'No Lightning Console apps found — agents will not have a console workspace for escalated case handling')
    ];

    res.json({
      category: 'Console App and Agent Workspace Readiness',
      consoleAppsFound: (apps.records || []).length,
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
    const [flexiPages, dynamicForms] = await Promise.all([
      safeQuery(conn, "SELECT Id, DeveloperName, EntityDefinitionId, Type FROM FlexiPage WHERE Type IN ('RecordPage','AppPage') LIMIT 50").catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, DeveloperName FROM FlexiPage WHERE Type = 'RecordPage' LIMIT 50").catch(() => ({ records: [] }))
    ]);

    const autoChecks = [
      ac('lp_ac_1', 'Lightning record pages exist', (flexiPages.records||[]).length > 0, 'No custom Lightning record pages found — agents and human users may rely on default layouts without proper field/action configuration')
    ];

    res.json({
      category: 'Lightning Record Pages, Dynamic Forms, Dynamic Actions, and UX',
      recordPagesCount: (flexiPages.records || []).length,
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
    const [flows, apexClasses, promptTemplates] = await Promise.all([
      safeQuery(conn, "SELECT Id, DeveloperName, ProcessType, Status FROM Flow WHERE ProcessType IN ('AutoLaunchedFlow','Workflow') AND Status = 'Active' LIMIT 100"),
      safeQuery(conn, 'SELECT Id, Name, IsValid, ApiVersion FROM ApexClass WHERE Status = \'Active\' LIMIT 200'),
      safeQuery(conn, 'SELECT Id, DeveloperName, Type FROM PromptTemplate LIMIT 30').catch(() => ({ records: [] }))
    ]);

    const outdatedApex = (apexClasses.records || []).filter(c => parseFloat(c.ApiVersion) < 50);
    const outdatedApexCount = outdatedApex.length;
    const activeFlowsCount = (flows.records || []).length;
    const promptTemplatesCount = (promptTemplates.records || []).length;
    const invalidApexCount = (apexClasses.records || []).filter(c => !c.IsValid).length;
    const autoChecks = [
      ac('auto_ac_1', 'Active flows exist (candidate agent actions)', activeFlowsCount > 0, 'No active flows found — no existing automation available to use as Agentforce actions'),
      ac('auto_ac_2', 'All Apex classes use current API versions (>=v50)', outdatedApexCount === 0, `${outdatedApexCount} Apex class(es) use outdated API versions (<v50) — upgrade before using as agent actions`),
      ac('auto_ac_3', 'Prompt templates are configured', promptTemplatesCount > 0, 'No prompt templates found — agent grounding prompts and action prompts are not yet defined'),
      ac('auto_ac_4', 'No invalid Apex classes', invalidApexCount === 0, `${invalidApexCount} Apex class(es) have compilation errors — fix before using as agent actions`)
    ];

    res.json({
      category: 'Flow, Apex, Prompt Templates, and Agent Actions',
      activeFlowsCount,
      apexClassesCount: (apexClasses.records || []).length,
      outdatedApexCount,
      promptTemplatesCount,
      promptTemplates: promptTemplates.records || [],
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
      safeQuery(conn, 'SELECT Id, DeveloperName, Description FROM BotTopic LIMIT 50').catch(() => ({ records: [] }))
    ]);

    const agentsFound = (agents.records || []).length;
    const topicsFound = (topics.records || []).length;
    const autoChecks = [
      ac('ab_ac_1', 'Agentforce agents (Bot Definitions) are defined', agentsFound > 0, 'No Agentforce agents found — agent build has not started'),
      ac('ab_ac_2', 'Agent topics/subagents are defined', topicsFound > 0, 'No agent topics found — agents have no defined scope or capabilities'),
      ac('ab_ac_3', 'Topics-to-agents ratio suggests decomposition (>=1 topic per agent)', agentsFound > 0 && topicsFound >= agentsFound, agentsFound === 0 ? 'No agents found' : `${agentsFound} agent(s) but ${topicsFound} topic(s) — ensure each agent has at least one topic scoped to a job-to-be-done`)
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
    const [sites, networks, guestUserSharing] = await Promise.all([
      safeQuery(conn, "SELECT Id, Name, Status, UrlPathPrefix FROM Site WHERE Status IN ('Active','InMaintenance') LIMIT 20").catch(() => ({ records: [] })),
      safeQuery(conn, 'SELECT Id, Name, Status FROM Network LIMIT 20').catch(() => ({ records: [] })),
      safeQuery(conn, "SELECT Id, Name FROM SharingSet LIMIT 20").catch(() => ({ records: [] }))
    ]);

    const sitesExist = (sites.records||[]).length > 0;
    const sharingSetsExist = (guestUserSharing.records||[]).length > 0;
    const autoChecks = [
      ac('ec_ac_1', 'Experience Cloud sites exist', sitesExist, 'No active Experience Cloud sites found — if external user access is in scope, site configuration is required'),
      ac('ec_ac_2', 'Sharing Sets are configured', sharingSetsExist, 'No Sharing Sets found — external user record access for Experience Cloud portals is not configured')
    ];

    res.json({
      category: 'Experience Cloud, Embedded Service, and Public/External Access',
      activeSitesCount: (sites.records || []).length,
      networksCount: (networks.records || []).length,
      sharingSetsCount: (guestUserSharing.records || []).length,
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
    const dataStreams = await safeQuery(conn, 'SELECT Id, DeveloperName, Category FROM DataStream LIMIT 30').catch(() => ({ records: [] }));

    const autoChecks = [
      ac('dc_ac_1', 'Data streams are configured in Data Cloud', (dataStreams.records||[]).length > 0, 'No Data Cloud data streams found — Data 360 is not configured for Agentforce grounding')
    ];

    res.json({
      category: 'Data 360 / Data Cloud Architecture',
      dataStreamsFound: (dataStreams.records || []).length,
      dataStreams: dataStreams.records || [],
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
      safeRest(conn, '/services/data/v59.0/tooling/query/?q=SELECT+PercentCovered+FROM+ApexOrgWideCoverage').catch(() => ({ records: [] }))
    ]);

    const orgCoverage = (overallCoverage.records || [])[0]?.PercentCovered || 0;
    const apexTestClassesCount = (apexTestClasses.records || []).length;

    const totalApexRes = await safeQuery(conn, "SELECT COUNT() FROM ApexClass WHERE Status = 'Active'").catch(() => ({ totalSize: 0 }));
    const totalApexCount = totalApexRes.totalSize || 0;
    const testRatio = totalApexCount > 0 ? apexTestClassesCount / totalApexCount : 0;
    const autoChecks = [
      ac('test_ac_1', 'Org-wide Apex coverage meets 75% threshold', orgCoverage >= 75, `Org-wide Apex coverage is ${orgCoverage}% — below the 75% required for production deployment`),
      ac('test_ac_2', 'Apex test classes exist', apexTestClassesCount > 0, 'No Apex test classes found — automated testing is not established'),
      ac('test_ac_3', 'Test class ratio is adequate (>=15% of classes)', testRatio >= 0.15, `Test class ratio is ${Math.round(testRatio * 100)}% — increase test coverage before Agentforce go-live`)
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
    const eventLogFiles = await safeQuery(conn, "SELECT Id, EventType, CreatedDate FROM EventLogFile WHERE EventType IN ('AgentforceSession','EinsteinPrompt') ORDER BY CreatedDate DESC LIMIT 20").catch(() => ({ records: [] }));

    const eventLogFilesFound = (eventLogFiles.records || []).length;
    const autoChecks = [
      ac('obs_ac_1', 'Agentforce or Einstein event log files exist', eventLogFilesFound > 0, 'No Agentforce/Einstein event log files found — AI session observability data is not being captured'),
      ac('obs_ac_2', 'Event log files are recent (last 7 days)', (eventLogFiles.records||[]).some(e => new Date(e.CreatedDate) > new Date(Date.now() - 7*24*60*60*1000)), 'No recent (last 7 days) Agentforce/Einstein event logs — verify monitoring is active')
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
      safeQuery(conn, "SELECT Id, Status, StartDate FROM DeployRequest WHERE Status IN ('Succeeded','Failed') ORDER BY StartDate DESC LIMIT 10").catch(() => ({ records: [] }))
    ]);

    const sandboxesFound = (sandboxes.records || []).length;
    const successfulDeploys = (deployments.records||[]).filter(d => d.Status === 'Succeeded');
    const autoChecks = [
      ac('do_ac_1', 'Sandboxes exist (work is not all done in production)', sandboxesFound > 0, 'No sandboxes found — Agentforce development directly in production is extremely high risk'),
      ac('do_ac_2', 'Multiple sandboxes support a proper environment strategy', sandboxesFound >= 2, `Only ${sandboxesFound} sandbox found — consider dev, QA, and UAT environments for Agentforce`),
      ac('do_ac_3', 'Recent successful deployments indicate active CI/CD', successfulDeploys.length > 0, 'No recent successful deployments found — CI/CD and deployment processes may not be established')
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
    const limits = await safeRest(conn, '/services/data/v59.0/limits/');

    const flags = [];
    if (limits && !limits.error) {
      const pct = (used, max) => max ? Math.round((used / max) * 100) : 0;
      const checks = [
        { name: 'DailyApiRequests', label: 'Daily API Requests', ...limits.DailyApiRequests },
        { name: 'DailyAsyncApexExecutions', label: 'Daily Async Apex', ...limits.DailyAsyncApexExecutions },
        { name: 'DailyBulkApiBatches', label: 'Daily Bulk API Batches', ...limits.DailyBulkApiBatches },
        { name: 'DailyStreamingApiEvents', label: 'Daily Streaming Events', ...limits.DailyStreamingApiEvents }
      ];
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

// ─── Serve React app in production ───────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../build', 'index.html'));
  });
}

app.listen(PORT, () => console.log(`Agentforce Readiness server running on port ${PORT}`));
