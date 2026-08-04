import {createUuid} from './uuid'

export type OrderStatus='NEW'|'CONFIRMED'|'PREPARING'|'READY'|'DRIVER_ASSIGNED'|'PICKED_UP'|'ON_THE_WAY'|'ARRIVED'|'DELIVERED'|'REJECTED'|'CANCELLED'|'DELIVERY_FAILED'|'RETURNED'
export type ActorType='CUSTOMER'|'RESTAURANT'|'DISPATCHER'|'DRIVER'|'SYSTEM'
export type PaymentMethod='CASH'|'CARD_ON_DELIVERY'
export type PaymentCollectionStatus='NOT_REQUIRED'|'PENDING'|'COLLECTED'|'FAILED'
export type AddressConfidence='COMPLETE'|'NEEDS_CLARIFICATION'|'CUSTOMER_CONFIRMATION_REQUIRED'
export type DriverAvailability='AVAILABLE'|'BUSY'|'OFFLINE'
export type DeliveryIssueType='ADDRESS_INCORRECT'|'CUSTOMER_NOT_ANSWERING'|'PAYMENT_PROBLEM'|'ADDRESS_CLARIFICATION'

export interface MenuModifier {id:string;name:string;price:number}
export interface MenuItem {id:string;categoryId:string;name:string;description:string;price:number;image:string;modifiers?:MenuModifier[];available:boolean}
export interface MenuCategory {id:string;name:string;description:string}
export interface CartItem {id:string;menuItemId:string;name:string;unitPrice:number;quantity:number;modifierIds:string[];modifierNames:string[];instructions:string}
export interface Cart {items:CartItem[]}
export interface Customer {id:string;name:string;primaryPhone:string;secondaryPhone?:string}
export interface CustomerAddress {customerName:string;primaryPhone:string;secondaryPhone?:string;district:string;street:string;house:string;entrance?:string;floor?:string;apartment?:string;landmark:string;deliveryNotes:string;latitude?:number;longitude?:number;confidence:AddressConfidence;pinConfirmedAt?:string;locationProvider?:'mock'|'yandex';providerPlaceId?:string;providerFormattedAddress?:string;deliveryDistanceKm?:number;deliveryZoneResult?:'ELIGIBLE'|'OUTSIDE_ZONE'|'DELIVERY_DISABLED'}
export interface OrderItem extends CartItem {total:number}
export interface OrderEvent {id:string;orderId:string;actorType:ActorType;actorId:string;previousStatus:OrderStatus|null;newStatus:OrderStatus;timestamp:string;reason?:string;notes?:string}
export interface DeliveryIssue {id:string;orderId:string;type:DeliveryIssueType;description:string;createdAt:string;reportedBy:string;resolvedAt?:string}
export interface Driver {id:string;name:string;phone:string;vehicle:string;availability:DriverAvailability}
export interface DriverAssignment {id:string;orderId:string;driverId:string;assignedAt:string;acceptedAt?:string}
export interface Order {id:string;number:string;customer:Customer;type:'DELIVERY'|'PICKUP';address?:CustomerAddress;items:OrderItem[];subtotal:number;deliveryFee:number;total:number;paymentMethod:PaymentMethod;paymentStatus:PaymentCollectionStatus;specialInstructions:string;status:OrderStatus;createdAt:string;estimatedMinutes?:number;assignedDriverId?:string;assignmentAcceptedAt?:string;events:OrderEvent[];issues:DeliveryIssue[];rejectionReason?:string;cancellationReason?:string}

export const legalTransitions:Record<OrderStatus,OrderStatus[]>={NEW:['CONFIRMED','REJECTED','CANCELLED'],CONFIRMED:['PREPARING','CANCELLED'],PREPARING:['READY','CANCELLED'],READY:['DRIVER_ASSIGNED','DELIVERED','CANCELLED'],DRIVER_ASSIGNED:['PICKED_UP','CANCELLED'],PICKED_UP:['ON_THE_WAY','DELIVERY_FAILED','RETURNED'],ON_THE_WAY:['ARRIVED','DELIVERY_FAILED','RETURNED'],ARRIVED:['DELIVERED','DELIVERY_FAILED','RETURNED'],DELIVERED:[],REJECTED:[],CANCELLED:[],DELIVERY_FAILED:['RETURNED'],RETURNED:[]}
export const canTransition=(from:OrderStatus,to:OrderStatus)=>legalTransitions[from].includes(to)
export function createEvent(orderId:string,previousStatus:OrderStatus|null,newStatus:OrderStatus,actorType:ActorType,actorId:string,reason?:string,notes?:string):OrderEvent{return{id:createUuid(),orderId,previousStatus,newStatus,actorType,actorId,timestamp:new Date().toISOString(),reason,notes}}
export function transitionOrder(order:Order,to:OrderStatus,actorType:ActorType,actorId:string,reason?:string,notes?:string):Order{if(!canTransition(order.status,to))throw new Error(`Illegal transition: ${order.status} → ${to}`);const event=createEvent(order.id,order.status,to,actorType,actorId,reason,notes);return{...order,status:to,events:[...order.events,event],rejectionReason:to==='REJECTED'?reason:order.rejectionReason,cancellationReason:to==='CANCELLED'?reason:order.cancellationReason}}
export function calculateOrderTotal(items:Pick<CartItem,'unitPrice'|'quantity'>[],deliveryFee=0){return items.reduce((sum,item)=>sum+item.unitPrice*item.quantity,0)+deliveryFee}
export function validateAddress(address:CustomerAddress):Record<string,string>{const e:Record<string,string>={};if(!address.customerName.trim())e.customerName='Ismingizni kiriting';if(!/^\+?[\d\s()-]{9,}$/.test(address.primaryPhone))e.primaryPhone='To‘g‘ri telefon raqamini kiriting';if(!address.district.trim())e.district='Mahalla yoki tumanni kiriting';if(!address.street.trim())e.street='Ko‘cha yoki aniq joylashuvni kiriting';if(!address.house.trim())e.house='Uy/bino raqami yoki izoh kiriting';if(!address.landmark.trim()&&!address.deliveryNotes.trim())e.landmark='Mo‘ljal yoki yetkazish izohi kerak';if(address.latitude===undefined||address.longitude===undefined)e.coordinates='Xaritadan joylashuvni belgilang';else if(address.latitude<-90||address.latitude>90||address.longitude<-180||address.longitude>180||(address.latitude===0&&address.longitude===0))e.coordinates='Tanlangan koordinata noto‘g‘ri';if(!address.pinConfirmedAt)e.pinConfirmation='Pin yetkazish nuqtasida ekanini tasdiqlang';if(address.deliveryZoneResult==='OUTSIDE_ZONE')e.deliveryZone='Bu manzil yetkazish hududidan tashqarida';if(address.deliveryZoneResult==='DELIVERY_DISABLED')e.deliveryZone='Yetkazib berish vaqtincha o‘chirilgan';return e}
export function validateOrderInput(type:'DELIVERY'|'PICKUP',address:CustomerAddress|undefined,payment?:PaymentMethod){const e:Record<string,string>={};if(!payment)e.paymentMethod='To‘lov usulini tanlang';if(type==='DELIVERY'){if(!address)return{...e,address:'Yetkazish manzili kerak'};Object.assign(e,validateAddress(address))}return e}
export function createIssue(orderId:string,type:DeliveryIssueType,description:string,reportedBy:string):DeliveryIssue{if(!description.trim())throw new Error('Issue description is required');return{id:createUuid(),orderId,type,description,reportedBy,createdAt:new Date().toISOString()}}
