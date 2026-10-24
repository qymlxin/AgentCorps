import { createHash, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type DependencySource = 'registry' | 'git' | 'file' | 'http' | 'workspace' | 'tag' | 'unknown';

export interface DependencyAuditFinding {
  readonly name: string;
  readonly specification: string;
  readonly source: DependencySource;
  readonly severity: 'warning' | 'error';
  readonly reason: string;
}

export function classifyDependencySource(specification: string): DependencySource {
  const value = specification.trim();
  if (/^(workspace:|link:)/.test(value)) return 'workspace';
  if (/^(file:|\.{0,2}\/|\/)/.test(value)) return 'file';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:\/\/.*(?:\.git|\/archive\/|\/tarball\/)|ssh:)/.test(value)) return 'git';
  if (/^https?:\/\//.test(value)) return 'http';
  if (/^(latest|next|beta|canary|dev|alpha|rc|\*|[A-Za-z][A-Za-z0-9_-]*)$/.test(value)) return 'tag';
  if (/^[~^<>=*]|\s|\|/.test(value)) return 'registry';
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) return 'registry';
  return 'unknown';
}

export function auditDependencySpecs(packageJson: Record<string, unknown>, fileName = 'package.json'): readonly DependencyAuditFinding[] {
  const findings: DependencyAuditFinding[] = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const values = packageJson[section];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [name, specificationValue] of Object.entries(values as Record<string, unknown>)) {
      if (typeof specificationValue !== 'string') {
        findings.push({ name, specification: String(specificationValue), source: 'unknown', severity: 'error', reason: `${fileName} ${section} entry is not a string` });
        continue;
      }
      const source = classifyDependencySource(specificationValue);
      if (source !== 'registry') findings.push({ name, specification: specificationValue, source, severity: source === 'tag' || source === 'unknown' ? 'error' : 'warning', reason: source === 'tag' ? 'Floating dependency tags are not reproducible' : `Dependency is sourced from ${source}, so registry provenance must be reviewed` });
    }
  }
  return findings;
}

export interface SignedArtifact {
  readonly name: string;
  readonly version: string;
  readonly content: string | Uint8Array;
  readonly sha256: string;
  readonly signature: string;
  readonly publicKey: string | KeyObject;
  readonly algorithm?: 'ed25519';
}

export interface VerifiedArtifact {
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
}

/** Verifies both content integrity and an Ed25519 publisher signature. */
export function verifySignedArtifact(artifact: SignedArtifact): VerifiedArtifact {
  const bytes = typeof artifact.content === 'string' ? Buffer.from(artifact.content, 'utf8') : Buffer.from(artifact.content);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.sha256.toLowerCase()) throw new Error(`Artifact digest mismatch for ${artifact.name}@${artifact.version}`);
  if (artifact.algorithm && artifact.algorithm !== 'ed25519') throw new Error(`Unsupported artifact signature algorithm: ${artifact.algorithm}`);
  const valid = verify(null, bytes, artifact.publicKey, Buffer.from(artifact.signature, 'base64url'));
  if (!valid) throw new Error(`Artifact signature is invalid for ${artifact.name}@${artifact.version}`);
  return { name: artifact.name, version: artifact.version, sha256: digest };
}

export function readAndVerifySignedArtifact(path: string, metadata: Omit<SignedArtifact, 'content'>): VerifiedArtifact {
  return verifySignedArtifact({ ...metadata, content: readFileSync(path) });
}
