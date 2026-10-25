import { useEffect, useState, type FormEvent } from 'react';
import type { Approval, GitApprovalResult, GatewayClient, TerminalResult } from '../api.js';
import { errorMessage } from '../useDashboard.js';

function isApproval(result: TerminalResult | GitApprovalResult): result is GitApprovalResult { return 'approval' in result; }

export function TerminalPanel({ client, approvals, visible, onRefresh }: { client: GatewayClient; approvals: Approval[]; visible: boolean; onRefresh: () => void }) {
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('[]');
  const [result, setResult] = useState<TerminalResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ id: string; run: (approvalId: string) => Promise<TerminalResult | GitApprovalResult> } | null>(null);

  const run = async (operation: (approvalId?: string) => Promise<TerminalResult | GitApprovalResult>) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await operation();
      if (isApproval(next)) {
        setPending({ id: next.approval.id, run: (approvalId) => operation(approvalId) });
        setNotice(`Approval ${next.approval.id} is waiting in the approval queue.`);
      } else { setResult(next); setNotice('Command completed.'); onRefresh(); }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!pending) return;
    const approval = approvals.find((candidate) => candidate.id === pending.id);
    if (approval?.status === 'approved') {
      const operation = pending;
      setPending(null);
      void run((approvalId) => operation.run(approvalId ?? operation.id));
    } else if (approval && ['denied', 'expired'].includes(approval.status)) {
      setPending(null); setNotice(`Approval ${approval.id} was ${approval.status}.`);
    }
  }, [approvals, pending]);

  if (!visible) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    let parsed: string[];
    try {
      const value: unknown = JSON.parse(args);
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error('Arguments must be a JSON string array.');
      parsed = value;
    } catch (reason) { setError(errorMessage(reason)); return; }
    if (!command.trim()) { setError('Enter a command.'); return; }
    void run((approvalId) => client.terminalExec(command.trim(), parsed, 'console-terminal', approvalId));
  };

  return <section className="panel terminal-panel" aria-labelledby="terminal-title">
    <div className="panel-head"><div><div className="eyebrow">CONTROLLED EXECUTION</div><h2 id="terminal-title">Terminal</h2></div><span className="muted panel-hint">No shell interpolation · approval-gated</span></div>
    <form className="terminal-form" onSubmit={submit}><label htmlFor="terminal-command">COMMAND<input id="terminal-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="node" /></label><label htmlFor="terminal-args">ARGUMENTS <small>JSON string array</small><input id="terminal-args" value={args} onChange={(event) => setArgs(event.target.value)} placeholder='["--version"]' /></label><button className="primary-button" disabled={busy}>Run command →</button></form>
    {error && <div className="empty-state" role="alert">{error}</div>}
    {notice && <div className="git-notice" role="status">{notice}</div>}
    {result && <div className="terminal-result"><div className="terminal-meta"><span>{result.exitCode === 0 ? 'EXIT 0' : `EXIT ${result.exitCode ?? 'unknown'}`}</span><span>{result.cwd}</span>{result.timedOut && <span className="deny-button">TIMED OUT</span>}</div><pre>{result.stdout || result.stderr || '(no output)'}</pre>{result.stdout && result.stderr && <details><summary>stderr</summary><pre>{result.stderr}</pre></details>}</div>}
  </section>;
}
