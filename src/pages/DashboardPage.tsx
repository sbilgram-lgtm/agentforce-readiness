import React, { useState, useCallback } from 'react';
import { logout, fetchCategory } from '../services/api';
import { AutoCheck, CATEGORY_IDS, CATEGORY_LABELS, CategoryId, CategoryResult, Question } from '../types/assessment';
import { scoreCategory, computeOverallScore, buildRemediationBacklog, getApiFindings, getAutoChecks } from '../utils/scoring';
import { RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer, Tooltip } from 'recharts';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface Props { instanceUrl: string; onLogout: () => void; }

type ViewMode = 'dashboard' | 'category';

export default function DashboardPage({ instanceUrl, onLogout }: Props) {
  const [categories, setCategories] = useState<Partial<Record<CategoryId, CategoryResult>>>({});
  const [loading, setLoading] = useState<Partial<Record<CategoryId, boolean>>>({});
  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);
  const [view, setView] = useState<ViewMode>('dashboard');
  const [runningAll, setRunningAll] = useState(false);

  const runCategory = useCallback(async (id: CategoryId) => {
    setLoading(prev => ({ ...prev, [id]: true }));
    try {
      const data = await fetchCategory(id);
      const apiFindings = getApiFindings(data as Record<string, unknown>);
      const autoChecks = getAutoChecks(data as Record<string, unknown>);
      const existing = categories[id];
      const answers = existing?.answers || {};
      const { score, status, findings } = scoreCategory(data.questions || [], answers, apiFindings, autoChecks);
      setCategories(prev => ({
        ...prev,
        [id]: {
          category: CATEGORY_LABELS[id],
          score,
          status,
          findings,
          questions: data.questions || [],
          answers,
          apiData: data,
          note: data.note,
          autoChecks
        }
      }));
    } catch (err: any) {
      setCategories(prev => ({
        ...prev,
        [id]: {
          category: CATEGORY_LABELS[id],
          score: 0,
          status: 'red',
          findings: [err?.response?.data?.error || 'Failed to load category data'],
          questions: [],
          answers: {},
          apiData: {}
        }
      }));
    } finally {
      setLoading(prev => ({ ...prev, [id]: false }));
    }
  }, [categories]);

  const runAll = async () => {
    setRunningAll(true);
    for (const id of CATEGORY_IDS) {
      await runCategory(id);
    }
    setRunningAll(false);
  };

  const handleAnswerChange = (catId: CategoryId, qId: string, value: string | boolean | string[]) => {
    setCategories(prev => {
      const cat = prev[catId];
      if (!cat) return prev;
      const answers = { ...cat.answers, [qId]: value };
      const apiFindings = getApiFindings(cat.apiData || {});
      const autoChecks = cat.autoChecks || [];
      const { score, status, findings } = scoreCategory(cat.questions, answers, apiFindings, autoChecks);
      return { ...prev, [catId]: { ...cat, answers, score, status, findings } };
    });
  };

  const handleLogout = async () => {
    await logout();
    onLogout();
  };

  const allResults = CATEGORY_IDS.map(id => categories[id]).filter(Boolean) as CategoryResult[];
  const overallScore = computeOverallScore(allResults);
  const remediationBacklog = buildRemediationBacklog(allResults);

  const radarData = CATEGORY_IDS.map(id => ({
    subject: CATEGORY_LABELS[id].split(' ')[0],
    score: categories[id]?.score || 0
  }));

  const exportPDF = () => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    doc.setFontSize(18);
    doc.setTextColor(3, 45, 96);
    doc.text('Agentforce Readiness Assessment', 14, 20);
    doc.setFontSize(10);
    doc.setTextColor(90, 100, 115);
    doc.text(`Org: ${instanceUrl}`, 14, 28);
    doc.text(`Assessed: ${new Date().toLocaleString()}`, 14, 33);
    doc.setFontSize(14);
    doc.setTextColor(3, 45, 96);
    doc.text(`Overall Readiness Score: ${overallScore}%`, 14, 42);

    autoTable(doc, {
      startY: 50,
      head: [['Category', 'Score', 'Status', 'Key Findings']],
      body: allResults.map(r => [
        r.category,
        `${r.score}%`,
        r.status.toUpperCase(),
        r.findings.slice(0, 3).join('; ') || 'No issues found'
      ]),
      headStyles: { fillColor: [1, 118, 211] },
      alternateRowStyles: { fillColor: [243, 243, 243] },
      columnStyles: { 3: { cellWidth: 80 } }
    });

    if (remediationBacklog.length > 0) {
      const finalY = (doc as any).lastAutoTable.finalY + 10;
      doc.setFontSize(12);
      doc.setTextColor(3, 45, 96);
      doc.text('Remediation Backlog', 14, finalY);
      autoTable(doc, {
        startY: finalY + 4,
        head: [['Finding']],
        body: remediationBacklog.map(f => [f]),
        headStyles: { fillColor: [194, 57, 52] }
      });
    }

    doc.save(`agentforce-readiness-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  if (view === 'category' && activeCategory) {
    const cat = categories[activeCategory];
    return (
      <CategoryView
        id={activeCategory}
        result={cat}
        loading={!!loading[activeCategory]}
        onRun={() => runCategory(activeCategory)}
        onAnswer={(qId, val) => handleAnswerChange(activeCategory, qId, val)}
        onBack={() => setView('dashboard')}
      />
    );
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>⚡ Agentforce Readiness Assessment</h1>
          <p style={styles.subtitle}>{instanceUrl}</p>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {allResults.length > 0 && (
            <button style={styles.exportBtn} onClick={exportPDF}>Export PDF</button>
          )}
          <button style={styles.runAllBtn} onClick={runAll} disabled={runningAll}>
            {runningAll ? 'Running…' : 'Run All Categories'}
          </button>
          <button style={styles.logoutBtn} onClick={handleLogout}>Logout</button>
        </div>
      </header>

      {overallScore > 0 && (
        <div style={styles.scoreBar}>
          <div style={styles.scoreCircle}>
            <span style={{ fontSize: 32, fontWeight: 700, color: scoreColor(overallScore) }}>{overallScore}%</span>
            <span style={{ fontSize: 12, color: '#5a6472' }}>Overall Readiness</span>
          </div>
          <div style={{ flex: 1 }}>
            <ResponsiveContainer width="100%" height={220}>
              <RadarChart data={radarData}>
                <PolarGrid />
                <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10 }} />
                <Radar dataKey="score" fill="#0176d3" fillOpacity={0.3} stroke="#0176d3" />
                <Tooltip />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div style={styles.grid}>
        {CATEGORY_IDS.map((id, i) => {
          const cat = categories[id];
          const isLoading = !!loading[id];
          return (
            <div key={id} style={{ ...styles.card, borderTop: `4px solid ${cat ? statusColor(cat.status) : '#c9c9c9'}` }}>
              <div style={styles.cardHeader}>
                <span style={styles.cardNum}>{i + 1}</span>
                <span style={styles.cardLabel}>{CATEGORY_LABELS[id]}</span>
              </div>
              {cat ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' }}>
                    <div style={{ ...styles.badge, background: statusColor(cat.status) }}>
                      {cat.status.toUpperCase()}
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 20 }}>{cat.score}%</span>
                  </div>
                  {cat.findings.length > 0 && (
                    <ul style={styles.findingsList}>
                      {cat.findings.slice(0, 2).map((f, fi) => <li key={fi} style={styles.finding}>{f}</li>)}
                      {cat.findings.length > 2 && <li style={styles.finding}>+{cat.findings.length - 2} more…</li>}
                    </ul>
                  )}
                </>
              ) : (
                <p style={{ color: '#888', fontSize: 13, margin: '8px 0' }}>Not yet assessed</p>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 12 }}>
                <button
                  style={isLoading ? { ...styles.runBtn, opacity: 0.6 } : styles.runBtn}
                  onClick={() => runCategory(id)}
                  disabled={isLoading}
                >
                  {isLoading ? 'Running…' : cat ? 'Re-run' : 'Run'}
                </button>
                {cat && (
                  <button style={styles.detailBtn} onClick={() => { setActiveCategory(id); setView('category'); }}>
                    Details
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {remediationBacklog.length > 0 && (
        <div style={styles.backlog}>
          <h2 style={{ color: '#032d60', marginBottom: 12 }}>Remediation Backlog ({remediationBacklog.length} items)</h2>
          <ul>
            {remediationBacklog.map((item, i) => (
              <li key={i} style={styles.backlogItem}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Category Detail View ─────────────────────────────────────────────────────
interface CategoryViewProps {
  id: CategoryId;
  result?: CategoryResult;
  loading: boolean;
  onRun: () => void;
  onAnswer: (qId: string, val: string | boolean | string[]) => void;
  onBack: () => void;
}

function CategoryView({ id, result, loading, onRun, onAnswer, onBack }: CategoryViewProps) {
  const autoChecks: AutoCheck[] = result?.autoChecks || [];
  return (
    <div style={styles.page}>
      <div style={{ padding: '24px 32px', maxWidth: 800, margin: '0 auto' }}>
        <button style={styles.backBtn} onClick={onBack}>← Back to Dashboard</button>
        <h2 style={{ color: '#032d60', marginBottom: 8 }}>{CATEGORY_LABELS[id]}</h2>
        {result?.note && <p style={{ color: '#5a6472', marginBottom: 16 }}>{result.note}</p>}
        {result && (
          <div style={{ display: 'flex', gap: 16, marginBottom: 24, alignItems: 'center' }}>
            <div style={{ ...styles.badge, background: statusColor(result.status), fontSize: 14, padding: '6px 14px' }}>
              {result.status.toUpperCase()}
            </div>
            <span style={{ fontWeight: 700, fontSize: 24 }}>{result.score}%</span>
          </div>
        )}

        {autoChecks.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 10, padding: 24, marginBottom: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
            <h3 style={{ marginBottom: 16, color: '#032d60' }}>Auto-Checks</h3>
            {autoChecks.map(ac => (
              <div key={ac.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
                <span style={{ fontSize: 16, flexShrink: 0, color: ac.passed ? '#2e844a' : '#c23934', fontWeight: 700 }}>
                  {ac.passed ? '✓' : '✗'}
                </span>
                <div>
                  <span style={{ fontSize: 14, color: '#032d60' }}>{ac.label}</span>
                  {!ac.passed && ac.finding && (
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: '#c23934' }}>{ac.finding}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {result?.questions && result.questions.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 10, padding: 24, marginBottom: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
            <h3 style={{ marginBottom: 16, color: '#032d60' }}>Assessment Questions</h3>
            {result.questions.map(q => (
              <QuestionRow key={q.id} question={q} answer={result.answers[q.id]} onChange={v => onAnswer(q.id, v)} />
            ))}
          </div>
        )}

        {result?.findings && result.findings.length > 0 && (
          <div style={{ background: '#fff', borderRadius: 10, padding: 24, marginBottom: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
            <h3 style={{ marginBottom: 12, color: '#c23934' }}>Findings</h3>
            <ul>
              {result.findings.map((f, i) => <li key={i} style={{ marginBottom: 6, color: '#3e3e3c' }}>{f}</li>)}
            </ul>
          </div>
        )}

        <button
          style={loading ? { ...styles.runBtn, opacity: 0.6, fontSize: 15, padding: '10px 24px' } : { ...styles.runBtn, fontSize: 15, padding: '10px 24px' }}
          onClick={onRun}
          disabled={loading}
        >
          {loading ? 'Running…' : result ? 'Re-run Category' : 'Run Category'}
        </button>
      </div>
    </div>
  );
}

function QuestionRow({ question, answer, onChange }: { question: Question; answer: any; onChange: (v: any) => void }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <p style={{ fontWeight: 500, marginBottom: 8 }}>{question.text}</p>
      {question.type === 'boolean' && (
        <div style={{ display: 'flex', gap: 12 }}>
          {['Yes', 'No'].map(opt => (
            <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                name={question.id}
                value={opt.toLowerCase()}
                checked={answer === (opt === 'Yes')}
                onChange={() => onChange(opt === 'Yes')}
              />
              {opt}
            </label>
          ))}
        </div>
      )}
      {question.type === 'select' && question.options && (
        <select
          value={answer || ''}
          onChange={e => onChange(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #c9c9c9', fontSize: 14 }}
        >
          <option value="">Select…</option>
          {question.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
      {question.type === 'multiselect' && question.options && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {question.options.map(o => {
            const checked = Array.isArray(answer) && answer.includes(o);
            return (
              <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', background: checked ? '#e8f4fd' : '#f3f3f3', padding: '4px 10px', borderRadius: 20, border: `1px solid ${checked ? '#0176d3' : '#c9c9c9'}` }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const prev = Array.isArray(answer) ? answer : [];
                    onChange(checked ? prev.filter((x: string) => x !== o) : [...prev, o]);
                  }}
                  style={{ display: 'none' }}
                />
                {o}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function statusColor(status: string) {
  return status === 'green' ? '#2e844a' : status === 'amber' ? '#e07b00' : status === 'red' ? '#c23934' : '#8e8e8e';
}

function scoreColor(score: number) {
  return score >= 80 ? '#2e844a' : score >= 50 ? '#e07b00' : '#c23934';
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#f3f3f3', paddingBottom: 60 },
  header: { background: '#032d60', color: '#fff', padding: '20px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  title: { fontSize: 20, fontWeight: 700, margin: 0 },
  subtitle: { fontSize: 12, opacity: 0.75, marginTop: 2 },
  scoreBar: { background: '#fff', margin: '24px 32px 0', borderRadius: 12, padding: '20px 32px', display: 'flex', alignItems: 'center', gap: 32, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  scoreCircle: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 100 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20, padding: '24px 32px', maxWidth: 1400 },
  card: { background: '#fff', borderRadius: 10, padding: 20, boxShadow: '0 2px 8px rgba(0,0,0,0.06)', display: 'flex', flexDirection: 'column', minHeight: 160 },
  cardHeader: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  cardNum: { background: '#e8f4fd', color: '#0176d3', borderRadius: '50%', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 2 },
  cardLabel: { fontWeight: 600, fontSize: 14, color: '#032d60', lineHeight: 1.4 },
  badge: { color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700 },
  findingsList: { listStyle: 'none', margin: '4px 0', padding: 0 },
  finding: { fontSize: 12, color: '#c23934', marginBottom: 2, paddingLeft: 12, position: 'relative' },
  runBtn: { background: '#0176d3', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  runAllBtn: { background: '#0176d3', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  detailBtn: { background: '#f3f3f3', color: '#032d60', border: '1px solid #c9c9c9', borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  exportBtn: { background: '#2e844a', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  logoutBtn: { background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', borderRadius: 6, padding: '10px 20px', fontSize: 14, cursor: 'pointer' },
  backlog: { margin: '0 32px', background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  backlogItem: { color: '#3e3e3c', marginBottom: 6, fontSize: 13, paddingLeft: 16, listStyle: 'disc' },
  backBtn: { background: 'none', border: 'none', color: '#0176d3', cursor: 'pointer', fontSize: 14, marginBottom: 16, padding: 0 }
};
