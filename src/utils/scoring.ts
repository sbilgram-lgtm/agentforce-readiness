import { AutoCheck, CategoryResult, Question } from '../types/assessment';

export function scoreFromAutoChecks(autoChecks: AutoCheck[]): { score: number; status: 'green' | 'amber' | 'red'; findings: string[] } {
  const passed = autoChecks.filter(c => c.passed).length;
  const score = Math.round((passed / autoChecks.length) * 100);
  const status: 'green' | 'amber' | 'red' = score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red';
  const findings = autoChecks.filter(c => !c.passed && c.finding).map(c => c.finding!);
  return { score, status, findings };
}

// Score a category based on answered boolean/select questions.
// If autoChecks.length >= 3, score is computed purely from autoChecks.
// If autoChecks.length 1-2, manual scoring is used but autoCheck findings are prepended.
// Manual categories without answers score 0 until questions are answered.
export function scoreCategory(
  questions: Question[],
  answers: Record<string, string | string[] | boolean>,
  apiFindings: string[] = [],
  autoChecks: AutoCheck[] = []
): { score: number; status: 'green' | 'amber' | 'red' | 'manual'; findings: string[] } {
  if (autoChecks.length >= 3) {
    return scoreFromAutoChecks(autoChecks);
  }

  const autoCheckFindings = autoChecks.filter(c => !c.passed && c.finding).map(c => c.finding!);
  const allFindings = [...autoCheckFindings, ...apiFindings];

  const boolQuestions = questions.filter(q => q.type === 'boolean');
  if (boolQuestions.length === 0) return { score: 0, status: 'manual', findings: allFindings };

  const answered = boolQuestions.filter(q => answers[q.id] !== undefined);
  if (answered.length === 0) return { score: 0, status: 'manual', findings: allFindings };

  const yesCount = answered.filter(q => answers[q.id] === true || answers[q.id] === 'true' || answers[q.id] === 'yes').length;
  const score = Math.round((yesCount / boolQuestions.length) * 100);

  const status: 'green' | 'amber' | 'red' =
    score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red';

  const findings = [
    ...allFindings,
    ...boolQuestions
      .filter(q => answers[q.id] === false || answers[q.id] === 'false' || answers[q.id] === 'no')
      .map(q => `Not confirmed: ${q.text}`)
  ];

  return { score, status, findings };
}

export function computeOverallScore(categories: CategoryResult[]): number {
  const scored = categories.filter(c => c.status !== 'manual' && c.score > 0);
  if (scored.length === 0) return 0;
  return Math.round(scored.reduce((sum, c) => sum + c.score, 0) / scored.length);
}

export function buildRemediationBacklog(categories: CategoryResult[]): string[] {
  return categories
    .filter(c => c.status === 'red' || c.status === 'amber')
    .flatMap(c => c.findings.map(f => `[${c.category}] ${f}`));
}

export function getApiFindings(data: Record<string, unknown>): string[] {
  const findings: string[] = [];

  if (typeof data.insecureRemoteSitesCount === 'number' && data.insecureRemoteSitesCount > 0)
    findings.push(`${data.insecureRemoteSitesCount} remote site(s) using HTTP (not HTTPS)`);

  if (typeof data.outdatedApexCount === 'number' && data.outdatedApexCount > 0)
    findings.push(`${data.outdatedApexCount} Apex class(es) on outdated API versions (<v50)`);

  if (typeof data.orgWideApexCoverage === 'number' && data.orgWideApexCoverage < 75)
    findings.push(`Org-wide Apex test coverage is ${data.orgWideApexCoverage}% (below 75% threshold)`);

  if (Array.isArray(data.limitsFlags)) {
    (data.limitsFlags as Array<{ label: string; percentUsed: number; flagged: boolean }>)
      .filter(f => f.flagged)
      .forEach(f => findings.push(`${f.label} is at ${f.percentUsed}% capacity`));
  }

  return findings;
}

export function getAutoChecks(data: Record<string, unknown>): AutoCheck[] {
  if (Array.isArray(data.autoChecks)) {
    return data.autoChecks as AutoCheck[];
  }
  return [];
}
