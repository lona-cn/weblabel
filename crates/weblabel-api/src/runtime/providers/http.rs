//! Shared bounded transport and native HTTP execution. Only protocol mechanics
//! are shared: each provider owns its request, events and tool-result dialect.
use std::{collections::{BTreeMap,BTreeSet},future::Future,net::{IpAddr,Ipv4Addr},pin::Pin,time::Duration};
use annotation_domain::{ProviderId,RunEventType};
use base64::{engine::general_purpose::STANDARD,Engine};
use serde::Serialize;
use serde_json::{json,Value};
use sqlx::Row;
use tokio::{sync::watch,time::Instant};
use crate::{ai::{consent,runs},jobs::model_jobs::{ModelJobError,ProviderEvent,RunDriver,RunOutcome,RunRunner,RunnerError},runtime::{agent_tools::{AgentToolService,AgentToolOutput,AuthorizedRegion,tool_definitions},config::RuntimeConfig,run_tokens::RunTokenStore},storage::Repository};
use crate::ai::profiles::http_base_approval;
use super::{openai,anthropic,mimo};

pub(crate) const SYSTEM_TEXT:&str="You are a WebLabel annotation assistant. Use the provided tools to inspect authorized regions and propose changes. Tool context fixes identity and permission. Never execute commands.";
pub(crate) fn tools()->&'static [Value]{
    static TOOLS:std::sync::LazyLock<Vec<Value>>=std::sync::LazyLock::new(||tool_definitions().as_array().expect("frozen tool array").clone());
    &TOOLS
}

#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub enum Kind {OpenAi,Anthropic,Mimo}
impl Kind {
    pub fn path(self)->&'static str {match self {Self::OpenAi=>"/responses",Self::Anthropic=>"/v1/messages",Self::Mimo=>"/chat/completions"}}
    pub fn id(self)->&'static str {match self {Self::OpenAi=>"openai_api",Self::Anthropic=>"anthropic_api",Self::Mimo=>"mimo_api"}}
    fn official(self)->&'static str {match self {Self::OpenAi=>"https://api.openai.com/v1",Self::Anthropic=>"https://api.anthropic.com",Self::Mimo=>"https://api.xiaomimimo.com/v1"}}
    fn transport(self)->&'static str {match self {Self::OpenAi=>"openai_responses_sse",Self::Anthropic=>"anthropic_messages_sse",Self::Mimo=>"mimo_chat_completions_sse"}}
}
#[derive(Clone,Debug,PartialEq,Eq)]
pub struct HttpError {pub code:String}
impl HttpError {pub(crate) fn new(code:impl Into<String>)->Self{Self{code:code.into()}}}
impl From<HttpError> for RunnerError {fn from(e:HttpError)->Self{RunnerError::new(&e.code,"Provider operation failed; no automatic retry; billing may be unknown")}}
#[derive(Clone,Copy,Debug)]
pub struct Limits {pub max_response_bytes:usize,pub max_stream_bytes:usize,pub max_frame_bytes:usize}
impl Default for Limits {fn default()->Self{Self{max_response_bytes:4*1024*1024,max_stream_bytes:4*1024*1024,max_frame_bytes:1024*1024}}}
/// Read an accepted JS-safe numeric integer without rewriting its serde Value.
/// Only an absent field selects the default; explicit null/invalid values fail.
pub fn numeric_limit(value:Option<&Value>,default:u64)->Result<u64,HttpError>{
    let Some(value)=value else{return Ok(default)};
    if let Some(number)=value.as_u64().filter(|n|*n<=9_007_199_254_740_991){return Ok(number)}
    value.as_f64().filter(|n|n.is_finite()&&*n>=0.0&&n.fract()==0.0&&*n<=9_007_199_254_740_991.0)
        .map(|n|n as u64).ok_or_else(||HttpError::new("RUNTIME_CONFIGURATION_UNAVAILABLE"))
}
#[derive(Clone,Copy)]
struct HttpBudgets {
    turns:u64,total_data:usize,run_ms:u64,output_tokens:u64,image_bytes:u64,pixels:u64,crops:u64,
    request_ms:u64,response_bytes:usize,stream_bytes:usize,
}
impl HttpBudgets {
    fn parse(config:&Value)->Result<Self,HttpError>{
        let budgets=match config.get("budgets"){None=>None,Some(value)=>Some(value.as_object().ok_or_else(||HttpError::new("RUNTIME_CONFIGURATION_UNAVAILABLE"))?)};
        let budget=|key:&str,default|numeric_limit(budgets.and_then(|b|b.get(key)),default);
        let native=|number:u64|usize::try_from(number).map_err(|_|HttpError::new("RUNTIME_CONFIGURATION_UNAVAILABLE"));
        Ok(Self{turns:budget("max_tool_turns",8)?,total_data:native(budget("max_total_bytes",1_048_576)?)?,
            run_ms:budget("max_run_ms",120_000)?,output_tokens:budget("max_output_tokens",2048)?,
            image_bytes:budget("max_image_bytes",20_971_520)?,pixels:budget("max_pixels",4_000_000)?,crops:budget("max_crops",4)?,
            request_ms:numeric_limit(config.get("timeout_ms"),60_000)?,response_bytes:native(numeric_limit(config.get("max_response_bytes"),4_194_304)?)?,
            stream_bytes:native(numeric_limit(config.get("max_stream_bytes"),4_194_304)?)?})
    }
}
fn private_v4(ip:Ipv4Addr)->bool {let [a,b,_,_]=ip.octets();ip.is_private()||ip.is_loopback()||ip.is_link_local()||ip.is_unspecified()||ip.is_broadcast()||ip.is_multicast()||a==0||a>=240||(a==100&&(64..=127).contains(&b))}
fn private_ip(ip:IpAddr)->bool {
    match ip {
        IpAddr::V4(ip)=>private_v4(ip),
        IpAddr::V6(ip)=>{
            if let Some(ip)=ip.to_ipv4(){return private_v4(ip)}
            let segments=ip.segments();
            if segments[..4]==[0;4]&&segments[4]==0xffff&&segments[5]==0 {
                return private_v4(Ipv4Addr::new((segments[6]>>8) as u8,segments[6] as u8,(segments[7]>>8) as u8,segments[7] as u8))
            }
            ip.is_loopback()||ip.is_unspecified()||ip.is_unique_local()||ip.is_unicast_link_local()||ip.is_multicast()
        }
    }
}
fn private_host(host:&str)->bool {
    let host=host.trim_matches(['[',']']).to_ascii_lowercase();
    host.parse::<IpAddr>().map(private_ip).unwrap_or_else(|_|host=="localhost"||[".localhost",".local",".internal",".lan",".home",".corp"].iter().any(|suffix|host.ends_with(suffix)))
}
pub fn resolve_base(kind:Kind,config:&Value)->Result<String,HttpError> {
    let raw=config["api_base"].as_str().unwrap_or(kind.official()).trim_end_matches('/');
    let url=reqwest::Url::parse(raw).map_err(|_|HttpError::new("base_not_approved"))?;
    if !url.username().is_empty()||url.password().is_some()||url.query().is_some()||url.fragment().is_some()||url.host_str().is_none(){return Err(HttpError::new("base_not_approved"))}
    let approval=&config["base_approval"];
    let approved=http_base_approval(config);
    if raw!=kind.official()&&!approved {return Err(HttpError::new("base_not_approved"))}
    if url.scheme()!="https"&&!(url.scheme()=="http"&&approved&&approval["allow_insecure_http"]==true){return Err(HttpError::new("ssrf_blocked"))}
    if private_host(url.host_str().unwrap())&&!(approved&&approval["allow_private_network"]==true){return Err(HttpError::new("ssrf_blocked"))}
    Ok(url.as_str().trim_end_matches('/').into())
}
/// Pin the authorized DNS answer for this client's lifetime. Checking a DNS
/// answer then letting reqwest resolve again would permit rebinding between
/// authorization and the billable POST. A shared immutable answer also prevents
/// concurrent profiles with different private-network grants from interfering.
#[derive(Default)]
struct PinnedDns(std::sync::RwLock<BTreeMap<String,std::sync::Arc<Vec<IpAddr>>>>);
impl PinnedDns {
    async fn authorize(&self,host:&str,allow_private:bool)->Result<(),HttpError>{
        if host.trim_matches(['[',']']).parse::<IpAddr>().is_ok(){return Ok(())}
        let existing=self.0.read().map_err(|_|HttpError::new("network_error"))?.get(host).cloned();
        let addresses=if let Some(addresses)=existing{addresses}else{
            let mut addresses=Vec::new();
            for socket in tokio::net::lookup_host((host,0)).await.map_err(|_|HttpError::new("network_error"))? {
                if !addresses.contains(&socket.ip()){addresses.push(socket.ip());}
                if addresses.len()>64{return Err(HttpError::new("ssrf_blocked"))}
            }
            if addresses.is_empty(){return Err(HttpError::new("network_error"))}
            let mut pinned=self.0.write().map_err(|_|HttpError::new("network_error"))?;
            if pinned.len()>=500&&!pinned.contains_key(host){return Err(HttpError::new("base_not_approved"))}
            pinned.entry(host.into()).or_insert_with(||std::sync::Arc::new(addresses)).clone()
        };
        if !allow_private&&addresses.iter().copied().any(private_ip){return Err(HttpError::new("ssrf_blocked"))}
        Ok(())
    }
}
impl reqwest::dns::Resolve for PinnedDns {
    fn resolve(&self,name:reqwest::dns::Name)->reqwest::dns::Resolving{
        let addresses=self.0.read().ok().and_then(|pinned|pinned.get(name.as_str()).cloned());
        Box::pin(async move {
            let addresses=addresses.ok_or_else(||Box::<dyn std::error::Error+Send+Sync>::from(std::io::Error::other("destination not authorized")))?;
            let mut position=0usize;
            let iterator=std::iter::from_fn(move||{
                let ip=*addresses.get(position)?;position+=1;Some(std::net::SocketAddr::new(ip,0))
            });
            Ok(Box::new(iterator) as reqwest::dns::Addrs)
        })
    }
}

