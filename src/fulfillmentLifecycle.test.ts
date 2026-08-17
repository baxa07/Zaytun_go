import{describe,expect,it}from'vitest'
import{customerDeliveryStageEventMatchers,customerDeliveryStageIndex,customerDeliveryStages,deliveryDispatchPhase,fulfillmentTimeline,isNormalDeliveryStatus,isRemotePaymentMethod,orderExceptions,paymentLabel,paymentMethodsForFulfillment,pickupPaymentGuidance,remotePaymentCustomerNotice,remotePaymentStaffHint}from'./fulfillmentLifecycle'
import{developmentRestaurantConfig}from'./data'
import type{OrderEvent,OrderStatus}from'./domain'
describe('fulfillment timeline',()=>{it('contains exactly five pickup-only stages',()=>{const stages=fulfillmentTimeline('PICKUP');expect(stages.map(x=>x.label)).toEqual(['Buyurtma qabul qilindi','Tasdiqlandi','Tayyorlanmoqda','Olib ketishga tayyor','Olib ketildi']);expect(stages.map(x=>x.status)).not.toEqual(expect.arrayContaining(['DRIVER_ASSIGNED','ON_THE_WAY','ARRIVED','DELIVERED']))});it('retains delivery stages',()=>expect(fulfillmentTimeline('DELIVERY').map(x=>x.status)).toEqual(expect.arrayContaining(['DRIVER_ASSIGNED','ON_THE_WAY','ARRIVED','DELIVERED'])));it('provides physical-payment guidance',()=>{expect(pickupPaymentGuidance('TERMINAL')).toContain('terminal');expect(pickupPaymentGuidance('CASH')).toContain('naqd pulda')})})
describe('fulfillment payments',()=>{
  it('offers restaurant card only for pickup, and Click/Payme only for delivery',()=>{
    expect(paymentMethodsForFulfillment(developmentRestaurantConfig,'PICKUP')).toEqual(['CASH','TERMINAL'])
    expect(paymentMethodsForFulfillment(developmentRestaurantConfig,'DELIVERY')).toEqual(['CASH','CLICK','PAYME'])
  })
  it('renders customer-friendly labels for Click/Payme, distinct from the existing methods',()=>{
    expect(paymentLabel('CLICK')).toBe('Click')
    expect(paymentLabel('PAYME')).toBe('Payme')
    expect(paymentLabel('CLICK',true)).toBe('Click')
    expect(paymentLabel('PAYME',true)).toBe('Payme')
    expect(paymentLabel('CASH')).toBe('Naqd pul')
  })
  it('flags only Click/Payme as a remote (unverified) payment intent',()=>{
    expect(isRemotePaymentMethod('CLICK')).toBe(true)
    expect(isRemotePaymentMethod('PAYME')).toBe(true)
    expect(isRemotePaymentMethod('CASH')).toBe(false)
    expect(isRemotePaymentMethod('CARD_AT_PICKUP')).toBe(false)
  })
  it('never tells the customer to transfer money or exposes payment-account details',()=>{
    expect(remotePaymentCustomerNotice).not.toMatch(/karta|hisob|raqam|o‘tkazing/i)
    expect(remotePaymentCustomerNotice).toContain('tekshirib tasdiqlaydi')
    expect(remotePaymentStaffHint).toContain('qo‘ng‘iroq')
  })
})

// --- Phase D: customer-facing 7-stage delivery timeline ---
let seq=0
const ev=(previousStatus:OrderStatus|null,newStatus:OrderStatus,notes?:string):OrderEvent=>({id:`e${++seq}`,orderId:'o1',actorType:'SYSTEM',actorId:'system',previousStatus,newStatus,timestamp:`2026-08-09T00:${String(seq).padStart(2,'0')}:00.000Z`,notes})
const STAGE_LABELS=['Buyurtma qabul qilindi','Manzil tasdiqlandi','Tayyorlanmoqda','Haydovchi restoranga keldi','Haydovchiga berildi','Yo‘lda','Yetib keldi','Yetkazildi']

describe('customer delivery timeline: event-driven restaurant arrival',()=>{
  it('has the eight approved labels in order',()=>{
    expect(customerDeliveryStages.map(s=>s.label)).toEqual(STAGE_LABELS)
  })
  it('credits restaurant arrival only from its immutable event',()=>{
    const arrivalIndex=customerDeliveryStages.findIndex(s=>s.label==='Haydovchi restoranga keldi')
    expect(customerDeliveryStageEventMatchers[arrivalIndex](ev('PREPARING','PREPARING','DRIVER_ARRIVED_RESTAURANT'))).toBe(true)
    expect(customerDeliveryStageEventMatchers[arrivalIndex](ev('DRIVER_ASSIGNED','PICKED_UP'))).toBe(false)
  })
})

