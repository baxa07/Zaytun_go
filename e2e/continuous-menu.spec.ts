import {expect,test} from '@playwright/test'

test.describe('continuous customer menu',()=>{
  test.use({viewport:{width:390,height:844}})

  test('renders every category in one document and synchronizes the sticky rail',async({page})=>{
    await page.goto('/menu')
    expect(await page.evaluate(()=>window.scrollY)).toBe(0)
    const menu=page.getByTestId('continuous-menu')
    const sections=menu.locator('.menu-category-section')
    const sectionCount=await sections.count()
    expect(sectionCount).toBeGreaterThan(1)
    await expect(menu.getByRole('heading',{name:'Gril',exact:true})).toBeVisible()
    await expect(menu.getByRole('heading',{name:'Issiq taomlar',exact:true})).toBeAttached()
    await expect(menu.getByRole('heading',{name:'Ichimliklar',exact:true})).toBeAttached()
    for(let index=0;index<sectionCount;index++)expect(await sections.nth(index).locator('.menu-grid').evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2)
    await sections.first().evaluate(element=>{(element as HTMLElement).dataset.mountProof='original'})
    await page.getByTestId('menu-section-mains').evaluate(element=>window.scrollTo({top:(element as HTMLElement).offsetTop-80}))
    await expect(page.getByTestId('menu-category-rail').getByRole('button',{name:'Issiq taomlar'})).toHaveClass(/active/)
    const stickyGeometry=await page.evaluate(()=>{const header=document.querySelector('header')!.getBoundingClientRect(),rail=document.querySelector('[data-testid="menu-category-rail"]')!.getBoundingClientRect();return{headerBottom:header.bottom,railTop:rail.top}})
    expect(stickyGeometry.railTop).toBeGreaterThanOrEqual(stickyGeometry.headerBottom-1)
    await page.getByTestId('menu-category-rail').getByRole('button',{name:'Ichimliklar'}).click()
    await expect(page.getByTestId('menu-section-drinks')).toBeInViewport()
    await expect(page.getByTestId('menu-category-rail').getByRole('button',{name:'Ichimliklar'})).toHaveClass(/active/)
    await expect(sections).toHaveCount(sectionCount)
    await expect(sections.first()).toHaveAttribute('data-mount-proof','original')
    const activeButton=page.getByTestId('menu-category-rail').getByRole('button',{name:'Ichimliklar'})
    expect(await activeButton.evaluate(element=>{const button=element.getBoundingClientRect(),rail=element.parentElement!.getBoundingClientRect();return button.left>=rail.left&&button.right<=rail.right})).toBe(true)
    expect(await page.getByTestId('menu-category-rail').evaluate(element=>getComputedStyle(element).overflowX)).toMatch(/auto|scroll/)
    await expect(page.getByTestId('customer-bottom-nav').getByRole('link',{name:/Savat/})).toBeVisible()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  })

  test('simple product plus uses the existing cart while modifier products retain selection',async({page})=>{
    await page.goto('/menu')
    await page.getByRole('button',{name:'Mol go‘shtli kabob savatga qo‘shish'}).click()
    await expect(page.getByTestId('cart-pill')).toContainText('1')
    await expect(page.getByRole('link',{name:'Zaytun tovuq grili tanlash'})).toHaveAttribute('href','/menu/chicken')
  })
})

for(const viewport of [{width:320,height:700},{width:360,height:800},{width:430,height:900},{width:1280,height:800}]){
  test(`continuous menu grid is stable at ${viewport.width}px`,async({page})=>{
    await page.setViewportSize(viewport)
    await page.goto('/menu')
    const grids=page.getByTestId('continuous-menu').locator('.menu-grid')
    for(let index=0;index<await grids.count();index++)expect(await grids.nth(index).evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(viewport.width<=760?2:3)
    if(viewport.width<=760){const firstCard=page.locator('.menu-category-section .menu-card').first();await expect(firstCard.locator('h3')).toBeVisible();await expect(firstCard.locator('footer b')).toBeVisible();expect(await firstCard.locator('p').evaluate(element=>getComputedStyle(element).display)).toBe('none');expect(await firstCard.locator('h3').evaluate(element=>getComputedStyle(element).webkitLineClamp)).toBe('2');expect(await firstCard.locator('.round').evaluate(element=>Math.min(element.getBoundingClientRect().width,element.getBoundingClientRect().height))).toBeGreaterThanOrEqual(38)}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  })
}
