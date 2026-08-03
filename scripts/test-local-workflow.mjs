import {createClient} from '@supabase/supabase-js'
import assert from 'node:assert/strict'
const url=process.env.SUPABASE_URL||'http://127.0.0.1:54321',key=process.env.SUPABASE_ANON_KEY
if(!key)throw new Error('Set SUPABASE_ANON_KEY from `supabase status -o env`')
const make=()=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
const customer=make(),restaurant=make(),dispatcher=make(),driver=make(),password='zaytun-local-2026'
for(const[c,email]of[[restaurant,'restaurant@zaytun.local'],[dispatcher,'dispatcher@zaytun.local'],[driver,'driver@zaytun.local']]){const{error}=await c.auth.signInWithPassword({email,password});assert.ifError(error)}
const payload={customer:{name:'Integration Customer',primaryPhone:'+998 90 000 00 00'},type:'DELIVERY',paymentMethod:'CASH',deliveryFee:10000,specialInstructions:'Integration test',address:{district:'Navoiy shahar',street:'Test ko‘chasi',house:'10',landmark:'Test maktabi',deliveryNotes:'Qo‘ng‘iroq qiling',latitude:40.1039,longitude:65.3688,confidence:'COMPLETE'},items:[{menuItemId:'plov',name:'Navoiy oshi',unitPrice:48000,quantity:1,modifierIds:[],modifierNames:[],instructions:''}]}
const created=await customer.rpc('create_order',{p_order:payload});assert.ifError(created.error);const orderId=created.data.id
let resolveDelivered
const deliveredEvent=new Promise((resolve,reject)=>{resolveDelivered=resolve;setTimeout(()=>reject(new Error('Timed out waiting for delivered Realtime update')),5000)})
const channel=restaurant.channel('integration-workflow').on('postgres_changes',{event:'UPDATE',schema:'public',table:'orders',filter:`id=eq.${orderId}`},event=>{if(event.new.status==='DELIVERED')resolveDelivered()})
await new Promise((resolve,reject)=>channel.subscribe(status=>{if(status==='SUBSCRIBED')resolve();if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')reject(new Error(`Realtime ${status}`))}))
const transition=async(c,status,reason=null)=>{const result=await c.rpc('transition_order',{p_order_id:orderId,p_new_status:status,p_reason:reason,p_notes:'integration'});assert.ifError(result.error)}
await transition(restaurant,'CONFIRMED');const estimate=await restaurant.rpc('set_preparation_estimate',{p_order_id:orderId,p_minutes:20});assert.ifError(estimate.error);await transition(restaurant,'PREPARING');await transition(restaurant,'READY')
const available=await dispatcher.from('drivers').select('id').eq('availability','AVAILABLE').limit(1).single();assert.ifError(available.error);const assigned=await dispatcher.rpc('assign_driver',{p_order_id:orderId,p_driver_id:available.data.id});assert.ifError(assigned.error)
const accepted=await driver.rpc('accept_assignment',{p_order_id:orderId});assert.ifError(accepted.error);await transition(driver,'PICKED_UP');await transition(driver,'ON_THE_WAY');await transition(driver,'ARRIVED');await transition(driver,'DELIVERED')
await deliveredEvent
const final=await restaurant.from('orders').select('status,payment_status,order_events(*)').eq('id',orderId).single();assert.ifError(final.error);assert.equal(final.data.status,'DELIVERED');assert.equal(final.data.payment_status,'COLLECTED');assert.equal(final.data.order_events.length,9)
const anonymousList=await customer.from('orders').select('id');assert.ok(anonymousList.error,'anonymous order listing blocked by privileges and RLS')
await restaurant.removeChannel(channel);console.log(`Local multi-client workflow passed for ${created.data.number}`);process.exit(0)
