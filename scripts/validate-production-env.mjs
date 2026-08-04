const env=process.env
const required=['VITE_DATA_PROVIDER','VITE_SUPABASE_URL','VITE_MAP_PROVIDER','VITE_YANDEX_MAPS_API_KEY','VITE_YANDEX_SEARCH_API_KEY','VITE_YANDEX_GEOSUGGEST_API_KEY','VITE_DEFAULT_MAP_LAT','VITE_DEFAULT_MAP_LNG','VITE_DEFAULT_MAP_ZOOM','VITE_PUBLIC_APP_ORIGIN']
const publicKey=env.VITE_SUPABASE_PUBLISHABLE_KEY||env.VITE_SUPABASE_ANON_KEY||''
let failed=false
const result=(name,value,format)=>{const present=Object.hasOwn(env,name),nonEmpty=Boolean(value?.trim());const valid=nonEmpty&&format(value);if(!valid)failed=true;console.log(`${name}: present=${present?'yes':'no'} non-empty=${nonEmpty?'yes':'no'} format=${valid?'valid':'invalid'}`)}
for(const name of required){const value=env[name]||'';result(name,value,current=>name==='VITE_DATA_PROVIDER'?current==='supabase':name==='VITE_MAP_PROVIDER'?current==='yandex':name==='VITE_SUPABASE_URL'||name==='VITE_PUBLIC_APP_ORIGIN'?(()=>{try{return new URL(current).protocol==='https:'}catch{return false}})():name==='VITE_DEFAULT_MAP_LAT'?Number(current)>=-90&&Number(current)<=90:name==='VITE_DEFAULT_MAP_LNG'?Number(current)>=-180&&Number(current)<=180:name==='VITE_DEFAULT_MAP_ZOOM'?Number(current)>=1&&Number(current)<=21:current.length>0)}
result(env.VITE_SUPABASE_PUBLISHABLE_KEY?'VITE_SUPABASE_PUBLISHABLE_KEY':'VITE_SUPABASE_ANON_KEY',publicKey,value=>value.length>0)
if(env.VITE_YANDEX_GEOCODER_API_KEY){failed=true;console.log('VITE_YANDEX_GEOCODER_API_KEY: present=yes obsolete=yes')}
if(failed){console.error('Production environment validation failed. Values were not printed.');process.exit(1)}
console.log('Production environment validation passed. Values were not printed.')
