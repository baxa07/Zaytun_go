import type {Order,OrderEvent,OrderStatus,PaymentMethod,RestaurantConfig} from './domain'

export type FulfillmentStage={status:OrderStatus;label:string}

// Staff/driver-facing only: granular, 1:1 with backend order_status. Never
// used for customer tracking, which uses the collapsed customer* exports
// below instead. Do not repurpose this for customer presentation.
const pickupStages:FulfillmentStage[]=[
  {status:'NEW',label:'Buyurtma qabul qilindi'},
  {status:'CONFIRMED',label:'Tasdiqlandi'},
  {status:'PREPARING',label:'Tayyorlanmoqda'},
  {status:'READY',label:'Olib ketishga tayyor'},
  {status:'COLLECTED',label:'Olib ketildi'},
]
const deliveryStages:FulfillmentStage[]=[
  {status:'NEW',label:'Buyurtma qabul qilindi'},
  {status:'CONFIRMED',label:'Tasdiqlandi'},
  {status:'PREPARING',label:'Tayyorlanmoqda'},
  {status:'READY',label:'Tayyor'},
  {status:'DRIVER_ASSIGNED',label:'Haydovchi biriktirilgan'},
  {status:'PICKED_UP',label:'Kuryer olib ketdi'},
  {status:'ON_THE_WAY',label:'Yo‘lda'},
  {status:'ARRIVED',label:'Yetib keldi'},
  {status:'DELIVERED',label:'Yetkazildi'},
]
export const fulfillmentTimeline=(type:Order['type'])=>type==='PICKUP'?pickupStages:deliveryStages
export const fulfillmentStatusLabel=(order:Pick<Order,'type'|'status'>)=>fulfillmentTimeline(order.type).find(stage=>stage.status===order.status)?.label

// Customer-facing delivery tracking: the approved 7-stage collapse. Pickup
// tracking is unaffected and keeps using fulfillmentTimeline('PICKUP') above.
export interface CustomerDeliveryStage{label:string}
export const customerDeliveryStages:CustomerDeliveryStage[]=[
  {label:'Buyurtma qabul qilindi'},
  {label:'Manzil tasdiqlandi'},
  {label:'Tayyorlanmoqda'},
  {label:'Haydovchiga berildi'},
  {label:'Yo‘lda'},
  {label:'Yetib keldi'},
  {label:'Yetkazildi'},
]
// Exceptional terminal statuses (REJECTED/CANCELLED/DELIVERY_FAILED/RETURNED)
// are deliberately excluded: they never advance the customer stage index,
// they are only ever reached by reading backward through event history.
const normalDeliveryStatuses:OrderStatus[]=['NEW','CONFIRMED','PREPARING','READY','DRIVER_ASSIGNED','PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED']
export const isNormalDeliveryStatus=(order:Pick<Order,'type'|'status'>)=>order.type==='DELIVERY'&&normalDeliveryStatuses.includes(order.status)
// For an order currently in an exceptional status, find the last normal
// status it legitimately passed through using its own (customer-safe) event
// history, rather than guessing from the exceptional status alone.
const lastNormalDeliveryStatus=(order:Pick<Order,'status'|'events'>):OrderStatus=>{
  if(normalDeliveryStatuses.includes(order.status))return order.status
  const reached=order.events.filter(e=>normalDeliveryStatuses.includes(e.newStatus)).sort((a,b)=>a.timestamp.localeCompare(b.timestamp))
  return reached.at(-1)?.newStatus??'NEW'
}
// PICKED_UP (not DRIVER_ASSIGNED) is the deliberate product decision for
// "Haydovchiga berildi": assignment only selects a driver, pickup proves the
// food left the restaurant. CONFIRMED/PREPARING/READY/DRIVER_ASSIGNED all
// collapse into "Tayyorlanmoqda" (index 2).
const kitchenStatusStageIndex:Partial<Record<OrderStatus,number>>={NEW:0,CONFIRMED:2,PREPARING:2,READY:2,DRIVER_ASSIGNED:2,PICKED_UP:3,ON_THE_WAY:4,ARRIVED:5,DELIVERED:6}
// Stage 1 ("Manzil tasdiqlandi") is driven by delivery_review_status, not by
// order status, and can be reached while status is still NEW; Math.max lets
// either signal (kitchen progress or address approval) advance the index.
export const customerDeliveryStageIndex=(order:Pick<Order,'status'|'deliveryReviewStatus'|'events'>):number=>{
  const statusIndex=kitchenStatusStageIndex[lastNormalDeliveryStatus(order)]??0
  const approvedIndex=order.deliveryReviewStatus==='APPROVED'?1:0
  return Math.max(statusIndex,approvedIndex)
}
export const customerDeliveryStageEventMatchers:((e:OrderEvent)=>boolean)[]=[
  e=>e.previousStatus===null&&e.newStatus==='NEW',
  e=>e.notes==='DELIVERY_REVIEW_APPROVED',
  e=>(['CONFIRMED','PREPARING','READY','DRIVER_ASSIGNED']as OrderStatus[]).includes(e.newStatus),
  e=>e.newStatus==='PICKED_UP',
  e=>e.newStatus==='ON_THE_WAY',
  e=>e.newStatus==='ARRIVED',
  e=>e.newStatus==='DELIVERED',
]
export const paymentLabel=(payment:PaymentMethod,staff=false)=>payment==='CASH'?'Naqd pul':payment==='CARD_AT_PICKUP'?(staff?'Karta — restoranda':'Restoranda karta orqali'):payment==='CLICK'?'Click':payment==='PAYME'?'Payme':'Yetkazilganda karta'
export const pickupPaymentGuidance=(payment:PaymentMethod)=>payment==='CARD_AT_PICKUP'?'To‘lov restoranda karta orqali amalga oshiriladi.':'To‘lov buyurtmani olayotganda naqd pulda amalga oshiriladi.'
export const paymentMethodsForFulfillment=(config:RestaurantConfig,type:Order['type'])=>type==='PICKUP'?(config.pickupPaymentMethods||config.supportedPaymentMethods):(config.deliveryPaymentMethods||config.supportedPaymentMethods)

// Payment Preference v1: CLICK/PAYME record only the customer's stated
// *intent* to pay by transfer -- never that payment was received. The
// restaurant calls the customer and verifies receipt operationally after
// confirming the order; nothing here marks an order paid automatically.
export const isRemotePaymentMethod=(payment:PaymentMethod)=>payment==='CLICK'||payment==='PAYME'
export const remotePaymentCustomerNotice='Restoran buyurtmangizni tasdiqlagach, to‘lov uchun siz bilan bog‘lanadi.'
export const remotePaymentStaffHint='Buyurtmani tekshiring va mijoz bilan to‘lov uchun bog‘laning.'