describe('customer delivery timeline: review-state mapping',()=>{
  it('NEW + REVIEW_REQUIRED stays at stage 1 only',()=>{
    expect(customerDeliveryStageIndex({status:'NEW',deliveryReviewStatus:'REVIEW_REQUIRED',events:[ev(null,'NEW')]})).toBe(0)
  })
  it('NEW + CLARIFICATION_REQUESTED stays at stage 1 only',()=>{
    expect(customerDeliveryStageIndex({status:'NEW',deliveryReviewStatus:'CLARIFICATION_REQUESTED',events:[ev(null,'NEW')]})).toBe(0)
  })
  it('NEW + APPROVED reaches stage 2 (Manzil tasdiqlandi) even though order status is still NEW',()=>{
    const index=customerDeliveryStageIndex({status:'NEW',deliveryReviewStatus:'APPROVED',events:[ev(null,'NEW'),ev('NEW','NEW','DELIVERY_REVIEW_APPROVED')]})
    expect(index).toBe(1)
    expect(customerDeliveryStages[index].label).toBe('Manzil tasdiqlandi')
  })
})

describe('customer delivery timeline: kitchen states collapse into stage 3',()=>{
  const base={deliveryReviewStatus:'APPROVED' as const,events:[ev(null,'NEW'),ev('NEW','NEW','DELIVERY_REVIEW_APPROVED')]}
  it.each<[OrderStatus]>([['CONFIRMED'],['PREPARING'],['READY'],['DRIVER_ASSIGNED']])('%s maps to stage 3 (Tayyorlanmoqda), not a distinct step',(status)=>{
    const index=customerDeliveryStageIndex({...base,status})
    expect(index).toBe(2)
    expect(customerDeliveryStages[index].label).toBe('Tayyorlanmoqda')
  })
})

describe('customer delivery timeline: Haydovchiga berildi begins at PICKED_UP, not DRIVER_ASSIGNED',()=>{
  const base={deliveryReviewStatus:'APPROVED' as const,events:[ev(null,'NEW'),ev('NEW','NEW','DELIVERY_REVIEW_APPROVED')]}
  it('DRIVER_ASSIGNED is still stage 3, not Haydovchiga berildi',()=>{
    const index=customerDeliveryStageIndex({...base,status:'DRIVER_ASSIGNED'})
    expect(customerDeliveryStages[index].label).not.toBe('Haydovchiga berildi')
    expect(customerDeliveryStages[index].label).toBe('Tayyorlanmoqda')
  })
  it('PICKED_UP is exactly Haydovchiga berildi',()=>{
    const index=customerDeliveryStageIndex({...base,status:'PICKED_UP'})
    expect(index).toBe(4)
    expect(customerDeliveryStages[index].label).toBe('Haydovchiga berildi')
  })
})

describe('customer delivery timeline: remaining driver states',()=>{
  const base={deliveryReviewStatus:'APPROVED' as const,events:[ev(null,'NEW'),ev('NEW','NEW','DELIVERY_REVIEW_APPROVED')]}
  it('ON_THE_WAY is stage 5 (Yo‘lda)',()=>expect(customerDeliveryStages[customerDeliveryStageIndex({...base,status:'ON_THE_WAY'})].label).toBe('Yo‘lda'))
  it('ARRIVED is stage 6 (Yetib keldi)',()=>expect(customerDeliveryStages[customerDeliveryStageIndex({...base,status:'ARRIVED'})].label).toBe('Yetib keldi'))
  it('DELIVERED is stage 7 (Yetkazildi), the terminal success stage',()=>{
    const index=customerDeliveryStageIndex({...base,status:'DELIVERED'})
    expect(index).toBe(7)
    expect(customerDeliveryStages[index].label).toBe('Yetkazildi')
  })
})

