const UPDATE_EVENT='zaytun-go:update-ready'
let waitingWorker:ServiceWorker|null=null
let updateRequested=false
export const requestApplicationUpdate=()=>{if(waitingWorker){updateRequested=true;waitingWorker.postMessage({type:'SKIP_WAITING'})}}
export function registerProductionServiceWorker(){if(!('serviceWorker'in navigator))return;window.addEventListener('load',()=>{void navigator.serviceWorker.register('/sw.js').then(registration=>{const announce=()=>{if(registration.waiting){waitingWorker=registration.waiting;window.dispatchEvent(new Event(UPDATE_EVENT))}};announce();registration.addEventListener('updatefound',()=>{const installing=registration.installing;installing?.addEventListener('statechange',()=>{if(installing.state==='installed'&&navigator.serviceWorker.controller)announce()})});navigator.serviceWorker.addEventListener('controllerchange',()=>{if(updateRequested)window.location.reload()})}).catch(()=>window.dispatchEvent(new CustomEvent('zaytun-go:service-worker-error')))});}
export async function clearDevelopmentServiceWorkers(){if(!('serviceWorker'in navigator))return;const registrations=await navigator.serviceWorker.getRegistrations();await Promise.all(registrations.map(registration=>registration.unregister()));for(const key of await caches.keys())if(key.startsWith('zaytun-go-'))await caches.delete(key)}
export{UPDATE_EVENT}
