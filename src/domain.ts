import {createUuid} from './uuid'

export type OrderStatus='NEW'|'CONFIRMED'|'PREPARING'|'READY'|'COLLECTED'|'DRIVER_ASSIGNED'|'PICKED_UP'|'ON_THE_WAY'|'ARRIVED'|'DELIVERED'|'REJECTED'|'CANCELLED'|'DELIVERY_FAILED'|'RETURNED'
export type ActorType='CUSTOMER'|'RESTAURANT'|'DISPATCHER'|'DRIVER'|'SYSTEM'
export type PaymentMethod='CASH'|'CARD_ON_DELIVERY'|'CARD_AT_PICKUP'|'CLICK'|'PAYME'
export type PaymentCollectionStatus='NOT_REQUIRED'|'PENDING'|'COLLECTED'|'FAILED'
export type AddressConfidence='COMPLETE'|'NEEDS_CLARIFICATION'|'CUSTOMER_CONFIRMATION_REQUIRED'
export type DriverAvailability='AVAILABLE'|'BUSY'|'OFFLINE'
export type DeliveryIssueType='ADDRESS_INCORRECT'|'CUSTOMER_NOT_ANSWERING'|'PAYMENT_PROBLEM'|'ADDRESS_CLARIFICATION'
export interface RestaurantConfig {restaurantName:string;restaurantAddress:string;restaurantPhone:string;restaurantLatitude:number;restaurantLongitude:number;operatingHours:Record<string,string>;deliveryEnabled:boolean;deliveryPolicyMode?:'RADIUS'|'MANUAL_CITY_REVIEW';deliveryReviewMessage?:string|null;deliveryRadiusKm:number|null;deliveryAreaDescription:string;minimumDeliverySubtotal:number;baseDeliveryFee:number;freeDeliveryThreshold:number|null;maximumItemQuantity:number;supportedPaymentMethods:PaymentMethod[];pickupPaymentMethods:PaymentMethod[];deliveryPaymentMethods:PaymentMethod[];estimatedPreparationMinutes:number|null;estimatedDeliveryMinutes:number|null;defaultMapZoom:number;customerAuthRequired?:boolean}

export type PublicMenuState='LOADING'|'READY'|'UNPUBLISHED'|'ERROR'
export const publicMenuState=(ready:boolean,error:string,categoryCount:number,itemCount:number):PublicMenuState=>!ready?'LOADING':error?'ERROR':categoryCount===0||itemCount===0?'UNPUBLISHED':'READY'

// Which order-creation RPC a submission should use. Pure and testable on
// purpose: this is the one place that decides public vs authenticated
// order creation, independent of React/Supabase, so the flag=false/true
// and authenticated/unauthenticated combinations can be verified directly.
export type OrderSubmissionMode='PUBLIC'|'CUSTOMER'|'REQUIRES_CUSTOMER_AUTH'
export const resolveOrderSubmissionMode=(customerAuthRequired:boolean,hasCustomerSession:boolean):OrderSubmissionMode=>!customerAuthRequired?'PUBLIC':hasCustomerSession?'CUSTOMER':'REQUIRES_CUSTOMER_AUTH'