describe('customer delivery timeline: exceptional states never fake later progress',()=>{
  it('REJECTED before approval never shows Manzil tasdiqlandi as reached',()=>{
    const events=[ev(null,'NEW'),ev('NEW','REJECTED')]
    const index=customerDeliveryStageIndex({status:'REJECTED',deliveryReviewStatus:'REJECTED',events})
    expect(index).toBe(0)
    expect(customerDeliveryStages[index].label).not.toBe('Manzil tasdiqlandi')
  })
  it('an order rejected after genuine address approval still credits the approval that actually happened',()=>{
    const events=[ev(null,'NEW'),ev('NEW','NEW','DELIVERY_REVIEW_APPROVED'),ev('NEW','REJECTED')]
    const index=customerDeliveryStageIndex({status:'REJECTED',deliveryReviewStatus:'APPROVED',events})
    expect(customerDeliveryStages[index].label).toBe('Manzil tasdiqlandi')
  })
  it('CANCELLED after reaching PREPARING is pinned at Tayyorlanmoqda, not further',()=>{
    const events=[ev(null,'NEW'),ev('NEW','NEW','DELIVERY_REVIEW_APPROVED'),ev('NEW','CONFIRMED'),ev('CONFIRMED','PREPARING'),ev('PREPARING','CANCELLED')]
    const index=customerDeliveryStageIndex({status:'CANCELLED',deliveryReviewStatus:'APPROVED',events})
    expect(customerDeliveryStages[index].label).toBe('Tayyorlanmoqda')
    expect(customerDeliveryStages[index].label).not.toBe('Yetkazildi')
  })
  it('DELIVERY_FAILED after ON_THE_WAY keeps the last legitimate stage, not Yetkazildi',()=>{
    const events=[ev(null,'NEW'),ev('NEW','NEW','DELIVERY_REVIEW_APPROVED'),ev('NEW','CONFIRMED'),ev('CONFIRMED','PREPARING'),ev('PREPARING','READY'),ev('READY','DRIVER_ASSIGNED'),ev('DRIVER_ASSIGNED','PICKED_UP'),ev('PICKED_UP','ON_THE_WAY'),ev('ON_THE_WAY','DELIVERY_FAILED')]
    const index=customerDeliveryStageIndex({status:'DELIVERY_FAILED',deliveryReviewStatus:'APPROVED',events})
    expect(customerDeliveryStages[index].label).toBe('Yo‘lda')
    expect(customerDeliveryStages[index].label).not.toBe('Yetkazildi')
  })
  it('RETURNED (reached via DELIVERY_FAILED, two hops back) keeps the last normal stage before failure, not Yetkazildi',()=>{
    const events=[ev(null,'NEW'),ev('NEW','NEW','DELIVERY_REVIEW_APPROVED'),ev('NEW','CONFIRMED'),ev('CONFIRMED','PREPARING'),ev('PREPARING','READY'),ev('READY','DRIVER_ASSIGNED'),ev('DRIVER_ASSIGNED','PICKED_UP'),ev('PICKED_UP','ON_THE_WAY'),ev('ON_THE_WAY','ARRIVED'),ev('ARRIVED','DELIVERY_FAILED'),ev('DELIVERY_FAILED','RETURNED')]
    const index=customerDeliveryStageIndex({status:'RETURNED',deliveryReviewStatus:'APPROVED',events})
    expect(customerDeliveryStages[index].label).toBe('Yetib keldi')
    expect(customerDeliveryStages[index].label).not.toBe('Yetkazildi')
  })
})

describe('isNormalDeliveryStatus',()=>{
  it('is true for the nine normal delivery statuses and false for exceptional ones',()=>{
    (['NEW','CONFIRMED','PREPARING','READY','DRIVER_ASSIGNED','PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED'] as OrderStatus[]).forEach(status=>
      expect(isNormalDeliveryStatus({type:'DELIVERY',status})).toBe(true))
    ;(['REJECTED','CANCELLED','DELIVERY_FAILED','RETURNED'] as OrderStatus[]).forEach(status=>
      expect(isNormalDeliveryStatus({type:'DELIVERY',status})).toBe(false))
  })
  it('is always false for pickup regardless of status',()=>{
    expect(isNormalDeliveryStatus({type:'PICKUP',status:'NEW'})).toBe(false)
    expect(isNormalDeliveryStatus({type:'PICKUP',status:'COLLECTED'})).toBe(false)
  })
})

describe('pickup isolation from the 7-stage delivery timeline',()=>{
  it('pickup keeps its own five-stage timeline and never gains a delivery-only label',()=>{
    const pickupLabels=fulfillmentTimeline('PICKUP').map(s=>s.label)
    expect(pickupLabels).toEqual(['Buyurtma qabul qilindi','Tasdiqlandi','Tayyorlanmoqda','Olib ketishga tayyor','Olib ketildi'])
    for(const deliveryOnlyLabel of['Manzil tasdiqlandi','Haydovchiga berildi','Yo‘lda','Yetib keldi'])
      expect(pickupLabels).not.toContain(deliveryOnlyLabel)
  })
})