#[derive(Clone)]
pub struct HttpClient {client:reqwest::Client,resolver:std::sync::Arc<PinnedDns>}
impl HttpClient {
    pub fn new()->Result<Self,HttpError> {
        let resolver=std::sync::Arc::new(PinnedDns::default());
        let client=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never()).no_proxy().dns_resolver(resolver.clone()).build().map_err(|_|HttpError::new("network_error"))?;
        Ok(Self{client,resolver})
    }
    /// One potentially billable POST, no retry even on an ambiguous disconnect.
    /// The caller owns cancellation and the absolute (not per-chunk) deadline.
    pub async fn post(&self,kind:Kind,config:&Value,secret:&str,body:&Value,limits:Limits,deadline:Instant,cancel:&watch::Receiver<bool>,turn:&mut Turn)->Result<(),HttpError> {
        self.post_observed(kind,config,secret,body,limits,deadline,cancel,turn,None).await
    }
    async fn post_observed(&self,kind:Kind,config:&Value,secret:&str,body:&Value,limits:Limits,deadline:Instant,cancel:&watch::Receiver<bool>,turn:&mut Turn,observations:Option<DispatchContext<'_>>)->Result<(),HttpError> {
        // Preparation and writer admission remain cancelable. No send future
        // is polled until endpoint/body validation and fresh authorization end.
        let preparation=async {
            let base=resolve_base(kind,config)?;
            if kind==Kind::Mimo&&secret.starts_with("tp-")&&(config.get("api_base").is_none()||base==kind.official()){return Err(HttpError::new("base_not_approved"))}
            let url=reqwest::Url::parse(&base).map_err(|_|HttpError::new("base_not_approved"))?;
            self.resolver.authorize(url.host_str().ok_or_else(||HttpError::new("base_not_approved"))?,http_base_approval(config)&&config["base_approval"]["allow_private_network"]==true).await?;
            let mut request=self.client.post(format!("{base}{}",kind.path())).header("content-type","application/json").json(body);
            request=if kind==Kind::Anthropic {
                let mut key=reqwest::header::HeaderValue::from_str(secret).map_err(|_|HttpError::new("secret_ref_invalid"))?;
                key.set_sensitive(true);
                request.header("x-api-key",key).header("anthropic-version","2023-06-01")
            }else{request.bearer_auth(secret)};
            let (client,request)=request.build_split();
            let request=reqwest::RequestBuilder::from_parts(client,request.map_err(|_|HttpError::new("network_error"))?);
            #[cfg(debug_assertions)]
            if let Some(context)=observations {
                if let Some(barrier)=&context.runner.dispatch_barrier {
                    if !barrier.hold_after_admission{barrier.entered.notify_one();barrier.release.notified().await;}
                }
            }
            let transaction=if let Some(context)=observations {
                let mut tx=context.runner.repository.begin_write().await.map_err(|error|HttpError::new(RunnerError::from(ModelJobError::from(error)).code))?;
                context.runner.preflight_on(tx.connection(),context.driver,kind,config).await.map_err(|error|HttpError::new(error.code))?;
                if context.runner.secret(config).map_err(|error|HttpError::new(error.code))?!=secret{return Err(HttpError::new("secret_ref_invalid"))}
                Some(tx)
            }else{None};
            Ok((request,transaction))
        };
        let (request,transaction)=Self::controlled(observations,deadline,cancel,preparation).await?;
        let send=request.send();tokio::pin!(send);
        let first=if let (Some(context),Some(mut tx))=(observations,transaction) {
            // This first poll and its checkpoint are one irreversible phase.
            // Never select cancellation/deadline against this phase: dropping
            // its transaction could roll back proof after actual IO admission.
            // Volatile uncertainty belongs to this original capability, not a
            // second event registry. Cancel reads it after writer admission.
            context.runner.tokens.set_observation_pending(context.token,true).map_err(|error|HttpError::new(error.code()))?;
            let first=std::future::poll_fn(|cx|std::task::Poll::Ready(context.runner.tokens.if_live(context.token,||{
                if Instant::now()>=deadline{return Err(HttpError::new(context.deadline_code))}
                if *cancel.borrow(){return Err(HttpError::new("RUN_CANCELLED"))}
                turn.attempted=true;turn.dispatch_phase=Some("attempted");
                Ok(send.as_mut().poll(cx))
            }))).await.map_err(|error|HttpError::new(error.code())).and_then(|result|result);
            let first=match first {
                Ok(first)=>first,
                Err(error)=>{
                    // No IO poll occurred: remove uncertainty before releasing
                    // the writer, including revocation/expiry/deadline rejection.
                    context.runner.tokens.set_observation_pending(context.token,false).map_err(|_|HttpError::new("event_checkpoint_failed"))?;
                    return Err(error)
                }
            };
            #[cfg(debug_assertions)]
            if let Some(barrier)=&context.runner.dispatch_barrier {
                if barrier.hold_after_admission{barrier.entered.notify_one();barrier.release.notified().await;}
            }
            // The token mutex is no longer held. Keep the existing repository
            // writer until the actual-attempt checkpoint is durably committed.
            let data=context.runner.checkpoint_data(context.driver,kind,config,context.previous,Some(turn),secret,context.budgets);
            crate::ai::events::record(tx.connection(),context.driver.run_id(),crate::ai::events::RecordEvent{
                provider_event_id:None,provider_seq:None,event_type:RunEventType::Progress,
                message:"provider observation checkpoint",data:Some(data),
            }).await.map_err(|_|HttpError::new("event_checkpoint_failed"))?;
            tx.commit().await.map_err(|_|HttpError::new("event_checkpoint_failed"))?;
            // A failed INSERT/COMMIT must leave the bit set even after revoke.
            // Only a confirmed durable checkpoint may remove uncertainty.
            context.runner.tokens.set_observation_pending(context.token,false).map_err(|_|HttpError::new("event_checkpoint_failed"))?;
            first
        }else{std::task::Poll::Pending};
        let operation=async {
            let response=match first {
                std::task::Poll::Ready(response)=>response,
                std::task::Poll::Pending=>{
                    let sending=std::future::poll_fn(|cx|{
                        turn.attempted=true;turn.dispatch_phase=Some("attempted");send.as_mut().poll(cx)
                    });
                    if let Some(context)=observations {
                        context.runner.tokens.while_live(context.token,sending).await.map_err(|error|HttpError::new(error.code()))?
                    }else{sending.await}
                }
            };
            let mut response=response.map_err(|error|HttpError::new(if error.is_timeout(){"timeout"}else{"network_error"}))?;
            if let Some(context)=observations {
                context.runner.checkpoint(context.driver,context.token,kind,config,context.previous,Some(turn),secret,context.budgets).await.map_err(|_|HttpError::new("event_checkpoint_failed"))?;
            }
            let status=response.status().as_u16();
            if (300..400).contains(&status){return Err(HttpError::new("redirect_rejected"))}
            let cap=if (200..300).contains(&status){limits.max_stream_bytes}else{limits.max_response_bytes};
            if response.content_length().is_some_and(|n|n>cap as u64){return Err(HttpError::new("oversized_response"))}
            if !(200..300).contains(&status) {
                let mut bytes=0usize;
                while let Some(chunk)=Self::read_chunk(&mut response,observations).await? {bytes=bytes.saturating_add(chunk.len());if bytes>cap{return Err(HttpError::new("oversized_response"))}}
                return Err(HttpError::new(match status {401=>"unauthorized_401",403=>"forbidden_403",429=>"rate_limited_429",500..=599=>"upstream_5xx",_=>"request_rejected_4xx"}));
            }
            let mut parser=Sse::new(limits.max_frame_bytes,observations.map_or(usize::MAX,|context|context.remaining_data));let mut total=0usize;
            while let Some(chunk)=Self::read_chunk(&mut response,observations).await? {
                total=total.saturating_add(chunk.len());turn.wire_bytes=total;
                if total>limits.max_stream_bytes{return Err(HttpError::new("oversized_response"))}
                let before=turn.observation();
                let parsed=parser.push(&chunk,turn);
                if before!=turn.observation() {
                    if let Some(context)=observations {
                        context.runner.checkpoint(context.driver,context.token,kind,config,context.previous,Some(turn),secret,context.budgets).await.map_err(|_|HttpError::new("event_checkpoint_failed"))?;
                    }
                }
                parsed?;
            }
            parser.end()?;
            if !turn.terminal{return Err(HttpError::new("missing_terminal"))}
            turn.successful=true;
            Ok(())
        };
        Self::controlled(observations,deadline,cancel,operation).await
    }
    async fn controlled<F,T>(context:Option<DispatchContext<'_>>,deadline:Instant,cancel:&watch::Receiver<bool>,future:F)->Result<T,HttpError>
    where F:Future<Output=Result<T,HttpError>> {
        let operation=async {
            if let Some(context)=context {
                context.runner.guarded(context.driver,context.token,deadline,context.deadline_code,async{future.await.map_err(RunnerError::from)}).await.map_err(|error|HttpError::new(error.code))
            }else{future.await}
        };
        tokio::pin!(operation);
        let mut cancellation=cancel.clone();
        if *cancellation.borrow(){return Err(HttpError::new("RUN_CANCELLED"))}
        loop {tokio::select! {biased;
            _=tokio::time::sleep_until(deadline)=>return Err(HttpError::new(context.map_or("timeout",|context|context.deadline_code))),
            result=cancellation.changed()=>{if result.is_err()||*cancellation.borrow(){return Err(HttpError::new("RUN_CANCELLED"))}},
            result=&mut operation=>return result
        }}
    }
    async fn read_chunk(response:&mut reqwest::Response,context:Option<DispatchContext<'_>>)->Result<Option<axum::body::Bytes>,HttpError>{
        let result=if let Some(context)=context {
            context.runner.tokens.while_live(context.token,response.chunk()).await.map_err(|e|HttpError::new(e.code()))?
        }else{response.chunk().await};
        result.map_err(|_|HttpError::new("interrupted_stream"))
    }
}
// Byte-oriented lines preserve UTF-8 across network fragments, and count raw
// frame bytes before any allocation/JSON decoding. No whole-body buffering.
struct Sse {line:Vec<u8>,data:String,event:Option<String>,bytes:usize,max:usize,max_data:usize}
impl Sse {
    fn new(max:usize,max_data:usize)->Self{Self{line:Vec::new(),data:String::new(),event:None,bytes:0,max,max_data}}
    fn push(&mut self,chunk:&[u8],turn:&mut Turn)->Result<(),HttpError>{
        for &byte in chunk {
            self.bytes=self.bytes.saturating_add(1);if self.bytes>self.max{return Err(HttpError::new("oversized_frame"))}
            if byte!=b'\n'{self.line.push(byte);continue}
            if self.line.last()==Some(&b'\r'){self.line.pop();}
            let line=std::str::from_utf8(&self.line).map_err(|_|HttpError::new("invalid_utf8"))?;
            if line.is_empty(){
                if !self.data.is_empty(){
                    self.data.pop();turn.data_bytes=turn.data_bytes.saturating_add(self.data.len());
                    if turn.data_bytes>self.max_data{return Err(HttpError::new("tool_byte_budget_exceeded"))}
                    turn.frame(self.event.as_deref(),&self.data)?;
                }
                self.event=None;self.data.clear();self.bytes=0;
            } else if !line.starts_with(':') {
                let (key,value)=line.split_once(':').unwrap_or((line,""));let value=value.strip_prefix(' ').unwrap_or(value);
                match key {"data"=>{self.data.push_str(value);self.data.push('\n');},"event"=>self.event=Some(value.into()),_=>{}}
            }
            self.line.clear();
        }
        Ok(())
    }
    fn end(&self)->Result<(),HttpError>{if !self.line.is_empty()||!self.data.is_empty()||self.event.is_some(){Err(HttpError::new("interrupted_stream"))}else{Ok(())}}
}
#[derive(Clone,Debug,Default,Serialize)]
pub struct Usage {pub input_tokens:Option<u64>,pub output_tokens:Option<u64>,pub cost_usd:Option<f64>}
impl Usage {
    pub(crate) fn observe(&mut self,value:&Value){
        fn count(value:&Value,a:&str,b:&str)->Option<u64>{value.get(a).filter(|v|!v.is_null()).or_else(||value.get(b)).and_then(|v|numeric_limit(Some(v),0).ok())}
        if let Some(n)=count(value,"input_tokens","prompt_tokens"){self.input_tokens=Some(n);}
        if let Some(n)=count(value,"output_tokens","completion_tokens"){self.output_tokens=Some(n);}
    }
    fn total(turns:&[Turn],current:Option<&Turn>,pricing:&Value)->Self {
        fn sum(turns:&[Turn],current:Option<&Turn>,f:impl Fn(&Usage)->Option<u64>)->Option<u64>{
            let mut observed=turns.iter().chain(current).filter(|turn|turn.successful||turn.usage.input_tokens.is_some()||turn.usage.output_tokens.is_some()).peekable();
            observed.peek()?;
            observed.try_fold(0u64,|sum,t|sum.checked_add(f(&t.usage)?))
        }
        let input_tokens=sum(turns,current,|u|u.input_tokens);let output_tokens=sum(turns,current,|u|u.output_tokens);
        let cost_usd=input_tokens.zip(output_tokens).and_then(|(i,o)|{
            let a=pricing["input_per_million_usd"].as_f64()?;let b=pricing["output_per_million_usd"].as_f64()?;
            let cost=(i as f64*a+o as f64*b)/1_000_000.0;(a>=0.0&&b>=0.0&&cost.is_finite()).then_some(cost)
        });Self{input_tokens,output_tokens,cost_usd}
    }
}
#[derive(Clone,Debug)]
pub struct Call {pub id:String,pub name:String,pub arguments:String}
impl Call {
    pub(crate) fn new(id:&Value,name:&Value,args:&str)->Result<Self,HttpError>{
        let id=id.as_str().filter(|s|!s.is_empty()&&s.len()<=256).ok_or_else(||HttpError::new("stream_order_invalid"))?;
        let name=name.as_str().filter(|s|crate::runtime::agent_tools::TOOL_NAMES.contains(s)).ok_or_else(||HttpError::new("invalid_tool_call"))?;
        Ok(Self{id:id.into(),name:name.into(),arguments:args.into()})
    }
}
#[derive(Debug,Default)]
pub(crate) struct ResponsePart {pub text:String,pub text_done:bool,pub done:bool}
#[derive(Debug)]
pub(crate) struct ResponseItem {
    pub id:String,pub kind:String,pub parts:BTreeMap<u64,ResponsePart>,pub completed:Option<Value>,
}
#[derive(Debug)]
pub struct Turn {
    kind:Kind,pub calls:Vec<Call>,pub text:String,pub usage:Usage,pub response_id:Option<String>,pub actual_model_id:Option<String>,pub wire_bytes:usize,pub data_bytes:usize,
    pub(crate) continuation:Vec<Value>,pub(crate) response_items:Vec<ResponseItem>,
    pub(crate) initial_inputs:BTreeMap<u64,Value>,pub(crate) input_deltas:BTreeSet<u64>,pub(crate) stop_reason:Option<String>,
    attempted:bool,successful:bool,dispatch_phase:Option<&'static str>,
    pub(crate) terminal:bool,pub(crate) sequence:Option<u64>,pub(crate) indices:BTreeMap<String,usize>,pub(crate) closed:BTreeSet<String>,pub(crate) blocks:BTreeMap<u64,String>,pub(crate) block_closed:BTreeSet<u64>,pub(crate) started:bool,pub(crate) finished:bool,
}
impl Turn {
    pub fn new(kind:Kind)->Self{Self{kind,calls:Vec::new(),text:String::new(),usage:Usage::default(),response_id:None,actual_model_id:None,wire_bytes:0,data_bytes:0,continuation:Vec::new(),response_items:Vec::new(),initial_inputs:BTreeMap::new(),input_deltas:BTreeSet::new(),stop_reason:None,attempted:false,successful:false,dispatch_phase:None,terminal:false,sequence:None,indices:BTreeMap::new(),closed:BTreeSet::new(),blocks:BTreeMap::new(),block_closed:BTreeSet::new(),started:false,finished:false}}
    fn observation(&self)->(bool,bool,Option<u64>,Option<u64>){(self.response_id.is_some(),self.actual_model_id.is_some(),self.usage.input_tokens,self.usage.output_tokens)}
    pub fn frame(&mut self,event:Option<&str>,data:&str)->Result<(),HttpError>{
        if self.terminal&&self.kind!=Kind::OpenAi{return Err(HttpError::new("stream_order_invalid"))}
        if self.kind==Kind::Mimo&&data=="[DONE]" {
            if !self.finished{return Err(HttpError::new("stream_order_invalid"))}self.terminal=true;return Ok(())
        }
        let mut value:Value=serde_json::from_str(data).map_err(|_|HttpError::new("invalid_json"))?;
        if !value.is_object(){return Err(HttpError::new("invalid_json"))}
        if let Some(event)=event {
            if value.get("type").is_none(){value["type"]=json!(event)}else if value["type"].as_str()!=Some(event){return Err(HttpError::new("stream_order_invalid"))}
        }
        match self.kind {Kind::OpenAi=>openai::frame(self,&value),Kind::Anthropic=>anthropic::frame(self,&value),Kind::Mimo=>mimo::frame(self,&value)}
    }
    pub(crate) fn observe(&mut self,value:&Value,id:&str)->Result<(),HttpError>{
        fn identity(slot:&mut Option<String>,v:&Value)->Result<(),HttpError>{
            if let Some(s)=v.as_str().filter(|s|!s.is_empty()) {
                if s.len()>256{return Err(HttpError::new("oversized_response"))}
                if slot.as_ref().is_some_and(|old|old!=s){return Err(HttpError::new("stream_order_invalid"))}*slot=Some(s.into());
            }Ok(())
        }
        identity(&mut self.response_id,&value[id])?;identity(&mut self.actual_model_id,&value["model"])?;self.usage.observe(&value["usage"]);Ok(())
    }
    pub(crate) fn add_call(&mut self,key:String,call:Call)->Result<(),HttpError>{
        if self.indices.contains_key(&key)||self.calls.iter().any(|c|c.id==call.id){return Err(HttpError::new("duplicate_tool_call"))}
        if self.calls.len()>=1000{return Err(HttpError::new("tool_turn_budget_exceeded"))}
        self.indices.insert(key,self.calls.len());self.calls.push(call);Ok(())
    }
}

