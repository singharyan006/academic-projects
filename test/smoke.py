import asyncio, pathlib, sys
from playwright.async_api import async_playwright
ROOT = pathlib.Path(__file__).resolve().parents[1]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width':1440,'height':900})
        errs=[]
        pg.on('pageerror', lambda e: errs.append('PAGEERR '+str(e)))
        pg.on('console', lambda m: errs.append('CONSOLE '+m.type+' '+m.text) if m.type in ('error','warning') else None)
        async def route(r):
            u=r.request.url
            if 'OrbitControls' in u: await r.fulfill(path=str(ROOT/'test/mock/orbit.js'), content_type='application/javascript')
            elif 'three.module' in u: await r.fulfill(path=str(ROOT/'test/mock/three.js'), content_type='application/javascript')
            else: await r.abort()
        await pg.route('http*://**/*', route)
        await pg.goto('file://'+str(ROOT/'dist/index.html'))
        await pg.wait_for_timeout(800)
        print('ok?', await pg.evaluate('!!window.__twinOK'))
        await pg.evaluate('window.__twin.sim.motion.speed=3')
        await pg.click('#dRed'); await pg.wait_for_timeout(9000)
        await pg.click('#dGreen'); await pg.wait_for_timeout(9000)
        print('after red/green', await pg.evaluate('JSON.stringify(window.__twin.sim.stats)'), await pg.inner_text('#hdrState'))
        await pg.click('#dAll'); await pg.wait_for_timeout(28000)
        print('after full', await pg.evaluate('JSON.stringify(window.__twin.sim.stats)'), await pg.inner_text('#demoStatus'))
        print('sensor', await pg.inner_text('#detL'), '|', await pg.inner_text('#sStat'))
        # manual
        await pg.click('#mMan')
        await pg.evaluate("(()=>{const e=document.getElementById('j_base'); e.value=150; e.dispatchEvent(new Event('input'))})()")
        await pg.wait_for_timeout(2500)
        print('base', await pg.inner_text('#jv_base'), await pg.inner_text('#fkOut'))
        await pg.click('#bSeq'); await pg.wait_for_timeout(1500)
        # unknown in auto, error case via calibration
        await pg.click('.tab[data-view=calView]'); await pg.wait_for_timeout(300)
        await pg.fill('[data-pose=PICKUP][data-j=shoulder]', '200'); await pg.click('#calApply')
        print('calmsg', await pg.inner_text('#calMsg'))
        await pg.fill('[data-pose=PICKUP][data-j=shoulder]', '125'); await pg.click('#calApply')
        print('calmsg', await pg.inner_text('#calMsg'))
        await pg.click('#tbRun'); print('bench', await pg.inner_text('#tbOut'))
        await pg.click('.tab[data-view=simView]')
        await pg.click('#mAuto'); await pg.click('#dRed'); await pg.wait_for_timeout(8000)
        print('miscal state', await pg.inner_text('#hdrState'), '|', await pg.inner_text('#errMsg'))
        await pg.click('#errReset'); await pg.wait_for_timeout(500)
        print('after reset', await pg.inner_text('#hdrState'))
        await pg.click('.tab[data-view=hwView]'); await pg.wait_for_timeout(300)
        await pg.screenshot(path=str(ROOT/'test/hw.png'), full_page=True)
        await pg.click('.tab[data-view=simView]'); await pg.wait_for_timeout(300)
        await pg.screenshot(path=str(ROOT/'test/sim.png'))
        print('log lines', await pg.evaluate("document.getElementById('log').children.length"))
        print('\n'.join(errs[:20]) or 'no errors')
        await pg.set_viewport_size({'width':420,'height':900}); await pg.wait_for_timeout(300)
        await pg.screenshot(path=str(ROOT/'test/mobile.png'), full_page=False)
        await b.close()
asyncio.run(main())
