type Environment=Record<string,string|boolean|undefined>
export type EnvironmentIssue={variable:string;message:string}
export type EnvironmentValidation={valid:boolean;issues:EnvironmentIssue[];dataProvider:'local'|'supabase';mapProvider:'mock'|'yandex'}

const text=(environment:Environment,name:string)=>typeof environment[name]==='string'?String(environment[name]).trim():''
const validUrl=(value:string,production:boolean)=>{try{const url=new URL(value);return production?url.protocol==='https:':['http:','https:'].includes(url.protocol)}catch{return false}}
const numeric=(value:string,min:number,max:number)=>value!==''&&Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max

export function validateEnvironment(environment:Environment,production=false):EnvironmentValidation{
  const issues:EnvironmentIssue[]=[]
  const dataProvider=text(environment,'VITE_DATA_PROVIDER')||'local'
  const mapProvider=text(environment,'VITE_MAP_PROVIDER')||'mock'
  const add=(variable:string,message:string)=>issues.push({variable,message})
  if(!['local','supabase'].includes(dataProvider))add('VITE_DATA_PROVIDER','local yoki supabase bo‘lishi kerak')
  if(production&&dataProvider!=='supabase')add('VITE_DATA_PROVIDER','production uchun supabase bo‘lishi kerak')
  if(dataProvider==='supabase'){
    const url=text(environment,'VITE_SUPABASE_URL')
    const publishable=text(environment,'VITE_SUPABASE_PUBLISHABLE_KEY')||text(environment,'VITE_SUPABASE_ANON_KEY')
    if(!url)add('VITE_SUPABASE_URL','kiritilmagan');else if(!validUrl(url,production))add('VITE_SUPABASE_URL',production?'HTTPS URL bo‘lishi kerak':'HTTP(S) URL bo‘lishi kerak')
    if(!publishable)add('VITE_SUPABASE_PUBLISHABLE_KEY','publishable kalit kiritilmagan')
  }
  if(!['mock','yandex'].includes(mapProvider))add('VITE_MAP_PROVIDER','mock yoki yandex bo‘lishi kerak')
  if(production&&mapProvider!=='yandex')add('VITE_MAP_PROVIDER','production uchun yandex aniq tanlanishi kerak')
  if(mapProvider==='yandex')for(const variable of ['VITE_YANDEX_MAPS_API_KEY','VITE_YANDEX_SEARCH_API_KEY','VITE_YANDEX_GEOSUGGEST_API_KEY'])if(!text(environment,variable))add(variable,'kiritilmagan')
  if(!numeric(text(environment,'VITE_DEFAULT_MAP_LAT'),-90,90))add('VITE_DEFAULT_MAP_LAT','-90 dan 90 gacha son bo‘lishi kerak')
  if(!numeric(text(environment,'VITE_DEFAULT_MAP_LNG'),-180,180))add('VITE_DEFAULT_MAP_LNG','-180 dan 180 gacha son bo‘lishi kerak')
  if(!numeric(text(environment,'VITE_DEFAULT_MAP_ZOOM'),1,21))add('VITE_DEFAULT_MAP_ZOOM','1 dan 21 gacha son bo‘lishi kerak')
  if(production){const origin=text(environment,'VITE_PUBLIC_APP_ORIGIN');if(!origin)add('VITE_PUBLIC_APP_ORIGIN','production domeni kiritilmagan');else if(!validUrl(origin,true))add('VITE_PUBLIC_APP_ORIGIN','HTTPS origin bo‘lishi kerak');const turnstile=text(environment,'VITE_TURNSTILE_SITE_KEY');if(!turnstile)add('VITE_TURNSTILE_SITE_KEY','kiritilmagan');else if(!/^[0-9]x[A-Za-z0-9_-]{15,}$/.test(turnstile))add('VITE_TURNSTILE_SITE_KEY','haqiqiy Cloudflare site key bo‘lishi kerak')}
  return{valid:issues.length===0,issues,dataProvider:(dataProvider==='supabase'?'supabase':'local'),mapProvider:(mapProvider==='yandex'?'yandex':'mock')}
}

export const runtimeEnvironment=validateEnvironment(import.meta.env,false)
