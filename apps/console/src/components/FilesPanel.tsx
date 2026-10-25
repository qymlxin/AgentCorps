import { useEffect, useState } from 'react';
import type { FileContent, FileListing, GatewayClient } from '../api.js';

export function FilesPanel({ client, visible }: { client: GatewayClient; visible: boolean }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<FileListing | null>(null);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [error, setError] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    setError('');
    void client.files(path).then((value) => { if (!disposed) { setListing(value); setPreview(null); } }).catch((reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { disposed = true; };
  }, [client, path, visible, refreshNonce]);

  const openEntry = (entry: FileListing['entries'][number]) => {
    setError('');
    if (entry.kind === 'directory') { setPath(entry.path); return; }
    void client.fileContent(entry.path).then(setPreview).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return <section className="panel files-panel" aria-labelledby="files-title">
    <div className="panel-head"><div><div className="eyebrow">WORKSPACE BROWSER</div><h2 id="files-title">Files</h2></div><button className="text-button" onClick={() => setRefreshNonce((value) => value + 1)}>Refresh ↗</button></div>
    <div className="file-toolbar"><button className="text-button" disabled={!path} onClick={() => setPath(parent)}>← Up</button><code>/{path}</code></div>
    {error ? <div className="empty-state" role="alert">{error}</div> : <div className="file-layout">
      <div className="files-list">{listing?.truncated && <div className="form-note">Showing the first entries only.</div>}{listing?.entries.map((entry) => <button className="file-row" key={entry.path} onClick={() => openEntry(entry)}><span className="file-kind" aria-hidden="true">{entry.kind === 'directory' ? '▸' : '·'}</span><span>{entry.name}</span><small>{entry.kind === 'file' && entry.size !== undefined ? `${entry.size} B` : 'directory'}</small></button>)}{listing && !listing.entries.length && <div className="empty-state">This directory is empty.</div>}</div>
      <div className="file-preview">{preview ? <><div className="eyebrow">PREVIEW · {preview.path}</div><pre>{preview.content}</pre></> : <div className="empty-state">Select a text file to preview it.</div>}</div>
    </div>}
  </section>;
}
