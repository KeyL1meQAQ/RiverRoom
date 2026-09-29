import { useRef } from 'react';
import type { Hand, Room, SquidMode, SquidRound, SquidSettlement } from './types';
import './squid.css';

const n = (v: number) => v.toLocaleString('zh-CN');
const signed = (v: number) => `${v > 0 ? '+' : ''}${n(v)}`;
export const squidName = (mode?: SquidMode) => mode === 'infinite' ? '无限鱿鱼' : '普通鱿鱼';
const factor = (count: number, round: SquidRound) => round.mode === 'infinite' && round.multiplier
  ? 2 ** [3, 5, 7].filter(threshold => count >= threshold).length : 1;

export function squidPending(room: Room) {
  const current = room.squid_current;
  if (!current || room.closed_at) return { hand: '', round: '' };
  const settings = room.settings;
  const handChanged = current.enabled !== settings.squid || (settings.squid &&
    (current.amount !== settings.squid_amount || current.reveal !== settings.squid_reveal));
  const roundChanged = settings.squid && ((current.mode || 'classic') !== (settings.squid_mode || 'classic') ||
    (settings.squid_mode === 'infinite' && !!current.multiplier !== !!settings.squid_multiplier));
  return {
    hand: handChanged ? (settings.squid
      ? `下一手开启 · 单价 ${n(settings.squid_amount || 0)} · ${settings.squid_reveal ? '自动亮牌' : '不额外亮牌'}`
      : '下一手关闭鱿鱼，未完成轮次作废') : '',
    round: roundChanged ? `下一轮：${squidName(settings.squid_mode)}${settings.squid_mode === 'infinite'
      ? ` · 倍率${settings.squid_multiplier ? '开启' : '关闭'}` : ''}` : '',
  };
}

export function SquidStatus({ room, open }: { room: Room; open: () => void }) {
  const current = room.squid_current;
  const round = room.squid_round;
  const pending = squidPending(room);
  if (!current?.enabled && !pending.hand && !pending.round && !room.squid_history?.length) return null;
  const activeHand = room.hand?.result === null;
  const contested = activeHand ? room.hand?.squid_contested : room.squid_next_contested;
  const progress = round ? `${round.members.reduce((sum, m) => sum + m.count, 0)}/${round.total}` : '等待新轮';
  return <div className="squid-top-status">
    <button type="button" className="squid-tag" onClick={open}
      aria-label={`鱿鱼游戏，${squidName(current?.mode)}，${progress}${pending.hand ? '，下一手有变更' : ''}${pending.round ? '，下一轮有变更' : ''}`}
      title={[`每个 ${n(current?.amount || 0)}`, pending.hand, pending.round].filter(Boolean).join(' · ')}>
      <span>🦑 {room.closed_at ? '鱿鱼记录' : current?.enabled ? `${squidName(current.mode)} ${progress}` : '鱿鱼已关闭'}
        <span className="squid-price"> · 每个 {n(current?.amount || 0)}</span></span>
      <small>{current?.enabled && round && `${activeHand ? '本手' : '下手'}争夺 ${contested ?? 1} 条`}
        {pending.hand && <b> · 下一手变更</b>}{pending.round && <b> · 下一轮变更</b>}</small>
    </button>
  </div>;
}

