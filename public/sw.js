// The cache-name suffix below is substituted at build time (see
// vite.config.ts's stampServiceWorker plugin) with the deployed commit
// SHA -- this file
// would otherwise be byte-identical across every deploy (a static file
// copied verbatim from public/), so the browser's own SW update check
// could never detect a new version at all: this was the actual root
// cause of an already-open tab running a stale bundle indefinitely after
// a production deploy, not the fetch/cache strategy below (which was
// already correct -- content-hashed /assets/* cached cache-first forever,
// navigations always network-first with cache:'no-store').
const CACHE='zaytun-go-static-__ZAYTUN_BUILD_ID__';const STATIC=['/manifest.webmanifest','/icon.svg','/offline.html'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(STATIC))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')void self.skipWaiting()});
self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==self.location.origin)return;if(request.mode==='navigate'){event.respondWith(fetch(request,{cache:'no-store'}).catch(()=>caches.match('/offline.html')));return}if(url.pathname.startsWith('/assets/')||STATIC.includes(url.pathname)){event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok){const copy=response.clone();void caches.open(CACHE).then(cache=>cache.put(request,copy))}return response})));}});
