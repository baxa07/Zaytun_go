import{createClient}from'@supabase/supabase-js'
import assert from'node:assert/strict'
const url=process.env.SUPABASE_URL||'http://127.0.0.1:54321',key=process.env.SUPABASE_ANON_KEY
if(!key)throw new Error('Set SUPABASE_ANON_KEY from `supabase status -o env`')
const make=()=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
const customer=make(),restaurant=make(),driver=make()
for(const[client,email]of[[restaurant,'restaurant@zaytun.local'],[driver,'driver@zaytun.local']]){const{error}=await client.auth.signInWithPassword({email,password:'zaytun-local-2026'});assert.ifError(error)}
const payload={customer:{name:'Pickup Integration',primaryPhone:'+998900000099'},type:'PICKUP',paymentMethod:'CARD_AT_PICKUP',items:[{menuItemId:'plov',quantity:1,modifierIds:[],instructions:'Issiq saqlang'}]}
const created=await customer.rpc('create_public_order',{p_order:payload});assert.ifError(created.error);assert.equal(created.data.subtotal,48000);assert.equal(created.data.deliveryFee,0);assert.equal(created.data.total,48000)
const id=created.data.id
const advance=async status=>{const result=await restaurant.rpc('transition_order',{p_order_id:id,p_new_status:status,p_reason:null,p_notes:'pickup integration'});assert.ifError(result.error)}
for(const status of['CONFIRMED','PREPARING','READY','COLLECTED'])await advance(status)
const final=await restaurant.from('orders').select('status,payment_method,payment_status,assigned_driver_id,order_events(*)').eq('id',id).single();assert.ifError(final.error);assert.equal(final.data.status,'COLLECTED');assert.equal(final.data.payment_method,'CARD_AT_PICKUP');assert.equal(final.data.payment_status,'COLLECTED');assert.equal(final.data.assigned_driver_id,null);assert.equal(final.data.order_events.length,5)
const driverOrders=await driver.from('orders').select('id');assert.ifError(driverOrders.error);assert.ok(driverOrders.data.every(order=>order.id!==id),'driver cannot see pickup order')
const tracked=await customer.rpc('get_order_tracking',{p_order_id:id,p_tracking_token:created.data.trackingToken});assert.ifError(tracked.error);assert.equal(tracked.data.status,'COLLECTED');assert.equal(tracked.data.order_type,'PICKUP');assert.equal(tracked.data.assigned_driver_id,null);assert.deepEqual(tracked.data.customer_addresses,[])
console.log(`Local pickup multi-client workflow passed for ${created.data.number}`)
