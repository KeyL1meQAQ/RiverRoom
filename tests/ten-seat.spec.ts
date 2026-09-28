import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Room } from '../src/types';

const fixtures: Record<string, Room> = JSON.parse(execFileSync('.venv/bin/python', ['-m', 'backend.tests.presentation_fixture'], { encoding: 'utf8' }));
function tenSeats() {
  const state = structuredClone(fixtures.table_actions);
  const extra = structuredClone(state.players.find(p => p.seat === 8)!);
  Object.assign(extra, { id: 'tenth-player', name: '第十位玩家', seat: 9, bet: 20 });
  state.players.push(extra);
  state.hand!.ids.push(extra.id); state.hand!.seats.push(9);
  state.hand!.clock = null;
  state.players.forEach(p => { if (p.seat !== null) { p.bet = 20; p.folded = false; p.cards = ['As', 'Kh']; state.hand!.cards[p.id] = ['As', 'Kh']; state.hand!.last_actions[p.id] = '跟注'; } });
  return state;
}
async function mount(page: Page, state: Room) {
  const delta = Date.now() / 1000 - state.server_time;
  state.server_time += delta;
  if (state.hand) { state.hand.reveal_until = 0; state.hand.presentation = null; }
  let send: (s: Room) => void;
  await page.route('**/api/rooms/ten-seat', route => route.fulfill({ json: state }));
  await page.route('**/api/rooms/ten-seat/logs**', route => route.fulfill({ json: { logs: [] } }));
  await page.routeWebSocket('**/ws/ten-seat', ws => { send = s => ws.send(JSON.stringify({ type: 'state', state: s })); send(state); });
  await page.goto('/r/ten-seat');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  return (s: Room) => { state = s; send(s); };
}

test('ten mobile seats keep complete player areas separate and fixed for every street', async ({ page }) => {
  const state = tenSeats();
  const push = await mount(page, state);
  for (const width of [320, 360, 390, 760]) {
    await page.setViewportSize({ width, height: 844 });
    let first: number[][] | undefined;
    for (const count of [0, 3, 4, 5]) {
      state.hand!.boards = [['2c', '3d', '4h', '5s', '6c'].slice(0, count)];
      push(state);
      await expect(page.locator('.boards .playing-card')).toHaveCount(count);
      await expect(page.locator('.seat.occupied')).toHaveCount(10);
      const layout = await page.evaluate(() => {
        const stage = document.querySelector('.table-stage')!.getBoundingClientRect();
        const regions = Array.from({ length: 10 }, (_, i) => {
          const wrap = document.querySelector(`.seat-wrap.position-${i}`)!;
          const rects = [...wrap.querySelectorAll('.seat, .hole-cards .playing-card')].map(el => el.getBoundingClientRect());
          return { left: Math.min(...rects.map(r => r.left)), top: Math.min(...rects.map(r => r.top)), right: Math.max(...rects.map(r => r.right)), bottom: Math.max(...rects.map(r => r.bottom)) };
        });
        const overlap = (a: typeof regions[0], b: typeof regions[0]) => Math.min(a.right,b.right) > Math.max(a.left,b.left) + 1 && Math.min(a.bottom,b.bottom) > Math.max(a.top,b.top) + 1;
        const blockers = [...document.querySelectorAll('.seat-bet, .dealer, .boards .playing-card')].map(el => ({ rect: el.getBoundingClientRect(), name: el.className }));
        const issues = regions.flatMap((a,i) => [
          ...regions.slice(i+1).filter(b=>overlap(a,b)).map(()=>`player ${i} overlaps another player`),
          ...blockers.filter(b=>overlap(a,b.rect)).map(b=>`player ${i} overlaps ${b.name}`),
          ...(a.left < stage.left - 1 || a.right > stage.right + 1 || a.top < stage.top - 1 || a.bottom > stage.bottom + 1 ? [`player ${i} outside stage`] : []),
        ]);
        const chips = blockers.filter(b=>b.name.includes('seat-bet'));
        issues.push(...chips.flatMap((a,i)=>chips.slice(i+1).filter(b=>overlap(a.rect,b.rect)).map(()=>`chips overlap`)));
        return { regions, issues, anchors: regions.map(r=>[r.left-stage.left,r.top-stage.top]), width:stage.width,height:stage.height, documentWidth:document.documentElement.scrollWidth };
      });
      expect(layout.issues, `${width}px ${count} board cards`).toEqual([]);
      expect(layout.width).toBeGreaterThanOrEqual(360); expect(layout.height).toBeGreaterThanOrEqual(800);
      expect(layout.documentWidth).toBeLessThanOrEqual(width);
      for (const i of [1,9]) expect(layout.regions[i].bottom).toBeLessThan(layout.regions[0].top);
      for (const i of [4,6]) expect(layout.regions[i].top).toBeGreaterThan(layout.regions[5].bottom);
      if (first) expect(layout.anchors).toEqual(first); else first=layout.anchors;
    }
    if (width===390) await page.locator('.table-stage').screenshot({path:'artifacts/ten-seat-mobile-390.png'});
  }
});

