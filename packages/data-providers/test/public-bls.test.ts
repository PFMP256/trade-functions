import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BlsPublicProvider, blsUserAgent, parseBlsMonthlyCalendar, parseBlsEmploymentRelease, BLS_EMPLOYMENT_URL } from '../src/bls-public';

// Deliberately synthetic, minimal HTML in the official page structures. These are not observations or live fixtures.
const request={eventId:'bls-employment-situation-2026-09',period:'2026-09'};
const calendarRequest={...request,calendarSourceUrl:'https://www.bls.gov/schedule/2026/10_sched.htm'};
const firstDetection='2026-10-02T12:31:00.000Z';
function calendar(options:{day?:number;time?:string;period?:string;header?:string}={}):string{
  const day=options.day??2;
  return `<html><h1>${options.header??'October 2026'}</h1><table id="main-content-table"><tr><td>
  <table class="release-calendar"><thead><tr><th>Monday</th></tr></thead><tbody><tr>
  <td class="other-month" id="d0930"><p class="day">30</p><p>&nbsp;</p></td>
  <td id="d10${String(day).padStart(2,'0')}"><p class="day">${day}</p><p><strong>Employment Situation<br></strong>${options.period??'September 2026'}<br>${options.time??'08:30 AM'}</p></td>
  </tr></tbody></table><p>NOTE: All times on calendar are Eastern Time.</p></td></tr></table></html>`;
}
function release(options:{period?:string;nfp?:string;secondNfp?:string;unemployment?:string;wages?:string;header?:string}={}):string{
  return `<html><h1>Employment Situation Summary</h1><pre>
  Transmission of material in this news release is embargoed until USDL-26-0000
  ${options.header??'8:30 a.m. (ET) Friday, October 2, 2026'}
  Technical information: SYNTHETIC TEST DATA ONLY.
  THE EMPLOYMENT SITUATION - ${options.period??'SEPTEMBER 2026'}
  Total nonfarm payroll employment ${options.nfp??'increased by 80,000 in September'}, and the unemployment rate ${options.unemployment??'was unchanged at 4.2 percent'}, the U.S. Bureau of Labor Statistics reported today.
  Household Survey Data
  The unemployment rate ${options.unemployment??'was unchanged at 4.2 percent'} in September.
  Establishment Survey Data
  Total nonfarm payroll employment ${options.secondNfp??options.nfp??'rose by 80,000 in September'}.
  In September, average hourly earnings for all employees on private nonfarm payrolls ${options.wages??'rose by 7 cents, or 0.2 percent, to $30.00'}.
  Over the year, average hourly earnings have increased by 3.1 percent.
  In September, average hourly earnings of private-sector production and nonsupervisory employees rose by 8 cents, or 0.3 percent, to $25.00.
  </pre></html>`;
}

describe('official BLS monthly-calendar parser',()=>{
  it('parses the explicit report period from its exact table, handling the outer layout table',()=>{
    const data=parseBlsMonthlyCalendar(calendar(),calendarRequest,firstDetection)!;
    expect(data.scheduledAtUtc).toBe('2026-10-02T12:30:00.000Z');expect(data.period).toBe('2026-09');
    expect(data.provenance.publishedAt).toBeNull();expect(data.provenance.synthetic).toBe(false);
    expect(data.provenance.evidenceSha256).toBe(createHash('sha256').update(calendar()).digest('hex'));
  });
  it('accepts official schedule changes instead of relying on the scenario date',()=>{
    const data=parseBlsMonthlyCalendar(calendar({day:9,time:'10:00 AM'}),calendarRequest,firstDetection)!;
    expect(data.scheduledAtUtc).toBe('2026-10-09T14:00:00.000Z');
    expect(parseBlsMonthlyCalendar(calendar({period:'August 2026'}),calendarRequest,firstDetection)).toBeNull();
  });
  it('uses IANA daylight savings for winter schedules',()=>{
    const html=calendar({header:'November 2026'}).replace(/d1002/,'d1102');
    const data=parseBlsMonthlyCalendar(html,{...calendarRequest,calendarSourceUrl:'https://www.bls.gov/schedule/2026/11_sched.htm'},firstDetection)!;
    expect(data.scheduledAtUtc).toBe('2026-11-02T13:30:00.000Z');
  });
  it.each([
    [calendar().replace('release-calendar','new-calendar'),'STRUCTURE_CHANGED'],
    [calendar().replace('Eastern Time','Central Time'),'STRUCTURE_CHANGED'],
    [calendar().replace('class="day">2','class="day">3'),'DATE_CONFLICT'],
    [calendar({time:'25:00 AM'}),'INVALID_TIME'],
    [calendar({header:'November 2026'}),'STRUCTURE_CHANGED'],
  ])('detects incompatible or conflicting structures', (html,error)=>{
    expect(()=>parseBlsMonthlyCalendar(html,calendarRequest,firstDetection)).toThrow(error);
  });
  it('rejects duplicate events and nonofficial URLs',()=>{
    const cell=/<td id="d1002">[\s\S]*?<\/td>/.exec(calendar())![0];
    expect(()=>parseBlsMonthlyCalendar(calendar().replace('</tbody>',`${cell}</tbody>`),calendarRequest,firstDetection)).toThrow('AMBIGUOUS_EVENT');
    expect(()=>parseBlsMonthlyCalendar(calendar(),{...calendarRequest,calendarSourceUrl:'https://bls.gov.attacker.test/schedule/2026/10_sched.htm'},firstDetection)).toThrow('INVALID_CALENDAR_URL');
  });
});

