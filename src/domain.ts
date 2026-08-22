import {createUuid} from './uuid'

export type OrderStatus='NEW'|'CONFIRMED'|'PREPARING'|'READY'|'COLLECTED'|'DRIVER_ASSIGNED'|'PICKED_UP'|'ON_THE_WAY'|'ARRIVED'|'DELIVERED'|'REJECTED'|'CANCELLED'|'DELIVERY_FAILED'|'RETURNED'
export type ActorType='CUSTOMER'|'RESTAURANT'|'DISPATCHER'|'DRIVER'|'SYSTEM'
export type PaymentMethod='CASH'|'CARD_ON_DELIVERY'|'CARD_AT_PICKUP'|'TERMINAL'|'CLICK'|'PAYME'
export type PaymentCollectionStatus='NOT_REQUIRED'|'PENDING'|'CONFIRMED'|'COLLECTED'|'FAILED'
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
export const resolveOrderSubmissionMode=(customerAuthRequired:boolean,hasCustomerSession:boolean):OrderSubmissionMode=>hasCustomerSession?'CUSTOMER':customerAuthRequired?'REQUIRES_CUSTOMER_AUTH':'PUBLIC'

export interface MenuModifier {id:string;name:string;price:number}
export interface PackagingConfig {packagingRequired:boolean;packagingUnitPrice:number;packagingCapacity:number|null}
export interface MenuItem extends PackagingConfig {id:string;categoryId:string;name:string;description:string;price:number;image:string;modifiers?:MenuModifier[];available:boolean;updatedAt?:string}
export interface MenuCategory {id:string;name:string;description:string}
export interface MenuItemDraft extends PackagingConfig {categoryId:string;name:string;description:string;price:number;image:string;available:boolean}
export type MenuAuditAction='PRODUCT_CREATED'|'PRODUCT_UPDATED'|'PRICE_CHANGED'|'AVAILABILITY_CHANGED'|'PACKAGING_CHANGED'
export interface MenuAuditEntry {id:string;productId:string;actorUserId:string;actorName?:string;action:MenuAuditAction;beforeState?:Record<string,unknown>;afterState:Record<string,unknown>;occurredAt:string}
export interface MenuImageUpload {url:string;path:string}
export const MENU_IMAGE_MAX_BYTES=8*1024*1024
export const MENU_IMAGE_MIME_EXTENSIONS:Readonly<Record<string,string>>={
  'image/jpeg':'jpg','image/png':'png','image/webp':'webp',
}
export function validateMenuImageFile(file:Pick<File,'type'|'size'>):string|null{
  if(!MENU_IMAGE_MIME_EXTENSIONS[file.type])return 'Faqat JPG, PNG yoki WebP rasm tanlang.'
  if(file.size<=0)return 'Rasm fayli bo\u2018sh.'
  if(file.size>MENU_IMAGE_MAX_BYTES)return 'Rasm hajmi 8 MB dan oshmasligi kerak.'
  return null
}
export interface CartItem {id:string;menuItemId:string;name:string;unitPrice:number;quantity:number;modifierIds:string[];modifierNames:string[];instructions:string;packagingRequired?:boolean;packagingUnitPrice?:number;packagingCapacity?:number|null;packagingBoxCount?:number;packagingTotal?:number}
export interface Cart {items:CartItem[]}
export const cartLineMatches=(left:CartItem,right:CartItem)=>left.menuItemId===right.menuItemId&&left.modifierIds.slice().sort().join()===right.modifierIds.slice().sort().join()&&left.instructions.trim()===right.instructions.trim()
export function addCartLine(items:CartItem[],incoming:CartItem,maximumQuantity:number){const existing=items.find(item=>cartLineMatches(item,incoming));if(!existing)return[...items,{...incoming,quantity:Math.min(incoming.quantity,maximumQuantity)}];return items.map(item=>item.id===existing.id?{...item,quantity:Math.min(item.quantity+incoming.quantity,maximumQuantity)}:item)}
export interface Customer {id:string;name:string;primaryPhone:string;secondaryPhone?:string}
export interface CustomerAddress {customerName:string;primaryPhone:string;secondaryPhone?:string;district:string;street:string;house:string;entrance?:string;floor?:string;apartment?:string;landmark:string;deliveryNotes:string;latitude?:number;longitude?:number;confidence:AddressConfidence;pinConfirmedAt?:string;locationProvider?:'mock'|'yandex';providerPlaceId?:string;providerFormattedAddress?:string;deliveryDistanceKm?:number;deliveryZoneResult?:'ELIGIBLE'|'OUTSIDE_ZONE'|'DELIVERY_DISABLED'}
export interface OrderItem extends CartItem {total:number}
export interface OrderEvent {id:string;orderId:string;actorType:ActorType;actorId:string;previousStatus:OrderStatus|null;newStatus:OrderStatus;timestamp:string;reason?:string;notes?:string}
export interface DeliveryIssue {id:string;orderId:string;type:DeliveryIssueType;description:string;createdAt:string;reportedBy:string;resolvedAt?:string}
// P4.1: the canonical work-state model (Smart Dispatch Phase 1) --
// shift_status ("am I working at all") and dispatch_status ("should I
// receive NEW assignments right now") are orthogonal. The driver-facing
// "Ishga tayyor" ON/OFF control maps to shift_status alone (start_shift/
// end_shift already set dispatch_status='ACTIVE' together with it) --
// dispatch_status's own pause/resume is a separate, finer-grained control
// this phase does not surface. `availability` (legacy) is left alone.
export type DriverShiftStatus='OFF_SHIFT'|'ON_SHIFT'
export type DriverDispatchStatus='ACTIVE'|'PAUSED'
export interface Driver {id:string;name:string;phone:string;vehicle:string;availability:DriverAvailability;shiftStatus:DriverShiftStatus;dispatchStatus:DriverDispatchStatus;deliveryCapacity:number}
export const driverAcceptsNewWork=(driver:Pick<Driver,'shiftStatus'|'dispatchStatus'>):boolean=>driver.shiftStatus==='ON_SHIFT'&&driver.dispatchStatus==='ACTIVE'
// Driver UI Phase: the driver's own screen must always show exactly one
// of these six states, unambiguously -- standby is deliberately never
// conflated with an actual assignment ("standby is information, not
// ownership"). A pure function so the state machine is unit-testable
// independent of the React tree that renders it.
export type DriverAvailabilityState='OFF_SHIFT'|'AVAILABLE'|'STANDBY'|'ASSIGNED'|'AT_RESTAURANT'|'CARRYING'
export const deriveDriverAvailabilityState=(
  driver:Pick<Driver,'shiftStatus'|'dispatchStatus'>|undefined,
  current:Pick<Order,'status'>|undefined,
  currentArrivedAtRestaurant:boolean,
  hasStandbyNotice:boolean,
):DriverAvailabilityState=>{
  if(!driver||!driverAcceptsNewWork(driver))return 'OFF_SHIFT'
  if(!current)return hasStandbyNotice?'STANDBY':'AVAILABLE'
  if(current.status==='DRIVER_ASSIGNED')return currentArrivedAtRestaurant?'AT_RESTAURANT':'ASSIGNED'
  return 'CARRYING'
}
// Driver UI Final Operational UX: the single classifier that decides which
// top-level screen the driver sees -- answers "what should I do right
// now?" without making the driver interpret raw lifecycle statuses.
// Deliberately shiftStatus alone (not driverAcceptsNewWork, which also
// folds in dispatchStatus) -- a driver who is ON_SHIFT but PAUSED is still
// on duty and must keep seeing standby/assignment state, matching the
// knownOffDuty fix from the Multi-Order Dispatch phase. NEW_ASSIGNMENT
// covers "not yet accepted, and hasn't already departed" (accept_assignment
// itself never checks status, only PICKED_UP-or-later implies acceptance
// by construction). ON_ROUTE covers PICKED_UP/ON_THE_WAY/ARRIVED -- one
// screen for "currently delivering," not one state per status, since the
// courier's actual next action (navigate / arrived / delivered) is decided
// by the order's own status within that screen, not by this classifier.
export type DriverOperationalState='OFF_SHIFT'|'AVAILABLE'|'STANDBY'|'NEW_ASSIGNMENT'|'PREPARING'|'READY_FOR_PICKUP'|'ON_ROUTE'
const departedStatuses:OrderStatus[]=['PICKED_UP','ON_THE_WAY','ARRIVED']
export const deriveDriverOperationalState=(
  driver:Pick<Driver,'shiftStatus'>|undefined,
  current:Pick<Order,'status'|'assignmentAcceptedAt'>|undefined,
  hasStandbyNotice:boolean,
):DriverOperationalState=>{
  // Only a POSITIVELY-known off-shift driver with no active work sees
  // off-duty: `driver` undefined means "not loaded yet" (e.g. the very
  // first render, or a test/local provider that never populates it), not
  // "confirmed off shift" -- and an active assignment always outranks
  // off-duty display regardless (a driver who somehow still holds one
  // must keep seeing it, never have it hidden behind "you're off shift").
  if(driver&&driver.shiftStatus!=='ON_SHIFT'&&!current)return 'OFF_SHIFT'
  if(!current)return hasStandbyNotice?'STANDBY':'AVAILABLE'
  if(!current.assignmentAcceptedAt&&!departedStatuses.includes(current.status))return 'NEW_ASSIGNMENT'
  if(current.status==='CONFIRMED'||current.status==='PREPARING')return 'PREPARING'
  if(current.status==='DRIVER_ASSIGNED')return 'READY_FOR_PICKUP'
  return 'ON_ROUTE'
}
export interface DriverAssignment {id:string;orderId:string;driverId:string;assignedAt:string;acceptedAt?:string}
export type DeliveryReviewStatus='NOT_REQUIRED'|'REVIEW_REQUIRED'|'CLARIFICATION_REQUESTED'|'APPROVED'|'REJECTED'
// Smart Dispatch Phase 6: small optional enum, canonical values only --
// never store a translated label as the value itself, same convention as
// every other reason/issue enum in this codebase.
export type AssignmentDeclineReason='TOO_FAR'|'VEHICLE_ISSUE'|'CANNOT_GO_NOW'|'OTHER'
// Per-assignment audit trail for one order (Phase 2's driver_assignments
// row history) -- distinct from DriverAssignment above, which models only
// the current/local assignment shape. Staff-visible only (order detail),
// never shown to customers.
export interface AssignmentHistoryEntry {id:string;driverId:string;driverName?:string;status:'ASSIGNED'|'ACCEPTED'|'DECLINED'|'SUPERSEDED'|'COMPLETED'|'FAILED'|'RETURNED'|'CANCELLED';assignedAt:string;acceptedAt?:string;declinedAt?:string;endedAt?:string;arrivedAtRestaurantAt?:string}
// Driver UI Phase: a PII-free heads-up -- no customer name, address, or
// phone, matching the Telegram-notification minimalism precedent. Mirrors
// exactly what list_my_standby_notices() returns.
export interface DriverStandbyNotice {orderId:string;orderNumber:string;branchId?:string;branchName?:string;createdAt:string}
// Driver UI Final Operational UX: mirrors list_my_pickup_batch_context()
// exactly -- the batch's own lifecycle status plus the actual-wait
// deadline, computed server-side (delivery_settings stays staff-only; the
// driver only ever sees the resulting timestamp, never the raw config).
export type PickupBatchStatus='OPEN'|'READY_TO_DEPART'|'IN_TRANSIT'|'COMPLETED'|'CANCELLED'
export interface PickupBatchContext {batchId:string;status:PickupBatchStatus;maxMembers:number;firstMemberReadyAt?:string;waitDeadlineAt?:string}
export interface Order {id:string;number:string;customer:Customer;type:'DELIVERY'|'PICKUP';address?:CustomerAddress;items:OrderItem[];subtotal:number;packagingTotal?:number;deliveryFee:number;total:number;paymentMethod:PaymentMethod;paymentStatus:PaymentCollectionStatus;specialInstructions:string;status:OrderStatus;createdAt:string;estimatedMinutes?:number;assignedDriverId?:string;assignmentAcceptedAt?:string;deliveryReviewStatus?:DeliveryReviewStatus;deliveryReviewReason?:string;events:OrderEvent[];issues:DeliveryIssue[];rejectionReason?:string;cancellationReason?:string;feedback?:OrderFeedback;assignmentHistory:AssignmentHistoryEntry[];
  // Multi-Order Dispatch: a driver may now be assigned as early as
  // ACCEPT (NEW->CONFIRMED), well before the order is READY -- these
  // fields expose that decoupled state without changing `status` at all.
  acceptedAt?:string;
  pickupBatchId?:string;
  stopSequence?:number;
}

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
export function calculateFoodSubtotal(items:Pick<CartItem,'unitPrice'|'quantity'>[]){return items.reduce((sum,item)=>sum+item.unitPrice*item.quantity,0)}
export function packagingForItem(item:Pick<CartItem,'quantity'|'packagingRequired'|'packagingUnitPrice'|'packagingCapacity'>){
  if(!item.packagingRequired)return{boxCount:0,total:0}
  const capacity=item.packagingCapacity??0
  const unitPrice=item.packagingUnitPrice??0
  if(capacity<=0||unitPrice<0)return{boxCount:0,total:0}
  const boxCount=Math.ceil(item.quantity/capacity)
  return{boxCount,total:boxCount*unitPrice}
}
export function calculatePackagingTotal(items:Pick<CartItem,'quantity'|'packagingRequired'|'packagingUnitPrice'|'packagingCapacity'>[]){return items.reduce((sum,item)=>sum+packagingForItem(item).total,0)}
export function calculateOrderTotal(items:Pick<CartItem,'unitPrice'|'quantity'|'packagingRequired'|'packagingUnitPrice'|'packagingCapacity'>[],deliveryFee=0){return calculateFoodSubtotal(items)+calculatePackagingTotal(items)+deliveryFee}
// Minimum delivery-address contract: the confirmed map pin is the primary
// geographic source. Written fields only need enough human-readable
// context for the courier -- district/street -- everything else (house,
// entrance/floor/apartment, landmark, delivery notes) is optional and must
// never block checkout. Mirrored exactly by create_order_internal and
// revise_delivery_address (supabase/migrations) so frontend and backend
// never disagree on what's required.
export function validateDeliveryLocation(address:Pick<CustomerAddress,'district'|'street'|'house'|'landmark'|'deliveryNotes'|'latitude'|'longitude'|'pinConfirmedAt'|'deliveryZoneResult'>):Record<string,string>{const e:Record<string,string>={};if(!address.district.trim())e.district='Mahalla yoki tumanni kiriting';if(!address.street.trim())e.street='Ko‘cha yoki joylashuvni kiriting';if(address.latitude===undefined||address.longitude===undefined)e.coordinates='Xaritadan joylashuvni belgilang';else if(address.latitude<-90||address.latitude>90||address.longitude<-180||address.longitude>180||(address.latitude===0&&address.longitude===0))e.coordinates='Tanlangan koordinata noto‘g‘ri';if(!address.pinConfirmedAt)e.pinConfirmation='Pin yetkazish nuqtasida ekanini tasdiqlang';if(address.deliveryZoneResult==='OUTSIDE_ZONE')e.deliveryZone='Bu manzil yetkazish hududidan tashqarida';if(address.deliveryZoneResult==='DELIVERY_DISABLED')e.deliveryZone='Yetkazib berish vaqtincha o‘chirilgan';return e}
// Uzbekistan-only checkout: the phone field only ever produces "" (empty)
// or an exact "+998" + 9-digit canonical value (see extractUzbekNationalDigits
// in src/phone.ts) -- so the customer-facing check can require that exact
// shape instead of the previously loose "9+ digit-ish characters" rule.
export function validateAddress(address:CustomerAddress):Record<string,string>{const e:Record<string,string>={};if(!address.customerName.trim())e.customerName='Ismingizni kiriting';if(!/^\+998\d{9}$/.test(address.primaryPhone))e.primaryPhone='Telefon raqamini to‘liq kiriting';return{...e,...validateDeliveryLocation(address)}}
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
