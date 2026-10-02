import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { DateTime } from 'luxon';
import {
  eventCalendarSchema, employmentReportSchema, type EventCalendar, type EmploymentReport, type NumericDatum,
  type Provenance,
} from '../../shared/src';
import { ProviderError, type PublicHttpOptions } from './http';

export const BLS_EMPLOYMENT_URL = 'https://www.bls.gov/news.release/empsit.nr0.htm';
export const BLS_PUBLIC_CALENDAR_SOURCE_ID = 'bls-public-calendar';
export const BLS_PUBLIC_EMPLOYMENT_SOURCE_ID = 'bls-public-employment';
const BLS_CLIENT = 'trade-functions-bls-release-monitor/1.0';

/**
 * BLS answers generic library agents from cloud networks with an Akamai "Access Denied" page, and its
 * robot policy reserves blocking for robots without owner contact information (https://www.bls.gov/bls/pss.htm).
 * This agent declares an automated, read-only, low-frequency client. It never imitates a browser.
 * The optional contact (email or HTTPS URL) is operator-supplied configuration, never inferred.
 */
export function blsUserAgent(contact?: string): string {
  const base = `${BLS_CLIENT} (automated read-only monitor of the BLS Employment Situation release; low frequency`;
  if (contact === undefined || contact === '') return `${base})`;
  const email = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(contact);
  let url = false;
  try { const parsed = new URL(contact); url = parsed.protocol === 'https:' && !parsed.username && !parsed.password && /^[\x21-\x7e]+$/.test(contact); } catch { url = false; }
  if (contact.length > 200 || (!email && !url) || /[()\s;]/.test(contact)) throw new ProviderError('BLS_INVALID_CONTACT');
  return `${base}; contact: ${contact})`;
}
export interface BlsPublicEvidence { sha256: string; content: string }
export interface BlsPublicResult<T> { data: T | null; evidence: BlsPublicEvidence[] }
export interface BlsEventRequest { eventId: string; period: string }
export interface BlsCalendarRequest extends BlsEventRequest { calendarSourceUrl: string }
export interface BlsEmploymentOptions { requireWages?: boolean }
interface PublicDocument { content: string; fetchedAt: string; url: string }
const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_RE = months.join('|');
const weekdays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

function periodParts(period: string): { year: number; month: number; monthName: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ProviderError('BLS_INVALID_PERIOD');
  const [year, month] = period.split('-').map(Number);
  return { year: year!, month: month!, monthName: months[month! - 1]! };
}
function plainText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const point = Number(code);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    }).replace(/\s+/g, ' ').trim();
}
function utcMillis(value: string): number {
  if (!value.endsWith('Z') || !Number.isFinite(Date.parse(value))) throw new ProviderError('BLS_INVALID_FETCH_TIME');
  return Date.parse(value);
}
function sourceProvenance(sourceId: string, document: PublicDocument, previous?: Provenance): Provenance {
  const evidenceSha256 = digest(document.content);
  const revision = `sha256:${evidenceSha256}`;
  const same = previous?.sourceId === sourceId && previous.sourceUrl === document.url && previous.revision === revision && previous.evidenceSha256 === evidenceSha256 &&
    previous.verified && !previous.synthetic && Date.parse(previous.firstSeenAt) <= Date.parse(document.fetchedAt);
  const firstSeenAt = same ? previous.firstSeenAt : document.fetchedAt;
  return { sourceId, sourceUrl: document.url, observedAt:firstSeenAt, publishedAt:null, firstSeenAt,
    availableAt:firstSeenAt, fetchedAt:document.fetchedAt, revision, verified:true, synthetic:false, conflicts:[], evidenceSha256 };
}
function evidence(document: PublicDocument): BlsPublicEvidence[] { return [{sha256:digest(document.content),content:document.content}]; }

