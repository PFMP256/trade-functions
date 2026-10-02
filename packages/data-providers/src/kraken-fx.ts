import { createHash } from 'node:crypto';
import { z } from 'zod';
import { numericDatumSchema, positiveDecimalSchema, type NumericDatum } from '../../shared/src';
import { ProviderError, PublicJsonHttpClient, type PublicHttpOptions } from './http';

export const KRAKEN_USDT_USD_URL='https://api.kraken.com/0/public/Trades?pair=USDTUSD&count=1';
const tradeSchema=z.tuple([positiveDecimalSchema,positiveDecimalSchema,z.number().positive(),z.enum(['b','s']),z.enum(['m','l']),z.string(),z.number().int().safe().nonnegative()]);
const responseSchema=z.object({error:z.array(z.string()),result:z.object({USDTZUSD:z.array(tradeSchema).min(1),last:z.string()}).strict()});
export interface PublicEvidence {sha256:string;content:string}
/** FX reference from an actually observed USDT/USD spot trade, never an assumed peg. */
export class KrakenFxProvider {
  private readonly http:PublicJsonHttpClient;
  private readonly now:()=>Date;
  constructor(options:PublicHttpOptions & {now?:()=>Date}={}) {this.http=new PublicJsonHttpClient(options);this.now=options.now ?? (()=>new Date());}
  async getUsdPerUsdt(previous?:NumericDatum|null):Promise<{data:NumericDatum;evidence:PublicEvidence[]}> {
    const raw=await this.http.get(KRAKEN_USDT_USD_URL);
    const parsed=responseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.error.length) throw new ProviderError('KRAKEN_FX_INVALID_RESPONSE');
    const trade=[...parsed.data.result.USDTZUSD].sort((a,b)=>b[2]-a[2])[0]!;
    const fetchedAt=this.now().toISOString(); const observedAt=new Date(Math.floor(trade[2]*1000)).toISOString();
    if (Date.parse(observedAt)>Date.parse(fetchedAt)) throw new ProviderError('KRAKEN_FX_FUTURE_OBSERVATION');
    const content=JSON.stringify(raw);const digest=createHash('sha256').update(content).digest('hex');
    const revision=`trade-${trade[6]}`;
    const old=previous?.provenance.sourceId==='kraken-usdt-usd' && previous.provenance.revision===revision ? previous : undefined;
    if (old && (old.value!==trade[0] || old.provenance.observedAt!==observedAt)) throw new ProviderError('KRAKEN_FX_REVISION_CONFLICT');
    return {data:numericDatumSchema.parse({value:trade[0],unit:'USD_PER_USDT',seriesId:'USD_USDT',period:observedAt.slice(0,10),
      provenance:{sourceId:'kraken-usdt-usd',sourceUrl:KRAKEN_USDT_USD_URL,observedAt,publishedAt:null,
        firstSeenAt:old?.provenance.firstSeenAt ?? fetchedAt,availableAt:old?.provenance.availableAt ?? fetchedAt,
        fetchedAt,revision,verified:true,synthetic:false,conflicts:[],evidenceSha256:digest}}),evidence:[{sha256:digest,content}]};
  }
}