/// Concrete shared executor for the three fixed HTTP providers. The integrating
/// production runner retains its fixed five-provider match, not a registry.
pub struct HttpRunner {
    repository:Repository,config:std::sync::Arc<RuntimeConfig>,tokens:RunTokenStore,tools:AgentToolService,http:HttpClient,timeout:Duration,
    #[cfg(debug_assertions)]
    dispatch_barrier:Option<std::sync::Arc<HttpDispatchBarrier>>,
}
/// Controlled Rust consumer seam; absent from release builds and never exposed
/// by a route, configuration field, environment flag or executable argument.
#[cfg(debug_assertions)]
#[derive(Default)]
pub struct HttpDispatchBarrier {entered:tokio::sync::Notify,release:tokio::sync::Notify,hold_after_admission:bool}
#[cfg(debug_assertions)]
impl HttpDispatchBarrier {
    pub fn after_admission()->Self{Self{hold_after_admission:true,..Self::default()}}
    pub async fn entered(&self){self.entered.notified().await}
    pub fn release(&self){self.release.notify_one();}
}
#[derive(Clone,Copy)]
struct DispatchContext<'a> {runner:&'a HttpRunner,driver:&'a RunDriver<'a>,previous:&'a [Turn],token:&'a str,budgets:HttpBudgets,remaining_data:usize,deadline_code:&'static str}
struct Lease {tokens:RunTokenStore,run_id:String}
impl Drop for Lease {fn drop(&mut self){self.tokens.revoke_run(&self.run_id);}}
fn rejected(code:&str)->RunnerError{RunnerError::new(code,"Native provider operation rejected; no automatic retry")}
impl HttpRunner {
    pub fn new(repository:Repository,config:std::sync::Arc<RuntimeConfig>,tokens:RunTokenStore,timeout:Duration)->Result<Self,RunnerError>{
        let tools=AgentToolService::new(repository.clone(),tokens.clone());
        Ok(Self{repository,config,tokens,tools,http:HttpClient::new()?,timeout,
            #[cfg(debug_assertions)]
            dispatch_barrier:None,
        })
    }
    #[cfg(debug_assertions)]
    pub fn with_dispatch_barrier(mut self,barrier:std::sync::Arc<HttpDispatchBarrier>)->Self{self.dispatch_barrier=Some(barrier);self}
    async fn preflight(&self,driver:&RunDriver<'_>,kind:Kind,config:&Value)->Result<runs::RunRecord,RunnerError>{
        let mut tx=self.repository.begin_write().await.map_err(ModelJobError::from)?;
        let record=self.preflight_on(tx.connection(),driver,kind,config).await?;
        tx.commit().await.map_err(ModelJobError::from)?;Ok(record)
    }
    async fn preflight_on(&self,connection:&mut sqlx::SqliteConnection,driver:&RunDriver<'_>,kind:Kind,config:&Value)->Result<runs::RunRecord,RunnerError>{
        let record=runs::load_record(&mut *connection,driver.run_id()).await.map_err(ModelJobError::from)?.ok_or_else(||rejected("RUN_NOT_FOUND"))?;
        if record.cancel_requested||record.state.is_terminal(){return Err(rejected("RUN_CANCELLED"))}
        if record.profile_id!=&*driver.profile().profile_id||record.provider_id!=kind.id()
            ||record.project_id!=&*driver.context().project_id
            ||record.asset_revision_id!=&*driver.context().asset_revision_id
            ||record.annotation_revision_id!=&*driver.context().annotation_revision_id
            ||record.ontology_version_id!=&*driver.context().ontology_version_id
            ||record.context().ok().as_ref()!=Some(driver.context())
            ||record.input_fingerprint!=driver.context().input_fingerprint {return Err(rejected("RUN_CONTEXT_MISMATCH"))}
        consent::authorize_run(&mut *connection,&record).await.map_err(|e|rejected(e.code))?;
        let row=sqlx::query("SELECT p.config_json FROM model_profiles p JOIN model_run_authorizations a ON a.run_id=? WHERE p.profile_id=?")
            .bind(driver.run_id()).bind(&record.profile_id).fetch_one(&mut *connection).await.map_err(ModelJobError::from)?;
        let stored:Value=serde_json::from_str(&row.try_get::<String,_>("config_json").map_err(ModelJobError::from)?).map_err(|_|rejected("RUNTIME_CONFIGURATION_UNAVAILABLE"))?;
        let hash=self.config.configuration_hash(kind.id(),&record.profile_id).map_err(|_|rejected("RUNTIME_CONFIGURATION_UNAVAILABLE"))?;
        // authorize_run already verified the larger consent-envelope hash.
        // Its authorization column is not an execution-configuration hash.
        if annotation_domain::hash::execution_configuration_hash(&stored).ok().as_ref()!=Some(&hash){return Err(rejected("PROFILE_CONFIGURATION_CONFLICT"))}
        if config["model_id"].as_str()!=Some(&*driver.profile().model_id)||config["account_model_verified"]!=true||!driver.profile().capabilities.tools {return Err(rejected("PROFILE_UNAVAILABLE"))}
        Ok(record)
    }
    async fn guarded<F,T>(&self,driver:&RunDriver<'_>,token:&str,deadline:Instant,deadline_code:&'static str,future:F)->Result<T,RunnerError> where F:Future<Output=Result<T,RunnerError>> {
        tokio::pin!(future);
        // Poll authorization concurrently with, not inside, the IO future:
        // tools can themselves hold the repository's write permit while
        // awaiting IO. Awaiting a second permit in a select branch deadlocks.
        let monitor=async {
            loop {
                tokio::time::sleep(Duration::from_millis(50)).await;
                self.tokens.verify(token).map_err(|error|rejected(if error.code()=="RUN_TOKEN_EXPIRED"{deadline_code}else{error.code()}))?;
                let mut tx=self.repository.begin_write().await.map_err(ModelJobError::from)?;
                let record=runs::load_record(tx.connection(),driver.run_id()).await.map_err(ModelJobError::from)?.ok_or_else(||rejected("RUN_NOT_FOUND"))?;
                if record.cancel_requested||record.state.is_terminal(){return Err(rejected("RUN_CANCELLED"))}
                consent::authorize_run(tx.connection(),&record).await.map_err(|e|rejected(e.code))?;
                tx.commit().await.map_err(ModelJobError::from)?;
            }
        };
        tokio::pin!(monitor);
        let outcome=tokio::select! {biased;
            _=tokio::time::sleep_until(deadline)=>Err(rejected(deadline_code)),
            result=&mut monitor=>result,
            result=&mut future=>result
        };
        outcome.map_err(|error|if error.code=="RUN_TOKEN_EXPIRED"{rejected(deadline_code)}else{error})
    }
    async fn invoke(&self,token:&str,name:&str,args:&Value)->Result<AgentToolOutput,RunnerError>{
        self.tools.invoke(token,name,args).await.map_err(|e|rejected(&e.code))
    }
    fn secret(&self,config:&Value)->Result<String,RunnerError>{
        let name=config["credential"]["secret_ref"].as_str().and_then(|s|s.strip_prefix("env:")).filter(|name|self.config.allowed_secret_env().iter().any(|allowed|allowed.as_str()==*name)).ok_or_else(||rejected("secret_ref_invalid"))?;
        std::env::var(name).ok().filter(|s|!s.is_empty()&&!s.contains(['\r','\n','\0'])).ok_or_else(||rejected("secret_ref_invalid"))
    }
    fn checkpoint_data(&self,driver:&RunDriver<'_>,kind:Kind,config:&Value,turns:&[Turn],current:Option<&Turn>,secret:&str,budgets:HttpBudgets)->Value{
        let usage=Usage::total(turns,current,&config["pricing"]);
        let receipts=turns.iter().chain(current).filter(|turn|turn.attempted).map(|t|json!({"provider_id":kind.id(),"requested_model_id":driver.profile().model_id,
            "actual_model_id":safe_identity(t.actual_model_id.as_deref(),secret),"response_id":safe_identity(t.response_id.as_deref(),secret),"dispatch_phase":t.dispatch_phase,"auth_kind":"api_key","transport":kind.transport(),"runtime_version":null,"runtime_version_status":"not_exposed",
            "budgets":{"max_tool_turns":budgets.turns,"max_run_ms":budgets.run_ms,"max_total_bytes":budgets.total_data,"request_timeout_ms":budgets.request_ms,"cost_usd":null}})).collect::<Vec<_>>();
        let data=json!({"receipts":receipts,"receipt":receipts.last(),"usage":usage,"cost_display":if usage.cost_usd.is_some(){"known"}else{"unknown"}});
        if json_bytes(&data)<=16*1024{data}else{json!({"dropped":"event_data_too_large"})}
    }
    async fn checkpoint(&self,driver:&RunDriver<'_>,token:&str,kind:Kind,config:&Value,turns:&[Turn],current:Option<&Turn>,secret:&str,budgets:HttpBudgets)->Result<(),RunnerError>{
        self.tokens.set_observation_pending(token,true).map_err(|_|rejected("event_checkpoint_failed"))?;
        let data=self.checkpoint_data(driver,kind,config,turns,current,secret,budgets);
        driver.emit(ProviderEvent{provider_event_id:String::new(),provider_seq:None,event_type:RunEventType::Progress,message:"provider observation checkpoint".into(),data:Some(data)}).await.map_err(|_|rejected("event_checkpoint_failed"))?;
        self.tokens.set_observation_pending(token,false).map_err(|_|rejected("event_checkpoint_failed"))?;
        Ok(())
    }
    async fn image_event(&self,driver:&RunDriver<'_>,metadata:&Value)->Result<(),RunnerError>{
        driver.emit(ProviderEvent{provider_event_id:String::new(),provider_seq:None,event_type:RunEventType::Progress,
            message:"authorized image input".into(),data:Some(metadata.clone())}).await?;Ok(())
    }
    pub(crate) async fn run(&self,driver:&RunDriver<'_>)->Result<RunOutcome,RunnerError>{
        let kind=match driver.profile().provider_id {ProviderId::OpenaiApi=>Kind::OpenAi,ProviderId::AnthropicApi=>Kind::Anthropic,ProviderId::MimoApi=>Kind::Mimo,_=>return Err(rejected("PROVIDER_UNSUPPORTED"))};
        let config=self.config.selected(kind.id(),&driver.profile().profile_id).map_err(|_|rejected("RUNTIME_CONFIGURATION_UNAVAILABLE"))?;
        let budgets=HttpBudgets::parse(config)?;
        if budgets.turns==0{return Err(rejected("tool_turn_budget_exceeded"))}
        if budgets.run_ms==0{return Err(rejected("tool_time_budget_exceeded"))}
        resolve_base(kind,config)?;
        let record=self.preflight(driver,kind,config).await?;
        let mut tx=self.repository.begin_write().await.map_err(ModelJobError::from)?;
        let expires:Option<String>=sqlx::query_scalar("SELECT capability_expires_at FROM model_run_authorizations WHERE run_id=?").bind(driver.run_id()).fetch_one(tx.connection()).await.map_err(ModelJobError::from)?;
        tx.commit().await.map_err(ModelJobError::from)?;
        let expires=expires.and_then(|s|chrono::DateTime::parse_from_rfc3339(&s).ok()).ok_or_else(||rejected("RUN_CAPABILITY_EXPIRED"))?;
        let remaining=(expires.with_timezone(&chrono::Utc)-chrono::Utc::now()).to_std().map_err(|_|rejected("RUN_CAPABILITY_EXPIRED"))?;
        let run_budget=Duration::from_millis(budgets.run_ms);
        let duration=self.timeout.min(remaining).min(run_budget).min(Duration::from_millis(self.config.timeout_ms));
        let deadline_code=if duration==remaining{"RUN_CAPABILITY_EXPIRED"}else if duration==run_budget{"tool_time_budget_exceeded"}else{"timeout"};
        let deadline=Instant::now()+duration;
        let until=expires.timestamp_millis().min(chrono::Utc::now().timestamp_millis().saturating_add(duration.as_millis().min(i64::MAX as u128) as i64));
        let token=self.tokens.issue_once_until(driver.run_id(),&record.project_id,until).ok_or_else(||rejected("RUN_TOKEN_ALREADY_ISSUED"))?;
        let _lease=Lease{tokens:self.tokens.clone(),run_id:record.run_id.clone()};
        let context=self.guarded(driver,&token,deadline,deadline_code,self.invoke(&token,"get_context",&json!({}))).await?;
        let AgentToolOutput::Json(context)=context else{return Err(rejected("INVALID_TOOL_RESULT"))};
        let mut object_labels=BTreeMap::new();let mut crop_regions=Vec::new();
        if context["allow_object_context"]==true {
            let mut cursor=Value::Null;
            loop {
                let mut args=json!({"limit":100});if !cursor.is_null(){args["cursor"]=cursor.take();}
                let objects=self.guarded(driver,&token,deadline,deadline_code,self.invoke(&token,"list_objects",&args)).await?;
                let AgentToolOutput::Json(objects)=objects else{return Err(rejected("INVALID_TOOL_RESULT"))};
                for object in objects["items"].as_array().ok_or_else(||rejected("INVALID_TOOL_RESULT"))? {
                    let id=object["object_id"].as_str().ok_or_else(||rejected("INVALID_TOOL_RESULT"))?;
                    let label=object["label_id"].as_str().ok_or_else(||rejected("INVALID_TOOL_RESULT"))?;
                    object_labels.insert(id.to_owned(),label.to_owned());
                    if !driver.context().selected_object_ids.is_empty()
                        &&(crop_regions.len() as u64)<budgets.crops {
                        crop_regions.push((id.to_owned(),object["bbox"].clone()));
                    }
                }
                cursor=objects["next_cursor"].clone();if cursor.is_null(){break}
            }
        }
        let mut image_budget=ImageBudget{bytes:budgets.image_bytes,pixels:budgets.pixels,used:0};
        let prompt=if kind==Kind::OpenAi {json!({"type":"input_text","text":record.prompt})}else{json!({"type":"text","text":record.prompt})};
        let mut content=vec![prompt];
        if context["allow_image"]==true {
            let region=context.get("approved_image_region").cloned().unwrap_or(Value::Null);
            let image=self.guarded(driver,&token,deadline,deadline_code,self.invoke(&token,"read_region",&json!({"region":region}))).await?;
            let AgentToolOutput::Region(image)=image else{return Err(rejected("INVALID_TOOL_RESULT"))};
            let (metadata,part)=prepare_image(kind,image,&mut image_budget,None)?;self.image_event(driver,&metadata).await?;content.push(part);
            if region.is_null() {
                for (object_id,region) in crop_regions {
                    let image=self.guarded(driver,&token,deadline,deadline_code,self.invoke(&token,"read_region",&json!({"region":region}))).await?;
                    let AgentToolOutput::Region(image)=image else{return Err(rejected("INVALID_TOOL_RESULT"))};
                    let (metadata,part)=prepare_image(kind,image,&mut image_budget,Some(&object_id))?;self.image_event(driver,&metadata).await?;content.push(part);
                }
            }
        }
        let mut history=Vec::new();if kind==Kind::Mimo{history.push(json!({"role":"system","content":SYSTEM_TEXT}));}
        history.push(json!({"role":"user","content":content}));
        let (_cancel_tx,cancel)=watch::channel(false);let mut turns=Vec::new();let mut total=0usize;
        let mut candidates=BTreeSet::new();let mut call_ids=BTreeSet::new();
        let mut body=match kind {Kind::OpenAi=>openai::request_with_labels(config,&[],budgets.output_tokens,driver.labels()),Kind::Anthropic=>anthropic::request(config,&[],budgets.output_tokens),Kind::Mimo=>mimo::request(config,&[],budgets.output_tokens)};
        let history_key=if kind==Kind::OpenAi{"input"}else{"messages"};
        loop {
            if turns.len() as u64>=budgets.turns{return Err(rejected("tool_turn_budget_exceeded"))}
            body[history_key]=Value::Array(std::mem::take(&mut history));
            // Cheap early rejection only. The final authorization gate runs
            // inside post_observed under the final writer, after DNS/body prep.
            self.guarded(driver,&token,deadline,deadline_code,self.preflight(driver,kind,config)).await?;
            self.tokens.verify(&token).map_err(|error|rejected(if error.code()=="RUN_TOKEN_EXPIRED"{deadline_code}else{error.code()}))?;
            let secret=self.secret(config)?;
            let mut turn=Turn::new(kind);
            let limits=Limits{max_response_bytes:budgets.response_bytes,max_stream_bytes:budgets.stream_bytes,max_frame_bytes:1_048_576};
            let request_deadline=deadline.min(Instant::now()+Duration::from_millis(budgets.request_ms));
            let context=DispatchContext{runner:self,driver,previous:&turns,token:&token,budgets,remaining_data:budgets.total_data.saturating_sub(total),deadline_code:if request_deadline==deadline{deadline_code}else{"timeout"}};
            // post_observed owns its cancelable phases. Do not cancel its
            // irreversible first-poll/checkpoint transaction from outside.
            let result=self.http.post_observed(kind,config,&secret,&body,limits,request_deadline,&cancel,&mut turn,Some(context)).await
                .map_err(|error|if error.code=="RUN_TOKEN_EXPIRED"{rejected(context.deadline_code)}else{error.into()});
            if result.as_ref().is_err_and(|error|error.code=="event_checkpoint_failed"){return Err(rejected("event_checkpoint_failed"))}
            if !turn.attempted{return result.and_then(|_|Err(rejected("network_error")))}
            total=total.saturating_add(turn.data_bytes);turns.push(turn);
            self.checkpoint(driver,&token,kind,config,&turns,None,&secret,budgets).await?;
            result?;
            history=match body[history_key].take(){Value::Array(items)=>items,_=>unreachable!("owned request history")};
            let turn=turns.last_mut().expect("just appended");
            if let Some(actual)=turn.actual_model_id.as_deref(){if actual!=&*driver.profile().model_id{return Err(rejected("MODEL_MISMATCH"))}}
            // Validate the entire turn's IDs/arguments before any candidate
            // tool can persist output. Duplicate later calls cannot leave a
            // partially published turn behind.
            let mut arguments=Vec::with_capacity(turn.calls.len());
            for call in &turn.calls {
                if !call_ids.insert(call.id.clone()){return Err(rejected("duplicate_tool_call"))}
                let mut args:Value=serde_json::from_str(&call.arguments).map_err(|_|rejected("invalid_tool_call"))?;
                if kind==Kind::OpenAi{openai::domain_arguments(&call.name,&mut args,driver.labels(),&object_labels);}
                if call.name=="propose_changes"||call.name=="report_issues" {
                    candidate_budget(&args,&mut candidates)?;
                }
                arguments.push(args);
            }
            let mut outputs=Vec::new();let mut proposed=false;
            for (call,args) in turn.calls.iter().zip(&arguments) {
                // Provider-controlled call IDs and names are never logged.
                driver.emit(ProviderEvent{provider_event_id:String::new(),provider_seq:None,event_type:RunEventType::ToolCall,message:"authorized provider tool call".into(),data:None}).await?;
                let output=self.guarded(driver,&token,deadline,deadline_code,self.invoke(&token,&call.name,args)).await?;
                let (output,image)=match output {
                    AgentToolOutput::Json(v)=>(v,None),
                    AgentToolOutput::Region(image)=>{
                        let (meta,part)=prepare_image(kind,image,&mut image_budget,None)?;
                        self.image_event(driver,&meta).await?;(meta,Some(part))
                    }
                };
                // Independent tool JSON bound, never charged to the approved
                // cumulative SSE-data budget. Images use their own byte/pixels.
                if json_bytes(&output)>4*1024*1024{return Err(rejected("tool_result_budget_exceeded"))}
                outputs.push((output,image));proposed|=call.name=="propose_changes";
            }
            if turn.calls.is_empty() {
                let candidate:Value=serde_json::from_str(&turn.text).map_err(|_|rejected("candidate_invalid"))?;
                candidate_budget(&candidate,&mut candidates)?;
                self.guarded(driver,&token,deadline,deadline_code,self.invoke(&token,"propose_changes",&candidate)).await?;
                proposed=true;
            } else {
                history.append(&mut turn.continuation);
                match kind {Kind::OpenAi=>openai::append(&mut history,&turn.calls,outputs),Kind::Anthropic=>anthropic::append(&mut history,&turn.calls,outputs),Kind::Mimo=>mimo::append(&mut history,&turn.calls,outputs)}
            }
            if proposed{return Ok(RunOutcome::Completed)}
            let previous=turns.last_mut().expect("just appended");
            previous.calls.clear();previous.text.clear();previous.continuation.clear();previous.response_items.clear();
        }
    }
}
impl RunRunner for HttpRunner {
    fn execute<'a>(&'a self,driver:&'a RunDriver<'_>)->Pin<Box<dyn Future<Output=Result<RunOutcome,RunnerError>>+Send+'a>> {Box::pin(self.run(driver))}
}
fn candidate_budget(args:&Value,seen:&mut BTreeSet<(&'static str,String)>)->Result<(),RunnerError>{
    for field in ["changes","issues"] {
        if args[field].as_array().is_some_and(|items|items.len()>256){return Err(rejected("candidate_invalid"))}
        for item in args[field].as_array().into_iter().flatten() {
            let id=item.get(if field=="changes"{"change_id"}else{"issue_id"}).and_then(Value::as_str).ok_or_else(||rejected("candidate_invalid"))?;
            if !seen.insert((field,id.to_owned())){return Err(rejected("duplicate_candidate"))}
        }
    }
    Ok(())
}
fn json_bytes(value:&Value)->usize {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self,bytes:&[u8])->std::io::Result<usize>{self.0=self.0.saturating_add(bytes.len());Ok(bytes.len())}
        fn flush(&mut self)->std::io::Result<()>{Ok(())}
    }
    let mut counter=Counter(0);serde_json::to_writer(&mut counter,value).expect("JSON values serialize");counter.0
}
// Do not persist arbitrary upstream IDs: the normal redactor alone cannot know
// an unusually shaped secret. Receipts preserve identity only in bounded form.
fn safe_identity(value:Option<&str>,secret:&str)->Option<String>{value.filter(|s|s.len()<=256&&!s.contains(secret)&&crate::ai::redact_text(s)==*s).map(str::to_owned)}
struct ImageBudget {bytes:u64,pixels:u64,used:u64}
fn prepare_image(kind:Kind,image:AuthorizedRegion,budget:&mut ImageBudget,object_id:Option<&str>)->Result<(Value,Value),RunnerError>{
    let pixels=u64::from(image.width)*u64::from(image.height);
    if image.bytes.len() as u64>budget.bytes||budget.used.saturating_add(pixels)>budget.pixels{return Err(rejected("image_budget_exceeded"))}
    if image.mime!="image/png"||image.width==0||image.height==0||image.bytes.len()<24||image.bytes[..8]!=[137,80,78,71,13,10,26,10]||image.bytes[12..16]!=*b"IHDR"||u32::from_be_bytes(image.bytes[16..20].try_into().unwrap())!=image.width||u32::from_be_bytes(image.bytes[20..24].try_into().unwrap())!=image.height||image.transform_to_canonical.iter().any(|n|!n.is_finite()){return Err(rejected("image_invalid"))}
    budget.used+=pixels;
    let mut metadata=json!({"kind":if image.region.is_some(){"crop"}else{"full"},"object_id":object_id,"mime":image.mime,"width":image.width,"height":image.height,"region":image.region,"transform_to_canonical":image.transform_to_canonical,"pixel_count":pixels});
    let identity=json!({"kind":metadata["kind"],"region":image.region,"transform_to_canonical":image.transform_to_canonical,"bytes_sha256":crate::media::canonical::sha256_hex(&image.bytes)});
    metadata["privacy_fingerprint"]=json!(crate::media::canonical::sha256_hex(&serde_json::to_vec(&identity).expect("bounded image identity")));
    let bytes=STANDARD.encode(&image.bytes);
    let part=match kind {
        Kind::OpenAi=>json!({"type":"input_image","image_url":format!("data:image/png;base64,{bytes}"),"detail":"auto"}),
        Kind::Anthropic=>json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":bytes}}),
        Kind::Mimo=>json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{bytes}")}})
    };Ok((metadata,part))
}
