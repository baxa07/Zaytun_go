import {describe,expect,it} from 'vitest'
import {store} from './data'

describe('driver assignment rules',()=>{it('rejects assigning a non-ready order',async()=>{const order=await store.get('ord-new');const drivers=await store.listDrivers();await expect(store.assign(order!,{...drivers[0],availability:'AVAILABLE'})).rejects.toThrow('Only ready orders')});it('rejects an unavailable driver',async()=>{const order=await store.get('ord-ready');const drivers=await store.listDrivers();await expect(store.assign(order!,drivers[0])).rejects.toThrow('Driver is not available')})})
