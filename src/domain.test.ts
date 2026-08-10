import {describe,expect,it} from 'vitest'
import {addCartLine,calculateOrderTotal,canTransition,createEvent,createIssue,deliveryAddressWasResubmitted,isDeliveryAddressRevisable,publicMenuState,resolveOrderSubmissionMode,transitionOrder,validateAddress,validateDeliveryLocation,validateOrderInput,type CartItem,type CustomerAddress,type Order} from './domain'

const address:CustomerAddress={customerName:'Ali',primaryPhone:'+998901234567',district:'Navoiy sh.',street:'Navoiy ko‘chasi',house:'12',landmark:'Bozor yonida',deliveryNotes:'',latitude:40.1,longitude:65.3,confidence:'COMPLETE',pinConfirmedAt:'2026-08-04T08:00:00Z',locationProvider:'mock',deliveryZoneResult:'ELIGIBLE'}
const order:Order={id:'o1',number:'ZG-1',customer:{id:'c1',name:'Ali',primaryPhone:'+998901234567'},type:'DELIVERY',address,items:[],subtotal:0,deliveryFee:0,total:0,paymentMethod:'CASH',paymentStatus:'PENDING',specialInstructions:'',status:'NEW',createdAt:'2026-08-03T10:00:00Z',events:[],issues:[]}
describe('order state machine',()=>{it('allows canonical legal transitions',()=>{expect(canTransition('NEW','CONFIRMED')).toBe(true);expect(canTransition('READY','DRIVER_ASSIGNED')).toBe(true);expect(canTransition('ARRIVED','DELIVERED')).toBe(true)});it('rejects illegal transitions',()=>{expect(()=>transitionOrder(order,'DELIVERED','RESTAURANT','staff')).toThrow(/Illegal transition/)});it('creates immutable events after transitions',()=>{const changed=transitionOrder(order,'CONFIRMED','RESTAURANT','staff');expect(changed.events).toHaveLength(1);expect(changed.events[0]).toMatchObject({orderId:'o1',previousStatus:'NEW',newStatus:'CONFIRMED'});expect(order.events).toHaveLength(0)})})
describe('validation',()=>{it('validates all required delivery address fields',()=>{const invalid={...address,customerName:'',district:'',street:'',house:'',landmark:'',deliveryNotes:'',latitude:undefined,longitude:undefined};expect(Object.keys(validateAddress(invalid))).toEqual(expect.arrayContaining(['customerName','district','street','house','landmark','coordinates']))});it('allows pickup without an address but requires payment',()=>{expect(validateOrderInput('PICKUP',undefined,'CASH')).toEqual({});expect(validateOrderInput('PICKUP',undefined,undefined)).toHaveProperty('paymentMethod')});it('requires address for delivery',()=>{expect(validateOrderInput('DELIVERY',undefined,'CASH')).toHaveProperty('address')})})
describe('delivery rules and totals',()=>{it('requires a delivery issue description',()=>{expect(()=>createIssue('o1','ADDRESS_INCORRECT',' ','driver')).toThrow();expect(createIssue('o1','CUSTOMER_NOT_ANSWERING','No answer','driver')).toMatchObject({orderId:'o1',type:'CUSTOMER_NOT_ANSWERING'})});it('calculates item quantities plus delivery',()=>{expect(calculateOrderTotal([{unitPrice:20000,quantity:2},{unitPrice:5000,quantity:1}],10000)).toBe(55000)})})
describe('public menu availability',()=>{it('distinguishes an unpublished empty menu from loading and transport errors',()=>{expect(publicMenuState(false,'',0,0)).toBe('LOADING');expect(publicMenuState(true,'',0,0)).toBe('UNPUBLISHED');expect(publicMenuState(true,'network',0,0)).toBe('ERROR');expect(publicMenuState(true,'',1,1)).toBe('READY')})})
describe('delivery location validation (address revision editor)',()=>{it('does not require customer contact fields, unlike full checkout validation',()=>{const location={district:'Navoiy',street:'Test ko‘chasi',house:'1',landmark:'Kirish',deliveryNotes:'',latitude:40.1,longitude:65.3,pinConfirmedAt:'2026-08-08T09:00:00Z',deliveryZoneResult:'ELIGIBLE' as const};expect(validateDeliveryLocation(location)).toEqual({})});it('still requires a freshly confirmed pin',()=>{const location={district:'Navoiy',street:'Test ko‘chasi',house:'1',landmark:'Kirish',deliveryNotes:'',latitude:40.1,longitude:65.3,pinConfirmedAt:undefined,deliveryZoneResult:'ELIGIBLE' as const};expect(validateDeliveryLocation(location)).toHaveProperty('pinConfirmation')});it('validateAddress still requires customer contact fields after the split',()=>{const invalid={...address,customerName:'',primaryPhone:''};expect(Object.keys(validateAddress(invalid))).toEqual(expect.arrayContaining(['customerName','primaryPhone']))})})
describe('cart line identity',()=>{const line=(id:string,instructions:string,quantity=1):CartItem=>({id,menuItemId:'plov',name:'Osh',unitPrice:48000,quantity,modifierIds:[],modifierNames:[],instructions});it('merges matching lines while preserving existing items and enforcing the maximum',()=>{const result=addCartLine([line('first','piyozsiz',2),{...line('other',''),id:'other',menuItemId:'tea'}],line('new','piyozsiz',4),5);expect(result).toHaveLength(2);expect(result[0].quantity).toBe(5);expect(result[1].menuItemId).toBe('tea')});it('keeps differently instructed products as separate lines',()=>{expect(addCartLine([line('first','piyozsiz')],line('second','achchiq'),50)).toHaveLength(2)})})
describe('delivery address revision eligibility (stale-state gate)',()=>{
  it('requires DELIVERY + NEW + CLARIFICATION_REQUESTED all at once',()=>{
    expect(isDeliveryAddressRevisable({type:'DELIVERY',status:'NEW',deliveryReviewStatus:'CLARIFICATION_REQUESTED'})).toBe(true)
  })
  it('rejects a cancelled order even if delivery_review_status is stuck at CLARIFICATION_REQUESTED',()=>{
    expect(isDeliveryAddressRevisable({type:'DELIVERY',status:'CANCELLED',deliveryReviewStatus:'CLARIFICATION_REQUESTED'})).toBe(false)
  })
  it('rejects pickup and every other review status',()=>{
    expect(isDeliveryAddressRevisable({type:'PICKUP',status:'NEW',deliveryReviewStatus:'CLARIFICATION_REQUESTED'})).toBe(false)
    expect(isDeliveryAddressRevisable({type:'DELIVERY',status:'NEW',deliveryReviewStatus:'REVIEW_REQUIRED'})).toBe(false)
    expect(isDeliveryAddressRevisable({type:'DELIVERY',status:'NEW',deliveryReviewStatus:'APPROVED'})).toBe(false)
  })
})
describe('order submission mode (customer_auth_required rollout gate)',()=>{
  it('always selects PUBLIC when the flag is off, authenticated or not',()=>{
    expect(resolveOrderSubmissionMode(false,false)).toBe('PUBLIC')
    expect(resolveOrderSubmissionMode(false,true)).toBe('PUBLIC')
  })
  it('selects CUSTOMER when the flag is on and a verified customer session exists',()=>{
    expect(resolveOrderSubmissionMode(true,true)).toBe('CUSTOMER')
  })
  it('demands auth when the flag is on and there is no customer session',()=>{
    expect(resolveOrderSubmissionMode(true,false)).toBe('REQUIRES_CUSTOMER_AUTH')
  })
})
describe('resubmitted-address cue (order_events inspection)',()=>{
  const withEvents=(...notes:(string|undefined)[]):Pick<Order,'events'>=>({events:notes.map((n,i)=>({...createEvent('o1','NEW','NEW','RESTAURANT','staff-1',undefined,n),timestamp:`2026-08-08T0${i}:00:00.000Z`}))})
  it('is false for a brand-new order awaiting its first review',()=>{
    expect(deliveryAddressWasResubmitted(withEvents(undefined))).toBe(false)
  })
  it('is true right after the customer revises following a clarification request',()=>{
    expect(deliveryAddressWasResubmitted(withEvents('DELIVERY_CLARIFICATION_REQUESTED','DELIVERY_ADDRESS_REVISED'))).toBe(true)
  })
  it('is false again once staff has approved or rejected since the last revision',()=>{
    expect(deliveryAddressWasResubmitted(withEvents('DELIVERY_ADDRESS_REVISED','DELIVERY_REVIEW_APPROVED'))).toBe(false)
    expect(deliveryAddressWasResubmitted(withEvents('DELIVERY_ADDRESS_REVISED','DELIVERY_REVIEW_REJECTED'))).toBe(false)
  })
})