export interface MenuModifier {id:string;name:string;price:number}
export interface MenuItem {id:string;categoryId:string;name:string;description:string;price:number;image:string;modifiers?:MenuModifier[];available:boolean}
export interface MenuCategory {id:string;name:string;description:string}
export interface CartItem {id:string;menuItemId:string;name:string;unitPrice:number;quantity:number;modifierIds:string[];modifierNames:string[];instructions:string}
export interface Cart {items:CartItem[]}
export const cartLineMatches=(left:CartItem,right:CartItem)=>left.menuItemId===right.menuItemId&&left.modifierIds.slice().sort().join()===right.modifierIds.slice().sort().join()&&left.instructions.trim()===right.instructions.trim()
export function addCartLine(items:CartItem[],incoming:CartItem,maximumQuantity:number){const existing=items.find(item=>cartLineMatches(item,incoming));if(!existing)return[...items,{...incoming,quantity:Math.min(incoming.quantity,maximumQuantity)}];return items.map(item=>item.id===existing.id?{...item,quantity:Math.min(item.quantity+incoming.quantity,maximumQuantity)}:item)}
export interface Customer {id:string;name:string;primaryPhone:string;secondaryPhone?:string}
export interface CustomerAddress {customerName:string;primaryPhone:string;secondaryPhone?:string;district:string;street:string;house:string;entrance?:string;floor?:string;apartment?:string;landmark:string;deliveryNotes:string;latitude?:number;longitude?:number;confidence:AddressConfidence;pinConfirmedAt?:string;locationProvider?:'mock'|'yandex';providerPlaceId?:string;providerFormattedAddress?:string;deliveryDistanceKm?:number;deliveryZoneResult?:'ELIGIBLE'|'OUTSIDE_ZONE'|'DELIVERY_DISABLED'}
export interface OrderItem extends CartItem {total:number}
export interface OrderEvent {id:string;orderId:string;actorType:ActorType;actorId:string;previousStatus:OrderStatus|null;newStatus:OrderStatus;timestamp:string;reason?:string;notes?:string}
export interface DeliveryIssue {id:string;orderId:string;type:DeliveryIssueType;description:string;createdAt:string;reportedBy:string;resolvedAt?:string}
export interface Driver {id:string;name:string;phone:string;vehicle:string;availability:DriverAvailability}
export interface DriverAssignment {id:string;orderId:string;driverId:string;assignedAt:string;acceptedAt?:string}
export type DeliveryReviewStatus='NOT_REQUIRED'|'REVIEW_REQUIRED'|'CLARIFICATION_REQUESTED'|'APPROVED'|'REJECTED'
export interface Order {id:string;number:string;customer:Customer;type:'DELIVERY'|'PICKUP';address?:CustomerAddress;items:OrderItem[];subtotal:number;deliveryFee:number;total:number;paymentMethod:PaymentMethod;paymentStatus:PaymentCollectionStatus;specialInstructions:string;status:OrderStatus;createdAt:string;estimatedMinutes?:number;assignedDriverId?:string;assignmentAcceptedAt?:string;deliveryReviewStatus?:DeliveryReviewStatus;deliveryReviewReason?:string;events:OrderEvent[];issues:DeliveryIssue[];rejectionReason?:string;cancellationReason?:string;feedback?:OrderFeedback}

export const legalTransitions:Record<OrderStatus,OrderStatus[]>={NEW:['CONFIRMED','REJECTED','CANCELLED'],CONFIRMED:['PREPARING','CANCELLED'],PREPARING:['READY','CANCELLED'],READY:['COLLECTED','DRIVER_ASSIGNED','CANCELLED'],COLLECTED:[],DRIVER_ASSIGNED:['PICKED_UP','CANCELLED'],PICKED_UP:['ON_THE_WAY','DELIVERY_FAILED','RETURNED'],ON_THE_WAY:['ARRIVED','DELIVERY_FAILED','RETURNED'],ARRIVED:['DELIVERED','DELIVERY_FAILED','RETURNED'],DELIVERED:[],REJECTED:[],CANCELLED:[],DELIVERY_FAILED:['RETURNED'],RETURNED:[]}
export const canTransition=(from:OrderStatus,to:OrderStatus)=>legalTransitions[from].includes(to)
export const canTransitionOrder=(order:Pick<Order,'type'|'status'>,to:OrderStatus)=>canTransition(order.status,to)&&(
  order.type==='PICKUP'
    ? !['DRIVER_ASSIGNED','PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','DELIVERY_FAILED','RETURNED'].includes(to)
    : to!=='COLLECTED'
)
export const isDeliveryAddressRevisable=(order:Pick<Order,'type'|'status'|'deliveryReviewStatus'>)=>order.type==='DELIVERY'&&order.status==='NEW'&&order.deliveryReviewStatus==='CLARIFICATION_REQUESTED'
const deliveryReviewMarkerNotes=['DELIVERY_CLARIFICATION_REQUESTED','DELIVERY_ADDRESS_REVISED','DELIVERY_REVIEW_APPROVED','DELIVERY_REVIEW_REJECTED']
export const deliveryAddressWasResubmitted=(order:Pick<Order,'events'>)=>{const marker=order.events.filter(e=>e.notes&&deliveryReviewMarkerNotes.includes(e.notes)).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)).at(-1);return marker?.notes==='DELIVERY_ADDRESS_REVISED'}
export function createEvent(orderId:string,previousStatus:OrderStatus|null,newStatus:OrderStatus,actorType:ActorType,actorId:string,reason?:string,notes?:string):OrderEvent{return{id:createUuid(),orderId,previousStatus,newStatus,actorType,actorId,timestamp:new Date().toISOString(),reason,notes}}
export function transitionOrder(order:Order,to:OrderStatus,actorType:ActorType,actorId:string,reason?:string,notes?:string):Order{if(!canTransitionOrder(order,to))throw new Error(`Illegal transition: ${order.status} → ${to}`);const event=createEvent(order.id,order.status,to,actorType,actorId,reason,notes);return{...order,status:to,events:[...order.events,event],rejectionReason:to==='REJECTED'?reason:order.rejectionReason,cancellationReason:to==='CANCELLED'?reason:order.cancellationReason}}
export function calculateOrderTotal(items:Pick<CartItem,'unitPrice'|'quantity'>[],deliveryFee=0){return items.reduce((sum,item)=>sum+item.unitPrice*item.quantity,0)+deliveryFee}
// Minimum delivery-address contract: the confirmed map pin is the primary
// geographic source. Written fields only need enough human-readable
// context for the courier -- district/street -- everything else (house,
// entrance/floor/apartment, landmark, delivery notes) is optional and must
// never block checkout. Mirrored exactly by create_order_internal and
// revise_delivery_address (supabase/migrations) so frontend and backend
// never disagree on what's required.
export function validateDeliveryLocation(address:Pick<CustomerAddress,'district'|'street'|'house'|'landmark'|'deliveryNotes'|'latitude'|'longitude'|'pinConfirmedAt'|'deliveryZoneResult'>):Record<string,string>{const e:Record<string,string>={};if(!address.district.trim())e.district='Mahalla yoki tumanni kiriting';if(!address.street.trim())e.street='Ko‘cha yoki joylashuvni kiriting';if(address.latitude===undefined||address.longitude===undefined)e.coordinates='Xaritadan joylashuvni belgilang';else if(address.latitude<-90||address.latitude>90||address.longitude<-180||address.longitude>180||(address.latitude===0&&address.longitude===0))e.coordinates='Tanlangan koordinata noto‘g‘ri';if(!address.pinConfirmedAt)e.pinConfirmation='Pin yetkazish nuqtasida ekanini tasdiqlang';if(address.deliveryZoneResult==='OUTSIDE_ZONE')e.deliveryZone='Bu manzil yetkazish hududidan tashqarida';if(address.deliveryZoneResult==='DELIVERY_DISABLED')e.deliveryZone='Yetkazib berish vaqtincha o‘chirilgan';return e}
export function validateAddress(address:CustomerAddress):Record<string,string>{const e:Record<string,string>={};if(!address.customerName.trim())e.customerName='Ismingizni kiriting';if(!/^\+?[\d\s()-]{9,}$/.test(address.primaryPhone))e.primaryPhone='To‘g‘ri telefon raqamini kiriting';return{...e,...validateDeliveryLocation(address)}}
export function validateOrderInput(type:'DELIVERY'|'PICKUP',address:CustomerAddress|undefined,payment?:PaymentMethod){const e:Record<string,string>={};if(!payment)e.paymentMethod='To‘lov usulini tanlang';if(type==='DELIVERY'){if(!address)return{...e,address:'Yetkazish manzili kerak'};Object.assign(e,validateAddress(address))}return e}
export function createIssue(orderId:string,type:DeliveryIssueType,description:string,reportedBy:string):DeliveryIssue{if(!description.trim())throw new Error('Issue description is required');return{id:createUuid(),orderId,type,description,reportedBy,createdAt:new Date().toISOString()}}