describe('official BLS Employment Situation release parser',()=>{
  it('gets all three current-month figures without confusing annual wages or nonsupervisory employees',()=>{
    const data=parseBlsEmploymentRelease(release(),request,firstDetection)!;
    expect(data.nfp).toMatchObject({value:'80000',unit:'persons',seriesId:'US_NFP_CHANGE'});
    expect(data.unemployment).toMatchObject({value:'4.2',unit:'percent',seriesId:'US_UNEMPLOYMENT_RATE'});
    expect(data.wages).toMatchObject({value:'0.2',unit:'percent_mom',seriesId:'US_AHE_MOM'});
    expect(data.releasedAtUtc).toBe(firstDetection);expect(data.provenance.publishedAt).toBeNull();
  });
  it.each([
    release({wages:'were unavailable in this format'}),
    release().replace('</pre>','In September, average hourly earnings for all employees on private nonfarm payrolls rose by 9 cents, or 0.3 percent, to $30.00.</pre>'),
  ])('ignores unsupported or contradictory wages only for the explicit NFP/unemployment projection',html=>{
    const data=parseBlsEmploymentRelease(html,request,firstDetection,null,{requireWages:false})!;
    expect(data.nfp?.value).toBe('80000');expect(data.unemployment?.value).toBe('4.2');expect(data.wages).toBeNull();
    expect(()=>parseBlsEmploymentRelease(html,request,firstDetection)).toThrow();
    expect(()=>parseBlsEmploymentRelease(html,request,firstDetection,null,{requireWages:true})).toThrow();
  });
  it.each([
    [release({nfp:'was unavailable'}),'NFP_LANGUAGE_CHANGED'],
    [release({unemployment:'was unavailable'}),'UNEMPLOYMENT_LANGUAGE_CHANGED'],
    [release({secondNfp:'rose by 81,000 in September'}),'CONTRADICTORY_VALUES'],
  ])('still rejects missing or contradictory required figures when wages are excluded',(html,error)=>{
    expect(()=>parseBlsEmploymentRelease(html,request,firstDetection,null,{requireWages:false})).toThrow(error);
  });
  it('preserves initial detection and evidence when switching between public projections',()=>{
    const initial=parseBlsEmploymentRelease(release(),request,firstDetection)!;
    const observed=parseBlsEmploymentRelease(release(),request,'2026-10-02T12:40:00.000Z',initial,{requireWages:false})!;
    const full=parseBlsEmploymentRelease(release(),request,'2026-10-02T12:45:00.000Z',observed)!;
    expect(observed.wages).toBeNull();expect(full.wages?.value).toBe('0.2');
    for(const value of [observed,full]){
      expect(value.releasedAtUtc).toBe(firstDetection);expect(value.provenance.firstSeenAt).toBe(firstDetection);
      expect(value.provenance.revision).toBe(initial.provenance.revision);
      expect(value.provenance.evidenceSha256).toBe(initial.provenance.evidenceSha256);
    }
  });
  it('accepts the double-hyphen title used by earlier official releases without relaxing the period',()=>{
    const html=release().replace('THE EMPLOYMENT SITUATION - SEPTEMBER 2026','THE EMPLOYMENT SITUATION -- SEPTEMBER 2026');
    expect(html).toContain('SITUATION -- SEPTEMBER');
    expect(parseBlsEmploymentRelease(html,request,firstDetection,null,{requireWages:false})).toMatchObject({nfp:{value:'80000'},unemployment:{value:'4.2'}});
    expect(parseBlsEmploymentRelease(html.replace('-- SEPTEMBER','-- AUGUST'),request,firstDetection)).toBeNull();
    expect(()=>parseBlsEmploymentRelease(html.replace('-- SEPTEMBER','--- SEPTEMBER'),request,firstDetection)).toThrow('STRUCTURE_CHANGED');
  });
  it('does not fabricate September results from a latest report for August',()=>{
    expect(parseBlsEmploymentRelease(release({period:'AUGUST 2026'}),request,firstDetection)).toBeNull();
  });
  it('does not infer publication just because a scheduled time exists, and respects embargoes',()=>{
    expect(parseBlsEmploymentRelease(release(),request,'2026-10-02T12:29:59.000Z')).toBeNull();
    expect(()=>parseBlsEmploymentRelease('<h1>Employment Situation Summary</h1><pre>Report unavailable</pre>',request,firstDetection)).toThrow('STRUCTURE_CHANGED');
  });
  it('preserves first detection on refetch and effective event time across corrected versions',()=>{
    const first=parseBlsEmploymentRelease(release(),request,firstDetection)!;
    const next=parseBlsEmploymentRelease(release(),request,'2026-10-02T12:35:00.000Z',first)!;
    expect(next.provenance.firstSeenAt).toBe(firstDetection);expect(next.provenance.observedAt).toBe(firstDetection);
    expect(next.provenance.fetchedAt).toBe('2026-10-02T12:35:00.000Z');
    const revised=parseBlsEmploymentRelease(release({nfp:'increased by 81,000 in September'}),request,'2026-10-02T12:40:00.000Z',next)!;
    expect(revised.releasedAtUtc).toBe(firstDetection);expect(revised.nfp?.value).toBe('81000');
    expect(revised.provenance.firstSeenAt).toBe('2026-10-02T12:40:00.000Z');
    expect(revised.provenance.revision).not.toBe(first.provenance.revision);expect(first.nfp?.value).toBe('80000');
  });
  it('does not import availability from an unrelated event or another source',()=>{
    const first=parseBlsEmploymentRelease(release(),request,firstDetection)!;
    const different={...first,eventId:'some-other-event'};
    expect(parseBlsEmploymentRelease(release(),request,'2026-10-02T12:40:00.000Z',different)?.releasedAtUtc).toBe('2026-10-02T12:40:00.000Z');
    const external={...first,provenance:{...first.provenance,sourceId:'third-party'}};
    expect(parseBlsEmploymentRelease(release(),request,'2026-10-02T12:40:00.000Z',external)?.releasedAtUtc).toBe('2026-10-02T12:40:00.000Z');
  });
  it('parses decreases and explicit signed low-change counts without treating missing numbers as zero',()=>{
    expect(parseBlsEmploymentRelease(release({nfp:'declined by 25,000 in September',wages:'fell by 3 cents, or 0.1 percent, to $30.00'}),request,firstDetection))
      .toMatchObject({nfp:{value:'-25000'},wages:{value:'-0.1'}});
    expect(parseBlsEmploymentRelease(release({nfp:'was little changed (-22,000) in September'}),request,firstDetection)?.nfp?.value).toBe('-22000');
    expect(()=>parseBlsEmploymentRelease(release({nfp:'was little changed in September'}),request,firstDetection)).toThrow('NFP_LANGUAGE_CHANGED');
  });
  it.each([
    [release({secondNfp:'rose by 81,000 in September'}),'CONTRADICTORY_VALUES'],
    [release({nfp:'increased by -80,000 in September'}),'CONTRADICTORY_VALUES'],
    [release({nfp:'increased by 80,000 in August'}),'NFP_LANGUAGE_CHANGED'],
    [release({wages:'were unchanged at $30.00'}),'WAGES_LANGUAGE_CHANGED'],
    [release({unemployment:'was unavailable'}),'UNEMPLOYMENT_LANGUAGE_CHANGED'],
    [release({header:'8:30 a.m. (ET) Thursday, October 2, 2026'}),'INVALID_EMBARGO'],
    [release().replace('embargoed until','available later'),'PUBLICATION_HEADER_CHANGED'],
    [release().replace('<pre>','<div>').replace('</pre>','</div>'),'STRUCTURE_CHANGED'],
  ])('fails closed on unsupported language or conflicting evidence', (html,error)=>{
    expect(()=>parseBlsEmploymentRelease(html,request,firstDetection)).toThrow(error);
  });
});

