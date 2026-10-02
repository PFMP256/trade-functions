import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { PublicEvidence } from '../../../packages/data-providers/src/kraken-fx';
import { hash,jsonValue } from './audit-store';

function object(value:unknown):Record<string,unknown>|null {
  return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
}

/** Retrieval metadata can change without changing the source's semantic revision. */
function semantic(value:unknown):unknown {
  if(Array.isArray(value))return value.map(semantic);
  const row=object(value);if(!row)return value;
  return Object.fromEntries(Object.entries(row).filter(([key])=>key!=='releasedAtUtc').map(([key,item])=>{
    const p=key==='provenance'?object(item):null;
    if(!p)return [key,semantic(item)];
    const ignored=new Set(['firstSeenAt','availableAt','fetchedAt','evidenceSha256']);
    if(p.sourceId==='bls-public-calendar'||p.sourceId==='bls-public-employment')ignored.add('observedAt');
    return [key,Object.fromEntries(Object.entries(p).filter(([field])=>!ignored.has(field)))];
  }));
}

function preserveAvailability(fresh:unknown,original:unknown):void {
  const f=object(fresh);const p=object(original);if(!f||!p)return;
  if(typeof p.releasedAtUtc==='string')f.releasedAtUtc=p.releasedAtUtc;
  const fp=object(f.provenance);const pp=object(p.provenance);
  if(fp&&pp){
    fp.firstSeenAt=pp.firstSeenAt;fp.availableAt=pp.availableAt;
    if(fp.sourceId==='bls-public-employment')fp.observedAt=pp.observedAt;
  }
  for(const key of Object.keys(f).filter(key=>key!=='provenance'))preserveAvailability(f[key],p[key]);
}

function preserveEventRelease(fresh:unknown,previous:unknown):void {
  const f=object(fresh);const p=object(previous);if(!f||!p)return;
  const fp=object(f.provenance);const pp=object(p.provenance);
  if(fp?.sourceId==='bls-public-employment'&&pp?.sourceId===fp.sourceId&&pp.sourceUrl===fp.sourceUrl&&
    f.eventId===p.eventId&&f.period===p.period&&typeof p.releasedAtUtc==='string'&&typeof f.releasedAtUtc==='string'&&
    Date.parse(p.releasedAtUtc)<Date.parse(f.releasedAtUtc))f.releasedAtUtc=p.releasedAtUtc;
}

/** Archives source responses and semantic revisions; no network access inside Firestore transactions. */
export class PublicDataStore {
  constructor(private readonly db:Firestore) {}
  async previous<T>(key:string):Promise<T|null> {return ((await this.db.collection('publicData').doc(hash(key)).get()).data()?.data as T|undefined) ?? null;}
  async record<T extends {provenance:{revision:string;fetchedAt:string;firstSeenAt:string;availableAt:string}}>(key:string,data:T,evidence:PublicEvidence[]):Promise<T> {
    for (const item of evidence) if (createHash('sha256').update(item.content).digest('hex')!==item.sha256) throw new Error('PUBLIC_EVIDENCE_HASH_MISMATCH');
    const unique=[...new Map(evidence.map(item=>[item.sha256,item])).values()];
    const hashes=new Set(unique.map(item=>item.sha256));
    const checkEvidence=(value:unknown):void=>{
      if(Array.isArray(value)){value.forEach(checkEvidence);return;}
      const row=object(value);if(!row)return;
      if('provenance' in row){
        const p=object(row.provenance);
        if(typeof p?.evidenceSha256!=='string'||!hashes.has(p.evidenceSha256))throw new Error('PUBLIC_SOURCE_EVIDENCE_MISSING');
      }
      for(const [field,item] of Object.entries(row))if(field!=='provenance')checkEvidence(item);
    };
    checkEvidence(data);
    const root=this.db.collection('publicData').doc(hash(key));
    const version=root.collection('revisions').doc(hash(data.provenance.revision));
    const refs=unique.map(e=>this.db.collection('sourceEvidence').doc(e.sha256));
    return this.db.runTransaction(async tx=>{
      const [current,old,...proofs]=await Promise.all([tx.get(root),tx.get(version),...refs.map(ref=>tx.get(ref))]);
      const canonical=jsonValue(data);
      const prior=old.data()?.data as T|undefined;
      if (prior) {
        if(hash(semantic(canonical))!==hash(semantic(prior)))throw new Error('PUBLIC_REVISION_CONFLICT');
        preserveAvailability(canonical,prior);
      }
      const previous=current.data()?.data as T|undefined;
      preserveEventRelease(canonical,previous);
      if(!old.exists)tx.create(version,{key,data:canonical});
      const newer=!previous||Date.parse(data.provenance.fetchedAt)>=Date.parse(previous.provenance.fetchedAt);
      if(newer)tx.set(root,{key,data:canonical});
      refs.forEach((ref,i)=>{if(!proofs[i]!.exists)tx.create(ref,{sha256:unique[i]!.sha256,content:unique[i]!.content,receivedAt:data.provenance.fetchedAt,source:'public-provider'});});
      // A slower request cannot expose a revision already superseded in the durable archive.
      return newer?canonical:jsonValue(previous!);
    });
  }
}
