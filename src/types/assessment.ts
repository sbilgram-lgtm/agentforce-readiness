export type QuestionType = 'boolean' | 'select' | 'multiselect' | 'text';

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  options?: string[];
}

export interface AutoCheck {
  id: string;
  label: string;
  passed: boolean;
  finding: string | null;
}

export interface CategoryResult {
  category: string;
  score: number;         // 0–100
  status: 'green' | 'amber' | 'red' | 'manual';
  findings: string[];
  questions: Question[];
  answers: Record<string, string | string[] | boolean>;
  apiData?: Record<string, unknown>;
  note?: string;
  autoChecks?: AutoCheck[];
}

export interface AssessmentReport {
  orgUrl: string;
  assessedAt: string;
  overallScore: number;
  categories: CategoryResult[];
  remediationBacklog: string[];
  summary: string;
}

// Category IDs for all 28 areas
export const CATEGORY_IDS = [
  'licensing',
  'security-model',
  'agent-user',
  'trust-layer',
  'data-quality',
  'knowledge',
  'omni-channel',
  'channels',
  'console',
  'lightning-pages',
  'automation',
  'agentforce-builder',
  'experience-cloud',
  'integrations',
  'data-cloud',
  'testing',
  'observability',
  'devops',
  'performance',
  'compliance',
  'agent-design',
  'prompt-engineering',
  'escalation',
  'middleware',
  'voice',
  'mcp',
  'agent-script',
  'finops'
] as const;

export type CategoryId = typeof CATEGORY_IDS[number];

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  'licensing': 'Licensing & Product Enablement',
  'security-model': 'Security Model & OWD',
  'agent-user': 'Agent User & Least Privilege',
  'trust-layer': 'Einstein Trust Layer',
  'data-quality': 'Data Quality & Grounding',
  'knowledge': 'Knowledge Management',
  'omni-channel': 'Omni-Channel & Routing',
  'channels': 'Messaging, Chat & Channels',
  'console': 'Console & Agent Workspace',
  'lightning-pages': 'Lightning Pages & UX',
  'automation': 'Flow, Apex & Agent Actions',
  'agentforce-builder': 'Agentforce Builder & Topics',
  'experience-cloud': 'Experience Cloud & External Access',
  'integrations': 'Integration & External Systems',
  'data-cloud': 'Data 360 / Data Cloud',
  'testing': 'Testing & Release Readiness',
  'observability': 'Observability & Audit',
  'devops': 'DevOps & ALM',
  'performance': 'Performance, Scalability & Limits',
  'compliance': 'Compliance, Privacy & Legal',
  'agent-design': 'Agent Design & Use Case Readiness',
  'prompt-engineering': 'Prompt Engineering & Grounding',
  'escalation': 'Escalation & Handoff Architecture',
  'middleware': 'Middleware & External API Readiness',
  'voice': 'Agentforce Voice Readiness',
  'mcp': 'MCP & External Tool Integration',
  'agent-script': 'Agent Script & Metadata',
  'finops': 'Licensing Model & FinOps'
};