// Checkout idempotency: the server already deduplicates by orders.idempotency_key
// (a real unique constraint, race-safe on the RPC side), but only if the client
// sends the SAME key on a resubmission. A fresh crypto.randomUUID() minted inside
// every submit() call defeats that entirely -- a reload, a second tab, or a
// same-session retry after an ambiguous network result would each mint their own
// key and the server would (correctly, per its own contract) create a separate
// order for each. This fingerprint identifies "the same pending checkout attempt"
// so the caller can persist {id, fingerprint} across reload/retry and reuse the
// id whenever the fingerprint still matches -- and mint a fresh id the moment it
// doesn't, so an old pending id can never bind to materially different contents.
export interface PendingCheckout{id:string;fingerprint:string}
export const checkoutFingerprint=(type:'DELIVERY'|'PICKUP',cart:Pick<CartItem,'menuItemId'|'modifierIds'|'quantity'|'instructions'>[],payment:PaymentMethod|undefined,address:CustomerAddress|undefined):string=>JSON.stringify({
  type,
  payment,
  cart:cart.map(item=>({menuItemId:item.menuItemId,modifierIds:item.modifierIds.slice().sort(),quantity:item.quantity,instructions:item.instructions.trim()})),
  address:type==='DELIVERY'&&address?{customerName:address.customerName,primaryPhone:address.primaryPhone,secondaryPhone:address.secondaryPhone,district:address.district,street:address.street,house:address.house,entrance:address.entrance,floor:address.floor,apartment:address.apartment,landmark:address.landmark,deliveryNotes:address.deliveryNotes,latitude:address.latitude,longitude:address.longitude}:undefined,
})
export const resolvePendingCheckoutId=(fingerprint:string,stored:PendingCheckout|null):string=>stored&&stored.fingerprint===fingerprint?stored.id:createUuid()

