import{describe,expect,it}from'vitest'
import{customerDeliveryStageIndex,customerDeliveryStages,fulfillmentTimeline,isNormalDeliveryStatus,paymentMethodsForFulfillment,pickupPaymentGuidance}from'./fulfillmentLifecycle'
import{developmentRestaurantConfig}from'./data'
import type{OrderEvent,OrderStatus}from'./domain'
describe('fulfillment timeline',()=>{it('contains exactly five pickup-only stages',()=>{const stages=fulfillmentTimeline('PICKUP');expect(stages.map(x=>x.label)).toEqual(['Buyurtma qabul qilindi','Tasdiqlandi','Tayyorlanmoqda','Olib ketishga tayyor','Olib ketildi']);expect(stages.map(x=>x.status)).not.toEqual(expect.arrayContaining(['DRIVER_ASSIGNED','ON_THE_WAY','ARRIVED','DELIVERED']))});it('retains delivery stages',()=>expect(fulfillmentTimeline('DELIVERY').map(x=>x.status)).toEqual(expect.arrayContaining(['DRIVER_ASSIGNED','ON_THE_WAY','ARRIVED','DELIVERED'])));it('provides physical-payment guidance',()=>{expect(pickupPaymentGuidance('CARD_AT_PICKUP')).toContain('restoranda karta');expect(pickupPaymentGuidance('CASH')).toContain('naqd pulda')})})
describe('fulfillment payments',()=>{it('offers card only for pickup',()=>{expect(paymentMethodsForFulfillment(developmentRestaurantConfig,'PICKUP')).toEqual(['CASH','CARD_AT_PICKUP']);expect(paymentMethodsForFulfillment(developmentRestaurantConfig,'DELIVERY')).toEqual(['CASH'])})})

// --- Phase D: customer-facing 7-stage delivery timeline ---
let seq=0
const ev=(previousStatus:OrderStatus|null,newStatus:OrderStatus,notes?:string):OrderEvent=>({id:`e${++seq}`,orderId:'o1',actorType:'SYSTEM',actorId:'system',previousStatus,newStatus,timestamp:`2026-08-09T00:${String(seq).padStart(2,'0')}:00.000Z`,notes})
const STAGE_LABELS=['Buyurtma qabul qilindi','Manzil tasdiqlandi','Tayyorlanmoqda','Haydovchiga berildi','Yo‘lda','Yetib keldi','Yetkazildi']

describe('customer delivery timeline: exactly the approved 7 stages',()=>{
  it('has exactly these seven labels in this order',()=>{
    expect(customerDeliveryStages.map(s=>s.label)).toEqual(STAGE_LABELS)
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
  it('PICKED_UP is exactly Haydovchiga berildi (stage 4)',()=>{
    const index=customerDeliveryStageIndex({...base,status:'PICKED_UP'})
    expect(index).toBe(3)
    expect(customerDeliveryStages[index].label).toBe('Haydovchiga berildi')
  })
})

describe('customer delivery timeline: remaining driver states',()=>{
  const base={deliveryReviewStatus:'APPROVED' as const,events:[ev(null,'NEW'),ev('NEW','NEW','DELIVERY_REVIEW_APPROVED')]}
  it('ON_THE_WAY is stage 5 (Yo‘lda)',()=>expect(customerDeliveryStages[customerDeliveryStageIndex({...base,status:'ON_THE_WAY'})].label).toBe('Yo‘lda'))
  it('ARRIVED is stage 6 (Yetib keldi)',()=>expect(customerDeliveryStages[customerDeliveryStageIndex({...base,status:'ARRIVED'})].label).toBe('Yetib keldi'))
  it('DELIVERED is stage 7 (Yetkazildi), the terminal success stage',()=>{
    const index=customerDeliveryStageIndex({...base,status:'DELIVERED'})
    expect(index).toBe(6)
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
