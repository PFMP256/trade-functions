import { createHash } from 'node:crypto';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { validateStructuredFeed, type AllowedSource, type StructuredFeed } from '../../../packages/data-providers/src';
import { hash, jsonValue } from './audit-store';

export const ingestEnvelopeSchema = z.object({
  feed:z.unknown(), evidence:z.array(z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),content:z.string().min(1).max(300_000)}).strict()).max(50),
}).strict();
export class FeedStore {
  constructor(private readonly db: Firestore, private readonly environment: 'testnet'|'mainnet') {}
  private head() { return this.db.collection('structuredFeeds').doc(this.environment); }
  async latest(asOf: string): Promise<StructuredFeed | undefined> {
    const versions = await this.head().collection('versions').where('receivedAt','<=',asOf).orderBy('receivedAt','desc').orderBy(FieldPath.documentId(),'desc').limit(1).get();
    return versions.docs[0]?.data().feed as StructuredFeed | undefined;
  }
  async ingest(input: unknown, receivedAt: string, allowedSources: AllowedSource[], ingestorEmail: string): Promise<{versionId:string; location:string}> {
    const envelope = ingestEnvelopeSchema.parse(input);
    const evidence = new Map(envelope.evidence.map(e => {
      if (createHash('sha256').update(e.content).digest('hex') !== e.sha256) throw new Error('EVIDENCE_HASH_MISMATCH');
      return [e.sha256,e.content];
    }));
    return this.db.runTransaction(async tx => {
      const current = await tx.get(this.head());
      const old = current.data();
      if (old && String(old.receivedAt) > receivedAt) throw new Error('INGESTION_OUT_OF_ORDER');
      const feed = validateStructuredFeed(envelope.feed,{receivedAt,allowedSources,previous:old?.feed as StructuredFeed | undefined});
      const hashes = new Set<string>();
      function walk(v: unknown): void {
        if (!v || typeof v !== 'object') return;
        if ('evidenceSha256' in v && typeof v.evidenceSha256 === 'string') hashes.add(v.evidenceSha256);
        for (const child of Object.values(v)) walk(child);
      }
      walk(feed);
      const refs = [...hashes].map(h => this.db.collection('sourceEvidence').doc(h));
      const existing = refs.length ? await tx.getAll(...refs) : [];
      for (const [i, ref] of refs.entries()) {
        if (!existing[i]?.exists && !evidence.has(ref.id)) throw new Error('SOURCE_EVIDENCE_MISSING');
      }
      const versionId = hash({feed,receivedAt});
      const ref = this.head().collection('versions').doc(versionId);
      const record = jsonValue({versionId,receivedAt,ingestorEmail,feed});
      const already = await tx.get(ref);
      if (!already.exists) tx.create(ref,record);
      refs.forEach((ref,i) => { if (!existing[i]?.exists) tx.create(ref,{sha256:ref.id,content:evidence.get(ref.id),receivedAt,ingestorEmail}); });
      tx.set(this.head(),record);
      return {versionId,location:ref.path};
    });
  }
}