test('minimum canvas scrolls in both directions without moving floating controls', async ({ page }) => {
  await page.setViewportSize({ width:320,height:568 });
  await mount(page, tenSeats());
  const before = await page.locator('.action-content').boundingBox();
  const scroll = await page.locator('.room-main').evaluate(el => { el.scrollTo(1000,1000); return {left:el.scrollLeft,top:el.scrollTop}; });
  expect(scroll.left).toBeGreaterThan(0); expect(scroll.top).toBeGreaterThan(0);
  expect(await page.locator('.action-content').boundingBox()).toEqual(before);
  expect(await page.evaluate(()=>window.scrollX+window.scrollY)).toBe(0);
});

test('all ten positions retain complete rank and suit glyphs above their frame', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  const state=tenSeats(); await mount(page,state);
  await page.addStyleTag({content:'.hole-cards, .hole-cards * { pointer-events:auto !important; }'});
  const glyphs=page.locator('.hole-cards .playing-card > b, .hole-cards .playing-card > span');
  await expect(glyphs).toHaveCount(40);
  for (const glyph of await glyphs.all()) {
    await glyph.evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest'}));
    expect(await glyph.evaluate(el=>{ const r=el.getBoundingClientRect(),card=el.closest('.playing-card')!; return [[r.left+2,r.top+r.height/2],[r.right-2,r.top+r.height/2],[r.left+r.width/2,r.bottom-2]].every(([x,y])=>card.contains(document.elementFromPoint(x,y))); }), await glyph.textContent() || '').toBeTruthy();
  }
});

test('tenth seat rotates to self, preserves empty slots, and observers retain all ten slots', async ({ page }) => {
  await page.setViewportSize({ width:390,height:1100 });
  const state=tenSeats(); state.me='tenth-player';
  const push=await mount(page,state);
  await expect(page.locator('.own-seat')).toHaveClass(/position-0/);
  await expect(page.locator('.position-0 .seat-name')).toHaveText('第十位玩家');
  state.players.find(p=>p.seat===4)!.seat=null; push(state);
  await expect(page.locator('.seat-wrap')).toHaveCount(10);
  await expect(page.locator('.position-5 .seat.empty')).toHaveAttribute('aria-label','入座 5 号位');
  const observer=structuredClone(state.players[0]);Object.assign(observer,{id:'observer',seat:null,cards:[]});
  state.players.push(observer);state.me=observer.id;push(state);
  await expect(page.locator('.own-seat')).toHaveCount(0);
  await expect(page.locator('.position-9 .seat-name')).toHaveText('第十位玩家');
  await expect(page.locator('.seat-wrap')).toHaveCount(10);
});

test('ten players, all dealer positions and large bets fit on desktop and mobile', async ({ page }) => {
  const state=tenSeats(); const push=await mount(page,state);
  for (const width of [320,360,390,760,761,1024,1440]) {
    await page.setViewportSize({width,height:1100});
    for (const large of [false,true]) {
      state.players.forEach(p=>{ if(p.seat!==null) p.bet=large?123456789:20; });
      for(let seat=0;seat<10;seat++) {
        state.button=seat;push(state);
        await expect(page.locator(`.position-${seat} .dealer`)).toHaveCount(1);
        const issues=await page.evaluate(()=>{
          const intersects=(a:DOMRect,b:DOMRect)=>Math.min(a.right,b.right)>Math.max(a.left,b.left)+1 && Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+1;
          const markers=[...document.querySelectorAll('.dealer,.seat-bet')];
          const blockers=[...document.querySelectorAll('.seat,.hole-cards,.boards')];
          const issues=markers.flatMap((a,i)=>[...blockers,...markers.slice(i+1)].filter(b=>intersects(a.getBoundingClientRect(),b.getBoundingClientRect())).map(b=>`${a.closest('.seat-wrap')!.className} ${a.className} overlaps ${b.className}`));
          const regions=[...document.querySelectorAll('.seat-wrap')].map(w=>[...w.querySelectorAll('.seat,.hole-cards .playing-card')].map(e=>e.getBoundingClientRect()));
          issues.push(...regions.flatMap((rs,i)=>regions.slice(i+1).flatMap(other=>rs.some(r=>other.some(o=>intersects(r,o)))?[`player ${i} overlaps another player`]:[])));
          return issues;
        });
        expect(issues,`${width}px ${large?'large':'normal'} dealer ${seat}`).toEqual([]);
      }
    }
    if(width===390 || width===1440) await page.locator('.table-stage').screenshot({path:`artifacts/ten-seat-full-${width}.png`});
  }
});

