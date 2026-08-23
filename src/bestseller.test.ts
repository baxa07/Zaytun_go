import{describe,expect,it}from'vitest';
import{addCartLine,calculatePackagingTotal,featuredMenuItems,type MenuItem}from'./domain';

const item=(id:string,overrides:Partial<MenuItem>={}):MenuItem=>({id,categoryId:'mains',name:id,description:'',price:20000,image:'',available:true,isBestseller:false,packagingRequired:true,packagingUnitPrice:3000,packagingCapacity:1,...overrides});

describe('Owner-curated Bestseller projection',()=>{
  it('hides the section projection when nothing is curated',()=>expect(featuredMenuItems([item('regular')])).toEqual([]));
  it('includes only available curated products',()=>expect(featuredMenuItems([item('regular'),item('featured',{isBestseller:true}),item('off',{isBestseller:true,available:false})]).map(value=>value.id)).toEqual(['featured']));
  it('returns a re-enabled curated product without changing its flag',()=>expect(featuredMenuItems([item('back',{isBestseller:true,available:true})])).toHaveLength(1));
  it('keeps stable menu order and limits the premium section to six',()=>expect(featuredMenuItems(['a','b','c','d','e','f','g'].map(id=>item(id,{isBestseller:true}))).map(value=>value.id)).toEqual(['a','b','c','d','e','f']));
  it('uses the existing cart line and packaging calculation unchanged',()=>{const featured=item('jiz',{isBestseller:true,price:260000});const cart=addCartLine([],{id:'line',menuItemId:featured.id,name:featured.name,unitPrice:featured.price,quantity:1,modifierIds:[],modifierNames:[],instructions:'',packagingRequired:featured.packagingRequired,packagingUnitPrice:featured.packagingUnitPrice,packagingCapacity:featured.packagingCapacity},50);expect(cart[0].unitPrice).toBe(260000);expect(calculatePackagingTotal(cart)).toBe(3000)});
});