describe('Smart Dispatch Phase 5: deliveryDispatchPhase renders canonical backend state only',()=>{
  it('is null for PICKUP regardless of status',()=>{
    expect(deliveryDispatchPhase({type:'PICKUP',status:'READY',assignmentAcceptedAt:undefined})).toBeNull()
    expect(deliveryDispatchPhase({type:'PICKUP',status:'COLLECTED',assignmentAcceptedAt:undefined})).toBeNull()
  })
  it('is SEARCHING at READY (no driver yet)',()=>{
    expect(deliveryDispatchPhase({type:'DELIVERY',status:'READY',assignmentAcceptedAt:undefined})).toBe('SEARCHING')
  })
  it('distinguishes ASSIGNED (not yet accepted) from ACCEPTED using assignmentAcceptedAt',()=>{
    expect(deliveryDispatchPhase({type:'DELIVERY',status:'DRIVER_ASSIGNED',assignmentAcceptedAt:undefined})).toBe('ASSIGNED')
    expect(deliveryDispatchPhase({type:'DELIVERY',status:'DRIVER_ASSIGNED',assignmentAcceptedAt:'2026-08-13T00:00:00Z'})).toBe('ACCEPTED')
  })
  it('maps PICKED_UP/ON_THE_WAY/ARRIVED straight through',()=>{
    expect(deliveryDispatchPhase({type:'DELIVERY',status:'PICKED_UP',assignmentAcceptedAt:'x'})).toBe('PICKED_UP')
    expect(deliveryDispatchPhase({type:'DELIVERY',status:'ON_THE_WAY',assignmentAcceptedAt:'x'})).toBe('ON_THE_WAY')
    expect(deliveryDispatchPhase({type:'DELIVERY',status:'ARRIVED',assignmentAcceptedAt:'x'})).toBe('ARRIVED')
  })
  it('is null once DELIVERED or for any other status -- restaurant gets no courier lifecycle buttons once finished',()=>{
    expect(deliveryDispatchPhase({type:'DELIVERY',status:'DELIVERED',assignmentAcceptedAt:'x'})).toBeNull()
    expect(deliveryDispatchPhase({type:'DELIVERY',status:'NEW',assignmentAcceptedAt:undefined})).toBeNull()
  })
})

describe('Smart Dispatch Phase 5: orderExceptions surfaces what needs staff attention',()=>{
  const base={type:'DELIVERY' as const,status:'NEW' as const,deliveryReviewStatus:'NOT_REQUIRED' as const,paymentMethod:'CASH' as const,paymentStatus:'PENDING' as const,assignedDriverId:undefined}
  it('flags nothing for a normal CASH order awaiting nothing',()=>{
    expect(orderExceptions(base)).toEqual([])
  })
  it('flags address review and clarification states, mutually as their own distinct flags',()=>{
    expect(orderExceptions({...base,deliveryReviewStatus:'REVIEW_REQUIRED'})).toContain('ADDRESS_REVIEW')
    expect(orderExceptions({...base,deliveryReviewStatus:'CLARIFICATION_REQUESTED'})).toContain('ADDRESS_CLARIFICATION')
  })
  it('flags CLICK/PAYME only while manual payment has not been confirmed',()=>{
    expect(orderExceptions({...base,paymentMethod:'CLICK',paymentStatus:'PENDING'})).toContain('REMOTE_PAYMENT_PENDING')
    expect(orderExceptions({...base,paymentMethod:'CLICK',paymentStatus:'CONFIRMED'})).not.toContain('REMOTE_PAYMENT_PENDING')
    expect(orderExceptions({...base,paymentMethod:'CASH'})).not.toContain('REMOTE_PAYMENT_PENDING')
  })
  it('flags a READY delivery order with no assigned driver as COURIER_WAITING, never for PICKUP',()=>{
    expect(orderExceptions({...base,status:'READY',assignedDriverId:undefined})).toContain('COURIER_WAITING')
    expect(orderExceptions({...base,status:'READY',assignedDriverId:'driver-1'})).not.toContain('COURIER_WAITING')
    expect(orderExceptions({...base,type:'PICKUP',status:'READY',assignedDriverId:undefined})).not.toContain('COURIER_WAITING')
  })
  it('flags DELIVERY_FAILED and RETURNED as their own exceptions',()=>{
    expect(orderExceptions({...base,status:'DELIVERY_FAILED'})).toContain('DELIVERY_FAILED')
    expect(orderExceptions({...base,status:'RETURNED'})).toContain('RETURNED')
  })
  it('can report multiple simultaneous exceptions',()=>{
    const flags=orderExceptions({...base,deliveryReviewStatus:'REVIEW_REQUIRED',paymentMethod:'PAYME',paymentStatus:'PENDING'})
    expect(flags).toEqual(expect.arrayContaining(['ADDRESS_REVIEW','REMOTE_PAYMENT_PENDING']))
  })
})