test('desktop has five mirrored pairs and chips follow the diagram on every street', async ({ page }) => {
  const state = tenSeats();
  const push = await mount(page, state);
  for (const [width,height] of [[761,600],[1024,768],[1440,960],[1920,1080]]) {
    await page.setViewportSize({width,height});
    let first: number[][] | undefined;
    for (const count of [0,3,4,5]) {
      state.hand!.boards = [['2c','3d','4h','5s','6c'].slice(0,count)];
      push(state);
      await expect(page.locator('.boards .playing-card')).toHaveCount(count);
      const layout = await page.evaluate(() => {
        const stage = document.querySelector('.table-stage')!.getBoundingClientRect();
        const seats = Array.from({length:10},(_,i) => {
          const wrap = document.querySelector(`.seat-wrap.position-${i}`)!;
          const box = wrap.getBoundingClientRect();
          const frame = wrap.querySelector('.seat')!.getBoundingClientRect();
          const cards = [...wrap.querySelectorAll('.hole-cards .playing-card')].map(e=>e.getBoundingClientRect());
          const bounds = [frame,...cards];
          return { x:box.left+box.width/2-stage.left, y:box.top+box.height/2-stage.top,
            area:{left:Math.min(...bounds.map(r=>r.left)),right:Math.max(...bounds.map(r=>r.right)),top:Math.min(...bounds.map(r=>r.top)),bottom:Math.max(...bounds.map(r=>r.bottom))},
            chip:wrap.querySelector('.seat-bet')!.getBoundingClientRect().toJSON() };
        });
        return {seats,width:stage.width,height:stage.height};
      });
      const {seats} = layout;
      expect(layout.width).toBeGreaterThanOrEqual(1000);
      expect(layout.height).toBeGreaterThanOrEqual(660);
      for (const [a,b] of [[0,1],[2,9],[3,8],[4,7],[5,6]]) {
        expect(Math.abs(seats[a].x+seats[b].x-layout.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(seats[a].y-seats[b].y)).toBeLessThanOrEqual(1);
      }
      expect(seats[0].x).toBeGreaterThan(layout.width/2);
      expect(seats[0].y).toBeGreaterThan(seats[9].y);
      expect(seats[9].y).toBeGreaterThan(seats[8].y);
      expect(seats[8].y).toBeGreaterThan(seats[7].y);
      expect(seats[7].y).toBeGreaterThan(seats[6].y);
      for (let i=0;i<10;i++) {
        const {chip,area}=seats[i];
        if ([0,1,2,9].includes(i)) expect(chip.bottom).toBeLessThan(area.top);
        if ([4,5,6,7].includes(i)) expect(chip.top).toBeGreaterThan(area.bottom);
        if ([2,3,4].includes(i)) expect(chip.left).toBeGreaterThan(area.right);
        if ([7,8,9].includes(i)) expect(chip.right).toBeLessThan(area.left);
        if ([3,8].includes(i)) expect(Math.abs((chip.top+chip.bottom-area.top-area.bottom)/2)).toBeLessThan(12);
      }
      const anchors=seats.map(s=>[s.x,s.y]);
      if(first) expect(anchors).toEqual(first); else first=anchors;
    }
  }
});

test('short desktop canvas scrolls while the expanded raise and reveal controls stay fixed', async ({page}) => {
  await page.setViewportSize({width:761,height:600});
  const state=tenSeats();
  state.legal={fold:true,call:2,can_call:true,can_raise:true,min_raise:4,max_raise:100};
  state.hand!.clock={pid:state.me,base_until:Date.now()/1000+200,until:Date.now()/1000+210,initial:10};
  const push=await mount(page,state);
  await page.locator('.raise-trigger').click();
  const before=await page.locator('.action-content').boundingBox();
  const offsets=await page.locator('.room-main').evaluate(el=>{el.scrollTo(el.scrollWidth,el.scrollHeight);return {x:el.scrollLeft,y:el.scrollTop};});
  expect(offsets.x).toBeGreaterThan(0);expect(offsets.y).toBeGreaterThan(0);
  expect(await page.locator('.action-content').boundingBox()).toEqual(before);
  await expect(page.locator('.own-seat .seat')).toBeInViewport();
  const own=(await page.locator('.own-seat .seat').boundingBox())!;
  const options=(await page.locator('.raise-options').boundingBox())!;
  expect(own.y+own.height).toBeLessThan(options.y);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth && window.scrollX===0 && window.scrollY===0)).toBeTruthy();
  const result=structuredClone(fixtures.twice);
  result.phase='between';result.rebuy=[];result.hand!.presentation=null;
  result.hand!.reveal_start=Date.now()/1000-1;result.hand!.reveal_until=Date.now()/1000+30;
  result.server_time=Date.now()/1000;push(result);
  await expect(page.locator('.reveal-actions')).toBeVisible();
  await page.locator('.room-main').evaluate(el=>el.scrollTo(el.scrollWidth,el.scrollHeight));
  const self=(await page.locator('.own-seat .seat').boundingBox())!;
  const reveal=(await page.locator('.reveal-actions').boundingBox())!;
  expect(self.y+self.height).toBeLessThan(reveal.y);
});
