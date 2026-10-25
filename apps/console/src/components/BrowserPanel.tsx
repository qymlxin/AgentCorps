import { useEffect, useState } from 'react';
import type { Approval, BrowserScreenshot, BrowserSnapshot, BrowserTab, GatewayClient, GitApprovalResult } from '../api.js';
import { errorMessage } from '../useDashboard.js';

type BrowserResult = { result: unknown } | GitApprovalResult;
function isApproval(result: BrowserResult): result is GitApprovalResult { return 'approval' in result; }

export function BrowserPanel({ client, approvals, visible, onRefresh }: { client: GatewayClient; approvals: Approval[]; visible: boolean; onRefresh: () => void }) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [tabId, setTabId] = useState('');
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const [screenshot, setScreenshot] = useState<BrowserScreenshot | null>(null);
  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('');
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ approvalId: string; label: string; run: (approvalId: string) => Promise<BrowserResult> } | null>(null);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const result = await client.browserTabs();
      setTabs(result.tabs);
      const nextTab = result.tabs.some((tab) => tab.id === tabId) ? tabId : result.tabs[0]?.id ?? '';
      setTabId(nextTab);
      if (nextTab) {
        const detail = await client.browserSnapshot(nextTab);
        setSnapshot(detail.snapshot); setUrl(detail.snapshot.url);
      } else { setSnapshot(null); setScreenshot(null); }
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (visible) void load(); }, [client, visible]);
  useEffect(() => {
    if (!visible || !tabId) return;
    const abort = new AbortController();
    void client.browserSnapshot(tabId, abort.signal).then((result) => { if (!abort.signal.aborted) { setSnapshot(result.snapshot); setUrl(result.snapshot.url); } }).catch((reason: unknown) => { if (!abort.signal.aborted) setError(errorMessage(reason)); });
    return () => abort.abort();
  }, [client, tabId, visible]);

  const run = async (operation: (approvalId?: string) => Promise<BrowserResult>, label: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await operation();
      if (isApproval(result)) {
        setPending({ approvalId: result.approval.id, label, run: (approvalId) => operation(approvalId) });
        setNotice(`Approval ${result.approval.id} is waiting in the approval queue.`);
      } else { setNotice(`Browser ${label} completed.`); await load(); }
      onRefresh();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!pending) return;
    const approval = approvals.find((candidate) => candidate.id === pending.approvalId);
    if (approval?.status === 'approved') {
      const operation = pending; setPending(null); setNotice(`Approval ${operation.approvalId} granted. Executing ${operation.label}…`);
      void run((approvalId) => operation.run(approvalId ?? operation.approvalId), operation.label);
    } else if (approval && ['denied', 'expired'].includes(approval.status)) {
      setPending(null); setNotice(`Approval ${approval.id} was ${approval.status}.`);
    }
  }, [approvals, pending]);

  const refreshSnapshot = async () => {
    if (!tabId) return;
    try { const result = await client.browserSnapshot(tabId); setSnapshot(result.snapshot); setUrl(result.snapshot.url); } catch (reason) { setError(errorMessage(reason)); }
  };
  const navigate = (event: React.FormEvent) => { event.preventDefault(); if (tabId && url.trim()) void run((approvalId) => client.browserNavigate(tabId, url.trim(), 'console-browser', approvalId), 'navigation'); };
  const click = () => { if (tabId && selector.trim()) void run((approvalId) => client.browserClick(tabId, selector.trim(), 'console-browser', approvalId), 'click'); };
  const fill = () => { if (tabId && selector.trim()) void run((approvalId) => client.browserFill(tabId, selector.trim(), text, 'console-browser', approvalId), 'form fill'); };
  const capture = async () => { if (!tabId) return; try { setScreenshot((await client.browserScreenshot(tabId)).screenshot); } catch (reason) { setError(errorMessage(reason)); } };

  return <section className="panel browser-panel" aria-labelledby="browser-title">
    <div className="panel-head"><div><div className="eyebrow">CONTROLLED BROWSER</div><h2 id="browser-title">Browser</h2></div><button className="text-button" onClick={() => void load()}>Refresh ↗</button></div>
    {error ? <div className="empty-state" role="alert">{error}</div> : loading && !tabs.length ? <div className="empty-state">Reading browser tabs…</div> : <>
      <div className="browser-tabs" aria-label="Browser tabs">{tabs.length ? tabs.map((tab) => <button key={tab.id} className={`browser-tab ${tab.id === tabId ? 'active' : ''}`} onClick={() => setTabId(tab.id)}><strong>{tab.title || 'Untitled'}</strong><small>{tab.url}</small></button>) : <div className="empty-state">No controllable browser tabs are connected.</div>}</div>
      {tabId && <>
        <form className="browser-url" onSubmit={navigate}><label htmlFor="browser-url-input" className="eyebrow">ADDRESS</label><div><input id="browser-url-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" /><button className="primary-button" disabled={busy || !url.trim()}>Navigate →</button></div></form>
        <div className="browser-controls"><label><span className="eyebrow">SELECTOR</span><input aria-label="Selector" value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="#submit or input[name=email]" /></label><label><span className="eyebrow">TEXT FOR FILL</span><input aria-label="Text for fill" value={text} onChange={(event) => setText(event.target.value)} placeholder="Optional input text" /></label><div className="browser-actions"><button className="secondary-button" disabled={busy || !selector.trim()} onClick={click}>Click selected</button><button className="secondary-button" disabled={busy || !selector.trim()} onClick={fill}>Fill selected</button><button className="text-button" onClick={() => void refreshSnapshot()}>Refresh page text ↗</button><button className="text-button" onClick={() => void capture()}>Capture PNG ↗</button></div></div>
        {notice && <div className="git-notice" role="status">{notice}</div>}
        <div className="browser-output"><div><div className="eyebrow">PAGE TEXT · {snapshot?.title || 'Untitled'}</div><pre>{snapshot?.text || 'No page text available.'}</pre></div>{screenshot && <div><div className="eyebrow">SCREENSHOT</div><img className="browser-screenshot" src={`data:${screenshot.mimeType};base64,${screenshot.data}`} alt="Current browser page" /></div>}</div>
      </>}
    </>}
  </section>;
}