/** Specific parser for the official monthly BLS release-calendar table, including its explicit reference period. */
export function parseBlsMonthlyCalendar(html: string, request: BlsCalendarRequest, fetchedAt: string, previous?: EventCalendar | null): EventCalendar | null {
  const parts = periodParts(request.period); utcMillis(fetchedAt);
  const source = /^https:\/\/www\.bls\.gov\/schedule\/(\d{4})\/(0[1-9]|1[0-2])_sched\.htm$/.exec(request.calendarSourceUrl);
  if (!source || !request.eventId) throw new ProviderError('BLS_INVALID_CALENDAR_URL');
  const year = Number(source[1]); const month = Number(source[2]);
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(match => plainText(match[1]!));
  if (!headings.includes(`${months[month-1]} ${year}`)) throw new ProviderError('BLS_CALENDAR_STRUCTURE_CHANGED');
  const tables = [...html.matchAll(/<table\b([^>]*\bclass\s*=\s*["'][^"']*\brelease-calendar\b[^"']*["'][^>]*)>([\s\S]*?)<\/table>/gi)];
  if (tables.length !== 1 || !/All times on calendar are Eastern Time/i.test(plainText(html))) throw new ProviderError('BLS_CALENDAR_STRUCTURE_CHANGED');
  const matches: string[] = [];
  for (const cell of tables[0]![2]!.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
    if (/\bother-month\b/.test(cell[1]!)) continue;
    const id = /\bid\s*=\s*["']d(\d{2})(\d{2})["']/i.exec(cell[1]!);
    if (!id) throw new ProviderError('BLS_CALENDAR_STRUCTURE_CHANGED');
    if (Number(id[1]) !== month) throw new ProviderError('BLS_CALENDAR_DATE_CONFLICT');
    const visibleDay=/<p\b[^>]*\bclass\s*=\s*["']day["'][^>]*>([\s\S]*?)<\/p>/i.exec(cell[2]!);
    if(!visibleDay || Number(plainText(visibleDay[1]!))!==Number(id[2]))throw new ProviderError('BLS_CALENDAR_DATE_CONFLICT');
    for (const paragraph of cell[2]!.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = plainText(paragraph[1]!);
      if (!/^Employment Situation\b/i.test(text)) continue;
      const release = new RegExp(`^Employment Situation (${MONTHS_RE}) (\\d{4}) (\\d{1,2}):(\\d{2}) (AM|PM)$`, 'i').exec(text);
      if (!release) throw new ProviderError('BLS_CALENDAR_STRUCTURE_CHANGED');
      if (release[1]!.toLowerCase() !== parts.monthName.toLowerCase() || Number(release[2]) !== parts.year) continue;
      const hour12 = Number(release[3]); const minute = Number(release[4]);
      if (hour12 < 1 || hour12 > 12 || minute > 59) throw new ProviderError('BLS_CALENDAR_INVALID_TIME');
      const hour = hour12 % 12 + (release[5]!.toUpperCase() === 'PM' ? 12 : 0);
      const scheduled = DateTime.fromObject({year,month,day:Number(id[2]),hour,minute}, {zone:'America/New_York'});
      if (!scheduled.isValid) throw new ProviderError('BLS_CALENDAR_INVALID_TIME');
      matches.push(scheduled.toUTC().toISO()!);
    }
  }
  if (matches.length > 1) throw new ProviderError('BLS_CALENDAR_AMBIGUOUS_EVENT');
  if (!matches.length) return null;
  const document = {content:html,url:request.calendarSourceUrl,fetchedAt};
  const p = sourceProvenance(BLS_PUBLIC_CALENDAR_SOURCE_ID,document,
    previous?.eventId===request.eventId && previous.period===request.period ? previous.provenance : undefined);
  // A successful new HTTP read is a fresh verification of the schedule. A cached document keeps its original time.
  p.observedAt=fetchedAt;
  return eventCalendarSchema.parse({eventId:request.eventId,period:request.period,scheduledAtUtc:matches[0],provenance:p});
}

function uniqueValue(values: string[], code: string): string {
  if (!values.length) throw new ProviderError(code);
  const normalized = values.map(value => new Decimal(value.replace(/,/g,'')).toFixed());
  if (new Set(normalized).size !== 1) throw new ProviderError('BLS_EMPLOYMENT_CONTRADICTORY_VALUES');
  return normalized[0]!;
}
function extractNfp(text: string, monthName: string): string {
  const values: string[]=[];
  const amount='([+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+))';
  const positive=new RegExp(`^ (?:increased|rose|grew|edged up)(?: by)? ${amount} in ${monthName}\\b`,'i');
  const negative=new RegExp(`^ (?:decreased|declined|fell|edged down)(?: by)? ${amount} in ${monthName}\\b`,'i');
  const unchanged=new RegExp(`^ (?:was |remained )?(?:little changed|essentially unchanged|unchanged|changed little)(?: in ${monthName})? \\(${amount}\\)(?: in ${monthName})?`,'i');
  for(const match of text.matchAll(/\bTotal nonfarm payroll employment\b/gi)){
    const rest=text.slice(match.index!+match[0].length,match.index!+match[0].length+250);
    const up=positive.exec(rest);const down=negative.exec(rest);const flat=unchanged.exec(rest);
    if(up){if(new Decimal(up[1]!.replace(/,/g,'')).lt(0))throw new ProviderError('BLS_EMPLOYMENT_CONTRADICTORY_VALUES');values.push(up[1]!);}
    else if(down){if(new Decimal(down[1]!.replace(/,/g,'')).lt(0))throw new ProviderError('BLS_EMPLOYMENT_CONTRADICTORY_VALUES');values.push(new Decimal(down[1]!.replace(/,/g,'')).neg().toFixed());}
    else if(flat && new RegExp(`\\bin ${monthName}\\b`,'i').test(flat[0]))values.push(flat[1]!);
  }
  return uniqueValue(values,'BLS_NFP_LANGUAGE_CHANGED');
}
function extractUnemployment(text:string):string{
  const values:string[]=[];
  const phrasing=/(?:was )?(?:unchanged at|little changed at|changed little at|essentially unchanged at|increased to|rose to|edged up to|decreased to|declined to|fell to|edged down to|held at|remained at|at)|was/;
  const regex=new RegExp(`\\bthe unemployment rate (?:${phrasing.source}) (\\d+(?:\\.\\d+)?) percent\\b`,'gi');
  for(const match of text.matchAll(regex))values.push(match[1]!);
  for(const match of text.matchAll(/\bthe unemployment rate, at (\d+(?:\.\d+)?) percent,/gi))values.push(match[1]!);
  const value=uniqueValue(values,'BLS_UNEMPLOYMENT_LANGUAGE_CHANGED');
  if(new Decimal(value).lt(0)||new Decimal(value).gt(100))throw new ProviderError('BLS_UNEMPLOYMENT_INVALID_RATE');
  return value;
}
function extractWages(text:string,monthName:string):string{
  const series=/\baverage hourly earnings for all employees on private nonfarm payrolls\b/gi;
  const values:string[]=[];
  for(const match of text.matchAll(series)){
    const start=match.index!;const rest=text.slice(start+match[0].length,start+match[0].length+240);
    const sentence=rest.split(/\.(?=\s|$)/)[0]!;
    const monthContext=text.slice(Math.max(0,start-35),start)+sentence;
    if(!new RegExp(`\\bIn ${monthName}\\b`,'i').test(monthContext))continue;
    const direction=/^ (rose|increased|edged up|grew|declined|decreased|fell|edged down)\b/i.exec(rest);
    if(!direction)continue;
    const percent=/\b(?:or|by) (\d+(?:\.\d+)?) percent\b/i.exec(sentence);
    if(!percent)continue;
    const negative=/declined|decreased|fell|edged down/i.test(direction[1]!);
    values.push(new Decimal(percent[1]!).mul(negative?-1:1).toFixed());
  }
  return uniqueValue(values,'BLS_WAGES_LANGUAGE_CHANGED');
}

/**
 * Detects an actual public report, never publication from a scheduled clock or historical API levels.
 * The header's embargo timestamp is only a lower bound; effective publication is conservatively first detection.
 * Unsupported wording, different table layouts, contradictory duplicate figures or ambiguous dates fail closed.
 */
export function parseBlsEmploymentRelease(html:string,request:BlsEventRequest,fetchedAt:string,previous?:EmploymentReport|null,options:BlsEmploymentOptions={}):EmploymentReport|null{
  const expected=periodParts(request.period);const now=utcMillis(fetchedAt);
  if(!request.eventId)throw new ProviderError('BLS_INVALID_EVENT');
  const pre=[...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)];
  if(pre.length!==1 || !/<h1\b[^>]*>\s*Employment Situation Summary\s*<\/h1>/i.test(html))throw new ProviderError('BLS_EMPLOYMENT_STRUCTURE_CHANGED');
  const text=plainText(pre[0]![1]!);
  // Official releases alternate between "SITUATION - AUGUST 2026" and "SITUATION -- APRIL 2026".
  const titles=[...text.matchAll(new RegExp(`THE EMPLOYMENT SITUATION\\s*(?:-{1,2}|[–—])\\s*(${MONTHS_RE}) (\\d{4})`,'gi'))];
  if(titles.length!==1)throw new ProviderError('BLS_EMPLOYMENT_STRUCTURE_CHANGED');
  if(titles[0]![1]!.toLowerCase()!==expected.monthName.toLowerCase() || Number(titles[0]![2])!==expected.year)return null;
  const embargo=new RegExp(`^Transmission of material in this news release is embargoed until\\s+USDL-([0-9-]+)\\s+(\\d{1,2}):(\\d{2}) (a\\.m\\.|p\\.m\\.) \\(ET\\) (${weekdays.join('|')}), (${MONTHS_RE}) (\\d{1,2}), (\\d{4})\\b`,'i').exec(text);
  if(!embargo)throw new ProviderError('BLS_EMPLOYMENT_PUBLICATION_HEADER_CHANGED');
  const hour12=Number(embargo[2]); const minute=Number(embargo[3]);
  if(hour12<1||hour12>12||minute>59)throw new ProviderError('BLS_EMPLOYMENT_INVALID_EMBARGO');
  const embargoTime=DateTime.fromObject({year:Number(embargo[8]),month:months.findIndex(m=>m.toLowerCase()===embargo[6]!.toLowerCase())+1,
    day:Number(embargo[7]),hour:hour12%12+(/^p/i.test(embargo[4]!)?12:0),minute},{zone:'America/New_York'});
  if(!embargoTime.isValid || weekdays[embargoTime.weekday-1]!.toLowerCase()!==embargo[5]!.toLowerCase())throw new ProviderError('BLS_EMPLOYMENT_INVALID_EMBARGO');
  if(embargoTime.toMillis()>now)return null;
  const sameEvent=previous?.eventId===request.eventId && previous.period===request.period && previous.provenance.sourceId===BLS_PUBLIC_EMPLOYMENT_SOURCE_ID &&
    previous.provenance.sourceUrl===BLS_EMPLOYMENT_URL && previous.provenance.verified && !previous.provenance.synthetic && Date.parse(previous.releasedAtUtc)<=now;
  const document={content:html,url:BLS_EMPLOYMENT_URL,fetchedAt};
  const p=sourceProvenance(BLS_PUBLIC_EMPLOYMENT_SOURCE_ID,document,sameEvent?previous.provenance:undefined);
  const releasedAtUtc=sameEvent?previous.releasedAtUtc:fetchedAt;
  const datum=(value:string,unit:string,seriesId:string):NumericDatum=>({value,unit,seriesId,period:request.period,provenance:{...p}});
  return employmentReportSchema.parse({eventId:request.eventId,period:request.period,releasedAtUtc,provenance:p,
    nfp:datum(extractNfp(text,expected.monthName),'persons','US_NFP_CHANGE'),
    unemployment:datum(extractUnemployment(text),'percent','US_UNEMPLOYMENT_RATE'),
    wages:options.requireWages===false?null:datum(extractWages(text,expected.monthName),'percent_mom','US_AHE_MOM'),
  });
}

/** Unauthenticated official-source reads. No API key, private source, market order or synthetic fallback. */
export class BlsPublicProvider{
  private readonly fetcher:typeof fetch;private readonly now:()=>Date;private readonly timeoutMs:number;
  private readonly maxRetries:number;private readonly retryDelayMs:number;private readonly cacheMs:number;
  private readonly sleep:(ms:number)=>Promise<void>;private readonly cache=new Map<string,PublicDocument>();
  private readonly userAgent:string;
  constructor(options:PublicHttpOptions&{now?:()=>Date;cacheMs?:number;userAgent?:string}={}){
    this.fetcher=options.fetch??fetch;this.now=options.now??(()=>new Date());this.timeoutMs=options.timeoutMs??4000;
    this.maxRetries=options.maxRetries??1;this.retryDelayMs=options.retryDelayMs??200;this.cacheMs=options.cacheMs??30000;
    this.sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));this.userAgent=options.userAgent??blsUserAgent();
    if(!Number.isInteger(this.maxRetries)||this.maxRetries<0||this.maxRetries>2||!Number.isFinite(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>15000||
      !Number.isFinite(this.cacheMs)||this.cacheMs<0||this.cacheMs>60000||!Number.isFinite(this.retryDelayMs)||this.retryDelayMs<0||this.retryDelayMs>2000||
      !this.userAgent.startsWith(`${BLS_CLIENT} (`)||this.userAgent.length>400||!/^[\x20-\x7e]+$/.test(this.userAgent))throw new ProviderError('BLS_INVALID_PROVIDER_CONFIGURATION');
  }
  async getCalendar(request:BlsCalendarRequest,previous?:EventCalendar|null):Promise<BlsPublicResult<EventCalendar>>{
    if(!/^https:\/\/www\.bls\.gov\/schedule\/\d{4}\/(0[1-9]|1[0-2])_sched\.htm$/.test(request.calendarSourceUrl))throw new ProviderError('BLS_INVALID_CALENDAR_URL');
    const doc=await this.document(request.calendarSourceUrl);
    return {data:parseBlsMonthlyCalendar(doc.content,request,doc.fetchedAt,previous),evidence:evidence(doc)};
  }
  async getEmployment(request:BlsEventRequest,previous?:EmploymentReport|null,options:BlsEmploymentOptions={}):Promise<BlsPublicResult<EmploymentReport>>{
    const doc=await this.document(BLS_EMPLOYMENT_URL);
    return {data:parseBlsEmploymentRelease(doc.content,request,doc.fetchedAt,previous,options),evidence:evidence(doc)};
  }
  private async document(url:string):Promise<PublicDocument>{
    const now=this.now().getTime();const old=this.cache.get(url);
    if(old&&now>=Date.parse(old.fetchedAt)&&now-Date.parse(old.fetchedAt)<this.cacheMs)return {...old};
    for(let attempt=0;attempt<=this.maxRetries;attempt++){
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        const request=(async()=>{
          const response=await this.fetcher(url,{method:'GET',redirect:'error',signal:controller.signal,headers:{accept:'text/html','user-agent':this.userAgent}});
          if(!response.ok)throw new ProviderError(`BLS_HTTP_${response.status}`,response.status===429||response.status>=500);
          if(!/text\/html/i.test(response.headers.get('content-type')??''))throw new ProviderError('BLS_UNEXPECTED_CONTENT_TYPE');
          const content=await response.text();if(content.length>300000)throw new ProviderError('BLS_RESPONSE_TOO_LARGE');
          return {content,url,fetchedAt:this.now().toISOString()};
        })();
        const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ProviderError('BLS_TIMEOUT',true));},this.timeoutMs);});
        const document=await Promise.race([request,timeout]);
        this.cache.set(url,document);return {...document};
      }catch(error){const safe=error instanceof ProviderError?error:new ProviderError('BLS_NETWORK_ERROR',true);if(!safe.retryable||attempt===this.maxRetries)throw safe;}
      finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
      await this.sleep(this.retryDelayMs*(attempt+1));
    }
    throw new ProviderError('BLS_UNAVAILABLE');
  }
}