export function SquidRules({ mode = 'classic' }: { mode?: SquidMode }) {
  const infinite = mode === 'infinite';
  return <div className="bounty-rules squid-rules">
    <div className="bounty-rule-mark squid-rule-mark" aria-hidden="true">🦑</div>
    <p className="rules-intro">{infinite ? '赢下主池，累积鱿鱼！本轮结束时，没有鱿鱼的人向持有者付款。' : '赢下主池，拿到一条鱿鱼！别成为本轮最后一个没有鱿鱼的人。'}</p>
    <h3>怎么玩</h3>
    <ul>
      <li><strong>赢牌拿鱿鱼：</strong>{infinite ? '开轮发牌人数＋3 条，首手争夺 2 条，后续每手 1 条加结转。独赢主池就领走本手全部鱿鱼，可以重复领取；让其他人全部弃牌也算。' : '独赢主池即可获得一条，让其他人全部弃牌也算。每人每轮最多一条，拿到后再赢也不会增加。'}</li>
      {infinite && <li><strong>平分留到下一手：</strong>主池平分或没有形成底池时不发鱿鱼，本手数量结转，下一手再加 1 条，最多争夺本轮剩余数量。</li>}
      <li><strong>{infinite ? '轮末付款：' : '最后一人付款：'}</strong>{infinite ? '鱿鱼全部发完，或只剩一人没有鱿鱼时，本轮结束。每名零鱿鱼者分别按对方的数量 × 单价 × 个人倍率付款，持有者之间不互付。未发数量作废。' : '只剩一人没有鱿鱼时，本轮结束。由他向其他每人支付一份约定的鱿鱼价格。'}</li>
      {infinite && <li><strong>可选倍率：</strong>默认关闭。开启后，持有 1–2 条为 ×1、3–4 条为 ×2、5–6 条为 ×4、7 条及以上为 ×8，作用于该玩家全部鱿鱼，新轮重新累计。</li>}
      <li><strong>清零再来一轮：</strong>一轮可以跨越多手牌，结算后大家的鱿鱼清零，从下一手开始新一轮。</li>
    </ul>
    <aside className="rules-example"><strong>举个例子</strong>{infinite
      ? <p>5 人共 8 条，单价 10，倍率开启。最终为 4、3、1、0、0 条时，两名零鱿鱼者各付 80、60、10，共各付 <b>150 筹码</b>。前三人分别实收 160、120、20（筹码充足时）。</p>
      : <p>6 人参与，每条鱿鱼 10 筹码。当其中 5 人各拿到一条时，最后没拿到的人向他们各付 10，共付 <b>50 筹码</b>（筹码充足时）。</p>}</aside>
    <h3>需要注意</h3>
    <ul>
      <li><strong>是否自动亮牌：</strong>房主可以开启“获得鱿鱼时自动亮出两张底牌”，默认关闭。</li>
      <li><strong>筹码不足不欠账：</strong>最多付清剩余筹码，{infinite ? '按各持有者应收金额的比例分配，不让其他付款者补差。' : '由有鱿鱼的玩家尽量均分。'}</li>
      <li><strong>离座仍参与本轮结算：</strong>已有鱿鱼会保留，暂时离开或断线也一样。离座后的剩余筹码会暂留，等本轮结算后再取回。</li>
      <li><strong>中途改价影响整轮：</strong>新价格从下一手生效，本轮已经拿到的鱿鱼也按新价结算，已离座的玩家同样适用。</li>
    </ul>
    <details className="rules-more"><summary>更多规则</summary>
      <ul>
        <li><strong>哪些情况拿不到鱿鱼：</strong>主池平分、只赢边池，或没有形成底池而仅退回投入。{!infinite && '已经有鱿鱼的人再次获胜，不会重复获得，也不会因此再次自动亮牌。'}</li>
        <li><strong>发两次牌：</strong>只看第一组主池，独赢第一组就能拿到鱿鱼。</li>
        <li><strong>中途加入：</strong>至少两人参与发牌才能开始一轮。新人从第一次拿到底牌起加入本轮，{infinite ? '可以获鱿鱼，也承担本轮付款责任。本轮总量不随加入或离座改变，下轮才重新计算。' : '并多提供一条鱿鱼；最终仍由最后一名没有鱿鱼的人付款。'}原玩家重连或重新入座，不会额外增加鱿鱼。</li>
        <li><strong>付款顺序：</strong>先分配底池，再支付 2–7 奖励，最后结算鱿鱼，之后才能取回筹码或补码。鱿鱼付款后筹码归零也算被清台。</li>
        <li><strong>暂停或人数不足：</strong>保留本轮进度，等玩家回来继续。离座不会减少本轮人数，也不会提前判定输赢。</li>
        <li><strong>关闭玩法或结束房间：</strong>当前手如果刚好完成本轮，仍正常结算；否则未完成的一轮取消，不再收付鱿鱼筹码，离座玩家可取回暂留筹码。</li>
        <li><strong>修改设置：</strong>普通／无限切换和倍率开关从下一轮生效；单价、自动亮牌和开关从下一手生效，两手之间可立即生效。正在进行的一手（包括 Straddle 询问）保持原规则，已结算的轮次不受影响。</li>
        <li><strong>鱿鱼价格：</strong>首次开启默认一个大盲的筹码数。之后调整盲注或关闭再开启，都不会自动改变已设价格。</li>
      </ul>
    </details>
  </div>;
}

