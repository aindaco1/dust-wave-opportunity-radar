import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays, businessIntro, dayOf, MEMBER_NOTICE, renderNewsletter, selectOpportunities, shouldStartNewsletter, type Newsletter, type Opportunity } from "../src/newsletter/model";
import { opportunityFromPage, parseMemberNames, queryPages, readAudience, readIntroAndContact, readOpportunityBody, resolveRecipients } from "../src/newsletter/source";
import { buildNewsletter, deliverNewsletter, expireNewsletterContent, freezeEdition, readEdition, summarizeOpportunity, type FrozenEdition } from "../src/newsletter/service";
import { OpportunityNewsletterWorkflow } from "../src/workflow/newsletter";
import worker from "../src/index";
import { env as baseEnv } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/d1";
import type { NotionPage } from "../src/notion/client";

const opened: TestDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); while(opened.length) opened.pop()!.close(); });
const NOW = new Date("2026-09-14T14:00:00Z");
const TZ = "America/Denver";
const SETTINGS = { databaseId: "11111111-1111-4111-8111-111111111111", peopleDataSourceId: "22222222-2222-4222-8222-222222222222", helpContactPageId: "33333333-3333-4333-8333-333333333333", helpEmail: "help@example.org", aliases: {} };
const item = (overrides: Partial<Opportunity> = {}): Opportunity => ({ id: "one", name: "Example Grant", website: "https://example.org/grant", notionUrl: "https://notion.so/one", type: "Grant", tags: ["Film"], opens: null, due: "2026-10-01", ...overrides });
const person = (name="Member", email="member@example.org"): NotionPage => ({ id: "member", properties: { Name: { title: [{ plain_text: name }] }, Email: { email }, "Phone #": { phone_number: "505-555-0100" } } });
const newsletter = (): Newsletter => ({ day: "2026-09-14", timezone: TZ, intro: [{ plain_text: "Dust Wave Biz Info\nExample LLC" }], contact: { name:"Owner", email: "help@example.org", phone: "505-555-0100" }, opportunities: [item({summary:"Support for artists."})] });
const edition = (): FrozenEdition => { const n=newsletter(); return { newsletter:n, recipients:[{name:"Member",email:"member@example.org"}], rendered:renderNewsletter(n) }; };
function setup() {
  const db = createTestDatabase(); opened.push(db);
  const send=vi.fn().mockResolvedValue({messageId:"message-1"});
  const env=baseEnv({ DB:db.db, NEWSLETTER_ENABLED:"true",NEWSLETTER_HOUR:"8",NEWSLETTER_DAYS:"1,4",NEWSLETTER_SETTINGS:JSON.stringify(SETTINGS),NEWSLETTER_EMAIL:{send},AI:{run:vi.fn().mockResolvedValue({response:JSON.stringify({summary:"Funding for independent artists who submit a proposal.",note:""})})} });
  return { db, env, send };
}
function mockSources(options: { names?:string[]; pages?:NotionPage[]; body?:string }={}) {
  return vi.stubGlobal("fetch",vi.fn(async (input: string|URL|Request) => {
    const url=String(input); if(url==="https://dustwave.xyz/about.html") return new Response((options.names??["Member"]).map(name=>`<article class="member-card"><h3>${name}</h3><h3><a>Social</a></h3></article>`).join(""));
    if(url.includes(`/data_sources/${SETTINGS.peopleDataSourceId}`)) return Response.json({results:[person()],has_more:false});
    if(url.endsWith("/query")) return Response.json({results:options.pages??[{id:"one",url:"https://notion.so/one",properties:{Name:{title:[{plain_text:"Example Grant"}]},"Due Date":{date:{start:"2026-10-01"}},Tags:{multi_select:[{name:"Film"}]},Website:{rich_text:[{text:{content:"Website",link:{url:"https://example.org"}}}]}}}],has_more:false});
    if(url.includes("/databases/")) return Response.json({description:[{plain_text:"Rolling submissions listed at the top\nDust Wave Biz Info\nExample LLC"}]});
    if(url.endsWith("/markdown")) return Response.json({markdown:options.body??"A grant for artists. Submit a proposal.",truncated:false,unknown_block_ids:[]});
    return Response.json(person("Owner","owner@example.org"));
  }));
}
describe("newsletter eligibility",()=>{
  it("includes today and day 31, excludes past, day 32, missing deadlines, rolling and archived",()=>{
    const dates=["2026-09-13","2026-09-14","2026-10-15","2026-10-16",null];
    const candidates=dates.map((due,i)=>item({id:String(i),due}));
    candidates.push(item({id:"rolling",tags:[" Rolling "]}),item({id:"archived",archived:true}));
    expect(selectOpportunities(candidates,NOW,TZ).map(o=>o.id)).toEqual(["1","2"]);
  });
  it("waits until the opening day or exact opening time",()=>{
    const opens=[null,"2026-09-14","2026-09-15","2026-09-14T13:59:00Z","2026-09-14T14:01:00Z"];
    expect(selectOpportunities(opens.map((open,i)=>item({id:String(i),opens:open})),NOW,TZ).map(o=>o.id)).toEqual(["0","1","3"]);
  });
  it("removes exact deadlines that passed today and respects local date at UTC midnight",()=>{
    expect(selectOpportunities([item({due:"2026-09-14T13:59:00Z"})],NOW,TZ)).toEqual([]);
    expect(dayOf("2026-09-15T03:00:00Z",TZ)).toBe("2026-09-14");
    expect(selectOpportunities([item({due:"2026-09-14"})],new Date("2026-09-15T03:00:00Z"),TZ)).toHaveLength(1);
  });
  it("keeps Done, uses real link targets, deduplicates by page id only",()=>{
    const page={...person(),properties:{...person().properties,Done:{checkbox:true},"Due Date":{date:{start:"2026-10-01"}},Website:{rich_text:[{text:{content:"Apply",link:{url:"https://example.org/apply"}}}]}}};
    const o=opportunityFromPage(page);
    expect(o.website).toBe("https://example.org/apply");
    expect(selectOpportunities([o,o,item({id:"separate"})],NOW,TZ)).toHaveLength(2);
  });
  it("sorts earliest due date first, then explicitly film-focused opportunities on ties",()=>{
    const general=item({id:"general",name:"AAA art",tags:["Visual Art"]});
    const adjacent=item({id:"adjacent",name:"BBB",tags:["Documentary"]});
    const film=item({id:"film",name:"ZZZ",tags:["Film"]});
    const earlier=item({id:"earlier",tags:[],due:"2026-09-20"});
    expect(selectOpportunities([general,adjacent,film,earlier],NOW,TZ).map(o=>o.id)).toEqual(["earlier","film","adjacent","general"]);
  });
  it("does not infer a due date from the end of the application window",()=>{
    const page=person();page.properties!["Application open"]={date:{start:"2026-09-01",end:"2026-10-01"}};
    expect(selectOpportunities([opportunityFromPage(page)],NOW,TZ)).toEqual([]);
  });
  it("handles month/year boundaries and rejects invalid dates",()=>{
    expect(addDays("2026-12-15",31)).toBe("2027-01-15");
    expect(()=>dayOf("2026-02-30",TZ)).toThrow();expect(()=>dayOf("garbage",TZ)).toThrow();
  });
});
describe("newsletter schedule",()=>{
  it.each(["2026-09-14T14:00:00Z","2026-09-17T14:00:00Z","2026-11-02T15:00:00Z","2026-11-05T15:00:00Z"])("runs Monday/Thursday at 8 Mountain across DST: %s",date=>{
    expect(shouldStartNewsletter(new Date(date),TZ,"8","1,4")).toBe(true);
  });
  it.each(["2026-09-13T14:00:00Z","2026-09-15T14:00:00Z","2026-09-16T14:00:00Z","2026-09-14T15:00:00Z","2026-11-02T14:00:00Z"])("skips other slots: %s",date=>{
    expect(shouldStartNewsletter(new Date(date),TZ,"8","1,4")).toBe(false);
  });
  it("rejects malformed schedule config",()=>{expect(()=>shouldStartNewsletter(NOW,TZ,"x","1,4")).toThrow();expect(()=>shouldStartNewsletter(NOW,TZ,"8","7")).toThrow();});
  it("starts the newsletter without starting the ingestion batch",async()=>{
    const {env}=setup();const create=vi.fn().mockResolvedValue({id:"ok"});const batch=vi.fn();Object.assign(env,{NEWSLETTER_WORKFLOW:{create},BATCH_WORKFLOW:{create:batch}});
    await worker.scheduled({scheduledTime:NOW.getTime()} as ScheduledController,env);
    expect(create).toHaveBeenCalledWith({id:"newsletter-2026-09-14",params:{scheduledFor:NOW.toISOString()}});expect(batch).not.toHaveBeenCalled();
  });
});
describe("newsletter content and recipient reads",()=>{
  it("removes the license link and omits the rolling-view instruction",()=>{
    const intro=businessIntro([{plain_text:"Rolling submissions listed at the top\nDust Wave Biz Info\n"},{text:{content:"Biz license",link:{url:"https://notion.so/license"}}}]);
    const rendered=renderNewsletter({...newsletter(),intro});
    expect(rendered.html).toContain(MEMBER_NOTICE);expect(rendered.text).not.toContain("Biz license");expect(rendered.html).not.toContain("https://notion.so/license");
    expect(rendered.html).not.toContain("Rolling submissions");expect(()=>businessIntro([])).toThrow();
  });
  it("escapes untrusted values and rejects unsafe link protocols",()=>{
    const n=newsletter();n.opportunities=[item({name:"<script>x</script>",website:"javascript:alert(1)",summary:"<b>hello</b>",note:"Dates differ"})];
    const r=renderNewsletter(n);expect(r.html).not.toContain("<script>");expect(r.html).not.toContain("javascript:");expect(r.html).toContain("&lt;b&gt;");expect(r.text).toContain("Dates differ");
    expect(r.html).toContain("mailto:help@example.org");expect(r.html).toContain("sms:5055550100");
  });
  it("provides honest missing-field fallbacks and retains every eligible item",()=>{
    const n=newsletter();n.opportunities=Array.from({length:80},(_,i)=>item({id:String(i),name:`Grant ${i}`,summary:undefined,website:null,type:"",tags:[]}));
    const r=renderNewsletter(n);expect(r.html).toContain("Grant 79");expect(r.text).toContain("No description is saved");expect(r.text).toContain("Applications open: Not listed");
    expect(renderNewsletter({...n,opportunities:[]}).html).toContain("No opportunities meet");
  });
  it("extracts only member names, not social links or other headings",()=>{
    expect(parseMemberNames('<h3>Ignore</h3><article class="x member-card"><h3>Artist &amp; Name</h3><h3>Social</h3></article>')).toEqual(["Artist & Name"]);
    expect(()=>parseMemberNames("login")).toThrow();expect(()=>parseMemberNames('<article class="member-card"><h3></h3></article>')).toThrow();
  });
  it("requires one explicit name match, supports reviewed aliases and rejects missing emails",()=>{
    expect(resolveRecipients(["Full Name"],[person("Short Name")],{"Full Name":"Short Name"})).toEqual([{name:"Full Name",email:"member@example.org"}]);
    expect(()=>resolveRecipients(["Member"],[],{})).toThrow();expect(()=>resolveRecipients(["Member"],[person(),person()],{})).toThrow();expect(()=>resolveRecipients(["Member"],[person("Member","bad")],{})).toThrow();
  });
  it("uses Email 2 only if primary is empty and deduplicates shared addresses",()=>{
    const p=person("Member","");p.properties!["Email 2"]={email:"fallback@example.org"};
    expect(resolveRecipients(["Member"],[p],{})[0]!.email).toBe("fallback@example.org");
    expect(resolveRecipients(["A","B"],[person("A"),person("B")],{})).toHaveLength(1);
  });
  it("paginates every page and refuses incomplete pagination",async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(Response.json({results:[person("A")],has_more:true,next_cursor:"next"})).mockResolvedValueOnce(Response.json({results:[person("B")],has_more:false}));vi.stubGlobal("fetch",fetch);
    expect(await queryPages("token","source",{})).toHaveLength(2);expect(JSON.parse(fetch.mock.calls[1]![1].body).start_cursor).toBe("next");
    fetch.mockResolvedValue(Response.json({results:[],has_more:true}));await expect(queryPages("token","source",{})).rejects.toThrow("pagination");
  });
  it("reads live roster, intro and specified help address",async()=>{
    const {env}=setup();mockSources();expect(await readAudience(env,SETTINGS)).toHaveLength(1);
    expect((await readIntroAndContact(env,SETTINGS)).contact.email).toBe("help@example.org");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({markdown:"partial",truncated:true})));await expect(readOpportunityBody(env,"id")).rejects.toThrow("incomplete");
  });
});
describe("newsletter generation and delivery",()=>{
  it("builds from Notion and caches summaries until body or dates change",async()=>{
    const {env}=setup();mockSources();const first=await buildNewsletter(env,NOW);const second=await buildNewsletter(env,NOW);
    expect(first.newsletter.opportunities[0]!.summary).toContain("independent artists");expect(second.recipients).toHaveLength(1);expect(env.AI.run).toHaveBeenCalledTimes(1);
    await summarizeOpportunity(env,item({due:"2026-10-02"}),"Changed body");expect(env.AI.run).toHaveBeenCalledTimes(2);
    expect((await summarizeOpportunity(env,item(),"")).summary).toContain("No description");
  });
  it("fails on invalid AI output and on oversized body",async()=>{
    const {env}=setup();vi.mocked(env.AI.run).mockResolvedValue({response:"invented format"} as never);
    await expect(summarizeOpportunity(env,item(),"body")).rejects.toThrow();await expect(summarizeOpportunity(env,item(),"x".repeat(50001))).rejects.toThrow("too_large");
  });
  it("freezes once; sends recipients privately; duplicate deliveries do not resend",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);const {env,send}=setup();mockSources();const frozen=edition();await freezeEdition(env,frozen);
    const changed=edition();changed.rendered.subject="changed";await freezeEdition(env,changed);
    expect(await deliverNewsletter(env,"2026-09-14")).toBe("accepted");expect(await deliverNewsletter(env,"2026-09-14")).toBe("accepted");expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({replyTo:"help@example.org",to:{name:"Member",email:"member@example.org"},bcc:[],subject:frozen.rendered.subject}));
  });
  it("never retries an ambiguous provider outcome",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);const {env,send}=setup();mockSources();send.mockRejectedValue(new Error("timeout"));await freezeEdition(env,edition());
    await expect(deliverNewsletter(env,"2026-09-14")).rejects.toThrow("requires_review");expect(await deliverNewsletter(env,"2026-09-14")).toBe("ambiguous");expect(send).toHaveBeenCalledTimes(1);
  });
  it("suppresses empty editions, refuses disabled/stale sends and changed membership",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);const {env,send}=setup();const empty=edition();empty.newsletter.opportunities=[];await freezeEdition(env,empty);expect(await deliverNewsletter(env,"2026-09-14")).toBe("empty");expect(send).not.toHaveBeenCalled();
    Object.assign(env,{NEWSLETTER_ENABLED:"false"});await expect(deliverNewsletter(env,"2026-09-14")).rejects.toThrow("disabled");
    Object.assign(env,{NEWSLETTER_ENABLED:"true"});const prepared=edition();prepared.newsletter.day="2026-09-13";await freezeEdition(env,prepared);await expect(deliverNewsletter(env,"2026-09-13")).rejects.toThrow("stale");
  });
  it("stops when the recipient roster changes after preparation",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);const {env,send}=setup();mockSources({names:["Changed"]});await freezeEdition(env,edition());await expect(deliverNewsletter(env,"2026-09-14")).rejects.toThrow("member_match");expect(send).not.toHaveBeenCalled();
  });
  it("removes private edition content after 24 hours while keeping delivery receipts",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);const {env}=setup();await freezeEdition(env,edition());await expireNewsletterContent(env.DB,new Date("2026-09-15T14:01:00Z"));
    expect(await readEdition(env.DB,"2026-09-14")).toMatchObject({state:"prepared",payload_json:null});
  });
  it("uses durable steps with only metadata outputs and can replay without resending",async()=>{
    vi.useFakeTimers();vi.setSystemTime(NOW);const {env,send}=setup();mockSources();const flow=new OpportunityNewsletterWorkflow({} as never,env);const results:unknown[]=[];
    const step={do:async(_name:string,...args:unknown[])=>{const value=await (args.at(-1) as ()=>Promise<unknown>)();results.push(value);return value;}};
    expect(await flow.run({instanceId:"newsletter-2026-09-14",payload:{scheduledFor:NOW.toISOString()}} as never,step as never)).toMatchObject({state:"accepted"});
    await flow.run({instanceId:"newsletter-2026-09-14",payload:{scheduledFor:NOW.toISOString()}} as never,step as never);expect(send).toHaveBeenCalledTimes(1);expect(JSON.stringify(results)).not.toContain("example.org");
  });
});