describe('public BLS adapter with mock HTTP integration',()=>{
  const response=(content:string,status=200)=>new Response(content,{status,headers:{'content-type':'text/html; charset=utf-8'}});
  it('forwards the explicit wage requirement and keeps the default legacy contract on the same cached document',async()=>{
    const html=release({wages:'were unavailable in this format'});
    const fetcher=vi.fn(async()=>response(html));
    const provider=new BlsPublicProvider({fetch:fetcher,now:()=>new Date(firstDetection)});
    const observed=await provider.getEmployment(request,null,{requireWages:false});
    expect(observed.data).toMatchObject({nfp:{value:'80000'},unemployment:{value:'4.2'},wages:null});
    expect(observed.evidence[0]?.content).toBe(html);
    await expect(provider.getEmployment(request,observed.data)).rejects.toThrow('WAGES_LANGUAGE_CHANGED');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('returns raw evidence, uses only official HTTPS and never rejuvenates cached data',async()=>{
    let now=new Date(firstDetection);const fetcher=vi.fn(async(_url:string|URL|Request)=>response(release()));
    const provider=new BlsPublicProvider({fetch:fetcher as typeof fetch,now:()=>now,cacheMs:30000});
    const first=await provider.getEmployment(request);now=new Date('2026-10-02T12:31:10.000Z');
    const second=await provider.getEmployment(request,first.data);
    expect(fetcher).toHaveBeenCalledOnce();expect(String(fetcher.mock.calls[0]?.[0])).toBe(BLS_EMPLOYMENT_URL);
    expect(second.data).toEqual(first.data);expect(first.evidence[0]?.sha256).toBe(first.data?.provenance.evidenceSha256);
    expect(first.evidence[0]?.content).toBe(release());
  });
  it('can collect calendar separately and returns a null not-yet-released report',async()=>{
    const fetcher=vi.fn(async(url:string|URL|Request)=>response(String(url).includes('/schedule/')?calendar():release({period:'AUGUST 2026'})));
    const provider=new BlsPublicProvider({fetch:fetcher as typeof fetch,now:()=>new Date(firstDetection)});
    expect((await provider.getCalendar(calendarRequest)).data?.scheduledAtUtc).toBe('2026-10-02T12:30:00.000Z');
    expect((await provider.getEmployment(request)).data).toBeNull();
  });
  it('identifies itself as a declared automated client and never as a browser',async()=>{
    const fetcher=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>response(release()));
    await new BlsPublicProvider({fetch:fetcher as typeof fetch,now:()=>new Date(firstDetection)}).getEmployment(request);
    const headers=fetcher.mock.calls[0]?.[1]?.headers as Record<string,string>;
    expect(headers['user-agent']).toBe(blsUserAgent());
    expect(headers['user-agent']).toMatch(/^trade-functions-bls-release-monitor\/1\.0 \(automated read-only/);
    expect(headers['user-agent']).not.toMatch(/Mozilla|Chrome|Safari|^node$/);
    expect(headers.accept).toBe('text/html');
    const contact=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>response(release()));
    await new BlsPublicProvider({fetch:contact as typeof fetch,now:()=>new Date(firstDetection),userAgent:blsUserAgent('operator@example.org')}).getEmployment(request);
    expect((contact.mock.calls[0]?.[1]?.headers as Record<string,string>)['user-agent']).toMatch(/; contact: operator@example\.org\)$/);
  });
  it.each(['not a contact','http://example.org','https://user:pw@example.org','ops@example.org) Mozilla/5.0','https://example.org/a b',`ops@example.org\r\nx: y`])(
    'rejects an unusable or header-injecting BLS contact: %s',contact=>{
      expect(()=>blsUserAgent(contact)).toThrow('BLS_INVALID_CONTACT');
    });
  it('rejects a configured agent that impersonates a browser or a generic library',()=>{
    for(const userAgent of ['Mozilla/5.0 (Windows NT 10.0)','node',`${blsUserAgent()}\r\nx-injected: 1`])
      expect(()=>new BlsPublicProvider({userAgent})).toThrow('BLS_INVALID_PROVIDER_CONFIGURATION');
    expect(blsUserAgent('https://example.org/contact')).toMatch(/; contact: https:\/\/example\.org\/contact\)$/);
  });
  it('bounds retries and timeouts, rejects bot/error pages instead of parsing them as economic data',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(response('unavailable',503)).mockResolvedValueOnce(response(release()));
    const p=new BlsPublicProvider({fetch:fetcher,now:()=>new Date(firstDetection),sleep:async()=>undefined});
    expect((await p.getEmployment(request)).data?.period).toBe(request.period);expect(fetcher).toHaveBeenCalledTimes(2);
    const blocked=new BlsPublicProvider({fetch:vi.fn(async()=>response('Access denied',403)),maxRetries:0});
    await expect(blocked.getEmployment(request)).rejects.toThrow('BLS_HTTP_403');
    const timeout=new BlsPublicProvider({fetch:(()=>new Promise<Response>(()=>undefined)) as typeof fetch,timeoutMs:5,maxRetries:0});
    await expect(timeout.getEmployment(request)).rejects.toThrow('BLS_TIMEOUT');
  });
});
