import { describe,expect,it,vi } from 'vitest';
import { KrakenFxProvider,KRAKEN_USDT_USD_URL } from '../src/kraken-fx';
const now='2026-10-02T12:46:30.000Z';
function response(price='0.9996',at='2026-10-02T12:46:20.000Z') {return {error:[],result:{USDTZUSD:[[price,'200',Date.parse(at)/1000,'s','l','',42]],last:'1790945180000000000'}};}
describe('public USD/USDT without credentials',()=>{
  it('uses USD per USDT, exchange trade timestamp and no authentication',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(response())));
    const result=await new KrakenFxProvider({fetch:fetcher,now:()=>new Date(now)}).getUsdPerUsdt();
    expect(String(fetcher.mock.calls[0]![0])).toBe(KRAKEN_USDT_USD_URL);
    expect(fetcher.mock.calls[0]![1]?.headers).toEqual({accept:'application/json'});
    expect(result.data.value).toBe('0.9996');expect(result.data.unit).toBe('USD_PER_USDT');
    expect(result.data.provenance.observedAt).toBe('2026-10-02T12:46:20.000Z');expect(result.data.provenance.publishedAt).toBeNull();expect(result.evidence[0]!.sha256).toHaveLength(64);
  });
  it('does not rejuvenate an old trade on receipt',async()=>{
    const provider=new KrakenFxProvider({fetch:async()=>new Response(JSON.stringify(response('0.998','2026-10-02T10:00:00.000Z'))),now:()=>new Date(now)});
    expect((await provider.getUsdPerUsdt()).data.provenance.observedAt).toBe('2026-10-02T10:00:00.000Z');
  });
  it('preserves first receipt across identical trade revisions',async()=>{
    let time=now;const provider=new KrakenFxProvider({fetch:async()=>new Response(JSON.stringify(response())),now:()=>new Date(time)});
    const first=await provider.getUsdPerUsdt();time='2026-10-02T12:46:40.000Z';const next=await provider.getUsdPerUsdt(first.data);
    expect(next.data.provenance.firstSeenAt).toBe(now);expect(next.data.provenance.fetchedAt).toBe(time);
  });
  it.each([{error:['Unavailable'],result:{}},{error:[],result:{USDUSDT:[[1,1,1]],last:'x'}}])('rejects error/wrong currency schema',async raw=>{
    await expect(new KrakenFxProvider({fetch:async()=>new Response(JSON.stringify(raw)),now:()=>new Date(now)}).getUsdPerUsdt()).rejects.toThrow('KRAKEN_FX_INVALID_RESPONSE');
  });
  it('rejects future timestamps',async()=>{
    await expect(new KrakenFxProvider({fetch:async()=>new Response(JSON.stringify(response('1','2026-10-03T00:00:00.000Z'))),now:()=>new Date(now)}).getUsdPerUsdt()).rejects.toThrow('KRAKEN_FX_FUTURE_OBSERVATION');
  });
});
