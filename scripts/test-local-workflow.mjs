import {createClient} from '@supabase/supabase-js'
import assert from 'node:assert/strict'
const url=process.env.SUPABASE_URL||'http://127.0.0.1:54321',key=process.env.SUPABASE_ANON_KEY
if(!key)throw new Error('Set SUPABASE_ANON_KEY from `supabase status -o env`')
const make=()=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
const customer=make(),restaurant=make(),dispatcher=make(),driver=make(),password='zaytun-local-2026'
for(const[c,email]of[[restaurant,'restaurant@zaytun.local'],[dispatcher,'dispatcher@zaytun.local'],[driver,'driver@zaytun.local']]){const{error}=await c.auth.signInWithPassword({email,password});assert.ifError(error)}
const transitionOrder=async(c,id,status,reason=null)=>{const result=await c.rpc('transition_order',{p_order_id:id,p_new_status:status,p_reason:reason,p_notes:'integration'});assert.ifError(result.error)}
const existingActive=await driver.from('orders').select('id,status,assignment_accepted_at').not('status','in','(DELIVERED,CANCELLED,REJECTED,DELIVERY_FAILED,RETURNED)');assert.ifError(existingActive.error)
for(const active of existingActive.data){if(active.status==='DRIVER_ASSIGNED'){if(!active.assignment_accepted_at){const accepted=await driver.rpc('accept_assignment',{p_order_id:active.id});assert.ifError(accepted.error)}await transitionOrder(driver,active.id,'PICKED_UP');active.status='PICKED_UP'}if(active.status==='PICKED_UP'){await transitionOrder(driver,active.id,'ON_THE_WAY');active.status='ON_THE_WAY'}if(active.status==='ON_THE_WAY'){await transitionOrder(driver,active.id,'ARRIVED');active.status='ARRIVED'}if(active.status==='ARRIVED')await transitionOrder(driver,active.id,'DELIVERED')}
const payload={customer:{name:'Integration Customer',primaryPhone:'+998 90 000 00 00'},type:'DELIVERY',paymentMethod:'CASH',specialInstructions:'Integration test',address:{district:'Navoiy shahar',street:'Test ko‘chasi',house:'10',landmark:'Test maktabi',deliveryNotes:'Qo‘ng‘iroq qiling',latitude:40.1039,longitude:65.3688,confidence:'COMPLETE',pinConfirmedAt:new Date().toISOString(),locationProvider:'mock'},items:[{menuItemId:'plov',quantity:3,modifierIds:[],instructions:''}]}
const created=await customer.rpc('create_order',{p_order:payload});assert.ifError(created.error);const orderId=created.data.id
assert.equal(created.data.subtotal,144000);assert.equal(created.data.deliveryFee,0);assert.equal(created.data.total,144000);assert.equal(created.data.items[0].unitPrice,48000)
const anonymousOrders=await customer.from('orders').select('id');assert.ok(anonymousOrders.error,'anonymous order listing is rejected')
const anonymousDrivers=await customer.from('drivers').select('id');assert.ok(anonymousDrivers.error,'anonymous driver listing is rejected')
const tracked=await customer.rpc('get_order_tracking',{p_order_id:orderId,p_tracking_token:created.data.trackingToken});assert.ifError(tracked.error);assert.equal(tracked.data.id,orderId);assert.deepEqual(tracked.data.customer_addresses,[]);assert.equal(tracked.data.assigned_driver_id,null)
const invalidTracking=await customer.rpc('get_order_tracking',{p_order_id:orderId,p_tracking_token:'ffffffff-ffff-ffff-ffff-ffffffffffff'});assert.ifError(invalidTracking.error);assert.equal(invalidTracking.data,null)
let resolveDelivered
const deliveredEvent=new Promise((resolve,reject)=>{resolveDelivered=resolve;setTimeout(()=>reject(new Error('Timed out waiting for delivered Realtime update')),10000)})
const channel=restaurant.channel('integration-workflow').on('postgres_changes',{event:'UPDATE',schema:'public',table:'orders',filter:`id=eq.${orderId}`},event=>{if(event.new.status==='DELIVERED')resolveDelivered()})
await new Promise((resolve,reject)=>channel.subscribe(status=>{if(status==='SUBSCRIBED')resolve();if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')reject(new Error(`Realtime ${status}`))}))
// Realtime can report SUBSCRIBED just before the replication listener is ready
// after a local database restart. Give that listener a bounded settling window.
await new Promise(resolve=>setTimeout(resolve,250))
const transition=(c,status,reason=null)=>transitionOrder(c,orderId,status,reason)
const reviewed=await dispatcher.rpc('review_delivery_request',{p_order_id:orderId,p_approved:true,p_reason:null});assert.ifError(reviewed.error)
await transition(restaurant,'CONFIRMED');const estimate=await restaurant.rpc('set_preparation_estimate',{p_order_id:orderId,p_minutes:20});assert.ifError(estimate.error);await transition(restaurant,'PREPARING');await transition(restaurant,'READY')
const available=await dispatcher.from('drivers').select('id').eq('availability','AVAILABLE').limit(1).single();assert.ifError(available.error);const assigned=await dispatcher.rpc('assign_driver',{p_order_id:orderId,p_driver_id:available.data.id});assert.ifError(assigned.error)
const driverOrders=await driver.from('orders').select('id,assigned_driver_id');assert.ifError(driverOrders.error);assert.ok(driverOrders.data.length>0);assert.ok(driverOrders.data.every(order=>order.assigned_driver_id===available.data.id),'driver sees only own orders')
const driverRoster=await driver.from('drivers').select('id');assert.ifError(driverRoster.error);assert.deepEqual(driverRoster.data.map(row=>row.id),[available.data.id])
const accepted=await driver.rpc('accept_assignment',{p_order_id:orderId});assert.ifError(accepted.error);await transition(driver,'PICKED_UP');await transition(driver,'ON_THE_WAY');await transition(driver,'ARRIVED');await transition(driver,'DELIVERED')
await deliveredEvent
const final=await restaurant.from('orders').select('status,payment_status,delivery_review_status,order_events(*)').eq('id',orderId).single();assert.ifError(final.error);assert.equal(final.data.status,'DELIVERED');assert.equal(final.data.payment_status,'COLLECTED');assert.equal(final.data.delivery_review_status,'APPROVED');assert.equal(final.data.order_events.length,10)
await restaurant.removeChannel(channel);console.log(`Local multi-client workflow passed for ${created.data.number}`);process.exit(0)
