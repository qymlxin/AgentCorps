import { useEffect, useMemo, useState } from 'react';
import type { Approval, GitCommit, GitMutationResult, GitStatus, GatewayClient } from '../api.js';
import { errorMessage } from '../useDashboard.js';

function isApproval(result: GitMutationResult): result is Extract<GitMutationResult, { approval: Approval }> {
  return 'approval' in result;
}

export function GitPanel({ client, approvals, visible, onRefresh }: { client: GatewayClient; approvals: Approval[]; visible: boolean; onRefresh: () => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<{ approvalId: string; label: string; run: (approvalId: string) => Promise<GitMutationResult> } | null>(null);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [nextStatus, nextLog] = await Promise.all([client.gitStatus(), client.gitLog()]);
      setStatus(nextStatus); setCommits(nextLog.commits);
      const nextPath = selectedPath && nextStatus.entries.some((entry) => entry.path === selectedPath) ? selectedPath : nextStatus.entries[0]?.path ?? '';
      setSelectedPath(nextPath);
      setDiff((await client.gitDiff(nextPath || undefined)).diff);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (visible) void load();
  }, [client, visible]);

  useEffect(() => {
    if (!visible || !selectedPath) { setDiff(''); return; }
    const abort = new AbortController();
    void client.gitDiff(selectedPath, abort.signal).then((result) => { if (!abort.signal.aborted) setDiff(result.diff); }).catch((reason: unknown) => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [client, selectedPath, visible]);

  const selectedEntry = useMemo(() => status?.entries.find((entry) => entry.path === selectedPath), [status, selectedPath]);
  const pendingGitApprovals = approvals.filter((approval) => approval.status === 'pending' && approval.request.taskId === 'console-git');
  const mutate = async (operation: (approvalId?: string) => Promise<GitMutationResult>, label: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await operation();
      if (isApproval(result)) {
        setPendingOperation({ approvalId: result.approval.id, label, run: (approvalId) => operation(approvalId) });
        setNotice(`Approval ${result.approval.id} is waiting in the approval queue.`);
      } else { setNotice('Git operation completed.'); await load(); }
      onRefresh();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const stage = () => { if (selectedPath) void mutate((approvalId) => client.gitStage([selectedPath], 'console-git', approvalId), 'staging changes'); };
  const unstage = () => { if (selectedPath) void mutate((approvalId) => client.gitUnstage([selectedPath], 'console-git', approvalId), 'unstaging changes'); };
  const commit = (event: React.FormEvent) => { event.preventDefault(); const value = message.trim(); if (value) void mutate(async (approvalId) => { const result = await client.gitCommit(value, 'console-git', approvalId); if (!isApproval(result)) setMessage(''); return result; }, 'committing changes'); };

  useEffect(() => {
    if (!pendingOperation) return;
    const approval = approvals.find((candidate) => candidate.id === pendingOperation.approvalId);
    if (approval?.status === 'approved') {
      const operation = pendingOperation;
      setPendingOperation(null);
      setNotice(`Approval ${operation.approvalId} granted. Executing ${operation.label}…`);
      void mutate((approvalId) => operation.run(approvalId ?? operation.approvalId), operation.label);
    } else if (approval && ['denied', 'expired'].includes(approval.status)) {
      setPendingOperation(null);
      setNotice(`Approval ${approval.id} was ${approval.status}.`);
    }
  }, [approvals, pendingOperation]);

  return <section className="panel git-panel" aria-labelledby="git-title">
    <div className="panel-head"><div><div className="eyebrow">REPOSITORY CONTROL</div><h2 id="git-title">Git</h2></div><div className="git-head-actions"><span className="muted panel-hint">Writes are approval-gated</span><button className="text-button" onClick={() => void load()}>Refresh ↗</button></div></div>
    {error ? <div className="empty-state" role="alert">{error}</div> : loading && !status ? <div className="empty-state">Reading repository state…</div> : status ? <>
      <div className="git-summary"><div><span className="eyebrow">BRANCH</span><strong>{status.branch}</strong>{status.upstream && <small>↔ {status.upstream}</small>}</div><div><span className="eyebrow">CHANGES</span><strong>{status.entries.length}</strong></div><div><span className="eyebrow">PENDING</span><strong>{pendingGitApprovals.length}</strong></div></div>
      <div className="git-layout">
        <div className="git-files"><div className="eyebrow git-section-label">WORKTREE</div>{status.entries.length ? status.entries.map((entry) => <button className={`git-file ${entry.path === selectedPath ? 'active' : ''}`} key={`${entry.index}${entry.worktree}${entry.path}`} onClick={() => setSelectedPath(entry.path)}><code>{entry.index}{entry.worktree}</code><span>{entry.path}</span></button>) : <div className="empty-state">Working tree is clean.</div>}
          {selectedEntry && <div className="git-actions"><button className="secondary-button" disabled={busy} onClick={stage}>Stage selected</button><button className="secondary-button" disabled={busy} onClick={unstage}>Unstage selected</button></div>}
        </div>
        <div className="git-diff"><div className="eyebrow">DIFF {selectedPath && `· ${selectedPath}`}</div><pre>{diff || 'No unstaged diff for the selected path.'}</pre></div>
      </div>
      <form className="git-commit-form" onSubmit={commit}><label htmlFor="git-message" className="eyebrow">COMMIT MESSAGE</label><div><input id="git-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Describe the change" maxLength={500} /><button className="primary-button" disabled={busy || !message.trim()}>Commit staged changes →</button></div></form>
      {notice && <div className="git-notice" role="status">{notice}</div>}
      <div className="git-log"><div className="eyebrow git-section-label">RECENT COMMITS</div>{commits.map((commit) => <article className="git-commit" key={commit.hash}><code>{commit.hash.slice(0, 8)}</code><span>{commit.subject}</span><small>{commit.author} · {new Date(commit.committedAt).toLocaleString()}</small></article>)}</div>
    </> : null}
  </section>;
}