// The driver surface's greeting previously hard-coded a fixed name
// ("XAYRLI KUN, AZIZ") for every courier. This derives a greeting name from
// the authenticated driver's own profiles.display_name instead, so no
// courier is ever shown someone else's identity. Returns null (neutral
// greeting, no name) when no reliable display name is available yet, rather
// than guessing or falling back to a placeholder person.
export const driverGreetingName=(displayName:string|null|undefined):string|null=>{
  const first=displayName?.trim().split(/\s+/)[0]
  return first?first.toUpperCase():null
}

// H1: Order History. Every date preset/custom range is resolved
// server-side (Asia/Tashkent business timezone) by the History RPC --
// the frontend only ever sends the symbolic preset (or explicit calendar
// dates for CUSTOM), never a browser-computed timestamp range.
export type HistoryDatePreset='TODAY'|'YESTERDAY'|'LAST_7_DAYS'|'THIS_MONTH'|'CUSTOM'
export interface OrderHistoryFilters {
  preset:HistoryDatePreset
  customFrom?:string
  customTo?:string
  branchId?:string
  driverId?:string
  status?:OrderStatus
  fulfillment?:'DELIVERY'|'PICKUP'
  paymentMethod?:PaymentMethod
  search?:string
  limit?:number
  offset?:number
}
export interface OrderHistoryRow {
  id:string
  number:string
  createdAt:string
  finishedAt?:string
  branchId:string
  branchName:string
  customerName:string
  type:'DELIVERY'|'PICKUP'
  status:OrderStatus
  assignedDriverId?:string
  driverName?:string
  paymentMethod:PaymentMethod
  total:number
  hasFeedback:boolean
}
export interface OrderHistoryPage {rows:OrderHistoryRow[];totalCount:number}
export interface OrderHistorySummary {totalOrders:number;delivered:number;cancelled:number;failed:number;totalValue:number}
export const HISTORY_PAGE_SIZE=25

// H2: Driver Delivery Ledger. Credit comes only from
// driver_assignments.status (never orders.assigned_driver_id) so
// reassignment can never misattribute completed work -- see the RPC
// migration for the full reasoning. This is a work-verification report,
// never payroll: no rate, no earnings, no salary field exists here.
export interface DriverLedgerSummaryRow {
  driverId:string
  driverName:string
  totalAssignments:number
  accepted:number
  completed:number
  failed:number
  returned:number
  declined:number
  superseded:number
  feedbackReceived:number
  feedbackFast:number
  feedbackNormal:number
  feedbackLate:number
  feedbackIssue:number
}
export interface DriverLedgerEntry {
  id:string
  orderId:string
  orderNumber:string
  branchId:string
  branchName:string
  district?:string
  type:'DELIVERY'|'PICKUP'
  assignedAt:string
  acceptedAt?:string
  endedAt?:string
  status:'ASSIGNED'|'ACCEPTED'|'DECLINED'|'SUPERSEDED'|'COMPLETED'|'FAILED'|'RETURNED'|'CANCELLED'
  total:number
}
export interface DriverLedgerPage {rows:DriverLedgerEntry[];totalCount:number}

// H3: Customer Feedback v1. Stable machine values only, never translated
// display text -- copy can change freely without a data migration.
export type FeedbackDeliveryRating='FAST'|'NORMAL'|'LATE'|'ISSUE'
export type FeedbackDeliveryIssueReason='SPILLED_OR_TIPPED'|'POOR_HANDLING'|'LOCATION_DIFFICULTY'|'VERY_LATE'|'OTHER'
export type FeedbackFoodRating='EXCELLENT'|'GOOD'|'OKAY'|'BAD'
export type FeedbackFoodIssueReason='COLD'|'TASTE'|'PREPARATION'|'MISSING_ITEM'|'OTHER'
export interface OrderFeedback {
  deliveryRating?:FeedbackDeliveryRating
  deliveryIssueReason?:FeedbackDeliveryIssueReason
  foodRating:FeedbackFoodRating
  foodIssueReason?:FeedbackFoodIssueReason
  comment?:string
  submittedAt:string
}
export interface OrderFeedbackSubmission {
  foodRating:FeedbackFoodRating
  deliveryRating?:FeedbackDeliveryRating
  deliveryIssueReason?:FeedbackDeliveryIssueReason
  foodIssueReason?:FeedbackFoodIssueReason
  comment?:string
}
// Feedback only becomes submittable once the order has actually reached
// the customer -- DELIVERED for delivery orders, COLLECTED for pickup
// (which never asks the courier question at all). Never while still active.
export const canSubmitOrderFeedback=(order:Pick<Order,'type'|'status'|'feedback'>):boolean=>
  !order.feedback&&(order.type==='DELIVERY'?order.status==='DELIVERED':order.status==='COLLECTED')
