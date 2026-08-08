import {describe,expect,it} from 'vitest'
import {store} from './data'
import type {CustomerAddress} from './domain'

describe('driver assignment rules',()=>{it('rejects assigning a non-ready order',async()=>{const order=await store.get('ord-new');const drivers=await store.listDrivers();await expect(store.assign(order!,{...drivers[0],availability:'AVAILABLE'})).rejects.toThrow('Only ready orders')});it('rejects an unavailable driver',async()=>{const order=await store.get('ord-ready');const drivers=await store.listDrivers();await expect(store.assign(order!,drivers[0])).rejects.toThrow('Driver is not available')})})
describe('delivery address clarification (local store)',()=>{
  const blank:CustomerAddress={customerName:'',primaryPhone:'',district:'',street:'',house:'',landmark:'',deliveryNotes:'',confidence:'CUSTOMER_CONFIRMATION_REQUIRED'}
  it('does not offer an address to edit for an order that is not awaiting clarification',async()=>{await expect(store.getAddressForRevision('ord-new')).resolves.toBeUndefined()})
  it('rejects a revision attempt for an order that is not awaiting clarification',async()=>{await expect(store.reviseAddress('ord-new',blank)).rejects.toThrow('Address revision is not allowed')})
  it('returns the current address for a clarification-requested order without carrying forward the prior pin confirmation',async()=>{const address=await store.getAddressForRevision('ord-clarify');expect(address).toBeDefined();expect(address!.house).toBe('Bino raqami noma’lum');expect(address!.pinConfirmedAt).toBeUndefined()})
  it('revises the address and returns the order to REVIEW_REQUIRED',async()=>{const current=await store.getAddressForRevision('ord-clarify');const revised={...current!,house:'14-uy',pinConfirmedAt:'2026-08-08T09:00:00Z'};const updated=await store.reviseAddress('ord-clarify',revised);expect(updated).toBeDefined();expect(updated!.deliveryReviewStatus).toBe('REVIEW_REQUIRED');expect(updated!.deliveryReviewReason).toBeUndefined();expect(updated!.address?.house).toBe('14-uy');const again=await store.get('ord-clarify');expect(again?.deliveryReviewStatus).toBe('REVIEW_REQUIRED')})
})
