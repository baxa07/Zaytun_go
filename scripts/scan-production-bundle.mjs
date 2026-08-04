import{readdir,readFile}from'node:fs/promises';import{join}from'node:path'
const files=[];const walk=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else files.push(path)}};await walk('dist')
// Dependencies contain harmless localhost defaults and the literal `sb_secret_` key-type
// detector. Match deployable endpoints and credential-shaped values instead of keywords.
const rules=[['local endpoint',/https?:\/\/(?:localhost|127\.0\.0\.1|zaytun-go\.test)(?::\d+)?\/(?:rest|auth|realtime|storage|functions|graphql|mcp)?/i],['service-role credential',/sb_secret_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/],['private key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],['obsolete map variable',/VITE_YANDEX_GEOCODER_API_KEY/],['development staff identity',/@zaytun\.local|zaytun-local-2026/i]]
let failed=false;for(const file of files){const content=await readFile(file,'utf8').catch(()=>null);if(content===null)continue;for(const[label,pattern]of rules)if(pattern.test(content)){failed=true;console.error(`${file}: forbidden ${label} marker`)}}
if(failed)process.exit(1);console.log(`Production bundle scan passed (${files.length} files).`)