export function SquidSettlementView({ event }: { event: SquidSettlement }) {
  return <section className="squid-settlement" aria-label={`第 ${event.number} 轮鱿鱼记录`}>
    <h3>第 {event.number} 轮鱿鱼 · {squidName(event.mode)} · {event.status === 'cancelled' ? '已作废' : '已结算'}</h3>
    <p>单价 {n(event.amount)} · {event.status === 'cancelled' ? event.reason
      : `已发 ${event.issued ?? event.members.reduce((s, m) => s + m.count, 0)}/${event.total} 条 · ${event.reason || '轮次完成'}`}</p>
    {event.results.map(r => <p key={r.pid}><strong>{r.name}</strong> · {r.count} 条 ×{r.multiplier ?? factor(r.count, event)}
      <b className={r.delta >= 0 ? 'positive' : 'negative'}>{r.count ? '实收' : '实付'} {n(Math.abs(r.delta))}</b>
      {r.due != null && <span> / {r.count ? '应收' : '应付'} {n(r.due)}</span>}</p>)}
    {event.payments.map(p => <details key={p.pid}><summary>{p.name} 实付 {n(p.amount)} / 应付 {n(p.due)}
      {p.amount < p.due ? '（余额不足）' : ''}</summary>
      {p.transfers.map(t => <p key={t.pid}>向 {t.name} 支付 {n(t.amount)} / 应付 {n(t.due)}</p>)}
    </details>)}
  </section>;
}

export function SquidDetails({ room }: { room: Room }) {
  const round = room.squid_round;
  const mode = round?.mode || room.squid_current?.mode || room.settings.squid_mode || 'classic';
  return <div className="squid-details">
    {round ? <section><h3>第 {round.number} 轮 · 已发 {round.members.reduce((s, m) => s + m.count, 0)}/{round.total}</h3>
      <p>{squidName(mode)} · 每个 {n(round.amount)} 筹码{mode === 'infinite' && ` · 倍率${round.multiplier ? '开启' : '关闭'}`}</p>
      {round.members.map(m => {
        const p = room.players.find(p => p.id === m.pid);
        return <div className="squid-member" key={m.pid}><strong>{p?.name || m.name}</strong>
          <span>🦑 {m.count} ×{factor(m.count, round)}</span><small>{p?.squid_held ? `已离座 · 待结算筹码 ${n(p.holding)}`
            : p?.away ? '离开 · 保留本轮收付' : '本轮参与者'}</small></div>;
      })}</section> : <p className="muted">{room.closed_at ? '房间已结束' : room.settings.squid ? '等待至少两人发牌，开始新一轮' : '鱿鱼游戏已关闭'}</p>}
    {[...(room.squid_history || [])].reverse().map(e => <SquidSettlementView event={e} key={e.id} />)}
    <details className="squid-rules-details"><summary>{squidName(mode)}规则</summary><SquidRules mode={mode} /></details>
  </div>;
}

export function SquidCelebration({ hand, connection, now }: { hand: Hand | null; connection: number; now: number }) {
  const settlement = hand?.squid?.settlement;
  const paidBy = new Map((settlement?.payments || []).map(payment => [payment.pid, payment.amount]));
  const at = hand?.presentation?.squid_at ?? settlement?.finished_at ?? 0;
  const baseline = useRef({ connection, event: settlement?.id, until: 0 });
  if (baseline.current.connection !== connection) baseline.current = { connection, event: settlement?.id, until: 0 };
  else if (baseline.current.event !== settlement?.id) baseline.current = { connection, event: settlement?.id, until: settlement ? at + 3 : 0 };
  if (!settlement || settlement.status !== 'settled' || !hand?.result || now < at || now >= baseline.current.until || document.visibilityState !== 'visible') return null;
  return <div className="squid-celebration" role="status" aria-live="polite" aria-label={`第${settlement.number}轮鱿鱼结算`}>
    <div className="squid-celebration-mark" aria-hidden="true">🦑</div>
    <strong>第 {settlement.number} 轮鱿鱼结算</strong>
    <span className="squid-celebration-sub">{squidName(settlement.mode)} · 每只 {n(settlement.amount)} · 已发 {settlement.issued ?? settlement.members.reduce((s, m) => s + m.count, 0)}/{settlement.total} 条</span>
    <div className="squid-reward-list">{settlement.results.map(result => <div className="squid-reward-row" key={result.pid}>
      <span>{result.name}</span><b>🦑 {result.count} ×{result.multiplier ?? factor(result.count, settlement)}</b><em className={result.count ? 'squid-reward' : 'squid-payment'}>{result.count ? `奖金 ${signed(result.delta)}` : `支付 ${n(paidBy.get(result.pid) || 0)}`}</em>
    </div>)}</div>
  </div>;
}
