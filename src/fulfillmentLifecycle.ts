import type {Order,OrderStatus,PaymentMethod,RestaurantConfig} from './domain'

export type FulfillmentStage={status:OrderStatus;label:string}

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
export const paymentLabel=(payment:PaymentMethod,staff=false)=>payment==='CASH'?'Naqd pul':payment==='CARD_AT_PICKUP'?(staff?'Karta — restoranda':'Restoranda karta orqali'):'Yetkazilganda karta'
export const pickupPaymentGuidance=(payment:PaymentMethod)=>payment==='CARD_AT_PICKUP'?'To‘lov restoranda karta orqali amalga oshiriladi.':'To‘lov buyurtmani olayotganda naqd pulda amalga oshiriladi.'
export const paymentMethodsForFulfillment=(config:RestaurantConfig,type:Order['type'])=>type==='PICKUP'?(config.pickupPaymentMethods||config.supportedPaymentMethods):(config.deliveryPaymentMethods||config.supportedPaymentMethods)
